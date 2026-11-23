/**
 * 简介翻译的 HTTP 接口。
 *
 * 全部操作都只影响「翻译」相关字段：
 *   - Bangumi 一手原文（subjects.summary）永远只读；
 *   - 「重新翻译」只重新生成中文，不会动原文，也不会动官方中文简介。
 */

import {
  ApiError,
  summaryQueueActionSchema,
  TRANSLATION_STATUS,
  type SubjectSummaryState,
  type TranslationQueueStatus,
} from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { aiAvailability, type AppConfig } from '../../config.js';
import { one, run } from '../../db/index.js';
import {
  getSummaryRecord,
  refreshSummaryQueue,
  requeueSubjectTranslation,
  requeueWhenAiConfigured,
  summaryTotals,
} from '../../db/summaries.js';
import {
  cancelAllPending,
  cancelJob,
  currentJobForSubject,
  listJobs,
  requeueAllFailed,
} from '../../db/translationJobs.js';
import { personalHidesActive } from '../../db/visibility.js';
import { isSubjectHidden } from '../../db/query.js';
import { nowIso } from '../../util.js';
import type { TranslationWorker } from '../../translate/worker.js';

export interface TranslateRouteDeps {
  worker: TranslationWorker;
  getConfig: () => AppConfig;
}

/** v1.5.3：被隐私设置隐藏的条目不得通过简介接口泄露原文 / 译文。 */
function assertSubjectVisible(subjectId: number): void {
  if (!isSubjectHidden(subjectId)) return;
  throw new ApiError('内容已被当前隐私设置隐藏', {
    code: 'subject_hidden',
    status: 404,
    hint: '可在「设置 → 外观 → 隐藏 NSFW 内容」中关闭该设置以恢复显示。',
    dataIntact: true,
  });
}

function summaryStateOf(subjectId: number): SubjectSummaryState | null {
  const record = getSummaryRecord(subjectId);
  if (!record) return null;
  const job = currentJobForSubject(subjectId);
  return {
    subjectId,
    chinese: record.chinese,
    chineseSource: record.chineseSource,
    bilingual: record.bilingual,
    original: record.original,
    originalLanguage: record.language,
    translatable: record.translatable,
    unsupportedReason: record.unsupportedReason,
    status: record.status,
    stale: record.stale,
    translationModel: record.translationModel,
    translationProvider: record.translationProvider,
    translationUpdatedAt: record.translationUpdatedAt,
    translationError: record.translationError,
    queued: job ? job.status === 'pending' || job.status === 'processing' : false,
    jobId: job ? Number(job.id) : null,
    attempts: job ? Number(job.attempts) : 0,
  };
}

export function registerTranslateRoutes(app: FastifyInstance, deps: TranslateRouteDeps): void {
  /** 队列总览：状态计数 + AI 可用性 + 统计。 */
  app.get('/api/translate/summary', async (): Promise<TranslationQueueStatus> => {
    const config = deps.getConfig();
    const availability = aiAvailability(config.ai);
    const counts = deps.worker.counts();
    const lastErrorRow = one<{ last_error: string | null }>(
      `SELECT last_error FROM translation_jobs
        WHERE last_error IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`,
    );
    return {
      counts,
      running: deps.worker.isRunning || deps.worker.activeJobs > 0,
      autoTranslate: config.summaryAutoTranslate,
      concurrency: config.summaryConcurrency,
      aiConfigured: availability.configured,
      aiReason: availability.reason,
      totals: summaryTotals(),
      lastError: personalHidesActive() ? null : lastErrorRow?.last_error ?? null,
    };
  });

  /** 队列明细（默认最近 100 条）。 */
  app.get('/api/translate/jobs', async (request) => {
    const query = request.query as { limit?: string; status?: string };
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100) || 100));
    const status = query.status as
      | 'pending'
      | 'processing'
      | 'completed'
      | 'failed'
      | 'waiting_ai'
      | undefined;
    const jobs = listJobs(limit, status);
    return { jobs: personalHidesActive() ? jobs.filter(job=>!isSubjectHidden(job.subject_id)).map(job=>({...job,last_error:null})) : jobs };
  });

  /**
   * 批量操作：
   *  - backfill：扫描收藏库，把「有日文原文但没有有效中文翻译」的作品补进队列
   *  - retry-all：把失败 / 待配置的任务重新排队
   *  - cancel-all：取消所有未完成的任务（已完成的翻译不受影响）
   *  - wake：立即唤醒后台 worker（例如刚在设置里配好 AI）
   */
  app.post('/api/translate/queue', async (request) => {
    const { action } = summaryQueueActionSchema.parse(request.body ?? {});
    const timestamp = nowIso();
    if (action === 'backfill') {
      const scan = refreshSummaryQueue(timestamp);
      deps.worker.wakeUp();
      return { action, scan };
    }
    if (action === 'retry-all') {
      const released = requeueWhenAiConfigured(timestamp) + requeueAllFailed(timestamp);
      deps.worker.wakeUp();
      return { action, requeued: released };
    }
    if (action === 'cancel-all') {
      const cancelled = cancelAllPending(timestamp);
      return { action, cancelled };
    }
    deps.worker.wakeUp();
    return { action, woke: true };
  });

  /** 单条作品的简介状态。 */
  app.get('/api/translate/subjects/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError('条目 ID 不合法', { code: 'invalid_subject_id', status: 400 });
    }
    assertSubjectVisible(id);
    const state = summaryStateOf(id);
    if (!state) {
      throw new ApiError('条目不存在', {
        code: 'subject_not_found',
        status: 404,
        dataIntact: true,
      });
    }
    return { state };
  });

  /** 立即翻译 / 重新翻译：只重新生成中文，原文与官方中文简介都不动。 */
  app.post('/api/translate/subjects/:id', async (request) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError('条目 ID 不合法', { code: 'invalid_subject_id', status: 400 });
    }
    assertSubjectVisible(id);
    const record = getSummaryRecord(id);
    if (!record) {
      throw new ApiError('条目不存在', { code: 'subject_not_found', status: 404, dataIntact: true });
    }
    if (!record.translatable) {
      // 没有简介 / 官方中文 / 语言无法识别：都不应该进入 AI 翻译
      if (record.officialChinese.trim()) {
        throw new ApiError('该条目已有 Bangumi 官方中文简介，无需 AI 翻译', {
          code: 'translation_unsupported',
          status: 400,
          hint: '官方中文简介会直接展示，不会被 AI 结果覆盖。',
          dataIntact: true,
        });
      }
      if (!record.original.trim()) {
        throw new ApiError('该条目没有简介，无法翻译', {
          code: 'summary_missing',
          status: 400,
          hint: 'Bangumi 没有提供简介时不会调用 AI。',
          dataIntact: true,
        });
      }
      throw new ApiError(record.unsupportedReason || '该简介不需要自动翻译', {
        code: 'translation_unsupported',
        status: 400,
        hint: '原文语言无法可靠识别，已保留原文且未调用 AI。',
        dataIntact: true,
      });
    }
    const queued = requeueSubjectTranslation(id, nowIso());
    if (queued) deps.worker.wakeUp();
    return { queued, state: summaryStateOf(id) };
  });

  /** 取消某条作品的未完成任务（不影响已有翻译与原文）。 */
  app.delete('/api/translate/subjects/:id', async (request) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError('条目 ID 不合法', { code: 'invalid_subject_id', status: 400 });
    }
    assertSubjectVisible(id);
    const job = currentJobForSubject(id);
    const cancelled = job ? cancelJob(Number(job.id), nowIso()) : false;
    if (cancelled) {
      run(
        `UPDATE subjects SET summary_zh_ai_status = CASE WHEN summary_zh_ai = '' THEN 'idle' ELSE 'completed' END
           WHERE id = :id`,
        { id },
      );
    }
    return { cancelled, state: summaryStateOf(id) };
  });
}
