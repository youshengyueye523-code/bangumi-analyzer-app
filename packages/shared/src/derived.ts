/**
 * 从 Bangumi 原始数据派生出分析所需的字段。
 * 全部为纯函数，便于单元测试与结果复现。
 */

import { type Season } from './subject.js';

/** Bangumi 的 infobox 值类型：字符串、`{v}` 或 `{k,v}` 列表的混合 */
export type InfoboxValue =
  | string
  | number
  | null
  | Array<string | { v?: string | null; k?: string | null } | null>;

export interface InfoboxItem {
  key: string;
  value: InfoboxValue;
}

/** Bangumi 返回的 infobox 是弱类型 JSON，解析前先做一次宽松转换。 */
export function asInfoboxValue(value: unknown): InfoboxValue {
  return value as InfoboxValue;
}

/** 把 infobox 中任意形态的 value 拉平成字符串数组，过滤空值。 */
export function flattenInfoboxValue(value: InfoboxValue | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === 'number') return [String(value)];
  if (!Array.isArray(value)) return [];

  const out: string[] = [];
  for (const entry of value) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) out.push(trimmed);
      continue;
    }
    const v = typeof entry.v === 'string' ? entry.v.trim() : '';
    if (v) out.push(v);
  }
  return out;
}

/** 同时返回带 key 的结构化值（例如 `{k: '第二中文名', v: 'xxx'}`）。 */
export function flattenInfoboxEntries(
  value: InfoboxValue | undefined,
): Array<{ key: string | null; value: string }> {
  if (!Array.isArray(value)) {
    return flattenInfoboxValue(value).map((v) => ({ key: null, value: v }));
  }
  const out: Array<{ key: string | null; value: string }> = [];
  for (const entry of value) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) out.push({ key: null, value: trimmed });
      continue;
    }
    const v = typeof entry.v === 'string' ? entry.v.trim() : '';
    if (!v) continue;
    out.push({ key: typeof entry.k === 'string' ? entry.k : null, value: v });
  }
  return out;
}

export function infoboxLookup(infobox: InfoboxItem[] | null | undefined, keys: string[]): string[] {
  if (!Array.isArray(infobox)) return [];
  const wanted = new Set(keys);
  const out: string[] = [];
  for (const item of infobox) {
    if (!item || typeof item.key !== 'string') continue;
    if (!wanted.has(item.key.trim())) continue;
    for (const value of flattenInfoboxValue(item.value)) {
      if (!out.includes(value)) out.push(value);
    }
  }
  return out;
}

const STUDIO_KEYS = ['动画制作', '制作公司', '製作', '制作', '动画制作公司', '工作室'];
const DIRECTOR_KEYS = ['导演', '監督', '监督', '总导演', '総監督', 'アニメーション監督'];
const ORIGINAL_KEYS = ['原作', '原作类型', '原案', '漫画原作'];

/** 制作公司（优先取 infobox，缺失时由 persons 接口补充，见 server/sync/enrich）。 */
export function extractStudios(infobox: InfoboxItem[] | null | undefined): string[] {
  const values = infoboxLookup(infobox, STUDIO_KEYS);
  return values
    .flatMap((value) => value.split(/[、,，/]/))
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= 40);
}

export function extractDirectors(infobox: InfoboxItem[] | null | undefined): string[] {
  return infoboxLookup(infobox, DIRECTOR_KEYS)
    .flatMap((value) => value.split(/[、,，/]/))
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= 40);
}

export function extractOriginalWorks(infobox: InfoboxItem[] | null | undefined): string[] {
  return infoboxLookup(infobox, ORIGINAL_KEYS)
    .flatMap((value) => value.split(/[、,，/]/))
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= 40);
}

const SEASON_MARKER_PATTERNS: RegExp[] = [
  /第[一二三四五六七八九十0-9]{1,3}[季期部篇]/g,
  /\b(?:season|seasons)\s*\d{1,2}\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)\s+season\b/gi,
  /\b(?:part|cour)\s*\d{1,2}\b/gi,
  /第[一二三四五六七八九十0-9]{1,3}シリーズ/g,
  /[（(]\s*(?:第\s*\d+\s*[季期]|season\s*\d+)\s*[)）]/gi,
  /\b(?:ii|iii|iv|v|vi|vii|viii)\b$/i,
];

const TITLE_PREFIXES = ['剧场版', '劇場版', '剧场总集篇', '电影', '劇場', '总集篇', '総集編'];

/**
 * 基于标题的系列归一化：仅用于 `series` 的启发式补充，
 * 结果在 UI 上会与官方关系数据区分展示。
 */
export function normalizeTitleForSeries(name: string): string {
  let value = (name ?? '').trim();
  if (!value) return '';
  for (const prefix of TITLE_PREFIXES) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length).trim();
  }
  for (const pattern of SEASON_MARKER_PATTERNS) {
    value = value.replace(pattern, ' ');
  }
  return value
    .replace(/[：:·・\-–—~～!！?？.,，。、'"“”‘’「」『』【】\[\]()（）\s]+/g, '')
    .toLowerCase();
}

export function titleHeuristicSeriesKey(name: string): string | null {
  const key = normalizeTitleForSeries(name);
  return key.length >= 2 ? key : null;
}

/** 评分差值（我的评分 - Bangumi 平均分），仅在两方都有分时有效。 */
export function ratingDelta(
  myRate: number | null | undefined,
  bgmScore: number | null | undefined,
): number | null {
  if (!myRate || myRate <= 0) return null;
  if (bgmScore === null || bgmScore === undefined || bgmScore <= 0) return null;
  return Number((myRate - bgmScore).toFixed(2));
}

export function formatSeasonLabel(year: number | null, season: Season | null): string {
  if (year === null) return '未知';
  if (!season) return `${year} 年`;
  return `${year} 年${season}季`;
}

/** 带等级的标签统计容器（用于偏好分析）。 */
export interface PreferenceEntry {
  name: string;
  total: number;
  rated: number;
  averageRate: number | null;
  averageScore: number | null;
  highRated: number;
  highRatedShare: number | null;
}
