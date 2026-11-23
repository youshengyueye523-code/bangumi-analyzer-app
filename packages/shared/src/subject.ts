/**
 * 条目 / 收藏 领域常量与纯函数。
 * 这些定义同时被服务端（同步、统计）与前端（展示、筛选）使用，
 * 因此只允许包含与运行环境无关的纯逻辑。
 */

export const SUBJECT_TYPE = {
  Book: 1,
  Anime: 2,
  Music: 3,
  Game: 4,
  Real: 6,
} as const;

export type SubjectType = (typeof SUBJECT_TYPE)[keyof typeof SUBJECT_TYPE];

export const SUBJECT_TYPE_LABEL: Record<number, string> = {
  1: '书籍',
  2: '动画',
  3: '音乐',
  4: '游戏',
  6: '三次元',
};

export const COLLECTION_TYPE = {
  Wish: 1,
  Done: 2,
  Doing: 3,
  OnHold: 4,
  Dropped: 5,
} as const;

export type CollectionType = (typeof COLLECTION_TYPE)[keyof typeof COLLECTION_TYPE];

/** 收藏状态顺序：与 Bangumi 网页端的展示顺序保持一致 */
export const COLLECTION_TYPES: CollectionType[] = [1, 2, 3, 4, 5];

export const COLLECTION_TYPE_LABEL: Record<CollectionType, string> = {
  1: '想看',
  2: '看过',
  3: '在看',
  4: '搁置',
  5: '抛弃',
};

export const COLLECTION_TYPE_META: Record<
  CollectionType,
  { label: string; short: string; description: string }
> = {
  1: { label: '想看', short: '想', description: '计划观看但尚未开始' },
  2: { label: '看过', short: '完', description: '已看完' },
  3: { label: '在看', short: '看', description: '正在观看' },
  4: { label: '搁置', short: '搁', description: '暂时停止观看' },
  5: { label: '抛弃', short: '弃', description: '放弃观看' },
};

export function isCollectionType(value: unknown): value is CollectionType {
  return typeof value === 'number' && (COLLECTION_TYPES as number[]).includes(value);
}

export function collectionTypeLabel(value: number | null | undefined): string {
  if (!isCollectionType(value)) return '未收藏';
  return COLLECTION_TYPE_LABEL[value];
}

/** 动画的放送形态分类（需求中要求的 TV / Movie / OVA / ONA / Special / Music / 其他） */
export const ANIME_FORMATS = ['TV', 'Movie', 'OVA', 'ONA', 'Special', 'Music', '其他'] as const;
export type AnimeFormat = (typeof ANIME_FORMATS)[number];

export const ANIME_FORMAT_LABEL: Record<AnimeFormat, string> = {
  TV: 'TV',
  Movie: '剧场版',
  OVA: 'OVA',
  ONA: '网络动画',
  Special: '特别篇',
  Music: '音乐',
  其他: '其他',
};

/**
 * Bangumi 的 `platform` 是自由文本，不同时期写入的值并不完全统一。
 * 这里把已观测到的取值收敛到固定分类，未知取值回退到标签/标题推断。
 */
const PLATFORM_MAP: Record<string, AnimeFormat> = {
  tv: 'TV',
  TV: 'TV',
  电视动画: 'TV',
  ova: 'OVA',
  OVA: 'OVA',
  oad: 'OVA',
  OAD: 'OVA',
  web: 'ONA',
  WEB: 'ONA',
  ona: 'ONA',
  网络动画: 'ONA',
  剧场版: 'Movie',
  劇場版: 'Movie',
  电影: 'Movie',
  movie: 'Movie',
  动态漫画: '其他',
  电视节目: '其他',
  music: 'Music',
  音乐: 'Music',
};

export function normalizeFormat(
  platform: string | null | undefined,
  hints: { subjectType?: number; tags?: string[]; name?: string } = {},
): AnimeFormat {
  const raw = (platform ?? '').trim();
  if (raw) {
    const mapped = PLATFORM_MAP[raw] ?? PLATFORM_MAP[raw.toLowerCase()];
    if (mapped) return mapped;
  }
  if (hints.subjectType === SUBJECT_TYPE.Music) return 'Music';

  const tagText = (hints.tags ?? []).join(' ').toLowerCase();
  const nameText = hints.name ?? '';
  const haystack = `${tagText} ${nameText}`.toLowerCase();
  if (/剧场版|劇場版|movie/.test(haystack)) return 'Movie';
  if (/\bova\b|\boad\b/.test(haystack)) return 'OVA';
  if (/\bweb\b|\bona\b|网络动画/.test(haystack)) return 'ONA';
  if (/特别篇|特別篇|特别编|special|\bsp\b/.test(haystack)) return 'Special';
  if (/\btv\b|电视动画/.test(haystack)) return 'TV';
  return '其他';
}

/** 季度（日本动画惯例：1-3 月冬、4-6 月春、7-9 月夏、10-12 月秋） */
export const SEASONS = ['冬', '春', '夏', '秋'] as const;
export type Season = (typeof SEASONS)[number];

export const SEASON_LABEL: Record<Season, string> = {
  冬: '冬季（1-3月）',
  春: '春季（4-6月）',
  夏: '夏季（7-9月）',
  秋: '秋季（10-12月）',
};

export interface DateParts {
  year: number | null;
  month: number | null;
  day: number | null;
  season: Season | null;
  /** `2024-04`，无法解析时为 null */
  yearMonth: string | null;
  /** `2024Q2`，无法解析时为 null */
  yearQuarter: string | null;
}

/** 解析 Bangumi 的 `YYYY-MM-DD` 放送日期，允许缺失/异常值。 */
export function parseAirDate(input: string | null | undefined): DateParts {
  const empty: DateParts = {
    year: null,
    month: null,
    day: null,
    season: null,
    yearMonth: null,
    yearQuarter: null,
  };
  if (!input) return empty;
  const match = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(input.trim());
  if (!match) return empty;
  const year = Number(match[1]);
  if (!Number.isFinite(year) || year < 1900 || year > 2200) return empty;
  const month = match[2] ? Number(match[2]) : null;
  const day = match[3] ? Number(match[3]) : null;
  const validMonth = month !== null && month >= 1 && month <= 12 ? month : null;
  const season: Season | null =
    validMonth === null ? null : SEASONS[Math.floor((validMonth - 1) / 3)] ?? null;
  const quarter = validMonth === null ? null : Math.floor((validMonth - 1) / 3) + 1;
  return {
    year,
    month: validMonth,
    day: day !== null && day >= 1 && day <= 31 ? day : null,
    season,
    yearMonth: validMonth === null ? null : `${year}-${String(validMonth).padStart(2, '0')}`,
    yearQuarter: quarter === null ? null : `${year}Q${quarter}`,
  };
}

/** 我的评分档位（0 表示未评分） */
export const SCORE_BANDS = [
  { key: 'unrated', label: '未评分', min: 0, max: 0 },
  { key: '1-4', label: '1-4 分', min: 1, max: 4 },
  { key: '5', label: '5 分', min: 5, max: 5 },
  { key: '6', label: '6 分', min: 6, max: 6 },
  { key: '7', label: '7 分', min: 7, max: 7 },
  { key: '8', label: '8 分', min: 8, max: 8 },
  { key: '9', label: '9 分', min: 9, max: 9 },
  { key: '10', label: '10 分', min: 10, max: 10 },
] as const;

export type ScoreBandKey = (typeof SCORE_BANDS)[number]['key'];

export function scoreBand(rate: number | null | undefined): ScoreBandKey {
  const value = rate ?? 0;
  if (value <= 0) return 'unrated';
  if (value <= 4) return '1-4';
  if (value >= 10) return '10';
  return String(value) as ScoreBandKey;
}

/**
 * 观看进度：`看过` 一律视为完成（Bangumi 上相当一部分条目的 ep_status 为 0），
 * 其它状态取 ep_status 与实际集数的较小值。
 */
/** 历史异常进度不贡献集数；0 沿用「未记录有效进度」的既有默认，不改写来源。 */
export function episodeProgress(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function watchedEpisodes(input: {
  collectionType: number | null | undefined;
  epStatus: number | null | undefined;
  totalEpisodes: number | null | undefined;
}): number {
  const total = episodeProgress(input.totalEpisodes);
  if (input.collectionType === COLLECTION_TYPE.Done) return total;
  const raw = episodeProgress(input.epStatus);
  return total > 0 ? Math.min(raw, total) : raw;
}

export function progressRatio(input: {
  collectionType: number | null | undefined;
  epStatus: number | null | undefined;
  totalEpisodes: number | null | undefined;
}): number {
  const total = episodeProgress(input.totalEpisodes);
  if (total === 0) return input.collectionType === COLLECTION_TYPE.Done ? 1 : 0;
  return Math.min(1, watchedEpisodes(input) / total);
}

/** 用于把「看过」以外、已经开始观看的作品归为一类 */
export function isInProgress(type: number | null | undefined): boolean {
  return type === COLLECTION_TYPE.Doing;
}

export function isStarted(type: number | null | undefined): boolean {
  return type === COLLECTION_TYPE.Done || type === COLLECTION_TYPE.Doing ||
    type === COLLECTION_TYPE.OnHold || type === COLLECTION_TYPE.Dropped;
}
