import {
  ANIME_FORMATS,
  COLLECTION_TYPES,
  PROGRESS_FILTERS,
  SEASONS,
  SORT_FIELDS,
  type AnimeFormat,
  type CollectionType,
  type ProgressFilter,
  type Season,
  type SortField,
  type SortOrder,
  type SubjectQuery,
} from '@bangumi-analyzer/shared';

export const DEFAULT_PAGE_SIZE = 48;

/**
 * 筛选条件保存在 URL 上：可以直接收藏 / 分享某个筛选视图，
 * 也能用浏览器的前进后退切换条件。这里负责 URL ↔ 查询对象的双向转换。
 */
/**
 * URL 上的多值参数。
 *
 * 注意：这里必须与 `SubjectQuery` 里的数组字段保持一一对应，
 * 漏掉任何一项都会导致「点了筛选但结果没变」——正因为以前漏了 `staff`，
 * 「作品 → 制作人员」的反向检索会被静默丢弃。
 */
const ARRAY_KEYS = [
  'status',
  'format',
  'season',
  'tags',
  'studios',
  'directors',
  'staff',
] as const;
const NUMBER_KEYS = [
  'yearFrom',
  'yearTo',
  'rateMin',
  'rateMax',
  'bgmScoreMin',
  'bgmScoreMax',
  'ratingMin',
  'ratingMax',
  'deltaMin',
  'deltaMax',
] as const;
const STRING_KEYS = [
  'q',
  'progress',
  'tagMode',
  'sort',
  'order',
  'seriesKey',
  'rated',
  'bias',
  'sourceRelation',
] as const;
/** 来源上下文参数：只影响界面提示，不参与筛选 */
const CONTEXT_KEYS = ['fromSubject'] as const;

function toArray(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function searchParamsToQuery(params: URLSearchParams): SubjectQuery {
  const query: SubjectQuery = {};

  const q = params.get('q');
  if (q) query.q = q;

  const statuses = toArray(params.get('status'))
    .map(Number)
    .filter((value): value is CollectionType =>
      (COLLECTION_TYPES as readonly number[]).includes(value),
    );
  if (statuses.length > 0) query.status = statuses;

  const formats = toArray(params.get('format')).filter((value): value is AnimeFormat =>
    (ANIME_FORMATS as readonly string[]).includes(value),
  );
  if (formats.length > 0) query.format = formats;

  const seasons = toArray(params.get('season')).filter((value): value is Season =>
    (SEASONS as readonly string[]).includes(value),
  );
  if (seasons.length > 0) query.season = seasons;

  const tags = toArray(params.get('tags'));
  if (tags.length > 0) query.tags = tags;
  const studios = toArray(params.get('studios'));
  if (studios.length > 0) query.studios = studios;
  const directors = toArray(params.get('directors'));
  if (directors.length > 0) query.directors = directors;
  // 制作人员（任意关系：导演 / 音响监督 / 脚本 / 音乐 / 制作公司…）
  const staff = toArray(params.get('staff'));
  if (staff.length > 0) query.staff = staff;

  const fromSubject = params.get('fromSubject');
  if (fromSubject) {
    const parsed = Number(fromSubject);
    if (Number.isFinite(parsed) && parsed > 0) query.fromSubject = parsed;
  }

  for (const key of NUMBER_KEYS) {
    const raw = params.get(key);
    if (raw === null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) query[key] = value;
  }

  const progress = params.get('progress');
  if (progress && (PROGRESS_FILTERS as readonly string[]).includes(progress)) {
    query.progress = progress as ProgressFilter;
  }

  const sort = params.get('sort');
  if (sort && (SORT_FIELDS as readonly string[]).includes(sort)) query.sort = sort as SortField;
  const order = params.get('order');
  if (order === 'asc' || order === 'desc') query.order = order as SortOrder;

  const tagMode = params.get('tagMode');
  if (tagMode === 'any' || tagMode === 'all') query.tagMode = tagMode;

  const rated = params.get('rated');
  if (rated === 'rated' || rated === 'unrated' || rated === 'all') query.rated = rated;

  const bias = params.get('bias');
  if (bias === 'over' || bias === 'under' || bias === 'all') query.bias = bias;

  const seriesKey = params.get('seriesKey');
  if (seriesKey) query.seriesKey = seriesKey;

  const sourceRelation = params.get('sourceRelation');
  if (sourceRelation) query.sourceRelation = sourceRelation;

  const page = Number(params.get('page') ?? '1');
  query.page = Number.isFinite(page) && page > 0 ? page : 1;
  const pageSize = Number(params.get('pageSize') ?? DEFAULT_PAGE_SIZE);
  query.pageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;

  return query;
}

export function queryToSearchParams(query: SubjectQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of STRING_KEYS) {
    const value = query[key];
    if (value) params.set(key, String(value));
  }
  for (const key of ARRAY_KEYS) {
    const value = query[key];
    if (Array.isArray(value) && value.length > 0) params.set(key, value.join(','));
  }
  for (const key of NUMBER_KEYS) {
    const value = query[key];
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  for (const key of CONTEXT_KEYS) {
    const value = query[key];
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.pageSize && query.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set('pageSize', String(query.pageSize));
  }
  return params;
}

/** 统计「当前生效的筛选条件数量」，用于在界面上提示。 */
/**
 * 高级筛选条件计数。
 *
 * 统计口径（唯一权威定义，所有入口共用）：
 *   - 多值维度（标签 / 制作人员 / 公司 / 导演 / 状态 / 季度 / 放送形态）
 *     按**实际选中的值的个数**计数 —— 选 3 个标签就是 3；
 *   - 区间与单选维度（年份 / 我的评分 / Bangumi 平均分 / 评分人数 / 进度 / 是否评分 / 偏差）
 *     每个维度算 1；
 *   - 全局搜索关键词与系列上下文**不属于**高级筛选条件，单独统计。
 *
 * 注意：这里统计的是「用户主动设置的条件数量」，
 * 不是结果作品数，也不是命中的标签数。
 */
function collectConditionCounts(query: SubjectQuery): {
  advanced: number;
  search: number;
  context: number;
} {
  // 多值维度：按选中的值计数
  const multiValue =
    (query.tags?.length ?? 0) +
    (query.staff?.length ?? 0) +
    (query.studios?.length ?? 0) +
    (query.directors?.length ?? 0) +
    (query.status?.length ?? 0) +
    (query.season?.length ?? 0) +
    (query.format?.length ?? 0);

  // 区间 / 单选维度：每个维度最多算 1
  let singleValue = 0;
  if (query.yearFrom !== undefined || query.yearTo !== undefined) singleValue += 1;
  if (query.rateMin !== undefined || query.rateMax !== undefined) singleValue += 1;
  if (query.bgmScoreMin !== undefined || query.bgmScoreMax !== undefined) singleValue += 1;
  if (query.ratingMin !== undefined || query.ratingMax !== undefined) singleValue += 1;
  if (query.progress && query.progress !== 'all') singleValue += 1;
  if (query.rated && query.rated !== 'all') singleValue += 1;
  if (query.bias && query.bias !== 'all') singleValue += 1;

  return {
    advanced: multiValue + singleValue,
    search: query.q ? 1 : 0,
    context: query.seriesKey ? 1 : 0,
  };
}

export interface ActiveFilterSummary {
  /** 高级筛选面板里的条件数量（多值维度按选中个数） */
  advanced: number;
  /** 全局搜索关键词（0 / 1） */
  search: number;
  /** 系列等来源上下文（0 / 1，不属于用户主动筛选） */
  context: number;
  /** 全部条件数量 */
  total: number;
}

export function summarizeActiveFilters(query: SubjectQuery): ActiveFilterSummary {
  const counts = collectConditionCounts(query);
  return { ...counts, total: counts.advanced + counts.search + counts.context };
}

/**
 * 高级筛选入口（徽标 / 面板标题 / 反向检索）统一使用的条件数量。
 * 任何新增筛选条件只需要接入 `collectConditionCounts`，各入口自动一致。
 */
export function getActiveAdvancedFilterCount(query: SubjectQuery): number {
  return collectConditionCounts(query).advanced;
}

/** 全部条件数量（含搜索关键词与系列上下文），用于「清除筛选」等全局判断。 */
export function countActiveFilters(query: SubjectQuery): number {
  return summarizeActiveFilters(query).total;
}

export function toggleArrayValue<T extends string | number>(list: T[] | undefined, value: T): T[] {
  const current = list ?? [];
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

export function resetFilters(query: SubjectQuery): SubjectQuery {
  return {
    sort: query.sort ?? 'updated',
    order: query.order ?? 'desc',
    pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
    page: 1,
  };
}

/**
 * 关键词匹配排序：完全匹配 → 前缀匹配 → 包含匹配，其次按出现次数。
 * 标签有数千个、公司与人员上万条，搜索必须优先于平铺列表。
 */
export function rankMatches<T extends { value: string; count: number }>(
  items: T[],
  keyword: string,
  limit: number,
): { matched: number; visible: T[] } {
  const query = keyword.trim().toLowerCase();
  if (!query) return { matched: items.length, visible: items.slice(0, limit) };
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const name = item.value.toLowerCase();
    const score = name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : 3;
    if (score === 3) continue;
    scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      b.item.count - a.item.count ||
      a.item.value.localeCompare(b.item.value),
  );
  return { matched: scored.length, visible: scored.slice(0, limit).map((entry) => entry.item) };
}
