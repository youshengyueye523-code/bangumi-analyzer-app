import type { EntityTitleCandidate } from '@bangumi-analyzer/shared';
import { parseJsonColumn } from '../util.js';

function isTitleCandidate(value: unknown): value is EntityTitleCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.title === 'string' && typeof candidate.source === 'string' &&
    typeof candidate.evidence === 'string' &&
    typeof candidate.state === 'string' &&
    ['resolved', 'provisional', 'unresolved', 'contested', 'manual'].includes(candidate.state) &&
    (candidate.valid === undefined || typeof candidate.valid === 'boolean');
}

/** 只读投影保留合法条目，不改写异常历史证据。 */
export function projectTitleCandidates(raw: unknown): EntityTitleCandidate[] {
  const candidates = parseJsonColumn<unknown>(raw, null);
  return Array.isArray(candidates) ? candidates.filter(isTitleCandidate) : [];
}

/** 治理必须保留完整证据；结构异常时拒绝写入，不能用过滤后的投影覆盖源列。 */
export function titleCandidatesForMutation(raw: unknown): EntityTitleCandidate[] | null {
  const candidates = parseJsonColumn<unknown>(raw, null);
  return Array.isArray(candidates) && candidates.every(isTitleCandidate) ? candidates : null;
}
