/**
 * 治理 / 修复历史（v1.6.2，只读投影）。
 *
 * 数据来源只有两张既有事实表：
 *   - entity_events：不可变的治理 / 引擎事件历史；
 *   - candidate_decisions：每个候选当前的决定（含证据快照），其 superseded 状态代表旧否决已失效。
 *
 * 这里不新增任何写模型，也不允许从历史视图修改治理状态。
 */
import type {
  DiagnosticHistoryEntry,
  DiagnosticsHistoryResponse,
} from '@bangumi-analyzer/shared';
import { all } from './index.js';

const ACTION_LABELS: Record<string, string> = {
  created: '创建实体',
  merged: '合并实体',
  legacy_merged: '迁移合并',
  legacy_split: '迁移拆分',
  unmatched: '迁移未匹配',
  title_proposed: '提出新标题候选',
  title_changed: '自动更新展示标题',
  title_manual: '人工确认标题',
  title_reset: '恢复自动解析',
  candidate_rejected: '否决标题候选',
  candidate_reopened: '候选重新进入评估',
  confirmed: '确认家族',
  rejected: '否决家族候选',
  conflict: '保留冲突链接',
  conflict_unmatched: '确认家族未匹配',
  conflict_resolved: '确认家族恢复匹配',
  candidate_member: '新增待确认成员',
  governance_unlocked: '解除人工确认（治理初始化）',
  member_excluded: '移出家族成员',
  member_reopened: '撤销成员排除',
};

const USER_ACTIONS = new Set([
  'title_manual',
  'title_reset',
  'candidate_rejected',
  'confirmed',
  'rejected',
  'member_excluded',
  'member_reopened',
]);

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function actorOf(
  kind: string,
  payload: Record<string, unknown>,
): DiagnosticHistoryEntry['actor'] {
  if (kind === 'governance_unlocked') return 'maintenance';
  if (USER_ACTIONS.has(kind)) return 'user';
  if (kind === 'candidate_reopened') {
    return payload.trigger === 'manual' ? 'user' : 'system';
  }
  return 'system';
}

/** 事件摘要：说明「做了什么决定 / 状态怎么变化」。 */
function eventSummary(kind: string, payload: Record<string, unknown>): string {
  const label = ACTION_LABELS[kind] ?? kind;
  switch (kind) {
    case 'title_manual': {
      const from = text(payload.from);
      const to = text(payload.to);
      return from && to ? `${label}：「${from}」→「${to}」` : label;
    }
    case 'title_reset':
      return text(payload.from) ? `${label}（原「${payload.from}」）` : label;
    case 'candidate_rejected':
      return text(payload.title) ? `${label}「${payload.title}」` : label;
    case 'candidate_reopened': {
      const title = text(payload.title) || text(payload.key);
      const manual = payload.trigger === 'manual';
      const added = Array.isArray(payload.added) ? `（新增 ${payload.added.length} 个成员）` : '';
      return title
        ? `${label}：${title}${manual ? '（人工）' : added || '（新证据）'}`
        : label;
    }
    case 'confirmed':
    case 'rejected':
    case 'governance_unlocked': {
      const key = text(payload.key);
      const previous = text(payload.previousState);
      const reason = text(payload.reason);
      return [label, key ? `家族 ${key}` : '', previous ? `（原状态 ${previous}）` : '', reason]
        .filter(Boolean)
        .join(' ');
    }
    case 'member_excluded':
    case 'member_reopened': {
      const series = text(payload.seriesTitle) || text(payload.seriesKey);
      const reason = text(payload.reason);
      const manual = kind === 'member_reopened' && payload.trigger === 'manual';
      return [label, series ? `「${series}」` : '', manual ? '（人工）' : '', reason]
        .filter(Boolean)
        .join(' ');
    }
    case 'created':
      return Array.isArray(payload.series) ? `${label}（${payload.series.length} 个系列）` : label;
    case 'conflict':
    case 'candidate_member':
      return payload.seriesId !== undefined ? `${label} #${payload.seriesId}` : label;
    default:
      return label;
  }
}

function stateChangeOf(payload: Record<string, unknown>): string | null {
  const from =
    text(payload.previousState) || text(payload.fromState) || text(payload.from) || '';
  const to = text(payload.to) || text(payload.state) || '';
  if (from && to) return `${from} → ${to}`;
  if (from) return `${from} →（当前）`;
  if (to) return `→ ${to}`;
  return null;
}

interface EntityInfo {
  key: string | null;
  title: string | null;
  state: string | null;
}

function loadEntities(
  kind: 'series' | 'franchise' | 'legacy',
  ids: number[],
): Map<number, EntityInfo> {
  const map = new Map<number, EntityInfo>();
  if (ids.length === 0 || kind === 'legacy') return map;
  const table = kind === 'series' ? 'series_entities' : 'franchise_entities';
  const stateColumn = kind === 'series' ? 'title_state' : 'state';
  for (const id of ids) {
    const row = all<{ key: string; title: string; state: string }>(
      `SELECT key, title, ${stateColumn} AS state FROM ${table} WHERE id = :id`,
      { id },
    )[0];
    if (row) map.set(id, { key: row.key, title: row.title, state: row.state });
  }
  return map;
}

export function listGovernanceHistory(
  options: { entityKind?: string; actor?: string; limit?: number } = {},
): DiagnosticsHistoryResponse {
  const entityKind =
    options.entityKind === 'series' || options.entityKind === 'franchise'
      ? options.entityKind
      : 'all';
  const actor =
    options.actor === 'user' ||
    options.actor === 'system' ||
    options.actor === 'maintenance'
      ? options.actor
      : 'all';
  const requested = Number(options.limit ?? 30);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(200, Math.round(requested))) : 30;
  const filterEvent = entityKind === 'all' ? '' : 'AND entity_kind = :entityKind';
  const filterDecision = entityKind === 'all' ? '' : 'AND entity_kind = :entityKind';
  const params = entityKind === 'all' ? {} : { entityKind };

  /*
   * 历史里同时存在大量引擎事件（每次重建都会产生 title_proposed / 迁移未匹配），
   * 因此先在工作集里算好 actor，再按需要过滤；这样「共 N 条」与显示条数始终一致。
   * 当前规模（千级事件）下在内存里处理即可，不需要新增索引。
   */
  const eventRows = all<{
    id: number;
    entity_kind: 'series' | 'franchise' | 'legacy';
    entity_id: number;
    kind: string;
    payload: string;
    created_at: string;
  }>(
    `SELECT id, entity_kind, entity_id, kind, payload, created_at FROM entity_events
      WHERE 1=1 ${filterEvent} ORDER BY id DESC`,
    params,
  );
  const decisionRows = all<{
    id: number;
    entity_kind: 'series' | 'franchise';
    entity_id: number;
    candidate_kind: string;
    candidate_title: string;
    decision: string;
    reason: string;
    evidence: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, entity_kind, entity_id, candidate_kind, candidate_title, decision, reason, evidence, created_at, updated_at
       FROM candidate_decisions WHERE 1=1 ${filterDecision} ORDER BY updated_at DESC`,
    params,
  );

  const entities = new Map<string, EntityInfo>();
  for (const kind of ['series', 'franchise'] as const) {
    const ids = [
      ...new Set([
        ...eventRows.filter((row) => row.entity_kind === kind).map((row) => Number(row.entity_id)),
        ...decisionRows.filter((row) => row.entity_kind === kind).map((row) => Number(row.entity_id)),
      ]),
    ];
    for (const [id, info] of loadEntities(kind, ids)) {
      entities.set(`${kind}:${id}`, info);
    }
  }

  const entries: DiagnosticHistoryEntry[] = [];
  for (const row of eventRows) {
    const payload = parseJsonObject(row.payload);
    const info = entities.get(`${row.entity_kind}:${row.entity_id}`) ?? {
      key: null,
      title: null,
      state: null,
    };
    const memberEvent = row.kind === 'member_excluded' || row.kind === 'member_reopened';
    const candidateTitle = memberEvent
      ? text(payload.seriesTitle) || text(payload.seriesKey) || null
      : text(payload.title) || text(payload.key) || text(payload.to) || null;
    entries.push({
      id: `event:${row.id}`,
      at: row.created_at,
      source: 'entity_event',
      kind: row.kind,
      summary: eventSummary(row.kind, payload),
      actor: actorOf(row.kind, payload),
      entityKind: row.entity_kind,
      entityId: Number(row.entity_id),
      entityKey: info.key,
      entityTitle: info.title,
      currentState: info.state,
      candidate:
        memberEvent
          ? candidateTitle
            ? { kind: 'member', title: candidateTitle }
            : null
          : candidateTitle && row.kind.startsWith('candidate_')
          ? { kind: 'title', title: candidateTitle }
          : candidateTitle && (row.kind === 'confirmed' || row.kind === 'rejected')
            ? { kind: 'franchise', title: candidateTitle }
            : null,
      stateChange: stateChangeOf(payload),
      reason: text(payload.reason) || null,
      evidence: row.payload && row.payload !== '{}' ? row.payload : null,
    });
  }
  for (const row of decisionRows) {
    const info = entities.get(`${row.entity_kind}:${row.entity_id}`) ?? {
      key: null,
      title: null,
      state: null,
    };
    const rejected = row.decision === 'rejected';
    entries.push({
      id: `decision:${row.id}`,
      at: row.updated_at || row.created_at,
      source: 'candidate_decision',
      kind: `decision.${row.decision}`,
      summary: rejected
        ? `候选决定：${row.candidate_kind === 'title' ? '标题候选' : '家族候选'}「${row.candidate_title}」→ rejected`
        : `候选决定失效：${row.candidate_kind === 'title' ? '标题候选' : '家族候选'}「${row.candidate_title}」→ superseded`,
      actor: rejected ? 'user' : 'system',
      entityKind: row.entity_kind,
      entityId: Number(row.entity_id),
      entityKey: info.key,
      entityTitle: info.title,
      currentState: info.state,
      candidate: { kind: row.candidate_kind, title: row.candidate_title },
      stateChange: rejected
        ? '→ rejected（当前生效）'
        : 'rejected → superseded（旧否决已失效）',
      reason: row.reason || null,
      evidence: row.evidence && row.evidence !== '{}' ? row.evidence : null,
    });
  }

  const filtered = actor === 'all' ? entries : entries.filter((entry) => entry.actor === actor);
  filtered.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : a.at < b.at ? 1 : -1));
  return {
    entries: filtered.slice(0, limit),
    total: filtered.length,
    filters: { entityKind, actor, limit },
  };
}
