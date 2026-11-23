/**
 * 候选治理存储（v1.6.1）。
 *
 * 设计要点：
 * - 决定（rejected / superseded）是真实的治理状态，写入 candidate_decisions 表；
 * - 被否决的候选不会被删除：实体里的候选列表继续保留它，并带上 rejected 标记用于解释；
 * - 决定会携带「作出决定时的证据快照」：未来同样的候选带着更强证据回来时，
 *   可以把旧否决标记为 superseded，让新证据重新形成 candidate；
 * - 每次决定同时写入 entity_events，保证治理历史可追溯。
 */
import { all, one, run } from './index.js';
import { nowIso } from '../util.js';

export type CandidateEntityKind = 'series' | 'franchise';
export type CandidateKind = 'title' | 'franchise';
export type CandidateDecision = 'rejected' | 'superseded';

export interface CandidateDecisionRow {
  id: number;
  entity_kind: CandidateEntityKind;
  entity_id: number;
  candidate_kind: CandidateKind;
  candidate_key: string;
  candidate_title: string;
  decision: CandidateDecision;
  reason: string;
  evidence: string;
  created_at: string;
  updated_at: string;
}

/** 候选身份归一化：忽略空白与常见标点差异，避免同一事实因写法不同绕过否决。 */
export function candidateKeyOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!！?？。.,，、:：;；“”"'’‘()（）\[\]【】「」『』~～—–\-·・_]/g, '');
}

export function recordCandidateDecision(input: {
  entityKind: CandidateEntityKind;
  entityId: number;
  candidateKind: CandidateKind;
  candidateTitle: string;
  decision: CandidateDecision;
  reason?: string;
  evidence?: unknown;
  timestamp?: string;
}): void {
  const timestamp = input.timestamp ?? nowIso();
  const key = candidateKeyOf(input.candidateTitle);
  /*
   * 重复的同向否决不覆盖 provenance（v1.7.0 Freeze Check）。
   *
   * 第一次「用户否决该候选」才是承载真实理由与证据快照的决定；之后再次写入
   * rejected（例如 E2E / 基线恢复流程为了恢复治理状态而重新调用 /reject）
   * 只应确认状态，不得改写 reason / evidence / 时间。决策本身发生变化时
   * （rejected → superseded 或 superseded → rejected）仍然写入新的 provenance。
   */
  if (input.decision === 'rejected') {
    const existing = one<{ decision: string }>(
      `SELECT decision FROM candidate_decisions
        WHERE entity_kind = :entityKind AND entity_id = :entityId
          AND candidate_kind = :candidateKind AND candidate_key = :key`,
      { entityKind: input.entityKind, entityId: input.entityId, candidateKind: input.candidateKind, key },
    );
    if (existing?.decision === 'rejected') return;
  }
  run(
    `INSERT INTO candidate_decisions
       (entity_kind, entity_id, candidate_kind, candidate_key, candidate_title, decision, reason, evidence, created_at, updated_at)
     VALUES (:entityKind, :entityId, :candidateKind, :candidateKey, :candidateTitle, :decision, :reason, :evidence, :ts, :ts)
     ON CONFLICT(entity_kind, entity_id, candidate_kind, candidate_key) DO UPDATE SET
       candidate_title = excluded.candidate_title,
       decision = excluded.decision,
       reason = excluded.reason,
       evidence = excluded.evidence,
       updated_at = excluded.updated_at`,
    {
      entityKind: input.entityKind,
      entityId: input.entityId,
      candidateKind: input.candidateKind,
      candidateKey: key,
      candidateTitle: input.candidateTitle,
      decision: input.decision,
      reason: input.reason ?? '',
      evidence: JSON.stringify(input.evidence ?? {}),
      ts: timestamp,
    },
  );
}

export function activeRejections(
  entityKind: CandidateEntityKind,
  entityId: number,
  candidateKind: CandidateKind,
): CandidateDecisionRow[] {
  return all<CandidateDecisionRow>(
    `SELECT * FROM candidate_decisions
      WHERE entity_kind = :entityKind AND entity_id = :entityId
        AND candidate_kind = :candidateKind AND decision = 'rejected'`,
    { entityKind, entityId, candidateKind },
  );
}

export function findDecision(
  entityKind: CandidateEntityKind,
  entityId: number,
  candidateKind: CandidateKind,
  title: string,
): CandidateDecisionRow | undefined {
  return one<CandidateDecisionRow>(
    `SELECT * FROM candidate_decisions
      WHERE entity_kind = :entityKind AND entity_id = :entityId
        AND candidate_kind = :candidateKind AND candidate_key = :key`,
    { entityKind, entityId, candidateKind, key: candidateKeyOf(title) },
  );
}

/** 解析证据快照：用于比较「新候选是否比被否决时更强」。 */
export function decisionEvidence(row: Pick<CandidateDecisionRow, 'evidence'>): {
  support: number | null;
  coverage: number | null;
  sources: string[] | null;
} {
  const unknown = { support: null, coverage: null, sources: null };
  try {
    const value: unknown = JSON.parse(row.evidence);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
    const parsed = value as Record<string, unknown>;
    // 合法旧数字字符串仍可比较；缺失、空串、布尔、对象和非有限值不是零证据。
    const numeric = (input: unknown): number | null => {
      if (typeof input !== 'number' && (typeof input !== 'string' || !input.trim())) return null;
      const number = Number(input);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const support = numeric(parsed.support);
    const coverage = numeric(parsed.coverage);
    const sources = Array.isArray(parsed.sources) && parsed.sources.every((source) => typeof source === 'string' && source.trim())
      ? [...new Set(parsed.sources.map((source: string) => source.trim()))] : null;
    return {
      support: support !== null && Number.isSafeInteger(support) ? support : null,
      coverage: coverage !== null && coverage <= 1 ? coverage : null,
      sources,
    };
  } catch {
    return unknown;
  }
}
