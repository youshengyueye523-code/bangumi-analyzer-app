/**
 * 简介翻译任务队列（本地持久化）。
 *
 * 设计要点：
 * 1. 队列存在数据库里，不依赖内存 → 进程被杀 / 电脑重启后仍能继续；
 * 2. 同一「作品 + 原文 hash」只有一行（唯一索引），重复同步不会重复消耗 token；
 * 3. 原文 hash 变化 → 旧任务不再是当前任务，新任务入队，旧的中文翻译保留（标记为过期）；
 * 4. 任务完成时做「hash 比对」再写入，避免把基于旧原文的翻译写进新版本。
 */

import { all, one, run, transaction } from './index.js';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'waiting_ai' | 'obsolete';

export interface TranslationJobRow {
  id: number;
  subject_id: number;
  source_hash: string;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  next_attempt_at: string | null;
}

export interface QueueCounts {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  waiting_ai: number;
  /** 原文已变化、仅作为历史记录保留的失效任务 */
  obsolete: number;
}

/**
 * 队列计数。
 *
 * 只统计「与作品当前 source_hash 一致」的任务：
 * 原文变化后的旧任务已经被标记为 obsolete（或保留 completed），
 * 不能再计入待翻译 / 翻译中 / 失败，否则界面会长期显示一堆永远处理不完的失败。
 */
export function countJobs(): QueueCounts {
  const rows = all<{ status: JobStatus; count: number }>(
    `SELECT j.status AS status, COUNT(*) AS count
       FROM translation_jobs j JOIN subjects s ON s.id = j.subject_id
      WHERE j.source_hash = s.summary_original_hash
      GROUP BY j.status`,
  );
  const counts: QueueCounts = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    waiting_ai: 0,
    obsolete: 0,
  };
  for (const row of rows) counts[row.status] = Number(row.count);
  const stale = one<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM translation_jobs j JOIN subjects s ON s.id = j.subject_id
      WHERE j.source_hash <> s.summary_original_hash`,
  );
  counts.obsolete = Number(stale?.count ?? 0);
  return counts;
}

/**
 * 启动时调用：上一次进程被杀时留在 processing 的任务必须回到 pending，
 * 否则会永久卡住（断点恢复的关键）。
 */
export function resetInFlightJobs(timestamp: string): number {
  const result = run(
    `UPDATE translation_jobs
       SET status = 'pending', started_at = NULL, updated_at = :ts, next_attempt_at = NULL
     WHERE status = 'processing'
       AND EXISTS (
         SELECT 1 FROM subjects s
          WHERE s.id = translation_jobs.subject_id
            AND s.summary_original_hash = translation_jobs.source_hash
       )`,
    { ts: timestamp },
  );
  return Number(result.changes ?? 0);
}

export interface EnqueueInput {
  subjectId: number;
  sourceHash: string;
  timestamp: string;
}

export interface EnqueueResult {
  created: boolean;
  jobId: number;
}

/**
 * 入队：同一作品 + 原文 hash 已存在时不做任何事（幂等）。
 * 原文变化会产生新的 hash → 新的一行；旧行若还没完成，会被标记为
 * 「已被更新的原文取代」，避免旧任务继续占用 AI 配额。
 */
export function enqueueTranslationJob(input: EnqueueInput): EnqueueResult {
  return transaction(() => {
    const existing = one<{ id: number; status: JobStatus }>(
      'SELECT id, status FROM translation_jobs WHERE subject_id = :subjectId AND source_hash = :hash',
      { subjectId: input.subjectId, hash: input.sourceHash },
    );
    if (existing) {
      /*
       * 同一原文 hash 已经有一行任务：
       *   - obsolete：之前因为「已有官方中文 / 语言变化」被作废，现在又需要翻译
       *     （例如 Bangumi 撤回了官方中文）→ 重新启用；
       *   - pending / processing / completed / failed / waiting_ai：保持原状态，
       *     避免因为一次扫描就把需要人工重试的失败任务重置。
       */
      if (existing.status === 'obsolete') {
        run(
          `UPDATE translation_jobs
             SET status = 'pending', attempts = 0, next_attempt_at = NULL,
                 last_error = NULL, updated_at = :ts
           WHERE id = :id`,
          { id: Number(existing.id), ts: input.timestamp },
        );
        return { created: true, jobId: Number(existing.id) };
      }
      return { created: false, jobId: Number(existing.id) };
    }

    // 旧版本（不同 hash）尚未完成的任务直接作废
    run(
      `UPDATE translation_jobs
         SET status = 'failed',
             last_error = '原文已更新，该任务被新的翻译任务取代',
             updated_at = :ts
       WHERE subject_id = :subjectId
         AND source_hash <> :hash
         AND status IN ('pending', 'processing', 'waiting_ai')`,
      { subjectId: input.subjectId, hash: input.sourceHash, ts: input.timestamp },
    );

    run(
      `INSERT INTO translation_jobs (subject_id, source_hash, status, created_at, updated_at)
       VALUES (:subjectId, :hash, 'pending', :ts, :ts)`,
      { subjectId: input.subjectId, hash: input.sourceHash, ts: input.timestamp },
    );
    const row = one<{ id: number }>(
      'SELECT id FROM translation_jobs WHERE subject_id = :subjectId AND source_hash = :hash',
      { subjectId: input.subjectId, hash: input.sourceHash },
    );
    return { created: true, jobId: Number(row?.id ?? 0) };
  });
}

/** 取下一批可执行任务（含退避到期与失败重试）。 */
export function nextPendingJobs(limit: number, timestamp: string): TranslationJobRow[] {
  return all<TranslationJobRow>(
    `SELECT * FROM translation_jobs
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= :ts)
        AND EXISTS (
          SELECT 1 FROM subjects s
           WHERE s.id = translation_jobs.subject_id
             AND s.summary_original_hash = translation_jobs.source_hash
        )
      ORDER BY (attempts > 0), next_attempt_at IS NOT NULL, id
      LIMIT :limit`,
    { ts: timestamp, limit },
  );
}

/**
 * 把「原文已经变化」的未完成任务标记为 obsolete。
 * 启动时与每次入队前都会调用，保证队列里只有当前有效任务。
 */
export function obsoleteStaleJobs(timestamp: string): number {
  const result = run(
    `UPDATE translation_jobs
       SET status = 'obsolete',
           last_error = COALESCE(last_error, '原文已更新，任务已失效'),
           updated_at = :ts
     WHERE status IN ('pending', 'processing', 'waiting_ai', 'failed')
       AND EXISTS (
         SELECT 1 FROM subjects s
          WHERE s.id = translation_jobs.subject_id
            AND s.summary_original_hash <> translation_jobs.source_hash
       )`,
    { ts: timestamp },
  );
  return Number(result.changes ?? 0);
}

/** 历史失效任务数量（仅用于展示，不参与队列统计）。 */
export function countObsoleteJobs(): number {
  return countJobs().obsolete;
}

/** 认领任务：只有仍是 pending 的那一行会被更新（避免重复认领）。 */
export function claimJob(jobId: number, timestamp: string): boolean {
  const result = run(
    `UPDATE translation_jobs
       SET status = 'processing', started_at = :ts, updated_at = :ts, next_attempt_at = NULL
     WHERE id = :id AND status = 'pending'`,
    { id: jobId, ts: timestamp },
  );
  return Number(result.changes ?? 0) > 0;
}

export function markJobCompleted(
  jobId: number,
  info: { provider: string; model: string; timestamp: string },
): void {
  run(
    `UPDATE translation_jobs
       SET status = 'completed', completed_at = :ts, updated_at = :ts,
           provider = :provider, model = :model, last_error = NULL
     WHERE id = :id`,
    { id: jobId, ts: info.timestamp, provider: info.provider, model: info.model },
  );
}

/** 任务作废（结果不再适用，例如翻译期间原文被更新）。 */
export function markJobSuperseded(jobId: number, reason: string, timestamp: string): void {
  run(
    `UPDATE translation_jobs
       SET status = 'failed', last_error = :reason, updated_at = :ts
     WHERE id = :id`,
    { id: jobId, reason, ts: timestamp },
  );
}

export interface FailInput {
  jobId: number;
  error: string;
  timestamp: string;
  /** 下一次可重试时间（ISO 字符串）；为空表示不再自动重试 */
  nextAttemptAt?: string | null;
  /** true 表示进入 failed 终态；false 表示回到 pending 等待重试 */
  terminal: boolean;
  /** AI 未配置 / 认证失败时进入 waiting_ai */
  waitingAi?: boolean;
}

export function markJobFailed(input: FailInput): void {
  const status: JobStatus = input.waitingAi ? 'waiting_ai' : input.terminal ? 'failed' : 'pending';
  run(
    `UPDATE translation_jobs
       SET status = :status,
           attempts = attempts + 1,
           last_error = :error,
           updated_at = :ts,
           next_attempt_at = :nextAttemptAt
     WHERE id = :id`,
    {
      id: input.jobId,
      status,
      error: input.error.slice(0, 500),
      ts: input.timestamp,
      nextAttemptAt: input.nextAttemptAt ?? null,
    },
  );
}

/** AI 配置补齐后，把 waiting_ai 的任务重新放回队列。 */
export function releaseWaitingAiJobs(timestamp: string): number {
  const result = run(
    `UPDATE translation_jobs
       SET status = 'pending', next_attempt_at = NULL, updated_at = :ts
     WHERE status = 'waiting_ai'`,
    { ts: timestamp },
  );
  return Number(result.changes ?? 0);
}

/** 手动重试：把失败/等待中的任务放回队列（不改变原文）。 */
export function requeueJob(jobId: number, timestamp: string): boolean {
  const result = run(
    `UPDATE translation_jobs
       SET status = 'pending', next_attempt_at = NULL, last_error = NULL, updated_at = :ts
     WHERE id = :id AND status IN ('failed', 'waiting_ai')`,
    { id: jobId, ts: timestamp },
  );
  return Number(result.changes ?? 0) > 0;
}

export function requeueAllFailed(timestamp: string): number {
  const result = run(
    `UPDATE translation_jobs
       SET status = 'pending', next_attempt_at = NULL, updated_at = :ts
     WHERE status IN ('failed', 'waiting_ai')`,
    { ts: timestamp },
  );
  return Number(result.changes ?? 0);
}

/** 取消：把未完成的任务标记为已取消（原文与已有译文都不动）。 */
export function cancelJob(jobId: number, timestamp: string): boolean {
  const result = run(
    `UPDATE translation_jobs
       SET status = 'failed', last_error = '已手动取消', updated_at = :ts, next_attempt_at = NULL
     WHERE id = :id AND status IN ('pending', 'processing', 'waiting_ai')`,
    { id: jobId, ts: timestamp },
  );
  return Number(result.changes ?? 0) > 0;
}

export function cancelAllPending(timestamp: string): number {
  const result = run(
    `UPDATE translation_jobs
       SET status = 'failed', last_error = '已手动取消', updated_at = :ts, next_attempt_at = NULL
     WHERE status IN ('pending', 'waiting_ai')`,
    { ts: timestamp },
  );
  return Number(result.changes ?? 0);
}

/** 指定作品的当前任务（最新一行）。 */
export function currentJobForSubject(subjectId: number): TranslationJobRow | null {
  return one<TranslationJobRow>(
    'SELECT * FROM translation_jobs WHERE subject_id = :id ORDER BY id DESC LIMIT 1',
    { id: subjectId },
  ) ?? null;
}

export function getJob(jobId: number): TranslationJobRow | null {
  return one<TranslationJobRow>('SELECT * FROM translation_jobs WHERE id = :id', { id: jobId }) ?? null;
}

/** 列表（用于「翻译队列」面板）。 */
export function listJobs(limit: number, status?: JobStatus): TranslationJobRow[] {
  if (status) {
    return all<TranslationJobRow>(
      'SELECT * FROM translation_jobs WHERE status = :status ORDER BY id DESC LIMIT :limit',
      { status, limit },
    );
  }
  return all<TranslationJobRow>('SELECT * FROM translation_jobs ORDER BY id DESC LIMIT :limit', {
    limit,
  });
}

export function hasPendingWork(): boolean {
  const row = one<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM translation_jobs j JOIN subjects s ON s.id = j.subject_id
      WHERE j.status IN ('pending', 'processing')
        AND j.source_hash = s.summary_original_hash`,
  );
  return Number(row?.count ?? 0) > 0;
}

/** 把单个任务标记为历史失效（原文变化 / 已有官方中文）。 */
export function markJobObsolete(jobId: number, reason: string, timestamp: string): void {
  run(
    `UPDATE translation_jobs
       SET status = 'obsolete', last_error = :reason, updated_at = :ts, next_attempt_at = NULL
     WHERE id = :id`,
    { id: jobId, reason, ts: timestamp },
  );
}
