/**
 * 简介翻译后台工作线程（进程内队列 + 数据库持久化）。
 *
 * 硬性约束：
 * 1. **绝不阻塞同步**：同步引擎只负责入队，worker 完全独立；
 * 2. 有限并发：默认 2，可在设置里调整（1–8），避免数百个请求同时打向 AI；
 * 3. 断点恢复：任务状态存在数据库里，启动时把 processing 复位为 pending；
 * 4. 幂等：完成时比对原文 hash，只有 hash 一致才写入中文，避免旧译文覆盖新原文；
 * 5. 失败不影响任何已有数据：AI 出错只改任务状态与错误信息。
 */

import {
  cleanTranslationOutput,
  TRANSLATION_STATUS,
  validateTranslationOutput,
} from '@bangumi-analyzer/shared';
import { AiError, translateSummary } from '../ai/provider.js';
import type { AiConfig } from '../config.js';
import { one, run } from '../db/index.js';
import { requeueWhenAiConfigured } from '../db/summaries.js';
import {
  claimJob,
  countJobs,
  nextPendingJobs,
  markJobCompleted,
  markJobFailed,
  markJobObsolete,
  markJobSuperseded,
  getJob,
  resetInFlightJobs,
  type QueueCounts,
  type TranslationJobRow,
} from '../db/translationJobs.js';
import { scrubSecrets } from '../logger.js';

export interface WorkerOptions {
  /** 每次读取配置都重新读，保证在设置里改完 Key / 模型后立刻生效 */
  getConfig: () => AiConfig;
  /** 最多同时进行的 AI 请求数 */
  concurrency?: () => number;
  /** 单个任务的最大重试次数（超过后进入 failed，等待手动重试） */
  maxAttempts?: number;
  /** 注入 fetch，便于测试（不传则用全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 单元测试里把退避时间压到最小 */
  backoffBaseMs?: number;
  /** 限流后的冷却时长（默认 30s，测试里可以调小） */
  rateLimitCooldownMs?: number;
  log?: (message: string) => void;
}

interface JobSubjectRow {
  id: number;
  name: string;
  summary_original: string;
  summary_original_hash: string;
  summary_original_lang: string;
  summary_zh_official: string;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 5;
/** 限流后的全局冷却上限（毫秒） */
const MAX_RATE_LIMIT_COOLDOWN_MS = 120_000;
/** 同一并发槽位两次请求之间的最小间隔（毫秒）：摊开建连，降低偶发网络失败 */
const INTER_REQUEST_DELAY_MS = 50;

export class TranslationWorker {
  private readonly options: WorkerOptions;
  private running = false;
  private stopping = false;
  private active = 0;
  private wake: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  /** 限流 / 认证错误后的全局冷却截止时间 */
  private cooldownUntil = 0;
  private rateLimitStreak = 0;

  constructor(options: WorkerOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get activeJobs(): number {
    return this.active;
  }

  counts(): QueueCounts {
    return countJobs();
  }

  /** 启动 worker：先复位上次遗留的 processing 任务，再进入循环。 */
  start(timestamp = new Date().toISOString()): void {
    if (this.running) return;
    const reset = resetInFlightJobs(timestamp);
    if (reset > 0) {
      this.log(`翻译队列：${reset} 个中断的任务已回到待处理状态`);
    }
    this.running = true;
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  /** 停止 worker：等待进行中的请求结束；未完成的任务会在下次启动时回到 pending。 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.signal();
    await this.loopPromise;
    this.loopPromise = null;
    this.running = false;
  }

  /** 有新任务入队 / 配置变化 / 退避到期时唤醒 */
  wakeUp(): void {
    this.signal();
  }

  /**
   * 等待队列跑空（仅用于测试与关停前的收尾）。
   * 返回是否在超时前处理完所有任务。
   */
  async waitForIdle(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const counts = this.counts();
      if (counts.pending === 0 && counts.processing === 0 && this.active === 0) {
        // 再确认一次，避免刚好有任务被重新入队
        await new Promise((resolve) => setTimeout(resolve, 20));
        const again = this.counts();
        if (again.pending === 0 && again.processing === 0 && this.active === 0) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  private signal(): void {
    const resolve = this.wake;
    this.wake = null;
    resolve?.();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      if (this.cooldownUntil > Date.now()) {
        // 限流冷却：等到冷却结束或收到唤醒
        await this.wait(this.cooldownRemaining());
        if (this.stopping) break;
        continue;
      }

      if (!this.configReady()) {
        /*
         * AI 未配置：不空转，也不让任务无声地卡在 pending。
         * 把待处理任务标记为「待配置 AI」并进入休眠，等配置补齐后由
         * wakeUp() 唤醒（设置页保存配置、启动扫描、手动操作都会唤醒）。
         */
        this.parkPendingJobsForMissingConfig();
        await this.wait(30_000);
        continue;
      }

      /*
       * AI 配置已就绪：把之前因「未配置 / 认证失败」暂停的任务放回队列。
       * 这样用户补好 Key 之后不需要任何手动操作，队列会自动继续。
       */
      if (this.releaseParkedJobs()) continue;

      const batch = nextPendingJobs(this.concurrency, new Date().toISOString());
      if (batch.length === 0) {
        // 队列暂时为空（可能只是退避未到期）：频繁检查，保证重试及时发生
        await this.wait(1_000);
        continue;
      }

      for (const job of batch) {
        if (this.stopping) break;
        await this.runJob(job);
      }
    }
  }

  private get concurrency(): number {
    const configured = this.options.concurrency?.() ?? DEFAULT_CONCURRENCY;
    return Math.min(8, Math.max(1, Math.round(configured)));
  }

  /** AI 未配置时把 pending 任务标记为 waiting_ai（原文与收藏数据不受影响）。 */
  private parkPendingJobsForMissingConfig(): void {
    const config = this.options.getConfig();
    const reason = !config.enabled
      ? 'AI 未启用（可在「设置 → AI」中开启）'
      : !config.apiKey
        ? '缺少 AI API Key（可在「设置 → AI」中填写）'
        : 'AI 配置不完整（Base URL / 模型）';
    const rows = nextPendingJobs(50, new Date().toISOString());
    if (rows.length === 0) return;
    for (const job of rows) {
      markJobFailed({
        jobId: Number(job.id),
        error: reason,
        timestamp: new Date().toISOString(),
        terminal: false,
        waitingAi: true,
        nextAttemptAt: null,
      });
      run(`UPDATE subjects SET summary_zh_ai_status = 'waiting_ai', summary_zh_ai_error = :error
            WHERE id = :id`, { id: Number(job.subject_id), error: reason });
    }
    this.log(`简介翻译暂停：${reason}（${rows.length} 条任务等待配置）`);
  }

  /** 配置就绪后释放 waiting_ai 任务；返回是否释放了任务（释放后重新取批次）。 */
  private releaseParkedJobs(): boolean {
    const parked = this.counts().waiting_ai;
    if (parked === 0) return false;
    const released = requeueWhenAiConfigured(new Date().toISOString());
    if (released > 0) this.log(`简介翻译继续：${released} 条任务从「待配置 AI」回到队列`);
    return released > 0;
  }

  private get maxAttempts(): number {
    return this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private configReady(): boolean {
    const config = this.options.getConfig();
    return Boolean(config.enabled && config.apiKey && config.baseUrl && config.model);
  }

  private cooldownRemaining(): number {
    return Math.max(1_000, this.cooldownUntil - Date.now());
  }

  private wait(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async runJob(job: TranslationJobRow): Promise<void> {
    const timestamp = new Date().toISOString();
    if (!claimJob(Number(job.id), timestamp)) return;
    this.active += 1;
    try {
      await this.execute({ ...job, attempts: Number(job.attempts) });
    } finally {
      this.active -= 1;
      /*
       * 每个并发槽位之间留一点间隔：把请求在时间上摊开，
       * 避免短时间内连续建连导致的偶发网络失败（对端限速 / 连接受限）。
       */
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, INTER_REQUEST_DELAY_MS));
    }
  }

  private async execute(job: TranslationJobRow): Promise<void> {
    const config = this.options.getConfig();
    const subjectId = Number(job.subject_id);
    const hash = job.source_hash;

    const subject = this.loadSubject(subjectId);
    if (!subject) {
      markJobSuperseded(Number(job.id), '条目已不存在，任务作废', new Date().toISOString());
      return;
    }
    // Bangumi 原文在排队后被更新 → 放弃这次翻译，让新任务处理
    if (subject.summary_original_hash !== hash) {
      // 旧任务标记为历史失效（不计入失败统计），新 hash 的任务由扫描 / 同步流程建立
      markJobObsolete(Number(job.id), '原文已更新，该任务的历史结果不再对应当前原文', new Date().toISOString());
      this.setStatus(subjectId, TRANSLATION_STATUS.Pending);
      return;
    }
    // 已经有官方中文 → 不需要 AI 翻译，任务直接作废
    if (subject.summary_zh_official.trim()) {
      markJobObsolete(Number(job.id), '已有 Bangumi 官方中文，无需 AI 翻译', new Date().toISOString());
      this.setStatus(subjectId, TRANSLATION_STATUS.Idle);
      return;
    }
    if (!subject.summary_original.trim()) {
      markJobSuperseded(Number(job.id), '原文为空，无需翻译', new Date().toISOString());
      this.setStatus(subjectId, TRANSLATION_STATUS.Idle);
      return;
    }

    this.setStatus(subjectId, TRANSLATION_STATUS.Processing, { clearError: true });

    try {
      const result = await translateSummary({
        config,
        source: subject.summary_original,
        sourceLanguage: subject.summary_original_lang || 'ja',
        subjectName: subject.name,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      });
      if (!this.isCurrentJob(job)) return;
      this.rateLimitStreak = 0;

      const cleaned = cleanTranslationOutput(result.text);
      const validation = validateTranslationOutput(cleaned, subject.summary_original);
      if (!validation.ok) {
        /*
         * 校验失败时把模型输出的开头一小段附在错误里，
         * 方便在界面上判断是「模型复述原文」还是「校验过严」。
         * 只保留前 40 字，且不含任何凭据。
         */
        const preview = cleaned.replace(/\s+/g, ' ').slice(0, 40);
        this.handleFailure(
          job,
          new AiError(
            'invalid_response',
            `${validation.reason}（模型输出开头：${preview || '空'}）`,
            '稍后会自动重试。',
          ),
        );
        return;
      }

      const committed = this.commit(subjectId, hash, cleaned, result.provider, result.model);
      if (committed) {
        markJobCompleted(Number(job.id), {
          provider: result.provider,
          model: result.model,
          timestamp: new Date().toISOString(),
        });
        this.log(`简介翻译完成：${subject.name}`);
      } else {
        // 翻译期间原文被更新：保留这次结果也不写库，交给新任务
        markJobSuperseded(
          Number(job.id),
          '翻译期间原文已更新，结果未写入（避免覆盖新原文）',
          new Date().toISOString(),
        );
        this.setStatus(subjectId, TRANSLATION_STATUS.Pending);
      }
    } catch (error) {
      this.handleFailure(job, error);
    }
  }

  /** 写入中文翻译（hash 校验通过才写，绝不覆盖一手原文）。 */
  private commit(
    subjectId: number,
    hash: string,
    translation: string,
    provider: string,
    model: string,
  ): boolean {
    const result = run(
      `UPDATE subjects SET
         summary_zh_ai = :translation,
         summary_zh_ai_hash = :hash,
         summary_zh_ai_status = 'completed',
         summary_zh_ai_provider = :provider,
         summary_zh_ai_model = :model,
         summary_zh_ai_updated_at = :ts,
         summary_zh_ai_error = NULL,
         summary_zh_source = 'ai'
       WHERE id = :id AND summary_original_hash = :hash AND summary_original <> ''
         AND summary_zh_official = ''`,
      {
        id: subjectId,
        hash,
        translation,
        provider,
        model,
        ts: new Date().toISOString(),
      },
    );
    return Number(result.changes ?? 0) > 0;
  }

  private setStatus(
    subjectId: number,
    status: string,
    options: { error?: string | null; clearError?: boolean } = {},
  ): void {
    run(
      `UPDATE subjects SET summary_zh_ai_status = :status,
         summary_zh_ai_error = CASE
           WHEN :clearError = 1 THEN NULL
           WHEN :error IS NULL THEN summary_zh_ai_error
           ELSE :error END
       WHERE id = :id`,
      {
        id: subjectId,
        status,
        error: options.error ?? null,
        clearError: options.clearError ? 1 : 0,
      },
    );
  }

  private loadSubject(subjectId: number): JobSubjectRow | null {
    return (
      one<JobSubjectRow>(
        'SELECT id, name, summary_original, summary_original_hash, summary_original_lang, summary_zh_official FROM subjects WHERE id = :id',
        { id: subjectId },
      ) ?? null
    );
  }

  private handleFailure(job: TranslationJobRow, error: unknown): void {
    if (!this.isCurrentJob(job)) return;
    const subjectId = Number(job.subject_id);
    const timestamp = new Date().toISOString();
    const attempts = Number(job.attempts) + 1;
    const config = this.options.getConfig();
    const aiError = error instanceof AiError ? error : null;
    const message = scrubSecrets(
      aiError ? `${aiError.message}${aiError.hint ? `｜${aiError.hint}` : ''}` : String((error as Error)?.message ?? error),
      [config.apiKey],
    );

    // AI 未配置 / 认证失败：不做无意义重试，等待用户处理
    if (aiError?.kind === 'disabled' || aiError?.kind === 'auth') {
      markJobFailed({
        jobId: Number(job.id),
        error: message,
        timestamp,
        terminal: false,
        waitingAi: true,
        nextAttemptAt: null,
      });
      this.setStatus(subjectId, TRANSLATION_STATUS.WaitingAi, { error: message });
      this.cooldownUntil = Date.now() + 60_000;
      this.log(`翻译暂停：${message}`);
      return;
    }

    if (aiError?.kind === 'rate_limit') {
      this.rateLimitStreak += 1;
      const base = this.options.rateLimitCooldownMs ?? 30_000;
      const cooldown = Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, base * this.rateLimitStreak);
      this.cooldownUntil = Date.now() + cooldown;
    }

    /*
     * 只有「模型输出异常」才在重试耗尽后进入 failed（需要人工介入）。
     * 网络 / 超时 / 服务端错误 / 限流都属于临时性问题，按退避一直自动恢复，
     * 不会把任务永久标记为失败——否则用户会在界面上看到一堆其实会自愈的失败。
     */
    const transient = aiError
      ? aiError.kind === 'network' ||
        aiError.kind === 'timeout' ||
        aiError.kind === 'server' ||
        aiError.kind === 'rate_limit'
      : false;
    const terminal = !transient && attempts >= this.maxAttempts;
    const nextAttemptAt = terminal ? null : new Date(Date.now() + this.backoff(attempts)).toISOString();
    markJobFailed({
      jobId: Number(job.id),
      error: message,
      timestamp,
      terminal,
      nextAttemptAt,
    });
    this.setStatus(subjectId, terminal ? TRANSLATION_STATUS.Failed : TRANSLATION_STATUS.Pending, {
      error: message,
    });
    this.log(
      terminal
        ? `简介翻译失败（已达到重试上限）：${message}`
        : `简介翻译失败，将自动重试：${message}`,
    );
  }

  /** 等待 AI 期间，来源同步或取消可能已改变任务；晚到响应不能复活旧状态。 */
  private isCurrentJob(job: TranslationJobRow): boolean {
    const current = getJob(Number(job.id));
    if (current?.status !== 'processing') return false;
    const subject = this.loadSubject(Number(job.subject_id));
    if (!subject || subject.summary_original_hash !== job.source_hash ||
        !subject.summary_original.trim() || subject.summary_zh_official.trim()) {
      markJobObsolete(Number(job.id), '来源已变化或已有官方中文，晚到结果未写入', new Date().toISOString());
      return false;
    }
    return true;
  }

  /** 指数退避 + 抖动，避免大量任务同时重试。 */
  private backoff(attempts: number): number {
    const base = this.options.backoffBaseMs ?? 2_000;
    const exponential = base * Math.pow(2, Math.max(0, attempts - 1));
    // 上限 30 分钟：临时性故障（网络中断等）可以一直自动恢复，但不会高频重试
    const capped = Math.min(exponential, 30 * 60_000);
    return Math.round(capped * (0.8 + Math.random() * 0.4));
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
