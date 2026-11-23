import { validRelationSql } from './metadata.js';
/**
 * Series / IP 域内「伪全局搜索」。
 *
 * 搜索语义复用 Library Global Search 的成熟做法：
 * - 身份字段（title / name / name_cn / alias）的部分匹配；
 * - `%q%` 等价的 substring + 前缀 + 完全匹配三档；
 * - 额外复用 searchStaff 的 compact 归一化（忽略空白与标点）作为兜底档位。
 *
 * 与 Library 的差异只在结果语义：
 * - 内部允许 Subject 命中，但必须先按 Subject → Series → Franchise 聚合；
 * - 同一个实体只返回一次，命中来源用于 explainability；
 * - 搜索域永远是完整实体表，不受列表筛选 / 排序 / 单成员隐藏影响；
 * - 只索引身份文本（当前标题、有效候选、成员标题、成员别名、relation 名称），
 *   不索引 tag / 制作人员 / 诊断信息 / 被否决候选。
 */

import type {
  FranchiseSearchHit,
  IpSearchMatch,
  IpSearchResponse,
  SeriesSearchHit,
} from '@bangumi-analyzer/shared';
import { all } from './index.js';
import { parseJsonColumn, parseStringArrayColumn } from '../util.js';
import {
  franchiseVisibilityClause,
  personalHidesActive,
  personallyVisibleId,
  publicFranchiseTitle,
  publicSeriesTitle,
  relatedSubjectVisibilityClause,
  seriesVisibilityClause,
  subjectVisibilityClause,
} from './visibility.js';

const TYPE_PRIORITY: Record<IpSearchMatch['type'], number> = {
  title: 0,
  alias: 1,
  series: 2,
  member: 3,
  'member-alias': 4,
  key: 5,
};

const MAX_REASONS = 5;

/**
 * 用户可见命中原因的「具体程度」偏好：同一文本被多种证据命中时，
 * 保留最具体、最接近用户认知的那一条（标题 > 成员 > 成员别名 > 成员 Series > 别名 > key）。
 * 内部证据仍然独立存在，这里只做展示层语义去重。
 */
const REASON_KEEP_PRIORITY: Record<IpSearchMatch['type'], number> = {
  title: 0,
  member: 1,
  'member-alias': 2,
  series: 3,
  alias: 4,
  key: 5,
};

function normalizeReasonText(text: string): string {
  return (text ?? '').trim().toLowerCase().replace(/[\s\p{P}]+/gu, '');
}

/**
 * 语义去重：同一个文本（同一 Subject / 同一名称）多次命中时只保留一条用户可见原因。
 * via 不同的成员命中视为不同上下文，不合并。
 */
function dedupeReasons(reasons: IpSearchMatch[]): IpSearchMatch[] {
  const groups = new Map<string, IpSearchMatch[]>();
  const order: string[] = [];
  for (const reason of reasons) {
    const key = `${normalizeReasonText(reason.text)}::${reason.via ?? ''}`;
    if (!groups.has(key)) order.push(key);
    const list = groups.get(key) ?? [];
    list.push(reason);
    groups.set(key, list);
  }
  return order.map((key) => {
    const list = groups.get(key)!;
    return [...list].sort(
      (a, b) => (REASON_KEEP_PRIORITY[a.type] ?? 9) - (REASON_KEEP_PRIORITY[b.type] ?? 9),
    )[0]!;
  });
}

interface SearchNeedle {
  lower: string;
  compact: string;
}

function makeNeedle(query: string): SearchNeedle | null {
  const raw = (query ?? '').trim();
  if (!raw) return null;
  const compact = raw.replace(/[\s\p{P}]+/gu, '').toLowerCase();
  return { lower: raw.toLowerCase(), compact };
}

/** 与 Library 搜索一致的匹配档位：完全 → 前缀 → 包含 → 归一化包含。 */
function matchQuality(text: string, needle: SearchNeedle): number | null {
  const value = (text ?? '').trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === needle.lower) return 0;
  if (lower.startsWith(needle.lower)) return 1;
  if (lower.includes(needle.lower)) return 2;
  if (needle.compact.length >= 2) {
    const compact = value.replace(/[\s\p{P}]+/gu, '').toLowerCase();
    if (compact.includes(needle.compact)) return 3;
  }
  return null;
}

interface SearchEntry {
  type: IpSearchMatch['type'];
  text: string;
  via?: string;
}

interface ScoredHit<T> {
  payload: T;
  typePriority: number;
  quality: number;
  memberCount: number;
  title: string;
  reasons: IpSearchMatch[];
}

function scoreEntries(
  entries: SearchEntry[],
  needle: SearchNeedle,
): { typePriority: number; quality: number; reasons: IpSearchMatch[] } | null {
  let best: { typePriority: number; quality: number } | null = null;
  const reasons: IpSearchMatch[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const quality = matchQuality(entry.text, needle);
    if (quality === null) continue;
    const typePriority = TYPE_PRIORITY[entry.type] ?? 9;
    if (!best || typePriority < best.typePriority || (typePriority === best.typePriority && quality < best.quality)) {
      best = { typePriority, quality };
    }
    const key = `${entry.type}:${entry.text}:${entry.via ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push({ type: entry.type, text: entry.text, ...(entry.via ? { via: entry.via } : {}) });
  }
  if (!best) return null;
  return {
    typePriority: best.typePriority,
    quality: best.quality,
    reasons: dedupeReasons(reasons).slice(0, MAX_REASONS),
  };
}

function validCandidateTitles(raw: string | null): string[] {
  const candidates = parseJsonColumn<unknown>(raw, []);
  // 语义分层：candidate →（结构校验）→ 有效身份候选 → 可搜索 alias。
  // 这里严格要求 valid === true：valid=false 是明确否决，valid 缺失（旧数据 / 未知）
  // 同样不进入搜索索引，避免「没被否决」被误解为「可以公开作为搜索词」。
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const entry = candidate as { valid?: unknown; title?: unknown };
    return entry.valid === true && typeof entry.title === 'string' && entry.title.trim()
      ? [entry.title.trim()] : [];
  });
}

interface CoverRow {
  id: number;
  title: string;
}

interface SeriesProjectionRow {
  key: string;
  title: string;
  title_state: string;
  state: string;
  member_count: number;
  collected_count: number;
  title_candidates: string | null;
  cover_subjects: string | null;
  subject_titles: string | null;
  subject_alias_groups: string | null;
  relation_names: string | null;
}

function buildSeriesEntries(row: SeriesProjectionRow): SearchEntry[] {
  const entries: SearchEntry[] = [{ type: 'title', text: row.title }];
  for (const candidate of validCandidateTitles(row.title_candidates)) {
    if (candidate !== row.title) entries.push({ type: 'alias', text: candidate });
  }
  const subjectTitles = parseStringArrayColumn(row.subject_titles);
  for (const title of subjectTitles) {
    if (title && title !== row.title) entries.push({ type: 'member', text: title });
  }
  for (const group of parseJsonColumn<Array<string | string[]>>(row.subject_alias_groups, [])) {
    // SQLite 的 json_group_array 会把 JSON 文本再包一层字符串，这里做一次兼容解析
    const aliases = typeof group === 'string' ? parseJsonColumn<string[]>(group, []) : group;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias === 'string' && alias.trim()) entries.push({ type: 'member-alias', text: alias.trim() });
    }
  }
  for (const name of parseStringArrayColumn(row.relation_names)) {
    if (name && name.trim()) entries.push({ type: 'member', text: name.trim() });
  }
  return entries;
}

function seriesProjectionSql(): string {
  const memberVisible = `AND ${subjectVisibilityClause('s')}`;
  const relationVisible = `${relatedSubjectVisibilityClause('r.related_id')} AND ${personallyVisibleId('r.subject_id')}`;
  return /* sql */ `
  SELECT e.key, ${publicSeriesTitle('e')} AS title, e.title_state, e.state, e.member_count, e.collected_count,
         ${personalHidesActive() ? "'[]'" : 'e.title_candidates'} AS title_candidates,
         (SELECT json_group_array(json_object('id', x.id, 'title', x.title))
            FROM (SELECT m.subject_id AS id, COALESCE(NULLIF(s.name_cn, ''), s.name) AS title
                    FROM series_entity_members m JOIN subjects s ON s.id = m.subject_id
                   WHERE m.series_id = e.id AND m.role = 'primary' AND s.cover_url IS NOT NULL ${memberVisible}
                   ORDER BY m.position ASC, m.subject_id ASC LIMIT 6) x) AS cover_subjects,
         (SELECT json_group_array(x.title)
            FROM (SELECT COALESCE(NULLIF(s.name_cn, ''), s.name) AS title
                    FROM series_entity_members m JOIN subjects s ON s.id = m.subject_id
                   WHERE m.series_id = e.id AND m.role = 'primary' ${memberVisible}) x) AS subject_titles,
         (SELECT json_group_array(x.aliases)
            FROM (SELECT s.aliases AS aliases
                    FROM series_entity_members m JOIN subjects s ON s.id = m.subject_id
                   WHERE m.series_id = e.id AND m.role = 'primary' ${memberVisible}) x) AS subject_alias_groups,
         (SELECT json_group_array(x.name)
            FROM (SELECT COALESCE(NULLIF(r.name_cn, ''), r.name) AS name
                    FROM subject_relations r
                   WHERE ${validRelationSql('r')} AND r.related_id IN (SELECT subject_id FROM series_entity_members WHERE series_id = e.id)
                     AND ${validRelationSql('r')} AND NOT EXISTS (SELECT 1 FROM subjects s2 WHERE s2.id = r.related_id)
                     AND ${relationVisible}
                     AND COALESCE(NULLIF(r.name_cn, ''), r.name) <> ''
                   GROUP BY r.related_id) x) AS relation_names
  FROM series_entities e
  WHERE e.state <> 'stale' AND ${seriesVisibilityClause('e')}
`;
}

export function searchSeriesEntities(
  query: string,
  options: { limit?: number } = {},
): IpSearchResponse<SeriesSearchHit> {
  const needle = makeNeedle(query);
  const empty: IpSearchResponse<SeriesSearchHit> = { query: '', total: 0, items: [] };
  if (!needle) return empty;
  const limit = Math.min(100, Math.max(1, Math.round(options.limit ?? 40)));

  const rows = all<SeriesProjectionRow>(seriesProjectionSql());
  const hits: ScoredHit<SeriesSearchHit>[] = [];
  for (const row of rows) {
    const scored = scoreEntries(buildSeriesEntries(row), needle);
    const keyHit = matchQuality(row.key, needle) === 0 ? [{ type: 'key' as const, text: row.key }] : [];
    if (!scored && keyHit.length === 0) continue;
    const reasons = dedupeReasons([...(scored?.reasons ?? []), ...keyHit]).slice(0, MAX_REASONS);
    hits.push({
      payload: {
        key: row.key,
        title: row.title,
        titleState: row.title_state as SeriesSearchHit['titleState'],
        state: row.state,
        memberCount: Number(row.member_count),
        collectedCount: Number(row.collected_count),
        coverSubjects: parseJsonColumn<CoverRow[]>(row.cover_subjects, []),
        matchReasons: reasons,
      },
      typePriority: scored?.typePriority ?? TYPE_PRIORITY.key,
      quality: scored?.quality ?? 0,
      memberCount: Number(row.member_count),
      title: row.title,
      reasons,
    });
  }

  hits.sort(
    (a, b) =>
      a.typePriority - b.typePriority ||
      a.quality - b.quality ||
      b.memberCount - a.memberCount ||
      a.title.localeCompare(b.title, 'zh-Hans-CN') ||
      a.payload.key.localeCompare(b.payload.key),
  );
  return { query: String(query).trim(), total: hits.length, items: hits.slice(0, limit).map((hit) => hit.payload) };
}

/**
 * 搜索可达性自检（v1.6.1）：每个实体用「自己的展示标题」作为查询，必须能命中自己。
 *
 * 复用与 searchSeriesEntities 完全相同的投影与匹配逻辑，因此检查的是真实产品路径，
 * 而不是另写一套简化匹配。返回所有未命中的实体（正常情况下应为空）。
 */
export function seriesSearchSelfCheck(): Array<{ key: string; title: string }> {
  const rows = all<SeriesProjectionRow>(seriesProjectionSql());
  const failures: Array<{ key: string; title: string }> = [];
  for (const row of rows) {
    const needle = makeNeedle(row.title);
    const scored = needle ? scoreEntries(buildSeriesEntries(row), needle) : null;
    const keyHit = matchQuality(row.key, needle ?? { lower: '', compact: '' }) === 0;
    if (!scored && !keyHit) failures.push({ key: row.key, title: row.title });
  }
  return failures;
}

/** Franchise 版本的搜索可达性自检。 */
export function franchiseSearchSelfCheck(): Array<{ key: string; title: string }> {
  const rows = all<FranchiseProjectionRow>(franchiseProjectionSql());
  const failures: Array<{ key: string; title: string }> = [];
  for (const row of rows) {
    const entries = buildFranchiseEntries(row);
    const needle = makeNeedle(row.title);
    const scored = needle ? scoreEntries(entries, needle) : null;
    if (!scored) failures.push({ key: row.key, title: row.title });
  }
  return failures;
}

interface FranchiseProjectionRow {
  key: string;
  title: string;
  title_state: string;
  state: string;
  series_count: number;
  collected_count: number;
  title_candidates: string | null;
  cover_subjects: string | null;
  series_titles: string | null;
  member_entries: string | null;
  subject_alias_groups: string | null;
  relation_entries: string | null;
}

/** 与 searchFranchiseEntities 共用的搜索条目构建（自检与搜索必须保持同一语义）。 */
function buildFranchiseEntries(row: FranchiseProjectionRow): SearchEntry[] {
  const entries: SearchEntry[] = [{ type: 'title', text: row.title }];
  for (const candidate of validCandidateTitles(row.title_candidates)) {
    if (candidate !== row.title) entries.push({ type: 'alias', text: candidate });
  }
  for (const seriesTitle of parseStringArrayColumn(row.series_titles)) {
    if (seriesTitle && seriesTitle !== row.title) entries.push({ type: 'series', text: seriesTitle });
  }
  for (const entry of parseJsonColumn<Array<{ title: string; series: string }>>(row.member_entries, [])) {
    if (entry?.title) {
      entries.push({ type: 'member', text: entry.title, ...(entry.series ? { via: entry.series } : {}) });
    }
  }
  for (const group of parseJsonColumn<Array<string | string[]>>(row.subject_alias_groups, [])) {
    const aliases = typeof group === 'string' ? parseJsonColumn<string[]>(group, []) : group;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias === 'string' && alias.trim()) entries.push({ type: 'member-alias', text: alias.trim() });
    }
  }
  for (const entry of parseJsonColumn<Array<{ name: string; series: string }>>(row.relation_entries, [])) {
    if (entry?.name?.trim()) {
      entries.push({
        type: 'member',
        text: entry.name.trim(),
        ...(entry.series ? { via: entry.series } : {}),
      });
    }
  }
  return entries;
}

function franchiseProjectionSql(): string {
  const memberVisible = `AND ${subjectVisibilityClause('s')}`;
  const relationVisible = `${relatedSubjectVisibilityClause('r.related_id')} AND ${personallyVisibleId('r.subject_id')}`;
  return /* sql */ `
  SELECT f.key, ${publicFranchiseTitle('f')} AS title, f.title_state, f.state, f.series_count, f.collected_count,
         ${personalHidesActive() ? "'[]'" : 'f.title_candidates'} AS title_candidates,
         (SELECT json_group_array(json_object('id', x.id, 'title', x.title))
            FROM (SELECT m.subject_id AS id, COALESCE(NULLIF(s.name_cn, ''), s.name) AS title
                    FROM franchise_series fs
                    JOIN series_entities e2 ON e2.id = fs.series_id
                    JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
                    JOIN subjects s ON s.id = m.subject_id
                   WHERE fs.franchise_id = f.id AND fs.state <> 'conflict' AND e2.state <> 'stale'
                     AND ${seriesVisibilityClause('e2')} AND s.cover_url IS NOT NULL ${memberVisible}
                   ORDER BY fs.series_id ASC, m.position ASC LIMIT 6) x) AS cover_subjects,
         (SELECT json_group_array(x.title)
            FROM (SELECT ${publicSeriesTitle('e2')} AS title
                    FROM franchise_series fs JOIN series_entities e2 ON e2.id = fs.series_id
                   WHERE fs.franchise_id = f.id AND fs.state <> 'conflict' AND e2.state <> 'stale'
                     AND ${seriesVisibilityClause('e2')}) x) AS series_titles,
         (SELECT json_group_array(json_object('title', x.title, 'series', x.series))
            FROM (SELECT COALESCE(NULLIF(s.name_cn, ''), s.name) AS title, ${publicSeriesTitle('e2')} AS series
                    FROM franchise_series fs
                    JOIN series_entities e2 ON e2.id = fs.series_id
                    JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
                    JOIN subjects s ON s.id = m.subject_id
                   WHERE fs.franchise_id = f.id AND fs.state <> 'conflict' AND e2.state <> 'stale'
                     AND ${seriesVisibilityClause('e2')} ${memberVisible}) x) AS member_entries,
         (SELECT json_group_array(x.aliases)
            FROM (SELECT s.aliases AS aliases
                    FROM franchise_series fs
                    JOIN series_entities e2 ON e2.id = fs.series_id
                    JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
                    JOIN subjects s ON s.id = m.subject_id
                   WHERE fs.franchise_id = f.id AND fs.state <> 'conflict' AND e2.state <> 'stale'
                     AND ${seriesVisibilityClause('e2')} ${memberVisible}) x) AS subject_alias_groups,
         (SELECT json_group_array(json_object('name', x.name, 'series', x.series))
            FROM (SELECT COALESCE(NULLIF(r.name_cn, ''), r.name) AS name, ${publicSeriesTitle('e2')} AS series
                    FROM franchise_series fs
                    JOIN series_entities e2 ON e2.id = fs.series_id
                    JOIN series_entity_members m ON m.series_id = fs.series_id
                    JOIN subject_relations r ON r.related_id = m.subject_id
                   WHERE fs.franchise_id = f.id AND fs.state <> 'conflict' AND e2.state <> 'stale'
                     AND ${seriesVisibilityClause('e2')}
                     AND ${validRelationSql('r')} AND NOT EXISTS (SELECT 1 FROM subjects s2 WHERE s2.id = r.related_id)
                     AND ${relationVisible}
                     AND COALESCE(NULLIF(r.name_cn, ''), r.name) <> ''
                   GROUP BY r.related_id) x) AS relation_entries
  FROM franchise_entities f
  WHERE f.state <> 'stale' AND ${franchiseVisibilityClause('f')}
`;
}

export function searchFranchiseEntities(
  query: string,
  options: { limit?: number } = {},
): IpSearchResponse<FranchiseSearchHit> {
  const needle = makeNeedle(query);
  const empty: IpSearchResponse<FranchiseSearchHit> = { query: '', total: 0, items: [] };
  if (!needle) return empty;
  const limit = Math.min(100, Math.max(1, Math.round(options.limit ?? 40)));

  const rows = all<FranchiseProjectionRow>(franchiseProjectionSql());
  const hits: ScoredHit<FranchiseSearchHit>[] = [];
  for (const row of rows) {
    const scored = scoreEntries(buildFranchiseEntries(row), needle);
    if (!scored) continue;
    hits.push({
      payload: {
        key: row.key,
        title: row.title,
        titleState: row.title_state as FranchiseSearchHit['titleState'],
        state: row.state,
        seriesCount: Number(row.series_count),
        collectedCount: Number(row.collected_count),
        coverSubjects: parseJsonColumn<CoverRow[]>(row.cover_subjects, []),
        matchReasons: scored.reasons,
      },
      typePriority: scored.typePriority,
      quality: scored.quality,
      memberCount: Number(row.series_count),
      title: row.title,
      reasons: scored.reasons,
    });
  }

  hits.sort(
    (a, b) =>
      a.typePriority - b.typePriority ||
      a.quality - b.quality ||
      b.memberCount - a.memberCount ||
      a.title.localeCompare(b.title, 'zh-Hans-CN') ||
      a.payload.key.localeCompare(b.payload.key),
  );
  return { query: String(query).trim(), total: hits.length, items: hits.slice(0, limit).map((hit) => hit.payload) };
}
