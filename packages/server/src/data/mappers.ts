import { bgmCollectionItemSchema, normalizeFormat, parseAirDate } from '@bangumi-analyzer/shared';
import type { SubjectRow } from '../bangumi/normalize.js';
import { parseJsonColumn } from '../util.js';
import { z } from 'zod';

type Row = Record<string, unknown>;
const stringArray = z.array(z.string());
const tagsSchema = z.array(z.object({ name: z.string() }));
const countsSchema = z.record(z.string(), z.number().int().nonnegative());
const infoboxSchema = z.array(z.object({ key: z.string(), value: z.unknown() }));
const imagesSchema = z.record(z.string(), z.string().nullable());

function validBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'boolean' || value === 0 || value === 1;
}

/** JSON 语法正确不代表字段类型正确；防止异常导入污染实体和统计输入。 */
function validSubjectJson(row: Row): boolean {
  for (const key of ['aliases', 'meta_tags', 'tag_names', 'studios', 'directors', 'originals']) {
    if (!stringArray.safeParse(JSON.parse(jsonString(row[key], '[]'))).success) return false;
  }
  if (!tagsSchema.safeParse(JSON.parse(jsonString(row.tags, '[]'))).success) return false;
  for (const key of ['rating_dist', 'collection_stats']) {
    if (row[key] != null && !countsSchema.safeParse(JSON.parse(jsonString(row[key], '{}'))).success) return false;
  }
  if (row.infobox != null && !infoboxSchema.safeParse(JSON.parse(jsonString(row.infobox, '[]'))).success) return false;
  if (!imagesSchema.safeParse(JSON.parse(jsonString(row.images, '{}'))).success) return false;
  return ['nsfw', 'locked', 'is_series'].every((key) => validBoolean(row[key]));
}

function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 已知来源必须与合法非空人数共同成立；未知/旧来源不推断为已知。 */
function validCollectionSource(row: Row): boolean {
  const known = row.collection_total_known;
  if (known != null && known !== 0 && known !== 1) return false;
  if (known !== 1) return true;
  // 与归一化共用缺失/空白/类型解释，不能在资格检查前用默认0补齐。
  const count = numberOrNull(row.collection_total);
  return count !== null && Number.isSafeInteger(count) && count >= 0;
}

function positiveId(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** 旧导出允许数字字符串；对象、布尔值和数组不构成人员或关系事实。 */
export function staffFromExportRow(row: Row) {
  const subjectId = positiveId(row.subject_id);
  const personId = row.person_id == null ? null : positiveId(row.person_id);
  if (subjectId === null || (row.person_id != null && personId === null)
      || typeof row.name !== 'string' || !row.name.trim()
      || (row.relation != null && typeof row.relation !== 'string')) return null;
  const source = row.source ?? 'infobox';
  if (source !== 'infobox' && source !== 'person-api') return null;
  if (source === 'person-api' && personId === null) return null;
  let career: unknown = row.career ?? [];
  if (typeof career === 'string') {
    try { career = JSON.parse(career); } catch { return null; }
  }
  const parsed = stringArray.safeParse(career);
  if (!parsed.success) return null;
  return { subjectId, personId, name: row.name.trim(), relation: row.relation as string ?? '',
    career: JSON.stringify(parsed.data), source };
}

export function relationFromExportRow(row: Row) {
  const subjectId = positiveId(row.subject_id);
  const relatedId = positiveId(row.related_id);
  const type = row.type == null ? 2 : numberOrNull(row.type);
  if (subjectId === null || relatedId === null || type === null || ![1, 2, 3, 4, 6].includes(type)) return null;
  for (const key of ['relation', 'name', 'name_cn']) {
    if (row[key] != null && typeof row[key] !== 'string') return null;
  }
  return { subjectId, relatedId, type, relation: row.relation as string ?? '',
    name: row.name as string ?? '', nameCn: row.name_cn as string ?? '' };
}

/** 缺失沿用旧默认值；明确非法的数值拒绝整行，不猜测、更不截断成合法事实。 */
function validSubjectNumbers(row: Row): boolean {
  for (const key of ['id', 'type', 'year', 'month', 'eps', 'total_episodes', 'volumes', 'score', 'rank', 'rating_total', 'collection_total']) {
    const value = row[key];
    if (value == null || (typeof value === 'string' && value.trim() === '')) continue;
    const number = numberOrNull(value);
    if (number === null) return false;
    if (key === 'score') {
      if (number < 0 || number > 10) return false;
    } else if (!Number.isSafeInteger(number) || number < 0) return false;
    if (key === 'type' && ![1, 2, 3, 4, 6].includes(number)) return false;
    if (key === 'month' && number > 12) return false;
  }
  return true;
}

function jsonString(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return fallback;
    }
  }
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value);
}

/** 导入导出文件中的 subject 行 → 数据库行（缺失字段用安全默认值补齐）。 */
export function subjectFromExportRow(row: Row): SubjectRow | null {
  const id = numberOrNull(row.id);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) return null;
  if (!validSubjectJson(row) || !validSubjectNumbers(row) || !validCollectionSource(row)) return null;
  const date = text(row.date, '') || null;
  const air = parseAirDate(date);
  const platform = text(row.platform);
  const type = numberOrNull(row.type) ?? 2;
  const tags = parseJsonColumn<Array<{ name: string }>>(jsonString(row.tags, '[]'), []);
  const tagNames = parseJsonColumn<string[]>(jsonString(row.tag_names, '[]'), []);
  return {
    id,
    type,
    name: text(row.name),
    name_cn: text(row.name_cn),
    aliases: jsonString(row.aliases, '[]'),
    platform,
    format: text(row.format) || normalizeFormat(platform, { subjectType: type }),
    date,
    year: numberOrNull(row.year) ?? air.year,
    month: numberOrNull(row.month) ?? air.month,
    season: text(row.season, '') || air.season,
    year_month: text(row.year_month, '') || air.yearMonth,
    year_quarter: text(row.year_quarter, '') || air.yearQuarter,
    eps: numberOrNull(row.eps) ?? 0,
    eps_provided: (typeof row.eps === 'number' || typeof row.eps === 'string')
      && String(row.eps).trim() !== '' && Number.isSafeInteger(Number(row.eps)) && Number(row.eps) >= 0,
    total_episodes: numberOrNull(row.total_episodes) ?? 0,
    volumes: numberOrNull(row.volumes) ?? 0,
    score: numberOrNull(row.score),
    rank: numberOrNull(row.rank),
    rating_total: numberOrNull(row.rating_total),
    rating_dist: row.rating_dist === undefined || row.rating_dist === null
      ? null
      : jsonString(row.rating_dist, '{}'),
    collection_stats: row.collection_stats === undefined || row.collection_stats === null
      ? null
      : jsonString(row.collection_stats, '{}'),
    collection_total: numberOrNull(row.collection_total) ?? 0,
    collection_total_known: row.collection_total_known as 0 | 1 | null ?? null,
    meta_tags: jsonString(row.meta_tags, '[]'),
    tags: jsonString(row.tags, '[]'),
    tag_names: tagNames.length > 0 ? JSON.stringify(tagNames) : JSON.stringify(tags.map((t) => t.name)),
    infobox:
      row.infobox === undefined || row.infobox === null ? null : jsonString(row.infobox, '[]'),
    studios: jsonString(row.studios, '[]'),
    directors: jsonString(row.directors, '[]'),
    originals: jsonString(row.originals, '[]'),
    summary: text(row.summary),
    images: jsonString(row.images, '{}'),
    cover_url: text(row.cover_url, '') || null,
    nsfw: row.nsfw ? 1 : 0,
    locked: row.locked ? 1 : 0,
    is_series: row.is_series ? 1 : 0,
    raw:
      row.raw === undefined || row.raw === null
        ? null
        : typeof row.raw === 'string'
          ? row.raw
          : JSON.stringify(row.raw),
  };
}

interface ImportedCollection {
  subjectId: number;
  subjectType: number;
  type: number;
  rate: number;
  epStatus: number;
  volStatus: number;
  comment: string;
  tags: string;
  private: number;
  updatedAt: string | null;
  raw: string;
}

export function collectionFromExportRow(row: Row): ImportedCollection | null {
  const subjectId = numberOrNull(row.subject_id);
  if (subjectId === null || !Number.isSafeInteger(subjectId) || subjectId <= 0) return null;
  if (!validBoolean(row.private)) return null;
  // 缺失字段兼容旧导出；明确提供的非法数字不能被安全默认值掩盖。
  const numeric = (value: unknown, fallback: number): number =>
    value == null || value === '' ? fallback : typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  const parsed = bgmCollectionItemSchema.safeParse({
    subject_id: subjectId,
    subject_type: numeric(row.subject_type, 2),
    type: numeric(row.type, 1),
    rate: numeric(row.rate, 0),
    ep_status: numeric(row.ep_status, 0),
    vol_status: numeric(row.vol_status, 0),
    tags: JSON.parse(jsonString(row.tags, '[]')),
    private: Boolean(row.private),
  });
  if (!parsed.success) return null;
  const item = parsed.data;
  return {
    subjectId,
    subjectType: item.subject_type,
    type: item.type,
    rate: item.rate,
    epStatus: item.ep_status,
    volStatus: item.vol_status,
    comment: text(row.comment),
    tags: JSON.stringify(item.tags),
    private: row.private ? 1 : 0,
    updatedAt: text(row.updated_at, '') || null,
    raw: jsonString(row.raw, '{}'),
  };
}
