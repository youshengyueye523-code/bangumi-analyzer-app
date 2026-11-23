import {
  ApiError,
  type SyncProgress,
  type SyncRequest,
  type SyncRunSummary,
  type SyncStatus,
} from '@bangumi-analyzer/shared';
import { BangumiApiError, type BangumiDataSource } from '../bangumi/client.js';
import type { AppConfig } from '../config.js';
import { setMeta, transaction } from '../db/index.js';
import { assertCollectionOwner, assertKnownCollectionOwner, bindCollectionOwner } from '../db/account.js';
import { recomputeSeries } from '../db/series.js';
import { recordMutation } from '../db/mutation.js';
import { markInterruptedRuns } from '../db/syncRuns.js';
import {
  createSyncRun,
  lastSuccessfulSyncAt,
  latestSyncRun,
  touchSyncRun,
  updateSyncRun,
} from '../db/syncRuns.js';
import {
  countCollections,
  detailQueue,
  pendingDetailQueue,
  personsQueue,
  relationsQueue,
} from '../db/subjects.js';
import { scrubSecrets } from '../logger.js';
import { isAbortError, nowIso } from '../util.js';
import { applyCollections, collectCollections } from './collections.js';
import { enrichDetails, enrichPersons, enrichRelations } from './enrich.js';
import { ProgressTracker } from './progress.js';
import { SYNC_FAILURE_EXPLANATIONS } from './failureExplanation.js';

export interface SyncEngineOptions {
  client: BangumiDataSource;
  getConfig: () => AppConfig;
  saveUsername?: (username: string) => void;
  onChange?: (progress: SyncProgress) => void;
  /** 各阶段的单次抓取上限（默认不限；测试与快速体验时可限制） */
  limits?: { details?: number; relations?: number; persons?: number };
}

/** 失败条目的最大重试次数（每次同步算一次尝试）。 */
const MAX_DETAIL_ATTEMPTS = 3;
const RELATION_STALE_DAYS = 30;

export class SyncEngine {
  private readonly client: BangumiDataSource;
  private readonly limits: { details?: number; relations?: number; persons?: number };
  private readonly getConfig: () => AppConfig;
  private controller: AbortController | null = null;
  private tracker: ProgressTracker | null = null;
  private progress: SyncProgress | null = null;
  private runId: number | null = null;
  private lastHeartbeatAt = 0;
  private idlePromise: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;
  private startsPaused = false;

  get accountChangeInProgress(): boolean { return this.startsPaused; }

  /** Block new runs while the caller cancels/drains an account transition. */
  pauseStarts(): () => void {
    if (this.startsPaused) throw new ApiError('正在断开 Bangumi 账号，请稍候', { code: 'account_disconnect_in_progress', status: 409 });
    this.startsPaused = true;
    return () => { this.startsPaused = false; };
  }

  constructor(private readonly options: SyncEngineOptions) {
    this.client = options.client;
    this.getConfig = options.getConfig;
    this.limits = options.limits ?? {};
  }

  /** 启动时调用：把上次异常退出遗留的 running 记录标记为中断。 */
  static recoverInterruptedRuns(): number {
    return markInterruptedRuns();
  }

  get running(): boolean {
    return this.controller !== null;
  }

  getStatus(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      lastRun: latestSyncRun(),
      lastSuccessfulSyncAt: lastSuccessfulSyncAt(),
    };
  }

  /** 等待当前（或最近一次）同步结束，供测试与脚本使用。 */
  async whenIdle(): Promise<void> {
    await this.idlePromise;
  }

  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    this.tracker?.setMessage('正在取消同步…');
    return true;
  }

  start(request: SyncRequest): SyncRunSummary {
    if (this.startsPaused) throw new ApiError('正在断开 Bangumi 账号，不能启动同步', { code: 'account_disconnect_in_progress', status: 409 });
    if (this.running) {
      throw new ApiError('已有同步任务正在运行', {
        code: 'sync_in_progress',
        status: 409,
        hint: '请等待当前同步结束，或先点击「取消同步」。',
      });
    }
    const config = this.getConfig();
    if (!config.username.trim()) {
      throw new ApiError('尚未配置 Bangumi 用户名', {
        code: 'missing_username',
        status: 400,
        hint: '请在「设置」页面填写你的 Bangumi 用户名（个人主页地址中的那一段，也可以直接填数字 UID）。',
      });
    }

    const depth = request.depth ?? 1;
    const mode = request.mode;
    const runId = createSyncRun(mode, depth);
    this.runId = runId;
    this.controller = new AbortController();
    this.tracker = new ProgressTracker(runId, mode, depth, (progress) => {
      this.handleProgress(progress);
    });
    this.progress = this.tracker.snapshot();
    this.idlePromise = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });

    void this.execute(runId, { ...request, depth, mode }, this.controller.signal);
    return latestSyncRun() ?? {
      id: runId,
      mode,
      depth,
      status: 'running',
      phase: 'preparing',
      startedAt: nowIso(),
      finishedAt: null,
      durationMs: null,
      counters: this.tracker.counters,
      error: null,
      warnings: [],
    };
  }

  private handleProgress(progress: SyncProgress): void {
    progress.counters.requests = this.client.stats.requests;
    progress.counters.retries = this.client.stats.retries;
    // tracker 自身持有计数对象，最终写入同步记录的就是它，因此需要同步更新
    if (this.tracker) {
      this.tracker.counters.requests = progress.counters.requests;
      this.tracker.counters.retries = progress.counters.retries;
    }
    this.progress = progress;
    // 心跳最多每 5 秒写一次，避免同步过程中产生过多数据库写入
    if (Date.now() - this.lastHeartbeatAt > 5000) {
      this.lastHeartbeatAt = Date.now();
      touchSyncRun(progress.runId);
    }
    this.options.onChange?.(progress);
  }

  private async execute(
    runId: number,
    request: Required<Pick<SyncRequest, 'mode' | 'depth'>> & SyncRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const tracker = this.tracker;
    if (!tracker) return;
    const startedAt = Date.now();
    const config = this.getConfig();
    const depth = request.depth ?? 1;
    /** 收藏是否已经写入：异常 / 取消时用于决定是否需要补偿派生投影（v1.8 OD2）。 */
    let collectionsApplied = false;

    this.client.updateOptions({
      token: config.token,
      userAgent: config.userAgent,
      requestIntervalMs: config.requestIntervalMs,
      httpProxy: config.httpProxy,
    });

    try {
      /* ---------------------------------------------------------- 准备阶段 */
      tracker.setPhase('preparing', '正在校验配置与凭据');
      let username = config.username.trim();
      assertKnownCollectionOwner();
      const target = await this.client.getUser(username, { signal });
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      assertCollectionOwner(target);
      let authenticatedTarget = false;
      if (config.token) {
        const me = await this.client.getMe({ signal });
        if (signal.aborted) throw new DOMException('已取消', 'AbortError');
        if (!username) {
          username = me.username;
          this.options.saveUsername?.(username);
        }
        authenticatedTarget = target.id === me.id;
        if (!authenticatedTarget) {
          tracker.addWarning('Token 所属账号与同步目标不同：目标账号的私有收藏不可据此确认删除，按公开范围保护。');
        }
      } else {
        tracker.addWarning(
          '未配置 Access Token：只能读取公开收藏，私有收藏和评分等私有信息不会被同步。',
        );
      }

      if (request.mode !== 'enrich') {
        /* ------------------------------------------------------ 收藏列表 */
        tracker.setPhase('collections', '正在获取收藏列表');
        const collected = await collectCollections(this.client, runId, {
          username,
          subjectTypes: config.subjectTypes,
          signal,
          progress: tracker,
        });
        tracker.counters.fetched = collected.staged;

        tracker.setPhase('applying', '正在写入本地数据库');
        if (signal.aborted) throw new DOMException('已取消', 'AbortError');
        const applied = transaction(() => {
          // 空库可以选择账号；非空库只能使用首次绑定的身份。
          bindCollectionOwner(target);
          setMeta('sync_projection_pending', '1');
          return applyCollections(runId, {
            allowDeletions: collected.complete,
            authenticated: authenticatedTarget,
            progress: tracker,
            subjectTypes: config.subjectTypes,
          });
        });
        // Commit has happened before any progress callback can fail or cancel.
        collectionsApplied = true;
        tracker.counters.added = applied.added;
        tracker.counters.updated = applied.updated;
        tracker.counters.removed = applied.removed;
        tracker.counters.unchanged = applied.unchanged;
        if (applied.skippedDeletions) {
          tracker.addWarning('检测到大量收藏消失，已跳过删除操作以保护本地数据。');
        }
        tracker.setMessage(
          `收藏同步完成：新增 ${applied.added}、更新 ${applied.updated}、` +
            `未变化 ${applied.unchanged}、移除 ${applied.removed}` +
            (applied.protectedOutOfScope > 0
              ? `、范围外保护 ${applied.protectedOutOfScope}（类型 ${applied.protectedTypes.join(' / ')}）`
              : ''),
        );
      }

      /* ------------------------------------------------------ 详情补充 */
      const forceDetail = request.forceDetail || request.mode === 'full';
      const detailIds = forceDetail
        ? pendingDetailQueue(this.limits.details)
        : detailQueue({
            refreshDays: config.detailRefreshDays,
            maxAttempts: MAX_DETAIL_ATTEMPTS,
            ...(this.limits.details ? { limit: this.limits.details } : {}),
          });

      // 关系/人员队列依赖详情阶段的结果（只有详情同步成功的条目才会进入后续队列），
      // 因此这里先用收藏总数估算权重，真实队列在详情阶段结束后再计算。
      const estimatedRelations = depth >= 2 ? countCollections() : 0;
      tracker.setPlan([
        { phase: 'preparing', weight: 2 },
        { phase: 'collections', weight: 6 },
        { phase: 'applying', weight: 2 },
        { phase: 'enriching', weight: Math.max(0, detailIds.length) * 1.0 },
        { phase: 'relations', weight: estimatedRelations * 0.7 },
        { phase: 'persons', weight: estimatedRelations * 0.7 },
        { phase: 'series', weight: 3 },
      ]);

      if (detailIds.length > 0) {
        tracker.setPhase('enriching', `正在补充 ${detailIds.length} 个条目的详情`, detailIds.length);
        const outcome = await enrichDetails(detailIds, { client: this.client, signal, progress: tracker });
        if (outcome.cancelled) throw new DOMException('已取消', 'AbortError');
        if (outcome.fatal) throw outcome.fatal;
        if (outcome.failed > 0) {
          tracker.addWarning(
            `${outcome.failed} 个条目的详情未能同步，稍后会再次尝试；这些条目的基础数据仍然可用。`,
          );
        }
      }

      const relationIds =
        depth >= 2
          ? relationsQueue({
              staleDays: RELATION_STALE_DAYS,
              maxAttempts: MAX_DETAIL_ATTEMPTS,
            }).slice(0, this.limits.relations ?? Infinity)
          : [];
      const personIds =
        depth >= 2
          ? personsQueue({
              staleDays: RELATION_STALE_DAYS,
              maxAttempts: MAX_DETAIL_ATTEMPTS,
            }).slice(0, this.limits.persons ?? Infinity)
          : [];

      if (relationIds.length > 0) {
        tracker.setPhase('relations', `正在抓取 ${relationIds.length} 个条目的系列关系`, relationIds.length);
        const outcome = await enrichRelations(relationIds, {
          client: this.client,
          signal,
          progress: tracker,
        });
        if (outcome.cancelled) throw new DOMException('已取消', 'AbortError');
        if (outcome.fatal) throw outcome.fatal;
      }

      if (personIds.length > 0) {
        tracker.setPhase('persons', `正在抓取 ${personIds.length} 个条目的制作人员`, personIds.length);
        const outcome = await enrichPersons(personIds, {
          client: this.client,
          signal,
          progress: tracker,
        });
        if (outcome.cancelled) throw new DOMException('已取消', 'AbortError');
        if (outcome.fatal) throw outcome.fatal;
      }

      /* -------------------------------------------------------- 收尾阶段 */
      tracker.setPhase('series', '正在计算系列 / IP 分组');
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      const mutation = transaction(() => {
        recomputeSeries();
        const result = recordMutation('sync', `sync run #${runId}`);
        setMeta('sync_projection_pending', '0');
        return result;
      });

      tracker.setPhase('finalizing', '正在保存同步结果');
      const version = mutation.dataVersion;
      setMeta('last_sync_at', nowIso());
      setMeta('last_sync_version', String(version));

      const counters = { ...tracker.counters };
      updateSyncRun(runId, {
        status: 'success',
        phase: 'done',
        finishedAt: nowIso(),
        durationMs: Date.now() - startedAt,
        counters,
        warnings: tracker.warnings,
        issues: tracker.issues,
        error: null,
      });
      tracker.setPhase('done', '同步完成');
    } catch (error) {
      const cancelled = isAbortError(error) || signal.aborted;
      const message = this.describeError(error);
      /*
       * v1.8 OD2：收藏（含评分）已经写入时，取消 / 失败也不能留下
       * 「collections 已更新、Series / Franchise 派生投影与 dataVersion 停在旧状态」。
       * 正常完成路径在 run 结尾重建；这里只补偿异常路径。
       * 进程被强杀的场景由启动恢复 + Data Center drift 检测兜底。
       */
      let failureExplanation: string = SYNC_FAILURE_EXPLANATIONS.beforeApply;
      if (collectionsApplied || tracker.counters.detailsFetched > 0 || tracker.counters.relationsFetched > 0 || tracker.counters.personsFetched > 0) {
        try {
          transaction(() => {
            recomputeSeries();
            recordMutation(
              'sync',
              `sync run #${runId} · source applied (${cancelled ? 'cancelled' : 'error'})`,
            );
            setMeta('sync_projection_pending', '0');
          });
          failureExplanation = SYNC_FAILURE_EXPLANATIONS.afterApplyRestored;
        } catch {
          failureExplanation = SYNC_FAILURE_EXPLANATIONS.afterApplyPending;
          tracker.addWarning('收藏已写入，但派生投影重建未完成；可在数据中枢执行「重建派生数据」。');
        }
      }
      // Preserve the terminal local outcome even when the 20 warning samples are full.
      tracker.warnings.push(failureExplanation);
      if (!cancelled) {
        tracker.addIssue(message);
        if (error instanceof BangumiApiError && error.hint) tracker.addWarning(error.hint);
        if (error instanceof ApiError && error.hint) tracker.addWarning(error.hint);
      }
      const counters = { ...tracker.counters };
      updateSyncRun(runId, {
        status: cancelled ? 'cancelled' : 'error',
        phase: cancelled ? 'cancelled' : 'error',
        finishedAt: nowIso(),
        durationMs: Date.now() - startedAt,
        counters,
        warnings: tracker.warnings,
        issues: tracker.issues,
        error: cancelled ? '同步已取消' : message,
      });
      tracker.setPhase(cancelled ? 'cancelled' : 'error', cancelled ? '同步已取消' : message);
    } finally {
      tracker.emit(true);
      this.controller = null;
      this.resolveIdle?.();
      this.resolveIdle = null;
    }
  }

  private describeError(error: unknown): string {
    const secrets = [this.getConfig().token];
    if (error instanceof BangumiApiError || error instanceof ApiError) {
      const hint = 'hint' in error && error.hint ? `（${error.hint}）` : '';
      return scrubSecrets(`${error.message}${hint}`, secrets);
    }
    if (error instanceof Error) return scrubSecrets(error.message, secrets);
    return scrubSecrets(String(error), secrets);
  }
}
