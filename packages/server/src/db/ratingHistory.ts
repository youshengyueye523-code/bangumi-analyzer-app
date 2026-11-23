import { parseCollectionItem, type PersonalRatingHistory } from '@bangumi-analyzer/shared';
import { one, run } from './index.js';

/** Invoked before overwriting an actual non-wish → wish row, inside the apply transaction. */
export function recordRatingBeforeWish(subjectId: number, runId: number): void {
  const prior = one<{ raw: string | null; synced_at: string; type: number; subject_type: number; rate: number }>(
    'SELECT raw,synced_at,type,subject_type,rate FROM collections WHERE subject_id=?',
    [subjectId],
  );
  if (!prior?.raw || !Number.isFinite(Date.parse(prior.synced_at))) return;
  let payload: unknown;
  try { payload = JSON.parse(prior.raw); } catch { return; }
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'rate')) return;
  const source = parseCollectionItem(payload).value;
  if (!source || source.subject_id !== subjectId || source.subject_type !== prior.subject_type ||
      source.type === 1 || source.type !== prior.type || source.rate === 0 || source.rate !== prior.rate) return;
  // A noncanonical or unknown owner cannot acquire history by inference. The sync engine
  // binds the known collection owner before apply, in this same transaction.
  run(`INSERT INTO collection_rating_history (owner_uid,subject_id,prior_status,rate,observed_at,transition_run_id)
       SELECT CAST(value AS INTEGER), :subjectId, :status, :rate, :observedAt, :runId
       FROM meta WHERE key='collection_owner_uid'
         AND value=CAST(CAST(value AS INTEGER) AS TEXT)
         AND CAST(value AS INTEGER) BETWEEN 1 AND 9007199254740991
       ON CONFLICT (owner_uid,subject_id) DO UPDATE SET prior_status=excluded.prior_status,
         rate=excluded.rate,observed_at=excluded.observed_at,transition_run_id=excluded.transition_run_id`,
    {subjectId,status:prior.type,rate:prior.rate,observedAt:prior.synced_at,runId});
}

export function personalRatingHistory(subjectId: number): PersonalRatingHistory | null {
  return one<PersonalRatingHistory>(
    `SELECT rate, prior_status AS previousCollectionType, observed_at AS observedAt
       FROM collection_rating_history h JOIN meta m ON m.key='collection_owner_uid'
       AND CAST(h.owner_uid AS TEXT)=m.value WHERE h.subject_id=?`,
    [subjectId],
  ) ?? null;
}
