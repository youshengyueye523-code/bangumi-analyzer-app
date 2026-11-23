import type { SyncCounters, SyncPhase, SyncRunSummary, SyncMode } from '@bangumi-analyzer/shared';
import { emptyCounters } from '../sync/progress.js';
import { nowIso, parseJsonColumn, toJson } from '../util.js';
import { all, one, run } from './index.js';

interface SyncRunRow {
  id: number;
  mode: string;
  depth: number;
  status: string;
  phase: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  counters: string;
  warnings: string;
  issues: string;
  error: string | null;
}

function mapRun(row: SyncRunRow): SyncRunSummary {
  return {
    id: Number(row.id),
    mode: row.mode as SyncMode,
    depth: Number(row.depth),
    status: row.status as SyncRunSummary['status'],
    phase: row.phase as SyncPhase,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    counters: { ...emptyCounters(), ...parseJsonColumn<Partial<SyncCounters>>(row.counters, {}) },
    error: row.error,
    warnings: parseJsonColumn<string[]>(row.warnings, []),
  };
}

export function createSyncRun(mode: SyncMode, depth: number): number {
  const result = run(
    `INSERT INTO sync_runs (mode, depth, status, phase, started_at, counters)
     VALUES (:mode, :depth, 'running', 'preparing', :startedAt, :counters)`,
    { mode, depth, startedAt: nowIso(), counters: toJson(emptyCounters()) },
  );
  return result.lastInsertRowid;
}

export function updateSyncRun(
  id: number,
  patch: {
    status?: SyncRunSummary['status'];
    phase?: SyncPhase;
    finishedAt?: string | null;
    durationMs?: number | null;
    counters?: SyncCounters;
    warnings?: string[];
    issues?: string[];
    error?: string | null;
  },
): void {
  const current = one<SyncRunRow>('SELECT * FROM sync_runs WHERE id = :id', { id });
  if (!current) return;
  run(
    `UPDATE sync_runs SET
       status = :status, phase = :phase, finished_at = :finishedAt, duration_ms = :durationMs,
       counters = :counters, warnings = :warnings, issues = :issues, error = :error,
       heartbeat_at = :heartbeatAt
     WHERE id = :id`,
    {
      id,
      heartbeatAt: nowIso(),
      status: patch.status ?? current.status,
      phase: patch.phase ?? current.phase,
      finishedAt: patch.finishedAt === undefined ? current.finished_at : patch.finishedAt,
      durationMs: patch.durationMs === undefined ? current.duration_ms : patch.durationMs,
      counters: toJson(patch.counters ?? parseJsonColumn<SyncCounters>(current.counters, emptyCounters())),
      warnings: toJson(patch.warnings ?? parseJsonColumn<string[]>(current.warnings, [])),
      issues: toJson(patch.issues ?? parseJsonColumn<string[]>(current.issues, [])),
      error: patch.error === undefined ? current.error : patch.error,
    },
  );
}

/** 同步进行中的心跳：让其他进程知道这次同步仍然活着。 */
export function touchSyncRun(id: number): void {
  run('UPDATE sync_runs SET heartbeat_at = :now WHERE id = :id', { id, now: nowIso() });
}

export function getSyncRun(id: number): SyncRunSummary | null {
  const row = one<SyncRunRow>('SELECT * FROM sync_runs WHERE id = :id', { id });
  return row ? mapRun(row) : null;
}

export function latestSyncRun(): SyncRunSummary | null {
  const row = one<SyncRunRow>('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
  return row ? mapRun(row) : null;
}

export function listSyncRuns(limit = 20): SyncRunSummary[] {
  return all<SyncRunRow>('SELECT * FROM sync_runs ORDER BY id DESC LIMIT :limit', {
    limit: Math.max(1, Math.min(200, limit)),
  }).map(mapRun);
}

export function lastSuccessfulSyncAt(): string | null {
  const row = one<{ finished_at: string | null }>(
    `SELECT finished_at FROM sync_runs
     WHERE status = 'success' AND finished_at IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  );
  return row?.finished_at ?? null;
}

/**
 * 启动时把上次异常退出遗留的 running 记录标记为 interrupted。
 * 这样可以明确告诉用户「上次同步被中断，数据已保留，可重新同步」。
 */
export function markInterruptedRuns(): number {
  // 只处理心跳过期（默认 2 分钟）的 running 记录：
  // 用户同时开着网页端与命令行同步时，不会互相误判。
  const cutoff = new Date(Date.now() - 120_000).toISOString();
  const result = run(
    `UPDATE sync_runs
     SET status = 'interrupted',
         phase = 'interrupted',
         finished_at = :now,
         error = COALESCE(error, '程序在同步过程中退出，本次同步未完成（已同步的数据保持可用）')
     WHERE status = 'running'
       AND COALESCE(heartbeat_at, started_at) < :cutoff`,
    { now: nowIso(), cutoff },
  );
  return result.changes;
}

export function cleanupStaging(): void {
  run('DELETE FROM sync_stage WHERE run_id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 3)');
}
