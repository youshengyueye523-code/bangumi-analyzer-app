/**
 * 把 Bangumi 原始响应转换为数据库行。
 * 所有派生字段（格式、年份、季度、制作公司、别名…）都在这里集中计算，
 * 保证同步逻辑与统计逻辑读取的是同一套口径。
 */

import {
  bgmSubjectSchema,
  asInfoboxValue,
  extractDirectors,
  extractOriginalWorks,
  extractStudios,
  flattenInfoboxEntries,
  flattenInfoboxValue,
  normalizeFormat,
  parseAirDate,
  type BgmCollectionItem,
  type BgmPersonRelation,
  type BgmSubject,
  type BgmSubjectRelation,
  type InfoboxItem,
} from '@bangumi-analyzer/shared';
import { toJson } from '../util.js';
import { subjectSource } from './subjectSource.js';

export interface SubjectRow {
  id: number;
  type: number;
  name: string;
  name_cn: string;
  aliases: string;
  platform: string;
  format: string;
  date: string | null;
  year: number | null;
  month: number | null;
  season: string | null;
  year_month: string | null;
  year_quarter: string | null;
  eps: number;
  /** 本次 slim 响应是否明确提供话数；不持久化，避免把缺失字段当成合法零值。 */
  eps_provided?: boolean;
  total_episodes: number;
  volumes: number;
  score: number | null;
  rank: number | null;
  rating_total: number | null;
  rating_dist: string | null;
  collection_stats: string | null;
  collection_total: number;
  /** NULL/absent = legacy ambiguity, 0 = new unknown, 1 = explicit source. */
  collection_total_known?: number | null;
  meta_tags: string;
  tags: string;
  tag_names: string;
  infobox: string | null;
  studios: string;
  directors: string;
  originals: string;
  summary: string;
  images: string;
  cover_url: string | null;
  nsfw: number;
  locked: number;
  is_series: number;
  raw: string | null;
}

export interface CollectionRow {
  subject_id: number;
  subject_type: number;
  type: number;
  rate: number;
  ep_status: number;
  vol_status: number;
  comment: string;
  tags: string;
  private: number;
  updated_at: string | null;
  raw: string;
}

export interface StaffRow {
  subject_id: number;
  person_id: number | null;
  name: string;
  relation: string;
  career: string;
  source: 'person-api' | 'infobox';
}

export interface RelationRow {
  subject_id: number;
  related_id: number;
  relation: string;
  type: number;
  name: string;
  name_cn: string;
}

/**
 * 提取用于筛选 / 统计的标签名。
 *
 * 这里**不做条数截断**：Bangumi 详情接口每个条目最多返回 30 个标签，
 * 早期版本只保留前 24 个，导致长尾标签无法被筛选与反向追溯。
 * 现在完整保存接口返回的全部标签，并保持接口给出的顺序（按热度）。
 */
function tagNames(tags: Array<{ name: string }> | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const names: string[] = [];
  for (const tag of tags) {
    if (!tag || typeof tag.name !== 'string') continue;
    const name = tag.name.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function pickImage(
  images: { large?: string; common?: string; medium?: string; small?: string } | undefined,
): string | null {
  if (!images) return null;
  return images.large || images.common || images.medium || images.small || null;
}

const ALIAS_LABELS = new Set([
  '别名',
  '中文名',
  '简体中文名',
  '繁体中文名',
  '第二中文名',
  '日文名',
  '罗马字',
  '英文名',
  '英文名二',
]);

/** 从 infobox 中提取别名/日文名/罗马字等，用于搜索与详情展示。 */
function extractAliases(infobox: InfoboxItem[] | undefined): string[] {
  if (!Array.isArray(infobox)) return [];
  const aliases: string[] = [];
  for (const item of infobox) {
    if (!item || typeof item.key !== 'string') continue;
    const itemKey = item.key.trim();
    if (!ALIAS_LABELS.has(itemKey)) continue;
    for (const entry of flattenInfoboxEntries(asInfoboxValue(item.value))) {
      const value = entry.value.trim();
      if (!value || value.length > 80) continue;
      // 带标签的条目只接受已知的别名类标签（跳过 IMDb 之类）
      if (entry.key !== null && !ALIAS_LABELS.has(entry.key)) continue;
      if (aliases.includes(value)) continue;
      aliases.push(value);
      if (aliases.length >= 40) return aliases;
    }
  }
  return aliases;
}

function baseSubjectRow(id: number): SubjectRow {
  return {
    id,
    type: 2,
    name: '',
    name_cn: '',
    aliases: '[]',
    platform: '',
    format: '其他',
    date: null,
    year: null,
    month: null,
    season: null,
    year_month: null,
    year_quarter: null,
    eps: 0,
    total_episodes: 0,
    volumes: 0,
    score: null,
    rank: null,
    rating_total: null,
    rating_dist: null,
    collection_stats: null,
    collection_total: 0,
    collection_total_known: 0,
    meta_tags: '[]',
    tags: '[]',
    tag_names: '[]',
    infobox: null,
    studios: '[]',
    directors: '[]',
    originals: '[]',
    summary: '',
    images: '{}',
    cover_url: null,
    nsfw: 0,
    locked: 0,
    is_series: 0,
    raw: null,
  };
}

/** 收藏列表中的 slim subject：字段少但足够做基础统计。 */
export function subjectFromSlim(item: BgmCollectionItem): SubjectRow {
  const slim = item.subject;
  const row = baseSubjectRow(item.subject_id);
  if (!slim) {
    return row;
  }
  const air = parseAirDate(slim.date);
  const tags = Array.isArray(slim.tags) ? slim.tags : [];
  const names = tagNames(tags);
  row.type = slim.type ?? item.subject_type;
  row.name = slim.name ?? '';
  row.name_cn = slim.name_cn ?? '';
  row.date = slim.date || null;
  row.year = air.year;
  row.month = air.month;
  row.season = air.season;
  row.year_month = air.yearMonth;
  row.year_quarter = air.yearQuarter;
  row.eps = slim.eps ?? 0;
  row.eps_provided = slim.eps !== undefined;
  row.total_episodes = slim.eps ?? 0;
  row.volumes = slim.volumes ?? 0;
  row.score = slim.score && slim.score > 0 ? slim.score : null;
  row.rank = slim.rank && slim.rank > 0 ? slim.rank : null;
  row.collection_total = slim.collection_total ?? 0;
  row.collection_total_known = slim.collection_total === undefined ? 0 : 1;
  row.tags = toJson(tags);
  row.tag_names = toJson(names);
  row.summary = slim.short_summary ?? '';
  row.images = toJson(slim.images ?? {});
  row.cover_url = pickImage(slim.images);
  row.format = normalizeFormat('', {
    subjectType: row.type,
    tags: names,
    name: `${row.name} ${row.name_cn}`,
  });
  return row;
}

/** 条目详情：权威数据，覆盖 slim 中的近似值。 */
export function subjectFromDetail(detail: BgmSubject, existing: SubjectRow | null): SubjectRow {
  const raw = subjectSource(detail);
  const parsed = bgmSubjectSchema.parse(raw);
  if (parsed.id !== detail.id || (existing && existing.id !== parsed.id)) {
    throw new Error('作品详情与持久化目标身份不一致');
  }
  detail = parsed;
  const row = existing ? { ...existing } : baseSubjectRow(detail.id);
  const air = parseAirDate(detail.date);
  const tags = Array.isArray(detail.tags) ? detail.tags : [];
  const names = tagNames(tags);
  const infobox = Array.isArray(detail.infobox) ? (detail.infobox as InfoboxItem[]) : [];
  const totalEpisodes = (detail.type ?? row.type) === 2
    ? (detail.eps ?? row.eps)
    : detail.total_episodes > 0 ? detail.total_episodes : (detail.eps ?? 0);

  row.type = detail.type ?? row.type;
  row.name = detail.name || row.name;
  row.name_cn = detail.name_cn || row.name_cn;
  row.aliases = toJson(extractAliases(infobox));
  row.platform = detail.platform ?? '';
  row.date = detail.date || null;
  row.year = air.year;
  row.month = air.month;
  row.season = air.season;
  row.year_month = air.yearMonth;
  row.year_quarter = air.yearQuarter;
  row.eps = row.type === 2 ? (detail.eps ?? row.eps) : (detail.eps ?? 0);
  row.total_episodes = totalEpisodes;
  row.volumes = detail.volumes ?? row.volumes;
  row.score = detail.rating?.score && detail.rating.score > 0 ? detail.rating.score : null;
  row.rank = detail.rating?.rank && detail.rating.rank > 0 ? detail.rating.rank : null;
  row.rating_total = detail.rating?.total ?? null;
  row.rating_dist = toJson(detail.rating?.count ?? {});
  row.collection_stats = toJson(detail.collection ?? {});
  row.collection_total = detail.collection
    ? Object.values(detail.collection).reduce((sum, value) => sum + (value ?? 0), 0)
    : row.collection_total;
  row.collection_total_known = 1;
  row.meta_tags = toJson(Array.isArray(detail.meta_tags) ? detail.meta_tags : []);
  row.tags = toJson(tags);
  row.tag_names = toJson(names);
  row.infobox = toJson(infobox);
  row.studios = toJson(extractStudios(infobox));
  row.directors = toJson(extractDirectors(infobox));
  row.originals = toJson(extractOriginalWorks(infobox));
  row.summary = detail.summary || row.summary;
  row.images = toJson(detail.images ?? {});
  row.cover_url = pickImage(detail.images) ?? row.cover_url;
  if (typeof detail.nsfw === 'boolean') row.nsfw = detail.nsfw ? 1 : 0;
  row.locked = detail.locked ? 1 : 0;
  row.is_series = detail.series ? 1 : 0;
  row.raw = toJson(raw);
  row.format = normalizeFormat(detail.platform, {
    subjectType: row.type,
    tags: names,
    name: `${row.name} ${row.name_cn}`,
  });
  return row;
}

export function collectionFromItem(
  item: BgmCollectionItem,
  options: { firstSeenAt: string; syncedAt: string; raw?: unknown },
): CollectionRow {
  return {
    subject_id: item.subject_id,
    subject_type: item.subject_type,
    type: item.type,
    rate: item.rate ?? 0,
    ep_status: item.ep_status ?? 0,
    vol_status: item.vol_status ?? 0,
    comment: item.comment ?? '',
    tags: toJson(Array.isArray(item.tags) ? item.tags : []),
    private: item.private ? 1 : 0,
    updated_at: item.updated_at || null,
    raw: toJson(options.raw ?? item),
  };
}

/** infobox 键名 → 统一的关系名，用于不额外请求 API 的情况下做制作人员分析。 */
const INFOBOX_STAFF_KEYS: Array<{ keys: string[]; relation: string }> = [
  { keys: ['导演', '監督', '监督', '总导演', '総監督', 'アニメーション監督'], relation: '导演' },
  { keys: ['系列构成', 'シリーズ構成', '脚本', '编剧', '剧本'], relation: '脚本' },
  { keys: ['动画制作', '制作公司', '动画制作公司', '製作', '制作'], relation: '动画制作' },
  { keys: ['人物设定', '角色设计', 'キャラクターデザイン', '人物原案'], relation: '人物设定' },
  { keys: ['音乐', '音楽', '音乐制作'], relation: '音乐' },
  { keys: ['美术监督', '色彩设计', '摄影监督', '剪辑', '音响监督', '制片人', '企画', '原作'], relation: '其他' },
];

export function staffFromInfobox(subjectId: number, infobox: InfoboxItem[] | null): StaffRow[] {
  if (!Array.isArray(infobox)) return [];
  const rows: StaffRow[] = [];
  for (const item of infobox) {
    if (!item || typeof item.key !== 'string') continue;
    const key = item.key.trim();
    const mapping = INFOBOX_STAFF_KEYS.find((entry) => entry.keys.includes(key));
    if (!mapping) continue;
    const values = flattenInfoboxValue(asInfoboxValue(item.value));
    for (const value of values) {
      for (const name of value.split(/[、,，/]/)) {
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > 60) continue;
        rows.push({
          subject_id: subjectId,
          person_id: null,
          name: trimmed,
          relation: mapping.relation,
          career: toJson([]),
          source: 'infobox',
        });
      }
    }
  }
  return rows;
}

export function staffFromPersons(subjectId: number, persons: BgmPersonRelation[]): StaffRow[] {
  return persons
    .filter((person) => person.name.trim().length > 0)
    .map((person) => ({
      subject_id: subjectId,
      person_id: person.id,
      name: person.name.trim(),
      relation: (person.relation || '').trim() || '其他',
      career: toJson(Array.isArray(person.career) ? person.career : []),
      source: 'person-api' as const,
    }));
}

/** 官方接口返回的关系名，只有这些才用于合并「系列」。 */
export const SERIES_RELATIONS = new Set([
  '前传',
  '续集',
  '续作',
  '前作',
  '后续',
  '正传',
  '外传',
  '番外篇',
  '总集篇',
  '同系列',
  '相同世界观',
]);

export function relationsToRows(
  subjectId: number,
  relations: BgmSubjectRelation[],
): RelationRow[] {
  return relations
    .filter((relation) => relation.id !== subjectId)
    .map((relation) => ({
      subject_id: subjectId,
      related_id: relation.id,
      relation: (relation.relation || '').trim(),
      type: relation.type ?? 2,
      name: relation.name ?? '',
      name_cn: relation.name_cn ?? '',
    }));
}

/** persons 接口中的制作公司（relation 为「动画制作」等）。 */
export function studiosFromPersons(persons: BgmPersonRelation[]): string[] {
  const out: string[] = [];
  for (const person of persons) {
    const relation = (person.relation || '').trim();
    if (!/动画制作|制作公司|动画制作公司|製作/.test(relation)) continue;
    const name = person.name.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function directorsFromPersons(persons: BgmPersonRelation[]): string[] {
  const out: string[] = [];
  for (const person of persons) {
    const relation = (person.relation || '').trim();
    if (!/^(导演|監督|监督|总导演|総監督|动画监督|アニメーション監督)$/.test(relation)) continue;
    const name = person.name.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
