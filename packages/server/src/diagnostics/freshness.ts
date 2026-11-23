import type { DiagnosticsFreshness } from '@bangumi-analyzer/shared';
import { getDatabase } from '../db/index.js';

export const OBSERVATION_MAX_AGE_MS = 60_000;
export const OBSERVATION_BOUNDARY = '仅为生成时的本地观察；磁盘文件及远端事实未被持续监控，期限内也不保证文件仍存在。缓存年龄或本地写入变化要求重新观察，不等于数据损坏。';
export function observationRevision(): string {
  const db = getDatabase();
  return `${String(db.prepare('PRAGMA data_version').get()!.data_version)}:${String(db.prepare('SELECT total_changes() AS n').get()!.n)}`;
}
export function reportFreshness(observed: number, revision: string): DiagnosticsFreshness {
  const now = Date.now();
  const changed = observationRevision() !== revision;
  const reason = now < observed ? 'clock' : changed ? 'local-change' : now >= observed + OBSERVATION_MAX_AGE_MS ? 'age' : null;
  return {status:reason ? 'expired' : 'snapshot', observedAt:new Date(observed).toISOString(),
    validUntil:new Date(observed+OBSERVATION_MAX_AGE_MS).toISOString(),reason,boundary:OBSERVATION_BOUNDARY};
}
