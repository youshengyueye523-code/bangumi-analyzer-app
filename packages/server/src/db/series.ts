import { validRelationSql } from './metadata.js';
import { ApiError } from '@bangumi-analyzer/shared';
/**
 * Series / Franchise 引擎（数据库层）
 *
 * 职责：
 * - 从 subjects / collections / subject_relations 加载全图输入；
 * - 调用纯逻辑 resolver 得到 Series 成员资格与 Franchise 候选；
 * - 与既有实体对账（稳定 key、alias、事件、名称提案）；
 * - 写入 series_entities / franchise_entities 等表。
 *
 * 全量重算 + 身份对账：当前数据规模（千级节点 / 万级边）下远快于
 * 维护增量图的复杂度，稳定性靠实体注册表而不是靠增量算法。
 */

import { classifyRelation } from '../series/taxonomy.js';
import { EPISODE_EXPRESSION } from '../stats/expressions.js';
import {
  resolveGraph,
  type EngineEdge,
  type EngineNode,
  type ResolvedSeries,
} from '../series/resolver.js';
import {
  resolveTitle,
  type TitleCandidate,
  type TitleResolution,
  type TitleState,
} from '../series/title.js';
import { nowIso, parseJsonColumn, parseStringArrayColumn, toJson } from '../util.js';
import {
  activeRejections,
  candidateKeyOf,
  decisionEvidence,
  findDecision,
  recordCandidateDecision,
} from './candidates.js';
import { all, one, run, transaction, getMeta, setMeta, schemaVersion } from './index.js';
import { franchiseAverageRateDriftCount, franchiseAverageRateSql } from './franchiseAverage.js';
import { seriesRankingMetricSql } from './entityRanking.js';
import { recordMutation } from './mutation.js';
import { titleCandidatesForMutation } from './titleCandidates.js';
import { projectManualFranchiseLinks } from './manualFranchiseProjection.js';

export const SERIES_ENGINE_VERSION = 2;

export interface SeriesRebuildResult {
  series: number;
  franchises: number;
  members: number;
  candidates: number;
  newSeries: number;
  mergedSeries: number;
  newFranchises: number;
  /** v1.8.3（B3）：历史 stale 身份按身份一致性恢复的数量。 */
  revived: number;
  /** v1.8.3（B3）：被恢复身份回收的 rebuild duplicate 数量。 */
  rebuiltAbsorbed: number;
  /** v1.8.3（B2）：alias 生命周期对账中重定向到 live 后继的数量。 */
  aliasesRedirected: number;
  /** v1.8.3（B2）：无法重定向、按契约退役的 alias 数量。 */
  aliasesRetired: number;
}

export interface TitleOverrideInput {
  /** confirm-current：确认当前展示名；candidate：采用现有候选；custom：自定义标题 */
  mode: 'confirm-current' | 'candidate' | 'custom';
  title?: string;
}

export type TitleOverrideResult =
  | { ok: true; key: string; title: string }
  | { ok: false; code: 'not_found' | 'invalid_title' | 'unknown_candidate'; message: string };

const TITLE_MAX_LENGTH = 120;

interface ExistingSeriesRow {
  id: number;
  key: string;
  state: string;
  title: string;
  title_state: string;
  title_source: string;
  anchor_subject_id: number | null;
  core_signature: string;
  member_count: number;
  created_at: string;
}

interface ExistingFranchiseRow {
  id: number;
  key: string;
  state: string;
  title: string;
  title_state: string;
  title_source: string;
  title_candidates: string;
  origin: 'auto' | 'manual';
}

const FORMAT_TAGS = new Set([
  'tv',
  'ova',
  'oad',
  'web',
  '剧场版',
  '劇場版',
  '电影',
  '映画',
  '动画',
  '日本',
  '原创',
  '漫画改',
  '漫改',
  '小说改',
  '轻小说改',
  '游戏改',
  'gal改',
  '里番',
  '总集篇',
  '特别篇',
  '泡面番',
]);

function compact(value: string): string {
  return (value ?? '').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

interface EngineInput {
  nodes: Map<number, EngineNode>;
  edges: EngineEdge[];
  tagFrequency: Map<string, number>;
  isExcludedTag: (tag: string) => boolean;
  collectedCount: number;
}

function loadEngineInput(): EngineInput {
  const subjectRows = all<{
    id: number;
    name: string | null;
    name_cn: string | null;
    year: number | null;
    total_episodes: number | null;
    format: string | null;
    detail_state: string | null;
    tag_names: string | null;
    originals: string | null;
    studios: string | null;
    directors: string | null;
    collection_type: number | null;
    rate: number | null;
  }>(
    `SELECT s.id, s.name, s.name_cn, canonical_positive_integer(s.year) AS year, ${EPISODE_EXPRESSION} AS total_episodes, s.format, s.detail_state,
            s.tag_names, s.originals, s.studios, s.directors,
            c.type AS collection_type, effective_personal_rate(c.type,c.rate) AS rate
     FROM subjects s
     LEFT JOIN collections c ON c.subject_id = s.id`,
  );

  const nodes = new Map<number, EngineNode>();
  for (const row of subjectRows) {
    nodes.set(Number(row.id), {
      id: Number(row.id),
      name: row.name ?? '',
      nameCn: row.name_cn ?? '',
      year: row.year === null ? null : Number(row.year),
      totalEpisodes: Number(row.total_episodes ?? 0),
      format: row.format ?? '',
      collected: row.collection_type !== null,
      collectionType: row.collection_type === null ? null : Number(row.collection_type),
      rate: Number(row.rate ?? 0),
      hasDetail: row.detail_state === 'ok',
      tags: parseStringArrayColumn(row.tag_names),
      originals: parseStringArrayColumn(row.originals),
      studios: parseStringArrayColumn(row.studios),
      directors: parseStringArrayColumn(row.directors),
    });
  }

  const relationRows = all<{
    subject_id: number;
    related_id: number;
    relation: string;
    name: string | null;
    name_cn: string | null;
  }>(
    `SELECT r.subject_id, r.related_id, r.relation, r.name, r.name_cn
     FROM subject_relations r
     WHERE ${validRelationSql('r')}
     ORDER BY r.subject_id, r.related_id`,
  );

  // 未收藏的 relation 引用节点：用关系行里携带的名称建立节点证据（不额外抓取详情）。
  const referencedNames = new Map<number, Array<{ nameCn: string; name: string }>>();
  for (const row of relationRows) {
    const id = Number(row.related_id);
    if (nodes.has(id)) continue;
    const list = referencedNames.get(id) ?? [];
    list.push({ nameCn: row.name_cn ?? '', name: row.name ?? '' });
    referencedNames.set(id, list);
  }
  for (const [id, names] of referencedNames) {
    const best = [...names].sort(
      (a, b) =>
        Number(Boolean(b.nameCn)) - Number(Boolean(a.nameCn)) ||
        (b.nameCn || b.name).length - (a.nameCn || a.name).length ||
        (a.nameCn || a.name).localeCompare(b.nameCn || b.name, 'zh-Hans-CN'),
    )[0]!;
    nodes.set(id, {
      id,
      name: best.name,
      nameCn: best.nameCn,
      year: null,
      totalEpisodes: 0,
      format: '',
      collected: false,
      collectionType: null,
      rate: 0,
      hasDetail: false,
      tags: [],
      originals: [],
      studios: [],
      directors: [],
    });
  }

  const edges: EngineEdge[] = [];
  for (const row of relationRows) {
    const from = Number(row.subject_id);
    const to = Number(row.related_id);
    if (from === to || !nodes.has(from) || !nodes.has(to)) continue;
    const kind = classifyRelation(row.relation ?? '');
    edges.push({
      from,
      to,
      relation: (row.relation ?? '').trim(),
      klass: kind.klass,
      polarity: kind.polarity,
    });
  }

  // 标签频次与噪声标签（作者/公司/年份/格式）——用于品牌证据的稀有度判断。
  const tagFrequency = new Map<string, number>();
  let collectedCount = 0;
  const noiseTokens = new Set<string>();
  for (const node of nodes.values()) {
    if (!node.collected) continue;
    collectedCount += 1;
    for (const tag of new Set(node.tags)) {
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
    }
    for (const value of [...node.originals, ...node.studios, ...node.directors]) {
      for (const token of value.split(/[、,，/／;；×xX]/)) {
        const text = compact(token);
        if (text.length >= 2) noiseTokens.add(text);
      }
    }
  }
  const staffRows = all<{ name: string | null }>('SELECT DISTINCT name FROM subject_staff');
  for (const row of staffRows) {
    const text = compact(row.name ?? '');
    if (text.length >= 2) noiseTokens.add(text);
  }
  const noisePrefixes = [...noiseTokens].filter((token) => token.length >= 3);

  const isExcludedTag = (tag: string): boolean => {
    const raw = (tag ?? '').trim();
    if (raw.length < 2) return true;
    const text = compact(raw);
    if (FORMAT_TAGS.has(text) || FORMAT_TAGS.has(raw)) return true;
    if (/^\d/.test(text)) return true;
    if (/(年|月|期|季度)$/.test(raw)) return true;
    if (noiseTokens.has(text)) return true;
    return noisePrefixes.some((token) => token.startsWith(text));
  };

  return { nodes, edges, tagFrequency, isExcludedTag, collectedCount };
}

function sortedSignature(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}

function signatureOf(series: ResolvedSeries): string {
  return sortedSignature(series.primaryIds);
}

function displayOrder(series: ResolvedSeries, nodes: Map<number, EngineNode>): number[] {
  return [...series.primaryIds].sort((a, b) => {
    const nodeA = nodes.get(a);
    const nodeB = nodes.get(b);
    const yearA = nodeA?.year ?? 9999;
    const yearB = nodeB?.year ?? 9999;
    if (yearA !== yearB) return yearA - yearB;
    return a - b;
  });
}

function memberStats(series: ResolvedSeries, nodes: Map<number, EngineNode>) {
  const primary = series.primaryIds;
  const collected = primary
    .map((id) => nodes.get(id))
    .filter((node): node is EngineNode => Boolean(node && node.collected));
  const rated = collected.filter((node) => node.rate > 0);
  const years = primary
    .map((id) => nodes.get(id)?.year ?? null)
    .filter((year): year is number => year !== null);
  const statusCounts: Record<string, number> = {};
  for (const node of collected) {
    const key = String(node.collectionType ?? 0);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  const confirmedCount = series.members.filter(
    (member) => member.role === 'primary' && member.state === 'confirmed',
  ).length;
  return {
    memberCount: primary.length,
    confirmedCount,
    collectedCount: collected.length,
    candidateCount: series.candidateIds.length,
    totalEpisodes: primary.reduce((sum, id) => sum + (nodes.get(id)?.totalEpisodes ?? 0), 0),
    averageRate:
      rated.length > 0
        ? Number((rated.reduce((sum, node) => sum + node.rate, 0) / rated.length).toFixed(2))
        : null,
    firstYear: years.length > 0 ? Math.min(...years) : null,
    lastYear: years.length > 0 ? Math.max(...years) : null,
    statusCounts,
  };
}

interface MatchResult {
  survivor: ExistingSeriesRow | null;
  absorbed: ExistingSeriesRow[];
}

function matchExistingSeries(
  series: ResolvedSeries,
  existing: ExistingSeriesRow[],
  memberMap: Map<number, Set<number>>,
  used: Set<number>,
): MatchResult {
  const signature = signatureOf(series);
  const newIds = new Set(series.primaryIds);
  const scored = existing
    .filter((row) => !used.has(row.id))
    .map((row) => {
      const oldIds = memberMap.get(row.id) ?? new Set<number>();
      let overlap = 0;
      for (const id of newIds) if (oldIds.has(id)) overlap += 1;
      if (overlap === 0) return { row, score: 0 };
      if (row.core_signature && row.core_signature === signature) {
        return { row, score: 1000 + overlap };
      }
      if (newIds.size === 1 && oldIds.size === 1 && oldIds.has(series.primaryIds[0]!)) {
        return { row, score: 900 };
      }
      if (
        row.anchor_subject_id !== null &&
        row.anchor_subject_id === series.anchorId &&
        oldIds.has(row.anchor_subject_id)
      ) {
        return { row, score: 600 + overlap };
      }
      const ratio = overlap / Math.min(oldIds.size, newIds.size);
      return { row, score: Math.round(ratio * 100) + overlap };
    })
    .filter((entry) => entry.score >= 50)
    .sort((a, b) => b.score - a.score || a.row.id - b.row.id);
  if (scored.length === 0) return { survivor: null, absorbed: [] };
  return { survivor: scored[0]!.row, absorbed: scored.slice(1).map((entry) => entry.row) };
}

/* ---------------------------------------------- v1.8.3 实体身份生命周期 */

type AbsorbReason = 'combined-into' | 'rebuilt-into';

interface SeriesIdentityPlanItem {
  series: ResolvedSeries;
  survivor: ExistingSeriesRow | null;
  absorbed: Array<{ row: ExistingSeriesRow; reason: AbsorbReason }>;
  revived: boolean;
}

/** 成员集合一致性强度：revival 只接受「完全一致 / 高度一致」，不接受普通 overlap。 */
function identityStrength(
  oldIds: Set<number>,
  newIds: Set<number>,
): { overlap: number; union: number; jaccard: number; ratio: number; exact: boolean; high: boolean } {
  let overlap = 0;
  for (const id of newIds) if (oldIds.has(id)) overlap += 1;
  const union = oldIds.size + newIds.size - overlap;
  const jaccard = union > 0 ? overlap / union : 0;
  const ratio = overlap / Math.max(oldIds.size, newIds.size);
  const exact = oldIds.size > 0 && overlap === oldIds.size && oldIds.size === newIds.size;
  const high = oldIds.size >= 2 && overlap >= 2 && ratio >= 0.8 && jaccard >= 0.6;
  return { overlap, union, jaccard, ratio, exact, high };
}

function buildMemberMap(): Map<number, Set<number>> {
  const rows = all<{ series_id: number; subject_id: number }>(
    'SELECT series_id, subject_id FROM series_entity_members',
  );
  const map = new Map<number, Set<number>>();
  for (const row of rows) {
    const set = map.get(Number(row.series_id)) ?? new Set<number>();
    set.add(Number(row.subject_id));
    map.set(Number(row.series_id), set);
  }
  return map;
}

/**
 * stale 身份的「最后已知成员集合」：从 entity_events 重建，无需新增字段。
 * - created / unmatched 的 payload.members 记录过当时的成员；
 * - unmatched 只有「刚变 stale 的那一次」带成员，之后的空事件会被忽略。
 */
function loadLastKnownMembers(): Map<number, number[]> {
  const rows = all<{ entity_id: number; payload: string }>(
    `SELECT entity_id, payload FROM entity_events
      WHERE entity_kind = 'series' AND kind IN ('created', 'unmatched')
      ORDER BY id ASC`,
  );
  const latest = new Map<number, number[]>();
  for (const row of rows) {
    const payload = parseJsonColumn<{ members?: unknown }>(row.payload, {});
    const members = Array.isArray(payload.members)
      ? payload.members.map(Number).filter((id) => Number.isFinite(id))
      : [];
    if (members.length === 0) continue;
    latest.set(Number(row.entity_id), members);
  }
  return latest;
}

/** 「合法 live 后继」：该 stale 身份的旧 key 已经指向一个 live 实体（合并 / 拆分谱系）。 */
function seriesHasLiveSuccessor(row: ExistingSeriesRow): boolean {
  const alias = one<{ entity_id: number }>(
    'SELECT entity_id FROM entity_aliases WHERE alias_key = :key AND entity_kind = :kind',
    { key: row.key, kind: 'series' },
  );
  if (!alias) return false;
  const target = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM series_entities WHERE id = :id AND state <> 'stale'`,
    { id: Number(alias.entity_id) },
  );
  return Number(target?.n ?? 0) > 0;
}

interface StaleIdentityMatch {
  row: ExistingSeriesRow;
  exact: boolean;
  signature: boolean;
  jaccard: number;
}

/**
 * revival 匹配（B3）。
 *
 * 只接受能证明「同一个历史实体重新出现」的情形：
 * - 历史成员集合与新解析成员集合完全一致；或
 * - 高度一致（overlap ≥ 2 且 0.8 / 0.6 双阈值）；或
 * - core_signature 明确相同。
 * 且该 stale 身份没有合法 live 后继 —— 有后继时必须沿后继链处理。
 */
function matchStaleIdentity(
  series: ResolvedSeries,
  existing: ExistingSeriesRow[],
  lastKnownMembers: Map<number, number[]>,
  used: Set<number>,
): StaleIdentityMatch | null {
  const newIds = new Set(series.primaryIds);
  const signature = signatureOf(series);
  const matches: StaleIdentityMatch[] = [];
  for (const row of existing) {
    if (row.state !== 'stale' || used.has(row.id)) continue;
    const oldIds = new Set((lastKnownMembers.get(row.id) ?? []).map(Number));
    if (oldIds.size === 0) continue;
    const strength = identityStrength(oldIds, newIds);
    const signatureMatch = Boolean(row.core_signature) && row.core_signature === signature;
    if (!strength.exact && !strength.high && !signatureMatch) continue;
    if (seriesHasLiveSuccessor(row)) continue;
    matches.push({
      row,
      exact: strength.exact,
      signature: signatureMatch,
      jaccard: strength.jaccard,
    });
  }
  if (matches.length === 0) return null;
  matches.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      Number(b.signature) - Number(a.signature) ||
      b.jaccard - a.jaccard ||
      a.row.id - b.row.id,
  );
  return matches[0]!;
}

/**
 * rebuild duplicate：与 stale 身份同成员集合、但更年轻且没有任何谱系关联的 live 实体。
 * 它属于 B3 的产物 —— 恢复旧身份时把它回收，而不是让两个身份并存。
 */
function isRebuildDuplicate(
  liveRow: ExistingSeriesRow,
  staleRow: ExistingSeriesRow,
  memberMap: Map<number, Set<number>>,
  lastKnownMembers: Map<number, number[]>,
): boolean {
  if (liveRow.state === 'stale') return false;
  if (liveRow.created_at <= staleRow.created_at) return false;
  if (seriesHasLiveSuccessor(staleRow)) return false;
  const staleIds = new Set((lastKnownMembers.get(staleRow.id) ?? []).map(Number));
  const liveIds = memberMap.get(liveRow.id) ?? new Set<number>();
  if (staleIds.size === 0 || liveIds.size === 0) return false;
  const strength = identityStrength(staleIds, liveIds);
  return strength.exact || strength.high;
}

/** 按「成员多的优先」为每个解析结果确定身份：live 匹配 → stale revival → 新建。 */
function planSeriesIdentities(
  resolved: ResolvedSeries[],
  existing: ExistingSeriesRow[],
  memberMap: Map<number, Set<number>>,
  lastKnownMembers: Map<number, number[]>,
): SeriesIdentityPlanItem[] {
  const used = new Set<number>();
  const items: SeriesIdentityPlanItem[] = [];
  const ordered = [...resolved].sort(
    (a, b) => b.primaryIds.length - a.primaryIds.length || a.localId - b.localId,
  );
  for (const series of ordered) {
    const live = matchExistingSeries(series, existing, memberMap, used);
    let survivor = live.survivor;
    let absorbed: Array<{ row: ExistingSeriesRow; reason: AbsorbReason }> = live.absorbed.map(
      (row) => ({ row, reason: 'combined-into' as const }),
    );
    let revived = false;
    const staleMatch = matchStaleIdentity(series, existing, lastKnownMembers, used);
    if (staleMatch) {
      if (!survivor) {
        survivor = staleMatch.row;
        revived = true;
      } else if (isRebuildDuplicate(survivor, staleMatch.row, memberMap, lastKnownMembers)) {
        absorbed = [...absorbed, { row: survivor, reason: 'rebuilt-into' }];
        survivor = staleMatch.row;
        revived = true;
      }
    }
    if (survivor) used.add(survivor.id);
    for (const entry of absorbed) used.add(entry.row.id);
    items.push({ series, survivor: survivor ?? null, absorbed, revived });
  }
  return items;
}

/**
 * v1.8.4：Franchise 成员身份 supersession 的只读校验。
 *
 * 只承认一种情况，且必须全部成立：
 * - `from` 是 stale 的历史身份；
 * - `from` 的 alias 是 `rebuilt-into` 且指向 live 的 `to`；
 * - `to` 存在明确的 merged 事件回收该 identity（absorbedKey=from.key、rebuilt=true）；
 * - from 的最后已知成员与 to 的当前成员满足强身份一致性（完全一致 / 高置信）。
 *
 * 任意一个条件不满足都返回 null —— 不允许仅凭普通 overlap / 标题相似度迁移成员。
 */
export interface SeriesSupersession {
  from: { id: number; key: string; title: string };
  to: { id: number; key: string; title: string };
  provenance: {
    aliasReason: string;
    mergedEventId: number;
    mergedAt: string;
    restoredEventId: number | null;
  };
  members: {
    members: number[];
    overlap: number;
    union: number;
    exact: boolean;
    high: boolean;
  };
}

export function findSeriesSupersession(fromKey: string): SeriesSupersession | null {
  const from = one<{ id: number; key: string; title: string; state: string }>(
    'SELECT id, key, title, state FROM series_entities WHERE key = :key',
    { key: fromKey },
  );
  if (!from || from.state !== 'stale') return null;

  const alias = one<{ entity_id: number; reason: string }>(
    `SELECT entity_id, reason FROM entity_aliases WHERE alias_key = :key AND entity_kind = 'series'`,
    { key: from.key },
  );
  if (!alias || alias.reason !== 'rebuilt-into') return null;

  const to = one<{ id: number; key: string; title: string; state: string }>(
    'SELECT id, key, title, state FROM series_entities WHERE id = :id',
    { id: Number(alias.entity_id) },
  );
  if (!to || to.state === 'stale') return null;

  const mergedRows = all<{ id: number; payload: string; created_at: string }>(
    `SELECT id, payload, created_at FROM entity_events
      WHERE entity_kind = 'series' AND entity_id = :id AND kind = 'merged'
      ORDER BY id DESC LIMIT 20`,
    { id: to.id },
  );
  const merged = mergedRows.find((row) => {
    const payload = parseJsonColumn<{ absorbedKey?: unknown; rebuilt?: unknown }>(row.payload, {});
    return String(payload.absorbedKey ?? '') === from.key && payload.rebuilt === true;
  });
  if (!merged) return null;

  const restored = one<{ id: number }>(
    `SELECT id FROM entity_events
      WHERE entity_kind = 'series' AND entity_id = :id AND kind = 'restored'
      ORDER BY id DESC LIMIT 1`,
    { id: to.id },
  );

  const lastKnown = (loadLastKnownMembers().get(from.id) ?? []).map(Number);
  const toMembers = all<{ subject_id: number }>(
    `SELECT subject_id FROM series_entity_members WHERE series_id = :id AND role = 'primary'`,
    { id: to.id },
  ).map((row) => Number(row.subject_id));
  if (lastKnown.length === 0 || toMembers.length === 0) return null;
  const strength = identityStrength(new Set(lastKnown), new Set(toMembers));
  if (!strength.exact && !strength.high) return null;

  return {
    from: { id: from.id, key: from.key, title: from.title },
    to: { id: to.id, key: to.key, title: to.title },
    provenance: {
      aliasReason: alias.reason,
      mergedEventId: merged.id,
      mergedAt: merged.created_at,
      restoredEventId: restored?.id ?? null,
    },
    members: {
      members: toMembers,
      overlap: strength.overlap,
      union: strength.union,
      exact: strength.exact,
      high: strength.high,
    },
  };
}

export interface EntityEventWrite {
  id: number;
  entity_kind: string;
  entity_id: number;
  kind: string;
  payload: string;
  created_at: string;
}

// Synchronous scoped observation of intentional writes, not a database-derived oracle.
// A trigger's extra/rewritten events cannot grant themselves authorization here.
const entityEventAudits = new Set<EntityEventWrite[]>();
export function captureEntityEventWrites<T>(execute: () => T): { result: T; events: EntityEventWrite[] } {
  const events: EntityEventWrite[] = [];
  entityEventAudits.add(events);
  try { return { result: execute(), events }; }
  finally { entityEventAudits.delete(events); }
}

export function insertEvent(
  entityKind: 'series' | 'franchise' | 'legacy',
  entityId: number,
  kind: string,
  payload: unknown,
  timestamp: string,
): void {
  const serialized = toJson(payload);
  const inserted = run(
    `INSERT INTO entity_events (entity_kind, entity_id, kind, payload, created_at)
     VALUES (:entityKind, :entityId, :kind, :payload, :createdAt)`,
    { entityKind, entityId, kind, payload: serialized, createdAt: timestamp },
  );
  for (const events of entityEventAudits) events.push({ id: inserted.lastInsertRowid,
    entity_kind: entityKind, entity_id: entityId, kind, payload: serialized, created_at: timestamp });
}

function upsertAlias(
  aliasKey: string,
  entityKind: 'series' | 'franchise',
  entityId: number,
  reason: string,
  timestamp: string,
): void {
  run(
    `INSERT INTO entity_aliases (alias_key, entity_kind, entity_id, reason, created_at)
     VALUES (:aliasKey, :entityKind, :entityId, :reason, :createdAt)
     ON CONFLICT(alias_key) DO UPDATE SET
       entity_kind = excluded.entity_kind,
       entity_id = excluded.entity_id,
       reason = excluded.reason`,
    { aliasKey, entityKind, entityId, reason, createdAt: timestamp },
  );
}

/** 解析用户提供的 key：直接命中或通过 alias 命中。 */
export function resolveEntityKey(
  entityKind: 'series' | 'franchise',
  key: string,
): { key: string; id: number; aliasedFrom: string | null } | null {
  const table = entityKind === 'series' ? 'series_entities' : 'franchise_entities';
  const direct = one<{ id: number; key: string }>(
    `SELECT id, key FROM ${table} WHERE key = :key AND state <> 'stale'`,
    { key },
  );
  if (direct) return { key: direct.key, id: Number(direct.id), aliasedFrom: null };
  const alias = one<{ entity_id: number }>(
    `SELECT entity_id FROM entity_aliases WHERE alias_key = :key AND entity_kind = :kind`,
    { key, kind: entityKind },
  );
  if (!alias) return null;
  const target = one<{ id: number; key: string }>(
    `SELECT id, key FROM ${table} WHERE id = :id AND state <> 'stale'`,
    { id: Number(alias.entity_id) },
  );
  if (!target) return null;
  return { key: target.key, id: Number(target.id), aliasedFrom: key };
}

function franchiseState(
  links: Array<{ state: 'candidate' | 'provisional' | 'contested' }>,
): 'candidate' | 'provisional' | 'contested' {
  if (links.some((link) => link.state === 'contested')) return 'contested';
  if (links.some((link) => link.state === 'candidate')) return 'candidate';
  return 'provisional';
}

/**
 * 应用标题候选否决（v1.6.1）。
 *
 * 被人工否决的标题不得成为展示标题：
 * - 优先选择下一个仍然有效的候选（状态保持 provisional，避免伪装成 consensus）；
 * - 所有候选都被否决时回落到未确认标签，而不是偷偷用回被否决的名字。
 */
function applyTitleRejections(
  resolution: TitleResolution,
  rejectedKeys: Set<string>,
  fallbackLabel: string,
): TitleResolution {
  if (resolution.state === 'manual' || rejectedKeys.size === 0) return resolution;
  if (!rejectedKeys.has(candidateKeyOf(resolution.title))) return resolution;
  const pool = [resolution.proposed, ...resolution.candidates].filter(
    (candidate): candidate is TitleCandidate => Boolean(candidate),
  );
  const next = pool.find(
    (candidate) => candidate.valid && !rejectedKeys.has(candidateKeyOf(candidate.title)),
  );
  if (next) {
    return { ...resolution, title: next.title, state: 'provisional', source: next.source };
  }
  return { ...resolution, title: fallbackLabel, state: 'unresolved', source: 'fallback' };
}

/**
 * 家族名称的自动解析（recompute 与「恢复自动解析」共用同一套规则）。
 *
 * 只依赖当前数据库事实：成员 Series 的展示标题 + 成员 Subject 的 tags；
 * 不改变成员构成，也不写入任何内容。
 */
export function resolveFranchiseTitle(
  seriesIds: number[],
  existing: { title: string; state: TitleState; source: string } | null,
): TitleResolution {
  const input = loadEngineInput();
  const rareTagLimit = Math.max(4, Math.ceil(input.collectedCount * 0.03));
  const members = seriesIds.map((seriesId) => {
    const row = one<{ title: string }>('SELECT title FROM series_entities WHERE id = :id', {
      id: seriesId,
    });
    const tags = new Set<string>();
    const subjectRows = all<{ subject_id: number }>(
      `SELECT subject_id FROM series_entity_members WHERE series_id = :id AND role = 'primary'`,
      { id: seriesId },
    );
    for (const subject of subjectRows) {
      for (const tag of input.nodes.get(Number(subject.subject_id))?.tags ?? []) tags.add(tag);
    }
    return { title: row?.title ?? '', core: true, tags: [...tags] };
  });
  return resolveTitle({
    members,
    anchorTitle: null,
    singleton: false,
    tagFrequency: input.tagFrequency,
    rareTagLimit,
    isExcludedTag: input.isExcludedTag,
    fallbackLabel: `未确认家族（${seriesIds.length} 个系列）`,
    existing,
  });
}

/**
 * 重建 Series / Franchise。
 *
 * 每次同步收尾时执行；结果确定（与输入顺序无关），身份通过注册表对账保持稳定。
 */
export function recomputeSeries(): SeriesRebuildResult {
  const input = loadEngineInput();
  const rareTagLimit = Math.max(4, Math.ceil(input.collectedCount * 0.03));
  const resolved = resolveGraph(input.nodes, input.edges, {
    tagFrequency: input.tagFrequency,
    rareTagLimit,
    isExcludedTag: input.isExcludedTag,
  });

  const timestamp = nowIso();
  const result: SeriesRebuildResult = {
    series: resolved.series.length,
    franchises: resolved.franchises.length,
    members: 0,
    candidates: 0,
    newSeries: 0,
    mergedSeries: 0,
    newFranchises: 0,
    revived: 0,
    rebuiltAbsorbed: 0,
    aliasesRedirected: 0,
    aliasesRetired: 0,
  };

  const franchiseStats = (seriesIds: number[]) => {
    const subjectIds = new Set<number>();
    const ratedRates = new Map<number, number>();
    let collected = 0;
    let firstYear: number | null = null;
    let lastYear: number | null = null;
    for (const seriesId of seriesIds) {
      const row = one<{
        collected_count: number;
        state: string;
        first_year: number | null;
        last_year: number | null;
      }>('SELECT collected_count, first_year, last_year, state FROM series_entities WHERE id = :id', {
        id: seriesId,
      });
      if (!row || row.state === 'stale') continue;
      if (row.first_year !== null) {
        firstYear =
          firstYear === null ? Number(row.first_year) : Math.min(firstYear, Number(row.first_year));
      }
      if (row.last_year !== null) {
        lastYear =
          lastYear === null ? Number(row.last_year) : Math.max(lastYear, Number(row.last_year));
      }
      const members = all<{ subject_id: number; role: string }>(
        `SELECT subject_id, role FROM series_entity_members WHERE series_id = :id`,
        { id: seriesId },
      );
      for (const member of members) {
        if (member.role !== 'primary') continue;
        const subjectId = Number(member.subject_id);
        if (!subjectIds.has(subjectId) && input.nodes.get(subjectId)?.collected) collected += 1;
        subjectIds.add(subjectId);
        if (ratedRates.has(subjectId)) continue;
        // 与 Series 的 memberStats 同一 canonical 算法：已收藏且 rate > 0 的 primary 成员
        const rate = input.nodes.get(subjectId)?.rate ?? 0;
        if (rate > 0) ratedRates.set(subjectId, rate);
      }
    }
    const rated = [...ratedRates.values()];
    return {
      seriesCount: seriesIds.length,
      knownCount: subjectIds.size,
      collectedCount: collected,
      averageRate:
        rated.length > 0
          ? Number((rated.reduce((sum, rate) => sum + rate, 0) / rated.length).toFixed(2))
          : null,
      firstYear,
      lastYear,
    };
  };

  transaction(() => {
    const existingSeries = all<ExistingSeriesRow>(
      `SELECT id, key, state, title, title_state, title_source, anchor_subject_id,
              core_signature, member_count, created_at
         FROM series_entities`,
    );
    const memberMap = buildMemberMap();
    const lastKnownMembers = loadLastKnownMembers();

    const usedExisting = new Set<number>();
    const entityIdByLocal = new Map<number, number>();
    const keyByLocal = new Map<number, string>();
    const titleByLocal = new Map<number, string>();

    /*
     * v1.8.3（B3）：身份计划 = live 匹配 → stale revival（仅无 live 后继）→ 新建。
     * 计划与实际执行共用同一份 decision，Preview 与 Execute 因此不会漂移。
     */
    const identityPlan = planSeriesIdentities(
      resolved.series,
      existingSeries,
      memberMap,
      lastKnownMembers,
    );
    for (const item of identityPlan) {
      const { series } = item;
      const match = { survivor: item.survivor, absorbed: item.absorbed };
      const stats = memberStats(series, input.nodes);
      const existingTitle = match.survivor
        ? {
            title: match.survivor.title,
            state: match.survivor.title_state as TitleState,
            source: match.survivor.title_source,
          }
        : null;
      const resolvedTitle = resolveTitle({
        ...series.titleInput,
        tagFrequency: input.tagFrequency,
        rareTagLimit,
        isExcludedTag: input.isExcludedTag,
        fallbackLabel: `未确认系列（${series.primaryIds.length} 部）`,
        existing: existingTitle,
      });
      // 候选治理（v1.6.1）：人工否决过的候选退出竞争，但不从列表里消失。
      const rejectionRows = match.survivor
        ? activeRejections('series', match.survivor.id, 'title')
        : [];
      const proposedAlreadyListed = Boolean(
        resolvedTitle.proposed &&
          resolvedTitle.candidates.some(
            (candidate) =>
              candidate.source === resolvedTitle.proposed!.source &&
              candidateKeyOf(candidate.title) === candidateKeyOf(resolvedTitle.proposed!.title),
          ),
      );
      const pendingCandidates: TitleCandidate[] = [
        // 人工确认的名称始终保留在候选列表中，作为可解释的 provenance
        ...(existingTitle?.state === 'manual'
          ? [
              {
                title: resolvedTitle.title,
                source: 'manual',
                state: 'manual' as TitleState,
                evidence: '人工确认',
                valid: true,
                support: 1,
                coverage: 0,
              },
            ]
          : []),
        ...(resolvedTitle.proposed && !proposedAlreadyListed
          ? [...resolvedTitle.candidates, { ...resolvedTitle.proposed, state: 'provisional' as TitleState }]
          : resolvedTitle.candidates),
      ];
      const activeRejection = new Map(rejectionRows.map((row) => [row.candidate_key, row]));
      // 新证据重开：同一候选带着新的独立来源或更强的支持度回来时，旧否决失效
      for (const [key, decision] of [...activeRejection.entries()]) {
        const candidate = pendingCandidates.find((entry) => candidateKeyOf(entry.title) === key);
        if (!candidate) continue;
        const previous = decisionEvidence(decision);
        const gainedSource = previous.sources !== null && !previous.sources.includes(candidate.source);
        const stronger =
          previous.support !== null && previous.coverage !== null &&
          candidate.support > previous.support && (candidate.coverage ?? 0) > previous.coverage;
        if (!gainedSource && !stronger) continue;
        recordCandidateDecision({
          entityKind: 'series',
          entityId: match.survivor!.id,
          candidateKind: 'title',
          candidateTitle: candidate.title,
          decision: 'superseded',
          reason: '出现新的独立证据，旧否决自动失效',
          evidence: { support: candidate.support, coverage: candidate.coverage ?? 0, sources: [candidate.source] },
          timestamp,
        });
        insertEvent('series', match.survivor!.id, 'candidate_reopened', {
          title: candidate.title,
          previousReason: decision.reason,
        }, timestamp);
        activeRejection.delete(key);
      }
      const title = applyTitleRejections(
        resolvedTitle,
        new Set(activeRejection.keys()),
        `未确认系列（${series.primaryIds.length} 部）`,
      );
      const candidatesJson = toJson(
        pendingCandidates.map((candidate) => {
          const decision = activeRejection.get(candidateKeyOf(candidate.title));
          return decision
            ? {
                ...candidate,
                valid: false,
                rejected: true,
                rejectedAt: decision.updated_at,
                rejectReason: decision.reason || '人工否决',
              }
            : candidate;
        }),
      );

      let entityId: number;
      if (match.survivor) {
        usedExisting.add(match.survivor.id);
        entityId = match.survivor.id;
        run(
          `UPDATE series_entities SET
             state = :state, title = :title, title_state = :titleState, title_source = :titleSource,
             title_candidates = :titleCandidates, anchor_subject_id = :anchor, core_signature = :signature,
             evidence_coverage = :coverage, member_count = :memberCount, confirmed_count = :confirmedCount,
             candidate_count = :candidateCount, collected_count = :collectedCount,
             total_episodes = :totalEpisodes, average_rate = :averageRate,
             first_year = :firstYear, last_year = :lastYear, status_counts = :statusCounts,
             updated_at = :updatedAt, revision = revision + 1
           WHERE id = :id`,
          {
            id: entityId,
            state: series.state,
            title: title.title,
            titleState: title.state,
            titleSource: title.source,
            titleCandidates: candidatesJson,
            anchor: series.anchorId,
            signature: signatureOf(series),
            coverage: series.coverage,
            memberCount: stats.memberCount,
            confirmedCount: stats.confirmedCount,
            candidateCount: stats.candidateCount,
            collectedCount: stats.collectedCount,
            totalEpisodes: stats.totalEpisodes,
            averageRate: stats.averageRate,
            firstYear: stats.firstYear,
            lastYear: stats.lastYear,
            statusCounts: toJson(stats.statusCounts),
            updatedAt: timestamp,
          },
        );
        if (title.proposed) {
          insertEvent(
            'series',
            entityId,
            'title_proposed',
            { current: title.title, proposed: title.proposed },
            timestamp,
          );
        }
        // 否决过滤之后的最终投影才决定是否变更，resolver 的中间候选不能制造历史事件。
        if (match.survivor.title !== title.title || match.survivor.title_state !== title.state) {
          insertEvent(
            'series',
            entityId,
            'title_changed',
            {
              from: match.survivor.title,
              to: title.title,
              fromState: match.survivor.title_state,
              toState: title.state,
              state: title.state,
              source: title.source,
            },
            timestamp,
          );
        }
        // v1.8.3（B3）：历史身份按成员一致性恢复 —— 事件与计数都留痕。
        if (item.revived) {
          insertEvent(
            'series',
            entityId,
            'restored',
            {
              key: match.survivor.key,
              reason: 'identity-match',
              members: series.primaryIds,
            },
            timestamp,
          );
          result.revived += 1;
        }
      } else {
        const inserted = run(
          `INSERT INTO series_entities (
             key, state, title, title_state, title_source, title_candidates,
             anchor_subject_id, core_signature, evidence_coverage,
             member_count, confirmed_count, candidate_count, collected_count,
             total_episodes, average_rate, first_year, last_year, status_counts,
             created_at, updated_at, revision
           ) VALUES (
             :key, :state, :title, :titleState, :titleSource, :titleCandidates,
             :anchor, :signature, :coverage,
             :memberCount, :confirmedCount, :candidateCount, :collectedCount,
             :totalEpisodes, :averageRate, :firstYear, :lastYear, :statusCounts,
             :createdAt, :updatedAt, 1
           )`,
          {
            key: `pending_${series.localId}_${timestamp}`,
            state: series.state,
            title: title.title,
            titleState: title.state,
            titleSource: title.source,
            titleCandidates: candidatesJson,
            anchor: series.anchorId,
            signature: signatureOf(series),
            coverage: series.coverage,
            memberCount: stats.memberCount,
            confirmedCount: stats.confirmedCount,
            candidateCount: stats.candidateCount,
            collectedCount: stats.collectedCount,
            totalEpisodes: stats.totalEpisodes,
            averageRate: stats.averageRate,
            firstYear: stats.firstYear,
            lastYear: stats.lastYear,
            statusCounts: toJson(stats.statusCounts),
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        );
        entityId = inserted.lastInsertRowid;
        run('UPDATE series_entities SET key = :key WHERE id = :id', {
          key: `sr_${entityId}`,
          id: entityId,
        });
        insertEvent('series', entityId, 'created', { members: series.primaryIds }, timestamp);
        result.newSeries += 1;
      }

      entityIdByLocal.set(series.localId, entityId);
      keyByLocal.set(series.localId, `sr_${entityId}`);
      titleByLocal.set(series.localId, title.title);

      // 被吸收的旧实体：保留行（stale）+ 别名 + 事件，不静默删除。
      for (const { row: absorbed, reason: absorbReason } of match.absorbed) {
        usedExisting.add(absorbed.id);
        upsertAlias(absorbed.key, 'series', entityId, absorbReason, timestamp);
        run(`UPDATE series_entities SET state = 'stale', updated_at = :ts WHERE id = :id`, {
          ts: timestamp,
          id: absorbed.id,
        });
        insertEvent(
          'series',
          entityId,
          'merged',
          {
            absorbedKey: absorbed.key,
            absorbedTitle: absorbed.title,
            members: [...(memberMap.get(absorbed.id) ?? [])],
            rebuilt: absorbReason === 'rebuilt-into',
          },
          timestamp,
        );
        result.mergedSeries += 1;
        if (absorbReason === 'rebuilt-into') result.rebuiltAbsorbed += 1;
      }
    }

    // 未被任何新实体认领的旧实体：可能是拆分，也可能是数据消失。
    for (const row of existingSeries) {
      if (usedExisting.has(row.id)) continue;
      // v1.8.3（P2）：已经是 stale 的历史身份不再重复 re-stale / 追加空 unmatched 事件。
      if (row.state === 'stale') continue;
      const oldIds = memberMap.get(row.id) ?? new Set<number>();
      let bestLocal: number | null = null;
      let bestOverlap = 0;
      for (const series of resolved.series) {
        let overlap = 0;
        for (const id of series.primaryIds) if (oldIds.has(id)) overlap += 1;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestLocal = series.localId;
        }
      }
      run(`UPDATE series_entities SET state = 'stale', updated_at = :ts WHERE id = :id`, {
        ts: timestamp,
        id: row.id,
      });
      if (bestLocal !== null && bestOverlap > 0) {
        upsertAlias(row.key, 'series', entityIdByLocal.get(bestLocal)!, 'split-from', timestamp);
        insertEvent(
          'series',
          entityIdByLocal.get(bestLocal)!,
          'split',
          { fromKey: row.key, fromTitle: row.title, sharedMembers: bestOverlap },
          timestamp,
        );
      } else {
        insertEvent(
          'series',
          row.id,
          'unmatched',
          { key: row.key, title: row.title, members: [...oldIds] },
          timestamp,
        );
      }
    }

    // 迁移快照里的旧 key → 新实体（旧链接可解析）。
    const snapshot = all<{ old_key: string; member_ids: string }>(
      'SELECT old_key, member_ids FROM series_legacy_snapshot',
    );
    const legacyTargets = new Map<
      number,
      { keys: string[]; splits: Array<{ oldKey: string; missing: number[] }> }
    >();
    for (const row of snapshot) {
      const ids = parseJsonColumn<number[]>(row.member_ids, []).map(Number);
      let bestLocal: number | null = null;
      let bestOverlap = 0;
      for (const series of resolved.series) {
        let overlap = 0;
        for (const id of series.primaryIds) if (ids.includes(id)) overlap += 1;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestLocal = series.localId;
        }
      }
      if (bestLocal !== null) {
        const target = entityIdByLocal.get(bestLocal)!;
        upsertAlias(row.old_key, 'series', target, 'legacy-key', timestamp);
        const entry = legacyTargets.get(target) ?? { keys: [], splits: [] };
        entry.keys.push(row.old_key);
        const newMembers = new Set(resolved.series[bestLocal]!.primaryIds);
        const missing = ids.filter((id) => !newMembers.has(id));
        if (missing.length > 0) entry.splits.push({ oldKey: row.old_key, missing });
        legacyTargets.set(target, entry);
      } else if (ids.length > 0) {
        insertEvent('legacy', 0, 'unmapped', { key: row.old_key, members: ids }, timestamp);
      }
    }
    // 迁移对账报告只在「首次重建」（实体表为空、刚从 v1.5.0 迁移）时记录一次，
    // 避免每次同步重复堆积同类事件。
    if (existingSeries.length === 0) {
      for (const [target, entry] of legacyTargets) {
        if (entry.keys.length > 1) {
          insertEvent('series', target, 'legacy_merged', { oldKeys: entry.keys }, timestamp);
        }
        for (const split of entry.splits) {
          insertEvent(
            'series',
            target,
            'legacy_split',
            { oldKey: split.oldKey, missingMembers: split.missing },
            timestamp,
          );
        }
      }
    }

    // 成员表整表重建（stale 实体不保留成员行，历史在事件里）。
    run('DELETE FROM series_entity_members');
    const subjectSeriesKey = new Map<number, string>();
    const subjectReason = new Map<number, string>();
    for (const series of resolved.series) {
      const entityId = entityIdByLocal.get(series.localId)!;
      const ordered = displayOrder(series, input.nodes);
      const positionById = new Map(ordered.map((id, index) => [id, index]));
      for (const member of series.members) {
        run(
          `INSERT INTO series_entity_members
             (series_id, subject_id, role, state, reason_code, via_subject_id, via_relation, position)
           VALUES (:seriesId, :subjectId, :role, :state, :reasonCode, :viaSubjectId, :viaRelation, :position)`,
          {
            seriesId: entityId,
            subjectId: member.subjectId,
            role: member.role,
            state: member.state,
            reasonCode: member.reasonCode,
            viaSubjectId: member.viaSubjectId,
            viaRelation: member.viaRelation,
            position: positionById.get(member.subjectId) ?? 0,
          },
        );
        if (member.role === 'primary') {
          result.members += 1;
          const node = input.nodes.get(member.subjectId);
          if (node?.collected) {
            subjectSeriesKey.set(member.subjectId, keyByLocal.get(series.localId)!);
            subjectReason.set(member.subjectId, member.reasonCode);
          }
        } else {
          result.candidates += 1;
        }
      }
    }

    // subjects.series_key 缓存（单成员系列同样写入，数据层永远存在归属）
    run(`UPDATE subjects SET series_key = NULL, series_source = NULL WHERE series_key IS NOT NULL`);
    for (const [subjectId, key] of subjectSeriesKey) {
      run(`UPDATE subjects SET series_key = :key, series_source = :source WHERE id = :id`, {
        key,
        source: subjectReason.get(subjectId) ?? 'engine',
        id: subjectId,
      });
    }

    /* ------------------------------------------------------ Franchise 对账 */
    const existingFranchises = all<ExistingFranchiseRow>(
      `SELECT id, key, state, title, title_state, title_source, title_candidates, ${schemaVersion()>=15 ? 'origin' : "'auto' AS origin"} FROM franchise_entities`,
    );
    const existingLinkRows = all<{
      franchise_id: number;
      series_id: number;
      state: string;
      evidence: string;
    }>('SELECT franchise_id, series_id, state, evidence FROM franchise_series');
    const existingLinkEvidence = new Map<number, Map<number, string>>();
    const existingLinks = new Map<number, Map<number, string>>();
    const manualOverlayIds = schemaVersion() >= 15
      ? new Map(all<{id:number;franchise_id:number;series_id:number}>(
          'SELECT id,franchise_id,series_id FROM franchise_member_assignments WHERE revoked_at IS NULL',
        ).map(a => [`${a.franchise_id}:${a.series_id}`,a.id]))
      : new Map<string,number>();
    for (const row of existingLinkRows) {
      // The automatic resolver may pin genuine old confirmations, not the
      // confirmed state written by the independent positive assignment layer.
      const manualId = manualOverlayIds.get(`${row.franchise_id}:${row.series_id}`);
      const overlay = manualId === undefined ? undefined : parseJsonColumn<{
        manualAssignment?: number; automatic?: {state:string;evidence:string}
      }>(row.evidence, {});
      const previous = manualId !== undefined && overlay?.manualAssignment === manualId ? overlay.automatic : row;
      if (!previous) continue;
      const evidenceMap =
        existingLinkEvidence.get(Number(row.franchise_id)) ?? new Map<number, string>();
      evidenceMap.set(Number(row.series_id), String(previous.evidence ?? '{}'));
      existingLinkEvidence.set(Number(row.franchise_id), evidenceMap);
      const stateMap = existingLinks.get(Number(row.franchise_id)) ?? new Map<number, string>();
      stateMap.set(Number(row.series_id), String(previous.state));
      existingLinks.set(Number(row.franchise_id), stateMap);
    }
    /*
     * 成员排除（v1.7.0）：人工移出的 Series 不参与该家族的身份匹配与链接重建。
     * 匹配在「治理后的成员集」上进行，保证 recompute 不会把被移出的成员静默加回来，
     * 也不会因为成员变少而丢掉家族身份。
     */
    const exclusionRows = all<{ franchise_id: number; series_id: number }>(
      `SELECT franchise_id, series_id FROM franchise_member_exclusions WHERE state = 'active'`,
    );
    const exclusionsByFranchise = new Map<number, Set<number>>();
    for (const row of exclusionRows) {
      const set = exclusionsByFranchise.get(Number(row.franchise_id)) ?? new Set<number>();
      set.add(Number(row.series_id));
      exclusionsByFranchise.set(Number(row.franchise_id), set);
    }
    const usedFranchises = new Set<number>();

    for (const franchise of resolved.franchises) {
      const memberSeriesIds = franchise.seriesLocalIds.map(
        (localId) => entityIdByLocal.get(localId)!,
      );
      const memberSet = new Set(memberSeriesIds);
      const matched = existingFranchises
        .filter((row) => row.origin!=='manual' && !usedFranchises.has(row.id))
        .map((row) => {
          const excluded = exclusionsByFranchise.get(row.id);
          const oldSet = new Set(
            [...(existingLinks.get(row.id) ?? new Map()).keys()].filter(
              (id) => !excluded?.has(id),
            ),
          );
          const effectiveSet = excluded
            ? new Set([...memberSet].filter((id) => !excluded.has(id)))
            : memberSet;
          let intersection = 0;
          for (const id of effectiveSet) if (oldSet.has(id)) intersection += 1;
          const union = new Set([...oldSet, ...effectiveSet]).size;
          return { row, score: union === 0 ? 0 : intersection / union, intersection };
        })
        .filter((entry) => entry.intersection > 0 && entry.score >= 0.5)
        .sort((a, b) => b.score - a.score || a.row.id - b.row.id)[0]?.row;

      /*
       * 候选治理（v1.6.1）：
       * - rejected 与 confirmed 一样是「人工决定」，重建时不得静默改回候选；
       * - 但如果家族出现了新的成员（新的独立证据），旧否决失效，重新进入候选。
       */
      let rejectedPinned = matched?.state === 'rejected';
      if (rejectedPinned && matched) {
        const existingIds = new Set((existingLinks.get(matched.id) ?? new Map()).keys());
        const added = memberSeriesIds.filter((id) => !existingIds.has(id));
        if (added.length > 0) {
          rejectedPinned = false;
          run(
            `UPDATE franchise_entities SET state = 'candidate', updated_at = :ts, revision = revision + 1 WHERE id = :id`,
            { id: matched.id, ts: timestamp },
          );
          insertEvent('franchise', matched.id, 'candidate_reopened', { added }, timestamp);
        }
      }
      const confirmedPinned = matched?.state === 'confirmed';
      const preservedPinned = (confirmedPinned || rejectedPinned) && Boolean(matched);
      /*
       * 人工移出的成员不参与成员集：统计、名称解析与链接重建都基于
       * 「当前证据 − 人工排除」。Series / Subject / Relation 本身不受影响。
       */
      const excludedForFranchise = matched ? exclusionsByFranchise.get(matched.id) : undefined;
      const effectiveLocalIds = excludedForFranchise?.size
        ? franchise.seriesLocalIds.filter(
            (localId) => !excludedForFranchise.has(entityIdByLocal.get(localId)!),
          )
        : franchise.seriesLocalIds;
      const effectiveSeriesIds = effectiveLocalIds.map((localId) => entityIdByLocal.get(localId)!);
      const effectiveSet = new Set(effectiveSeriesIds);
      const effectiveLinks = franchise.links.filter(
        (link) => effectiveSet.has(entityIdByLocal.get(link.a)!) && effectiveSet.has(entityIdByLocal.get(link.b)!),
      );
      const stats = franchiseStats(effectiveSeriesIds);
      const seriesTitles = effectiveLocalIds.map((localId) => titleByLocal.get(localId) ?? '');
      const seriesTags = effectiveLocalIds.map((localId) => {
        const tags = new Set<string>();
        for (const subjectId of resolved.series[localId]!.primaryIds) {
          for (const tag of input.nodes.get(subjectId)?.tags ?? []) tags.add(tag);
        }
        return [...tags];
      });
      const title =
        preservedPinned && matched
          ? {
              title: matched.title,
              state: matched.title_state as TitleState,
              source: matched.title_source,
              // 人工确认 / 已固定的名称保留候选 provenance（v1.7.0 人工命名）
              candidates: [], // 冻结候选的原始 JSON 在写入时独立保留。
              proposed: null,
            }
          : resolveTitle({
              members: effectiveLocalIds.map((localId, index) => ({
                title: seriesTitles[index] ?? '',
                core: true,
                tags: seriesTags[index] ?? [],
              })),
              anchorTitle: null,
              singleton: false,
              tagFrequency: input.tagFrequency,
              rareTagLimit,
              isExcludedTag: input.isExcludedTag,
              fallbackLabel: `未确认家族（${effectiveSeriesIds.length} 个系列）`,
              existing: matched
                ? {
                    title: matched.title,
                    state: matched.title_state as TitleState,
                    source: matched.title_source,
                  }
                : null,
            });

      let franchiseId: number;
      const generatedCandidates = title.proposed ? [...title.candidates, title.proposed] : title.candidates;
      const storedCandidates = matched?.title_state === 'manual'
        ? titleCandidatesForMutation(matched.title_candidates)
        : null;
      // Name governance is independent of membership confirmation. Preserve the
      // actual manual records even while automatic family evidence is reevaluated;
      // missing/invalid historical provenance must not be reconstructed from a title.
      const candidatesJson = matched?.title_state === 'manual'
        ? storedCandidates === null
          ? matched.title_candidates
          : toJson([
              ...storedCandidates.filter((candidate) => candidate.source === 'manual'),
              ...generatedCandidates,
            ])
        : toJson(generatedCandidates);
      if (matched) {
        usedFranchises.add(matched.id);
        franchiseId = matched.id;
        if (confirmedPinned && one<{ kind: string }>(
          `SELECT kind FROM entity_events WHERE entity_kind='franchise' AND entity_id=:id
             AND kind IN ('conflict_unmatched', 'conflict_resolved') ORDER BY id DESC LIMIT 1`,
          { id: matched.id },
        )?.kind === 'conflict_unmatched') {
          insertEvent('franchise', matched.id, 'conflict_resolved', { key: matched.key }, timestamp);
        }
        run(
          `UPDATE franchise_entities SET
             state = :state, title = :title, title_state = :titleState, title_source = :titleSource,
             title_candidates = :titleCandidates,
             series_count = :seriesCount, confirmed_series_count = :confirmedCount,
             candidate_series_count = :candidateCount, conflict_series_count = :conflictCount,
             known_count = :knownCount, collected_count = :collectedCount,
             average_rate = :averageRate, first_year = :firstYear, last_year = :lastYear,
             updated_at = :updatedAt, revision = revision + 1
           WHERE id = :id`,
          {
            id: franchiseId,
            state: confirmedPinned
              ? 'confirmed'
              : rejectedPinned
                ? 'rejected'
                : franchiseState(effectiveLinks),
            title: title.title,
            titleState: title.state,
            titleSource: title.source,
            titleCandidates: preservedPinned && matched
              ? matched.title_candidates
              : candidatesJson,
            seriesCount: stats.seriesCount,
            confirmedCount: confirmedPinned
              ? effectiveSeriesIds.length
              : effectiveLinks.filter((link) => link.state === 'provisional').length,
            candidateCount: confirmedPinned
              ? 0
              : effectiveLinks.filter((link) => link.state === 'candidate').length,
            conflictCount: 0,
            knownCount: stats.knownCount,
            collectedCount: stats.collectedCount,
            averageRate: stats.averageRate,
            firstYear: stats.firstYear,
            lastYear: stats.lastYear,
            updatedAt: timestamp,
          },
        );
      } else {
        const inserted = run(
          `INSERT INTO franchise_entities (
             key, state, title, title_state, title_source, title_candidates,
             series_count, confirmed_series_count, candidate_series_count, conflict_series_count,
             known_count, collected_count, average_rate, first_year, last_year,
             created_at, updated_at, revision
           ) VALUES (
             :key, :state, :title, :titleState, :titleSource, :titleCandidates,
             :seriesCount, 0, :candidateCount, 0,
             :knownCount, :collectedCount, :averageRate, :firstYear, :lastYear,
             :createdAt, :updatedAt, 1
           )`,
          {
            key: `pending_f${franchise.localId}_${timestamp}`,
            state: franchiseState(effectiveLinks),
            title: title.title,
            titleState: title.state,
            titleSource: title.source,
            titleCandidates: toJson(title.candidates),
            seriesCount: stats.seriesCount,
            candidateCount: effectiveLinks.filter((link) => link.state === 'candidate').length,
            knownCount: stats.knownCount,
            collectedCount: stats.collectedCount,
            averageRate: stats.averageRate,
            firstYear: stats.firstYear,
            lastYear: stats.lastYear,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        );
        franchiseId = inserted.lastInsertRowid;
        run('UPDATE franchise_entities SET key = :key WHERE id = :id', {
          key: `fr_${franchiseId}`,
          id: franchiseId,
        });
        insertEvent('franchise', franchiseId, 'created', { series: effectiveSeriesIds }, timestamp);
        result.newFranchises += 1;
      }

      // 链接重建：confirmed 家族保留已确认链接，新链接以 candidate 进入待确认。
      const existingLinkStates = matched ? existingLinks.get(matched.id) ?? new Map() : new Map();
      const linkByLocal = new Map<number, (typeof effectiveLinks)[number]>();
      for (const link of effectiveLinks) {
        linkByLocal.set(link.a, link);
        if (!linkByLocal.has(link.b)) linkByLocal.set(link.b, link);
      }
      run('DELETE FROM franchise_series WHERE franchise_id = :id', { id: franchiseId });
      for (const localId of effectiveLocalIds) {
        const seriesId = entityIdByLocal.get(localId)!;
        const link = linkByLocal.get(localId);
        const edgeState = confirmedPinned
          ? existingLinkStates.get(seriesId) === 'confirmed'
            ? 'confirmed'
            : 'candidate'
          : link?.state ?? 'candidate';
        /*
         * v1.8.4：supersede 治理写入的 identity provenance 必须跨 recompute 保留 ——
         * 链接 evidence 是派生投影，但「这个成员的身份来自哪次迁移」是不可再生的治理事实。
         */
        const priorEvidence = matched
          ? existingLinkEvidence.get(matched.id)?.get(seriesId)
          : undefined;
        const priorSuperseded = priorEvidence
          ? parseJsonColumn<{ supersededFrom?: unknown }>(priorEvidence, {}).supersededFrom
          : undefined;
        run(
          `INSERT INTO franchise_series (franchise_id, series_id, state, evidence)
           VALUES (:franchiseId, :seriesId, :state, :evidence)`,
          {
            franchiseId,
            seriesId,
            state: edgeState,
            evidence: toJson({
              relations: link?.evidence.relations ?? [],
              classes: link?.evidence.classes ?? [],
              negativeRelations: link?.evidence.negativeRelations ?? [],
              brand: link?.evidence.brand ?? null,
              tag: link?.evidence.tag ?? null,
              source: link?.evidence.source ?? null,
              ...(priorSuperseded ? { supersededFrom: priorSuperseded } : {}),
            }),
          },
        );
        if (confirmedPinned && edgeState === 'candidate') {
          insertEvent('franchise', franchiseId, 'candidate_member', { seriesId }, timestamp);
        }
      }
      // confirmed 家族中消失的链接 → 保留为 conflict，不静默移除。
      if (confirmedPinned && matched) {
        for (const [seriesId, state] of existingLinkStates) {
          if (!['confirmed', 'conflict'].includes(state) || effectiveSet.has(seriesId)) continue;
          run(
            `INSERT INTO franchise_series (franchise_id, series_id, state, evidence)
             VALUES (:franchiseId, :seriesId, 'conflict', :evidence)`,
            { franchiseId, seriesId, evidence: existingLinkEvidence.get(matched.id)?.get(seriesId) ?? '{}' },
          );
          if (state !== 'conflict') insertEvent('franchise', franchiseId, 'conflict', { seriesId }, timestamp);
        }
      }
    }

    for (const row of existingFranchises) {
      if (usedFranchises.has(row.id)) continue;
      if (row.origin==='manual' || (schemaVersion()>=15 && one(
        'SELECT 1 FROM franchise_member_assignments WHERE franchise_id=? AND revoked_at IS NULL LIMIT 1',[row.id],
      ))) continue;
      if (row.state === 'confirmed') {
        // 同一次未匹配状态只记一次；恢复匹配后再次失配仍是新的冲突。
        if (one<{ kind: string }>(
          `SELECT kind FROM entity_events WHERE entity_kind='franchise' AND entity_id=:id
             AND kind IN ('conflict_unmatched', 'conflict_resolved') ORDER BY id DESC LIMIT 1`,
          { id: row.id },
        )?.kind !== 'conflict_unmatched') {
          insertEvent('franchise', row.id, 'conflict_unmatched', { key: row.key }, timestamp);
        }
        continue;
      }
      run(`UPDATE franchise_entities SET state = 'stale', updated_at = :ts WHERE id = :id`, {
        ts: timestamp,
        id: row.id,
      });
    }

    projectManualFranchiseLinks(undefined, usedFranchises);
    // 人工冻结的链接可以比本轮 graph 更完整。聚合必须读取最终 source-of-truth
    // 链接，而不是 graph 的临时有效集合；冲突链接仍保留为家族治理证据。
    for (const franchise of all<{ id: number }>("SELECT id FROM franchise_entities WHERE state <> 'stale'")) {
      // 历史身份链接必须先经过正式 supersede 治理，不能用 generic recompute
      // 抹掉 counter-drift 所承载的结构性冲突证据（Constitution §9.7）。
      if (one(`SELECT fs.series_id FROM franchise_series fs JOIN series_entities e ON e.id = fs.series_id
               WHERE fs.franchise_id = :id AND e.state = 'stale' LIMIT 1`, { id: franchise.id })) continue;
      const links = all<{ series_id: number; state: string }>(
        'SELECT series_id, state FROM franchise_series WHERE franchise_id = :id', { id: franchise.id },
      );
      const stats = franchiseStats(links.map((link) => Number(link.series_id)));
      run(`UPDATE franchise_entities SET series_count = :seriesCount,
           confirmed_series_count = :confirmedCount, candidate_series_count = :candidateCount,
           conflict_series_count = :conflictCount, known_count = :knownCount,
           collected_count = :collectedCount, average_rate = :averageRate,
           first_year = :firstYear, last_year = :lastYear WHERE id = :id`, {
        id: franchise.id, ...stats,
        confirmedCount: links.filter((link) => ['confirmed', 'provisional'].includes(link.state)).length,
        candidateCount: links.filter((link) => link.state === 'candidate').length,
        conflictCount: links.filter((link) => link.state === 'conflict').length,
      });
    }

    /*
     * v1.8.3（B2）：alias 生命周期对账。
     *
     * entity_aliases 是派生解析投影，必须始终指向 live 实体：
     * - 目标失效但沿谱系能找到 live 后继 → 重定向（alias_redirected）；
     * - 找不到合法后继 → 退役（alias_retired），旧 key 诚实 404，而不是悬空。
     */
    reconcileEntityAliases(timestamp, result);
  });

  return result;
}

function entityKindOf(value: string): 'series' | 'franchise' {
  return value === 'franchise' ? 'franchise' : 'series';
}

/** v1.8.3（B2）：alias 生命周期对账（Execute）—— 悬空 alias 必须重定向或退役。 */
function reconcileEntityAliases(timestamp: string, result: SeriesRebuildResult): void {
  const aliases = all<{ alias_key: string; entity_kind: string; entity_id: number; reason: string }>(
    'SELECT alias_key, entity_kind, entity_id, reason FROM entity_aliases',
  );
  for (const alias of aliases) {
    const kind = entityKindOf(alias.entity_kind);
    const table = kind === 'series' ? 'series_entities' : 'franchise_entities';
    const target = one<{ id: number; key: string; state: string }>(
      `SELECT id, key, state FROM ${table} WHERE id = :id`,
      { id: Number(alias.entity_id) },
    );
    if (target && target.state !== 'stale') continue;

    // 沿「旧 key → 后继」链找一个 live 终点；链尾仍是 stale / 缺失 → 退役。
    let currentKey: string | null = target?.key ?? null;
    let destination: { id: number; key: string } | null = null;
    const seen = new Set<number>([Number(alias.entity_id)]);
    for (let guard = 0; currentKey && guard < 8; guard += 1) {
      const next = one<{ entity_id: number }>(
        `SELECT entity_id FROM entity_aliases WHERE alias_key = :key AND entity_kind = :kind`,
        { key: currentKey, kind: alias.entity_kind },
      );
      if (!next) break;
      const nextTarget = one<{ id: number; key: string; state: string }>(
        `SELECT id, key, state FROM ${table} WHERE id = :id`,
        { id: Number(next.entity_id) },
      );
      if (!nextTarget) break;
      if (nextTarget.state !== 'stale') {
        destination = { id: Number(nextTarget.id), key: nextTarget.key };
        break;
      }
      if (seen.has(Number(nextTarget.id))) break;
      seen.add(Number(nextTarget.id));
      currentKey = nextTarget.key;
    }

    if (destination) {
      run(
        `UPDATE entity_aliases SET entity_id = :id
          WHERE alias_key = :key AND entity_kind = :kind`,
        { id: destination.id, key: alias.alias_key, kind: alias.entity_kind },
      );
      insertEvent(
        kind,
        destination.id,
        'alias_redirected',
        {
          aliasKey: alias.alias_key,
          from: Number(alias.entity_id),
          to: destination.id,
          toKey: destination.key,
          reason: alias.reason,
        },
        timestamp,
      );
      result.aliasesRedirected += 1;
    } else {
      run(`DELETE FROM entity_aliases WHERE alias_key = :key AND entity_kind = :kind`, {
        key: alias.alias_key,
        kind: alias.entity_kind,
      });
      insertEvent(
        kind,
        Number(alias.entity_id),
        'alias_retired',
        {
          aliasKey: alias.alias_key,
          oldTarget: Number(alias.entity_id),
          reason: alias.reason,
        },
        timestamp,
      );
      result.aliasesRetired += 1;
    }
  }
}

/** v1.8.3：身份生命周期计划（Preview 与 Execute 共用的只读 dry-run）。 */
export interface EntityLifecyclePlan {
  revivals: Array<{
    id: number;
    key: string;
    title: string;
    titleState: string;
    members: number;
    reason: string;
  }>;
  rebuiltDuplicates: Array<{ key: string; toKey: string }>;
  aliasRedirects: Array<{
    aliasKey: string;
    entityKind: 'series' | 'franchise';
    from: number;
    to: number;
    toKey: string;
    reason: string;
  }>;
  aliasRetirements: Array<{
    aliasKey: string;
    entityKind: 'series' | 'franchise';
    oldTarget: number;
    reason: string;
  }>;
}

/**
 * 只读计算「下一次 recompute 会做哪些身份恢复 / alias 重定向 / alias 退役」。
 * 与 recomputeSeries 共用 planSeriesIdentities 与同一套 alias 规则，
 * 因此 Repair Preview 与实际 Execute 的范围一致。
 */
export function planEntityLifecycle(): EntityLifecyclePlan {
  const input = loadEngineInput();
  const rareTagLimit = Math.max(4, Math.ceil(input.collectedCount * 0.03));
  const resolved = resolveGraph(input.nodes, input.edges, {
    tagFrequency: input.tagFrequency,
    rareTagLimit,
    isExcludedTag: input.isExcludedTag,
  });
  const existingSeries = all<ExistingSeriesRow>(
    `SELECT id, key, state, title, title_state, title_source, anchor_subject_id,
            core_signature, member_count, created_at
       FROM series_entities`,
  );
  const memberMap = buildMemberMap();
  const lastKnownMembers = loadLastKnownMembers();
  const items = planSeriesIdentities(resolved.series, existingSeries, memberMap, lastKnownMembers);

  const revivals = items
    .filter((item) => item.revived && item.survivor)
    .map((item) => ({
      id: item.survivor!.id,
      key: item.survivor!.key,
      title: item.survivor!.title,
      titleState: item.survivor!.title_state,
      members: item.series.primaryIds.length,
      reason: 'identity-match',
    }));
  const rebuiltDuplicates = items
    .filter((item) => item.survivor)
    .flatMap((item) =>
      item.absorbed
        .filter((entry) => entry.reason === 'rebuilt-into')
        .map((entry) => ({ key: entry.row.key, toKey: item.survivor!.key })),
    );

  const aliasRows = all<{ alias_key: string; entity_kind: string; entity_id: number; reason: string }>(
    'SELECT alias_key, entity_kind, entity_id, reason FROM entity_aliases',
  );
  const franchiseRows = all<{ id: number; key: string; state: string }>(
    'SELECT id, key, state FROM franchise_entities',
  );
  const keyById = new Map<string, string>();
  for (const row of existingSeries) keyById.set(`series:${row.id}`, row.key);
  for (const row of franchiseRows) keyById.set(`franchise:${row.id}`, row.key);

  const liveAfter = new Set<string>();
  const revivedIds = new Set(
    items.filter((item) => item.revived && item.survivor).map((item) => `series:${item.survivor!.id}`),
  );
  for (const row of existingSeries) {
    if (row.state !== 'stale' || revivedIds.has(`series:${row.id}`)) {
      liveAfter.add(`series:${row.id}`);
    }
  }
  for (const row of franchiseRows) {
    if (row.state !== 'stale') liveAfter.add(`franchise:${row.id}`);
  }

  const aliasTargets = new Map<string, number>();
  for (const row of aliasRows) {
    aliasTargets.set(`${entityKindOf(row.entity_kind)}:${row.alias_key}`, Number(row.entity_id));
  }
  for (const item of items) {
    if (!item.survivor) continue;
    for (const entry of item.absorbed) {
      aliasTargets.set(`series:${entry.row.key}`, item.survivor.id);
    }
  }

  const aliasRedirects: EntityLifecyclePlan['aliasRedirects'] = [];
  const aliasRetirements: EntityLifecyclePlan['aliasRetirements'] = [];
  for (const row of aliasRows) {
    const kind = entityKindOf(row.entity_kind);
    if (liveAfter.has(`${kind}:${row.entity_id}`)) continue;
    let current = `${kind}:${row.entity_id}`;
    const seen = new Set<string>();
    let destination: string | null = null;
    while (!seen.has(current)) {
      seen.add(current);
      const key = keyById.get(current);
      if (!key) break;
      const next = aliasTargets.get(`${kind}:${key}`);
      if (next === undefined) break;
      const nextRef = `${kind}:${next}`;
      if (liveAfter.has(nextRef)) {
        destination = nextRef;
        break;
      }
      current = nextRef;
    }
    if (destination) {
      aliasRedirects.push({
        aliasKey: row.alias_key,
        entityKind: kind,
        from: Number(row.entity_id),
        to: Number(destination.split(':')[1]),
        toKey: keyById.get(destination) ?? '',
        reason: row.reason,
      });
    } else {
      aliasRetirements.push({
        aliasKey: row.alias_key,
        entityKind: kind,
        oldTarget: Number(row.entity_id),
        reason: row.reason,
      });
    }
  }

  return { revivals, rebuiltDuplicates, aliasRedirects, aliasRetirements };
}

/**
 * 启动兜底：
 * - 升级到 v1.5.1 后若实体表为空，用现有收藏数据重建一次；
 * - v1.8 OD2：若 franchise average_rate 与成员聚合不一致（含历史 NULL），按当前 source 重算一次。
 */
export function ensureSeriesEngine(): boolean {
  // 来源提交与完成投影之间被强杀时，持久化标记保证重启不会只检查平均分漂移。
  if (getMeta('sync_projection_pending') === '1') {
    transaction(() => {
      recomputeSeries();
      recordMutation('sync', 'recover interrupted sync projection');
      setMeta('sync_projection_pending', '0');
      if (getMeta('personal_rating_projection_pending') === '1') {
        setMeta('personal_rating_projection_pending', '0');
      }
    });
    return true;
  }
  let refreshedRatings = false;
  if (getMeta('personal_rating_projection_pending') === '1') {
    // Upgrade existing materialization in place, without rebuilding identity or
    // writing title/alias events just because rating policy changed.
    refreshedRatings = transaction(() => {
      const series = seriesRankingMetricSql('rate', 'real', 'e').value;
      const family = franchiseAverageRateSql('f', 'real');
      const changed =
        run(`UPDATE series_entities AS e SET average_rate=${series}
             WHERE e.state <> 'stale' AND e.average_rate IS NOT ${series}`).changes +
        run(`UPDATE franchise_entities AS f SET average_rate=${family}
             WHERE f.state <> 'stale' AND f.average_rate IS NOT ${family}`).changes;
      if (changed > 0) recordMutation('maintenance', 'refresh current personal rating projections');
      setMeta('personal_rating_projection_pending', '0');
      return changed > 0;
    });
  }
  const existing = one<{ n: number }>('SELECT COUNT(*) AS n FROM series_entities');
  const subjects = one<{ n: number }>('SELECT COUNT(*) AS n FROM subjects');
  if (Number(subjects?.n ?? 0) === 0) return refreshedRatings;
  if (Number(existing?.n ?? 0) > 0) {
    /*
     * v1.8 OD2：旧库升级后 franchise_entities.average_rate 可能仍为 NULL /
     * 与成员聚合不一致。这里按当前 source-of-truth 重算一次派生投影
     * （只重算派生值，不修改任何来源数据）。
     */
    if (franchiseAverageRateDriftCount() > 0) {
      recomputeSeries();
      return true;
    }
    return refreshedRatings;
  }
  recomputeSeries();
  return true;
}

/** 人工确认 Franchise：一旦 confirmed，自动 resolver 不得静默覆盖。 */
export function confirmFranchise(key: string): boolean {
  const resolved = resolveEntityKey('franchise', key);
  if (!resolved) return false;
  const timestamp = nowIso();
  transaction(() => {
    if (schemaVersion()>=15 && one(`SELECT 1 FROM franchise_series fs
      JOIN franchise_member_assignments a ON a.series_id=fs.series_id AND a.revoked_at IS NULL
      WHERE fs.franchise_id=:id AND a.franchise_id<>:id AND fs.state IN ('candidate','provisional') LIMIT 1`,
      {id:resolved.id})) throw new ApiError('已有其他家族的人工归属；请先明确撤销原指定。',{
        code:'manual_assignment_exists',status:409,dataIntact:true,
      });
    run(
      `UPDATE franchise_series SET state = 'confirmed'
       WHERE franchise_id = :id AND state IN ('candidate', 'provisional')`,
      { id: resolved.id },
    );
    run(
      `UPDATE franchise_entities
       SET state = 'confirmed',
           confirmed_series_count = (SELECT COUNT(*) FROM franchise_series WHERE franchise_id = :id AND state = 'confirmed'),
           candidate_series_count = (SELECT COUNT(*) FROM franchise_series WHERE franchise_id = :id AND state = 'candidate'),
           conflict_series_count = (SELECT COUNT(*) FROM franchise_series WHERE franchise_id = :id AND state = 'conflict'),
           updated_at = :ts, revision = revision + 1
       WHERE id = :id`,
      { ts: timestamp, id: resolved.id },
    );
    insertEvent('franchise', resolved.id, 'confirmed', { key: resolved.key }, timestamp);
    recordMutation('governance', `confirm-franchise:${resolved.key}`);
  });
  return true;
}

export interface CandidateDecisionResult {
  ok: boolean;
  code?: 'not_found' | 'unknown_candidate';
  message?: string;
  key?: string;
  previousState?: string;
}

/**
 * 否决家族候选（v1.6.1）。
 *
 * Analyzer 可以推断两个 Series 属于同一家族，但用户拥有最终裁决权：
 * - 状态写入 franchise_entities.state = 'rejected'（真实治理状态，不是 UI 过滤）；
 * - 决定写入 candidate_decisions（保留 key / 标题 / 当时状态等证据快照）；
 * - entity_events 记录历史；
 * - 家族实体与链接不会被删除，证据继续可查看。
 */
export function rejectFranchiseCandidate(key: string, reason = ''): CandidateDecisionResult {
  const resolved = resolveEntityKey('franchise', key);
  if (!resolved) return { ok: false, code: 'not_found', message: '未找到该作品家族' };
  const timestamp = nowIso();
  const row = one<{ id: number; key: string; title: string; state: string; series_count: number }>(
    'SELECT id, key, title, state, series_count FROM franchise_entities WHERE id = :id',
    { id: resolved.id },
  );
  if (!row) return { ok: false, code: 'not_found', message: '未找到该作品家族' };
  if (row.state === 'rejected' && findDecision('franchise', row.id, 'franchise', row.key)?.decision === 'rejected') {
    return { ok: true, key: row.key, previousState: row.state };
  }
  transaction(() => {
    if (schemaVersion()>=15 && one('SELECT 1 FROM franchise_member_assignments WHERE franchise_id=? AND revoked_at IS NULL',[row.id]))
      throw new ApiError('此家族有人工归属，请使用明确的人工撤销流程。',{code:'manual_assignment_exists',status:409,dataIntact:true});
    run(
      `UPDATE franchise_entities
         SET state = 'rejected', updated_at = :ts, revision = revision + 1
       WHERE id = :id`,
      { ts: timestamp, id: row.id },
    );
    recordCandidateDecision({
      entityKind: 'franchise',
      entityId: row.id,
      candidateKind: 'franchise',
      candidateTitle: row.key,
      decision: 'rejected',
      reason,
      evidence: {
        key: row.key,
        title: row.title,
        seriesCount: row.series_count,
        previousState: row.state,
        series: all<{ series_id: number }>(
          'SELECT series_id FROM franchise_series WHERE franchise_id = :id',
          { id: row.id },
        ).map((entry) => entry.series_id),
      },
      timestamp,
    });
    insertEvent(
      'franchise',
      row.id,
      'rejected',
      { key: row.key, title: row.title, previousState: row.state, reason },
      timestamp,
    );
    recordMutation('governance', `reject-franchise:${row.key}`);
  });
  return { ok: true, key: row.key, previousState: row.state };
}

export interface FranchiseGovernanceReset {
  unlocked: number;
  unlockedKeys: string[];
  before: Record<string, number>;
}

/**
 * 一次性治理初始化（v1.6.1）。
 *
 * 解除全部 confirmed 家族的确认锁定，使它们重新进入可重新评估的候选状态：
 * - 不删除任何 Franchise / Series / Subject / 关系证据；
 * - 只把治理状态从 confirmed 降级为 candidate（链接同步降级，避免下次重建被链接状态拉回 confirmed）；
 * - 写入 entity_events 记录这次解锁，便于追溯。
 * 调用方随后应执行 recomputeSeries() 重新计算投影。
 */
export function resetFranchiseGovernance(): FranchiseGovernanceReset {
  const timestamp = nowIso();
  const rows = all<{ id: number; key: string; state: string }>(
    `SELECT id, key, state FROM franchise_entities WHERE state <> 'stale'`,
  );
  const before: Record<string, number> = {};
  for (const row of rows) before[row.state] = (before[row.state] ?? 0) + 1;
  const confirmed = rows.filter((row) => row.state === 'confirmed');
  transaction(() => {
    for (const row of confirmed) {
      run(
        `UPDATE franchise_entities
           SET state = 'candidate', updated_at = :ts, revision = revision + 1
         WHERE id = :id`,
        { ts: timestamp, id: row.id },
      );
      run(
        `UPDATE franchise_series SET state = 'candidate'
          WHERE franchise_id = :id AND state = 'confirmed'`,
        { id: row.id },
      );
      insertEvent('franchise', row.id, 'governance_unlocked', { key: row.key }, timestamp);
    }
    recordMutation('maintenance', 'franchise-governance-reset');
  });
  return {
    unlocked: confirmed.length,
    unlockedKeys: confirmed.map((row) => row.key),
    before,
  };
}

/**
 * 重新评估已否决的家族候选（v1.6.1）。
 *
 * 否决不是永久抹掉：用户可以在家族页面把它放回候选状态，重新参与评估。
 * 旧的否决记录标记为 superseded（历史可追溯），并写入 candidate_reopened 事件。
 */
export function reopenFranchiseCandidate(key: string, reason = ''): CandidateDecisionResult {
  const resolved = resolveEntityKey('franchise', key);
  if (!resolved) return { ok: false, code: 'not_found', message: '未找到该作品家族' };
  const row = one<{ id: number; key: string; state: string }>(
    'SELECT id, key, state FROM franchise_entities WHERE id = :id',
    { id: resolved.id },
  );
  if (!row) return { ok: false, code: 'not_found', message: '未找到该作品家族' };
  if (row.state !== 'rejected') {
    return { ok: false, code: 'unknown_candidate', message: '该家族当前不是已否决状态' };
  }
  const timestamp = nowIso();
  transaction(() => {
    run(
      `UPDATE franchise_entities
         SET state = 'candidate', updated_at = :ts, revision = revision + 1
       WHERE id = :id`,
      { ts: timestamp, id: row.id },
    );
    run(
      `UPDATE candidate_decisions
         SET decision = 'superseded', reason = :reason, updated_at = :ts
       WHERE entity_kind = 'franchise' AND entity_id = :id
         AND candidate_kind = 'franchise' AND decision = 'rejected'`,
      { id: row.id, ts: timestamp, reason: reason || '用户重新评估，旧否决失效' },
    );
    insertEvent(
      'franchise',
      row.id,
      'candidate_reopened',
      { key: row.key, reason, trigger: 'manual' },
      timestamp,
    );
    recordMutation('governance', `reopen-franchise:${row.key}`);
  });
  return { ok: true, key: row.key, previousState: row.state };
}

export interface TitleCandidateRejectResult extends CandidateDecisionResult {
  titleChanged?: boolean;
  newTitle?: string;
}

/**
 * 手动重新进入评估某个被否决的标题候选（v1.6.2）。
 *
 * 与 Franchise 的「重新进入评估」对称：
 * - 旧的 rejected 决定标记为 superseded（保留 provenance 与当时的证据快照）；
 * - 候选清除 rejected 标记，重新参与展示竞争（valid=true）；
 * - 立即重建：resolver 按当前证据重新选择展示名，绝不写入 manual（人工确认只能走 Title Review）；
 * - 记录 candidate_reopened 事件（trigger: manual）。
 */
export function reopenSeriesTitleCandidate(
  key: string,
  title: string,
  reason = '',
): TitleCandidateRejectResult {
  const resolved = resolveEntityKey('series', key);
  if (!resolved) return { ok: false, code: 'not_found', message: '未找到该系列' };
  const row = one<{
    id: number;
    key: string;
    title: string;
    title_state: string;
    title_candidates: string;
  }>('SELECT id, key, title, title_state, title_candidates FROM series_entities WHERE id = :id', {
    id: resolved.id,
  });
  if (!row) return { ok: false, code: 'not_found', message: '未找到该系列' };
  const candidates = titleCandidatesForMutation(row.title_candidates);
  if (!candidates) return { ok: false, code: 'unknown_candidate', message: '历史候选证据结构异常，已保留原始数据并停止治理写入' };
  const targetKey = candidateKeyOf(title);
  const match = candidates.find(
    (candidate) => candidateKeyOf(String(candidate.title)) === targetKey,
  );
  if (!match) {
    return { ok: false, code: 'unknown_candidate', message: '该候选不在当前候选列表中' };
  }
  const decision = findDecision('series', row.id, 'title', title);
  if (!decision || decision.decision !== 'rejected') {
    return { ok: false, code: 'unknown_candidate', message: '该候选当前不是已否决状态' };
  }
  const timestamp = nowIso();
  transaction(() => {
    recordCandidateDecision({
      entityKind: 'series',
      entityId: row.id,
      candidateKind: 'title',
      candidateTitle: String(match.title),
      decision: 'superseded',
      reason: reason || '用户手动重新进入评估',
      evidence: {
        support: match.support ?? 1,
        coverage: match.coverage ?? 0,
        sources: [match.source],
        previousRejectReason: decision.reason,
        previousEvidence: decision.evidence,
      },
      timestamp,
    });
    const updated = candidates.map((candidate) =>
      candidateKeyOf(String(candidate.title)) === targetKey
        ? { ...candidate, valid: true, rejected: false, rejectedAt: null, rejectReason: null }
        : candidate,
    );
    run(
      `UPDATE series_entities
         SET title_candidates = :candidates, updated_at = :ts, revision = revision + 1
       WHERE id = :id`,
      { candidates: toJson(updated), ts: timestamp, id: row.id },
    );
    insertEvent(
      'series',
      row.id,
      'candidate_reopened',
      { title: match.title, reason, trigger: 'manual' },
      timestamp,
    );
    // 立即按当前证据重新解析：候选回到竞争，但不会变成 manual
    recomputeSeries();
    recordMutation('governance', `reopen-title:${row.key}`);
  });
  const fresh = one<{ title: string; title_state: string }>(
    'SELECT title, title_state FROM series_entities WHERE id = :id',
    { id: row.id },
  );
  return {
    ok: true,
    key: row.key,
    titleChanged: fresh?.title !== row.title,
    newTitle: fresh?.title ?? row.title,
  };
}

/**
 * 否决某个标题候选（v1.6.1）。
 *
 * - 决定写入 candidate_decisions，候选在 JSON 中保留但 valid=false + rejected 标记；
 * - 否决会立即影响搜索投影（valid !== true 不再作为别名）；
 * - 如果被否决的正是当前展示标题，立即重建并选择下一个有效候选（不偷偷用回被否决的名字）。
 */
export function rejectSeriesTitleCandidate(
  key: string,
  title: string,
  reason = '',
): TitleCandidateRejectResult {
  const resolved = resolveEntityKey('series', key);
  if (!resolved) return { ok: false, code: 'not_found', message: '未找到该系列' };
  const row = one<{ id: number; key: string; title: string; title_state: string; title_candidates: string }>(
    'SELECT id, key, title, title_state, title_candidates FROM series_entities WHERE id = :id',
    { id: resolved.id },
  );
  if (!row) return { ok: false, code: 'not_found', message: '未找到该系列' };
  const candidates = titleCandidatesForMutation(row.title_candidates);
  if (!candidates) return { ok: false, code: 'unknown_candidate', message: '历史候选证据结构异常，已保留原始数据并停止治理写入' };
  const targetKey = candidateKeyOf(title);
  const match = candidates.find((candidate) => candidateKeyOf(String(candidate.title)) === targetKey);
  if (!match) {
    return { ok: false, code: 'unknown_candidate', message: '该候选不在当前候选列表中' };
  }
  if (match.valid === false && findDecision('series', row.id, 'title', String(match.title))?.decision === 'rejected') {
    return { ok: true, key: row.key, titleChanged: false, newTitle: row.title };
  }
  const timestamp = nowIso();
  const isCurrent = candidateKeyOf(row.title) === targetKey && row.title_state !== 'manual';
  transaction(() => {
    recordCandidateDecision({
      entityKind: 'series',
      entityId: row.id,
      candidateKind: 'title',
      candidateTitle: String(match.title),
      decision: 'rejected',
      reason,
      evidence: {
        support: match.support ?? 1,
        coverage: match.coverage ?? 0,
        sources: [match.source],
        previousTitle: row.title,
        previousState: row.title_state,
      },
      timestamp,
    });
    const updated = candidates.map((candidate) =>
      candidateKeyOf(String(candidate.title)) === targetKey
        ? {
            ...candidate,
            valid: false,
            rejected: true,
            rejectedAt: timestamp,
            rejectReason: reason || '人工否决',
          }
        : candidate,
    );
    run(
      `UPDATE series_entities
         SET title_candidates = :candidates, updated_at = :ts, revision = revision + 1
       WHERE id = :id`,
      { candidates: toJson(updated), ts: timestamp, id: row.id },
    );
    insertEvent(
      'series',
      row.id,
      'candidate_rejected',
      { title: match.title, reason, wasCurrent: isCurrent },
      timestamp,
    );
    if (isCurrent) recomputeSeries();
    recordMutation('governance', `reject-title:${row.key}`);
  });
  if (!isCurrent) return { ok: true, key: row.key, titleChanged: false, newTitle: row.title };
  const fresh = one<{ title: string }>('SELECT title FROM series_entities WHERE id = :id', {
    id: row.id,
  });
  return {
    ok: true,
    key: row.key,
    titleChanged: fresh?.title !== row.title,
    newTitle: fresh?.title ?? row.title,
  };
}

/* ------------------------------------------------- Title Review / 人工覆盖 */

function titleOverrideFailure(
  code: 'not_found' | 'invalid_title' | 'unknown_candidate',
  message: string,
): TitleOverrideResult {
  return { ok: false, code, message };
}

/**
 * Title Review：把某个候选 / 自定义名称 / 当前名称确认为 manual canonical title。
 *
 * 一旦写入 manual，自动 resolver 只能生成 proposal，不得覆盖（见 resolveTitle 的
 * locked 分支与 recomputeSeries 的对账逻辑）。
 */
export function applySeriesTitleOverride(
  key: string,
  input: TitleOverrideInput,
): TitleOverrideResult {
  const resolved = resolveEntityKey('series', key);
  if (!resolved) return titleOverrideFailure('not_found', '未找到该系列');
  const row = one<{ title: string; title_state: string; title_candidates: string }>(
    'SELECT title, title_state, title_candidates FROM series_entities WHERE id = :id',
    { id: resolved.id },
  );
  if (!row) return titleOverrideFailure('not_found', '未找到该系列');

  const candidates = titleCandidatesForMutation(row.title_candidates);
  if (!candidates) return titleOverrideFailure('unknown_candidate', '历史候选证据结构异常，已保留原始数据并停止治理写入');

  let nextTitle = row.title;
  if (input.mode !== 'confirm-current') {
    const rawInput = input.title ?? '';
    if (/[\u0000-\u001f\u007f]/.test(rawInput)) {
      return titleOverrideFailure('invalid_title', '标题不能包含控制字符');
    }
    const raw = rawInput.trim().replace(/\s{2,}/g, ' ');
    if (!raw) return titleOverrideFailure('invalid_title', '标题不能为空');
    if (raw.length > TITLE_MAX_LENGTH) {
      return titleOverrideFailure('invalid_title', `标题不能超过 ${TITLE_MAX_LENGTH} 个字符`);
    }
    if (input.mode === 'candidate') {
      if (!candidates.some((candidate) => candidate.title === raw)) {
        return titleOverrideFailure('unknown_candidate', '该候选不存在，请刷新后重试');
      }
    }
    nextTitle = raw;
  }

  const timestamp = nowIso();
  transaction(() => {
    const manualCandidate: TitleCandidate = {
      title: nextTitle,
      source: 'manual',
      state: 'manual',
      evidence: '人工确认',
      valid: true,
      support: 1,
      coverage: 0,
    };
    const kept = candidates.filter(
      (candidate) => !(candidate.source === 'manual' && candidate.title === nextTitle),
    );
    run(
      `UPDATE series_entities SET
         title = :title, title_state = 'manual', title_source = 'manual',
         title_confirmed_at = :ts, title_candidates = :candidates,
         updated_at = :ts, revision = revision + 1
       WHERE id = :id`,
      {
        id: resolved.id,
        title: nextTitle,
        ts: timestamp,
        candidates: toJson([manualCandidate, ...kept]),
      },
    );
    insertEvent(
      'series',
      resolved.id,
      'title_manual',
      { from: row.title, fromState: row.title_state, to: nextTitle, mode: input.mode },
      timestamp,
    );
    recordMutation('governance', `title-override:${resolved.key}`);
  });
  return { ok: true, key: resolved.key, title: nextTitle };
}

/**
 * 恢复自动解析：清除人工确认，立即用当前证据重新推导展示名。
 * 仅用于纠正误操作，不改变 resolver 规则。
 */
export function resetSeriesTitleOverride(key: string): TitleOverrideResult {
  const resolved = resolveEntityKey('series', key);
  if (!resolved) return titleOverrideFailure('not_found', '未找到该系列');
  const row = one<{ title: string; title_state: string }>(
    'SELECT title, title_state FROM series_entities WHERE id = :id',
    { id: resolved.id },
  );
  if (!row) return titleOverrideFailure('not_found', '未找到该系列');
  if (row.title_state !== 'manual') {
    return titleOverrideFailure('invalid_title', '当前名称不是人工确认状态，无需恢复');
  }
  const timestamp = nowIso();
  transaction(() => {
    run(
      `UPDATE series_entities SET
         title_state = 'provisional', title_source = 'auto',
         title_confirmed_at = NULL, updated_at = :ts, revision = revision + 1
       WHERE id = :id`,
      { id: resolved.id, ts: timestamp },
    );
    insertEvent('series', resolved.id, 'title_reset', { from: row.title }, timestamp);
    // 立即重建，让展示名回到当前证据下的自动结果
    recomputeSeries();
    recordMutation('governance', `title-reset:${resolved.key}`);
  });
  const after = one<{ title: string }>('SELECT title FROM series_entities WHERE id = :id', {
    id: resolved.id,
  });
  return { ok: true, key: resolved.key, title: after?.title ?? row.title };
}
