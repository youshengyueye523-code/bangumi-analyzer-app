import { collectionTotalSql, validRelationSql } from './metadata.js';
import { episodeCount } from './episodeCount.js';
import { EPISODE_EXPRESSION, EP_STATUS_EXPRESSION } from '../stats/expressions.js';
import type {
  CollectionType,
  FilterFacets,
  FranchiseDetail,
  FranchiseSeriesEntry,
  FranchiseSummary,
  Page,
  RelationAudit,
  RelationAuditEntry,
  SeriesDetail,
  SeriesGroupSummary,
  SeriesMemberEntry,
  SeriesMergeCandidate,
  SeriesRelatedEntry,
  SeriesWatchSummary,
  EntitySearchResult,
  SubjectDetail,
  SubjectListItem,
  SubjectQuery,
  SubjectRelation,
  SubjectStaff,
  SubjectSummaryState,
  SummaryLanguage,
  TagCountList,
  StaffSearchItem,
  StaffSearchResult,
  AnimeFormat,
  Season,
  EntityLink,
} from '@bangumi-analyzer/shared';
import {
  ANIME_FORMAT_LABEL,
  COLLECTION_TYPE,
  COLLECTION_TYPE_LABEL,
  COLLECTION_TYPES,
  ENTITY_RANKING_MIN_SAMPLE,
  SEASONS,
  TRANSLATION_STATUS,
  asInfoboxValue,
  detectSummaryLanguage,
  flattenInfoboxEntries,
  episodeProgress,
  progressRatio,
  translationStrategy,
  watchedEpisodes,
} from '@bangumi-analyzer/shared';
import type { EntityRankingMeta, EntityRankingMetric } from '@bangumi-analyzer/shared';
import { parseJsonColumn, parseStringArrayColumn } from '../util.js';
import { all, one, schemaVersion } from './index.js';
import { projectTitleCandidates } from './titleCandidates.js';
import { jsonArrayExpression } from '../stats/expressions.js';
import { getSummaryRecord } from './summaries.js';
import { currentJobForSubject } from './translationJobs.js';
import { classifyRelation } from '../series/taxonomy.js';
import { findSeriesSupersession, resolveEntityKey } from './series.js';
import { franchiseAverageRateSql } from './franchiseAverage.js';
import { franchiseAnalysis, seriesAnalysis } from './entityAnalysis.js';
import { franchiseRankingMetricSql, seriesRankingMetricSql } from './entityRanking.js';
import { listFranchiseMemberExclusions } from './franchiseGovernance.js';
import {
  collectionVisibilityClause,
  currentVisibility,
  franchiseVisibilityClause,
  personalHidesActive,
  personallyVisibleId,
  publicFranchiseTitle,
  publicSeriesTitle,
  relatedSubjectVisibilityClause,
  memberVisibilityClause,
  seriesVisibilityClause,
  subjectVisibilityClause,
  type Visibility,
} from './visibility.js';
import { personalRatingHistory } from './ratingHistory.js';

function manualFranchisePriority(): string {
  return schemaVersion() < 15 ? '' : `EXISTS (SELECT 1 FROM franchise_member_assignments a
    WHERE a.series_id=fs.series_id AND a.franchise_id=fs.franchise_id AND a.revoked_at IS NULL) DESC,`;
}

function allowedSubjectSeries(): string {
  return personalHidesActive()
    ? `NOT EXISTS (SELECT 1 FROM series_entities se WHERE se.key=s.series_key AND NOT (${seriesVisibilityClause('se')}))`
    : '1=1';
}
const selectColumns = () => /* sql */ `
  s.id, s.type, s.name, s.name_cn, s.aliases, s.platform, s.format, s.date, canonical_positive_integer(s.year) AS year, s.month, s.season,
  s.year_month, s.year_quarter, s.eps, s.total_episodes, canonical_score(s.score) AS score, canonical_positive_integer(s.rank) AS rank, canonical_count(s.rating_total) AS rating_total,
  ${collectionTotalSql('s')} AS collection_total, s.cover_url, s.cover_cached_at, s.tag_names, s.studios, s.directors,
  CASE WHEN ${allowedSubjectSeries()} THEN s.series_key END AS series_key, s.series_source, s.detail_synced_at, s.summary, s.meta_tags, s.nsfw, s.locked,
  s.is_series, s.rating_dist, s.collection_stats, s.infobox, s.raw, s.relations_synced_at,
  s.persons_synced_at,
  c.type AS collection_type, effective_personal_rate(c.type,c.rate) AS rate, ${EP_STATUS_EXPRESSION} AS ep_status, c.vol_status, c.comment,
  c.tags AS user_tags, c.updated_at AS collection_updated_at, c.first_seen_at, c.raw AS collection_raw
`;

/**
 * 简介双语状态：把「原文 + 官方中文 / AI 翻译 + 翻译任务」合并成前端直接可用的结构。
 * 前端不需要知道数据库字段，也不需要自己判断优先级。
 */
function buildSummaryState(subjectId: number, fallbackSummary: string): SubjectSummaryState {
  const record = getSummaryRecord(subjectId);
  const job = currentJobForSubject(subjectId);
  const language: SummaryLanguage = record?.language ?? detectSummaryLanguage(fallbackSummary).language;

  if (!record) {
    // 数据层还没回填（旧库首次运行）：只做语言识别，不臆造翻译状态
    const stats = detectSummaryLanguage(fallbackSummary);
    const support = translationStrategy(stats.language);
    const official = stats.language === 'zh' ? fallbackSummary : '';
    return {
      subjectId,
      chinese: official,
      chineseSource: stats.language === 'zh' ? 'bangumi' : 'none',
      bilingual: false,
      original: fallbackSummary,
      originalLanguage: stats.language,
      translatable: support.translate && !official,
      unsupportedReason: support.translate ? '' : support.reason,
      status: TRANSLATION_STATUS.Idle,
      stale: false,
      translationModel: '',
      translationProvider: '',
      translationUpdatedAt: null,
      translationError: null,
      queued: false,
      jobId: null,
      attempts: 0,
    };
  }

  return {
    subjectId,
    chinese: record.chinese,
    chineseSource: record.chineseSource,
    bilingual: record.bilingual,
    original: record.original,
    originalLanguage: language,
    translatable: record.translatable,
    unsupportedReason: record.unsupportedReason,
    status: record.status,
    stale: record.stale,
    translationModel: record.translationModel,
    translationProvider: record.translationProvider,
    translationUpdatedAt: record.translationUpdatedAt,
    translationError: record.translationError,
    queued: job ? job.status === 'pending' || job.status === 'processing' : false,
    jobId: job ? Number(job.id) : null,
    attempts: job ? Number(job.attempts) : 0,
  };
}

/**
 * 命中原因：仅在主搜索栏带关键词时计算，用来告诉用户「为什么这条结果会出现」。
 * 顺序与 `MATCH_REASON_LABEL` 对应，前端负责翻译成人话。
 */
const MATCH_REASON_SQL = /* sql */ `
  TRIM(
    CASE WHEN s.name LIKE :qLike ESCAPE '\\' OR s.name_cn LIKE :qLike ESCAPE '\\'
         THEN 'title,' ELSE '' END ||
    CASE WHEN s.aliases LIKE :qLike ESCAPE '\\' THEN 'alias,' ELSE '' END ||
    CASE WHEN CAST(s.id AS TEXT) = :qExact THEN 'id,' ELSE '' END ||
    CASE WHEN EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('s.tag_names')}) mt WHERE mt.type = 'text' AND mt.value LIKE :qLike ESCAPE '\\')
         THEN 'tag,' ELSE '' END ||
    CASE WHEN EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('c.tags')}) mu WHERE mu.type = 'text' AND mu.value LIKE :qLike ESCAPE '\\')
         THEN 'userTag,' ELSE '' END ||
    CASE WHEN EXISTS (SELECT 1 FROM subject_staff ms
                      WHERE ms.subject_id = s.id AND ms.name LIKE :qLike ESCAPE '\\')
         THEN 'staff,' ELSE '' END ||
    CASE WHEN EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('s.studios')}) mso WHERE mso.type = 'text' AND mso.value LIKE :qLike ESCAPE '\\')
         THEN 'studio,' ELSE '' END ||
    CASE WHEN EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('s.directors')}) mdi WHERE mdi.type = 'text' AND mdi.value LIKE :qLike ESCAPE '\\')
         THEN 'director,' ELSE '' END
  , ',') AS match_reasons
`;

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

interface WhereResult {
  sql: string;
  params: Record<string, unknown>;
}

/** 把筛选条件编译为参数化 SQL，所有值都走绑定参数，避免注入。 */
export function buildWhere(query: SubjectQuery): WhereResult {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  // v1.5.3：NSFW 可见性策略（只影响当前可见投影，不改数据）
  conditions.push(subjectVisibilityClause('s'));

  if (query.q && query.q.trim()) {
    const needle = query.q.trim();
    params.qLike = `%${escapeLike(needle)}%`;
    params.qExact = needle;
    params.qLower = `%${escapeLike(needle.toLowerCase())}%`;
    /**
     * 全局搜索：不只匹配标题，还覆盖别名、ID、标签（公共 + 个人）、
     * 制作人员、制作公司与导演——只要实体与收藏作品存在真实关联就能搜到。
     * 所有分支都走同一套 WHERE，因此主搜索栏与详情页入口的语义完全一致。
     */
    conditions.push(
      `(s.name LIKE :qLike ESCAPE '\\' OR s.name_cn LIKE :qLike ESCAPE '\\'
        OR s.aliases LIKE :qLike ESCAPE '\\' OR lower(s.name) LIKE :qLower ESCAPE '\\'
        OR lower(s.name_cn) LIKE :qLower ESCAPE '\\' OR CAST(s.id AS TEXT) = :qExact
        OR EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('s.tag_names')}) qt WHERE qt.type = 'text' AND qt.value LIKE :qLike ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('c.tags')}) ut WHERE ut.type = 'text' AND ut.value LIKE :qLike ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM subject_staff qst
                   WHERE qst.subject_id = s.id AND qst.name LIKE :qLike ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('s.studios')}) qso WHERE qso.type = 'text' AND qso.value LIKE :qLike ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('s.directors')}) qdi WHERE qdi.type = 'text' AND qdi.value LIKE :qLike ESCAPE '\\'))`,
    );
  }

  if (query.status && query.status.length > 0) {
    const placeholders = query.status.map((value, index) => {
      params[`status${index}`] = value;
      return `:status${index}`;
    });
    conditions.push(`c.type IN (${placeholders.join(', ')})`);
  }

  if (query.format && query.format.length > 0) {
    const placeholders = query.format.map((value, index) => {
      params[`format${index}`] = value;
      return `:format${index}`;
    });
    conditions.push(`s.format IN (${placeholders.join(', ')})`);
  }

  if (query.season && query.season.length > 0) {
    const placeholders = query.season.map((value, index) => {
      params[`season${index}`] = value;
      return `:season${index}`;
    });
    conditions.push(`s.season IN (${placeholders.join(', ')})`);
  }

  if (query.yearFrom !== undefined) {
    params.yearFrom = query.yearFrom;
    conditions.push(`canonical_positive_integer(s.year) >= :yearFrom`);
  }
  if (query.yearTo !== undefined) {
    params.yearTo = query.yearTo;
    conditions.push(`canonical_positive_integer(s.year) <= :yearTo`);
  }
  if (query.rateMin !== undefined && query.rateMin > 0) {
    params.rateMin = query.rateMin;
    conditions.push(`effective_personal_rate(c.type,c.rate) >= :rateMin`);
  }
  if (query.rateMax !== undefined && query.rateMax > 0) {
    params.rateMax = query.rateMax;
    // 明确限定评分区间时，未评分的作品（rate = 0）不应被算作「低分」
    conditions.push(`effective_personal_rate(c.type,c.rate) > 0 AND effective_personal_rate(c.type,c.rate) <= :rateMax`);
  }
  if (query.bgmScoreMin !== undefined && query.bgmScoreMin > 0) {
    params.bgmScoreMin = query.bgmScoreMin;
    conditions.push(`canonical_score(s.score) >= :bgmScoreMin`);
  }
  if (query.bgmScoreMax !== undefined && query.bgmScoreMax > 0) {
    params.bgmScoreMax = query.bgmScoreMax;
    conditions.push(`canonical_score(s.score) <= :bgmScoreMax`);
  }
  if (query.ratingMin !== undefined && query.ratingMin > 0) {
    params.ratingMin = query.ratingMin;
    conditions.push(`canonical_count(s.rating_total) >= :ratingMin`);
  }
  if (query.ratingMax !== undefined && query.ratingMax > 0) {
    params.ratingMax = query.ratingMax;
    conditions.push(`canonical_count(s.rating_total) <= :ratingMax`);
  }
  if (query.deltaMin !== undefined) {
    params.deltaMin = query.deltaMin;
    conditions.push(`effective_personal_rate(c.type,c.rate) > 0 AND canonical_score(s.score) > 0 AND (effective_personal_rate(c.type,c.rate) - canonical_score(s.score)) >= :deltaMin`);
  }
  if (query.deltaMax !== undefined) {
    params.deltaMax = query.deltaMax;
    conditions.push(`effective_personal_rate(c.type,c.rate) > 0 AND canonical_score(s.score) > 0 AND (effective_personal_rate(c.type,c.rate) - canonical_score(s.score)) <= :deltaMax`);
  }

  switch (query.progress) {
    case 'not-started':
      conditions.push(`(c.type = 1 OR (c.type = 3 AND (${EP_STATUS_EXPRESSION}) = 0))`);
      break;
    case 'in-progress':
      conditions.push(`c.type = 3`);
      break;
    case 'completed':
      conditions.push(`c.type = 2`);
      break;
    case 'unfinished':
      conditions.push(`c.type IN (3, 4, 5)`);
      break;
    default:
      break;
  }

  if (query.rated === 'rated') conditions.push(`effective_personal_rate(c.type,c.rate) > 0`);
  if (query.rated === 'unrated') conditions.push(`effective_personal_rate(c.type,c.rate) = 0`);
  if (query.bias === 'over') {
    conditions.push(`effective_personal_rate(c.type,c.rate) > 0 AND canonical_score(s.score) > 0 AND effective_personal_rate(c.type,c.rate) > canonical_score(s.score)`);
  }
  if (query.bias === 'under') {
    conditions.push(`effective_personal_rate(c.type,c.rate) > 0 AND canonical_score(s.score) > 0 AND effective_personal_rate(c.type,c.rate) < canonical_score(s.score)`);
  }

  if (query.tags && query.tags.length > 0) {
    const placeholders = query.tags.map((value, index) => {
      params[`tag${index}`] = value;
      return `:tag${index}`;
    });
    const list = placeholders.join(', ');
    params.tagMatchMin = query.tagMode === 'all' ? query.tags.length : 1;
    // 公共标签与个人标记标签都算命中
    conditions.push(
      `(SELECT COUNT(DISTINCT matched.value) FROM (
          SELECT je.value AS value FROM json_each(${jsonArrayExpression('s.tag_names')}) je WHERE je.type = 'text'
          UNION
          SELECT je2.value AS value FROM json_each(${jsonArrayExpression('c.tags')}) je2 WHERE je2.type = 'text'
        ) AS matched
        WHERE matched.value IN (${list})) >= :tagMatchMin`,
    );
  }

  if (query.studios && query.studios.length > 0) {
    const placeholders = query.studios.map((value, index) => {
      params[`studio${index}`] = value;
      return `:studio${index}`;
    });
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('s.studios')}) st WHERE st.type = 'text' AND st.value IN (${placeholders.join(', ')}))`,
    );
  }

  if (query.directors && query.directors.length > 0) {
    const placeholders = query.directors.map((value, index) => {
      params[`director${index}`] = value;
      return `:director${index}`;
    });
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(${jsonArrayExpression('s.directors')}) di WHERE di.type = 'text' AND di.value IN (${placeholders.join(', ')}))`,
    );
  }

  if (query.staff && query.staff.length > 0) {
    // 制作人员 → 作品：不区分关系类型（导演 / 脚本 / 动画制作 / 音乐 都能命中）
    const placeholders = query.staff.map((value, index) => {
      params[`staff${index}`] = value;
      return `:staff${index}`;
    });
    conditions.push(
      `EXISTS (SELECT 1 FROM subject_staff st WHERE st.subject_id = s.id AND st.name IN (${placeholders.join(', ')}))`,
    );
  }

  if (query.seriesKey) {
    params.seriesKey = query.seriesKey;
    conditions.push(`s.series_key = :seriesKey AND ${allowedSubjectSeries()}`);
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join('\n AND ')}` : '',
    params,
  };
}

const PROGRESS_EXPRESSION = /* sql */ `
  CASE
    WHEN c.type = 2 THEN 1.0
    WHEN (${EPISODE_EXPRESSION}) > 0
      THEN MIN((${EP_STATUS_EXPRESSION}), (${EPISODE_EXPRESSION})) * 1.0
           / (${EPISODE_EXPRESSION})
    ELSE 0.0
  END
`;

const SORT_EXPRESSIONS: Record<string, string> = {
  updated: 'c.updated_at',
  added: 'c.first_seen_at',
  rate: 'effective_personal_rate(c.type,c.rate)',
  bgmScore: 'canonical_score(s.score)',
  delta: 'CASE WHEN effective_personal_rate(c.type,c.rate) > 0 AND canonical_score(s.score) > 0 THEN effective_personal_rate(c.type,c.rate) - canonical_score(s.score) END',
  year: 'canonical_positive_integer(s.year)',
  progress: PROGRESS_EXPRESSION,
  title: `COALESCE(NULLIF(s.name_cn, ''), s.name)`,
  ratingTotal: 'canonical_count(s.rating_total)',
  collectionTotal: collectionTotalSql('s'),
};

export interface RawJoinedRow {
  id: number;
  type: number;
  name: string | null;
  name_cn: string | null;
  aliases: string | null;
  platform: string | null;
  format: string | null;
  date: string | null;
  year: number | null;
  month: number | null;
  season: string | null;
  year_month: string | null;
  year_quarter: string | null;
  eps: number | null;
  total_episodes: number | null;
  score: number | null;
  rank: number | null;
  rating_total: number | null;
  collection_total: number | null;
  cover_url: string | null;
  cover_cached_at: string | null;
  tag_names: string | null;
  studios: string | null;
  directors: string | null;
  series_key: string | null;
  series_source: string | null;
  detail_synced_at: string | null;
  summary: string | null;
  meta_tags: string | null;
  nsfw: number | null;
  locked: number | null;
  is_series: number | null;
  rating_dist: string | null;
  collection_stats: string | null;
  infobox: string | null;
  raw: string | null;
  relations_synced_at: string | null;
  persons_synced_at: string | null;
  collection_type: number;
  rate: number;
  ep_status: number;
  vol_status: number;
  comment: string | null;
  user_tags: string | null;
  collection_updated_at: string | null;
  first_seen_at: string | null;
  collection_raw: string | null;
  match_reasons?: string | null;
}

export function mapSubjectRow(row: RawJoinedRow): SubjectListItem {
  const totalEpisodes = episodeCount(row);
  const watched = watchedEpisodes({
    collectionType: row.collection_type,
    epStatus: row.ep_status,
    totalEpisodes,
  });
  const rate = row.rate ?? 0;
  const score = row.score ?? null;
  return {
    id: Number(row.id),
    name: row.name ?? '',
    nameCn: row.name_cn ?? '',
    cover: row.cover_url ?? null,
    coverCached: Boolean(row.cover_cached_at),
    platform: row.platform ?? '',
    format: (row.format ?? '其他') as AnimeFormat,
    date: row.date ?? null,
    year: row.year ?? null,
    month: row.month ?? null,
    season: (row.season as Season | null) ?? null,
    yearQuarter: row.year_quarter ?? null,
    totalEpisodes,
    collectionType: (row.collection_type ?? 1) as CollectionType,
    rate,
    epStatus: episodeProgress(row.ep_status),
    watchedEpisodes: watched,
    progress: progressRatio({
      collectionType: row.collection_type,
      epStatus: row.ep_status,
      totalEpisodes,
    }),
    comment: row.comment ?? '',
    userTags: parseStringArrayColumn(row.user_tags),
    bgmScore: score && score > 0 ? score : null,
    bgmRank: row.rank && row.rank > 0 ? row.rank : null,
    ratingTotal: row.rating_total,
    collectionTotal: row.collection_total,
    delta: rate > 0 && score && score > 0 ? Number((rate - score).toFixed(2)) : null,
    tags: parseStringArrayColumn(row.tag_names),
    studios: parseStringArrayColumn(row.studios),
    directors: parseStringArrayColumn(row.directors),
    collectionUpdatedAt: row.collection_updated_at ?? null,
    firstSeenAt: row.first_seen_at ?? null,
    detailSyncedAt: row.detail_synced_at ?? null,
    seriesKey: row.series_key ?? null,
    ...(row.match_reasons
      ? { matchReasons: row.match_reasons.split(',').filter(Boolean) }
      : {}),
  };
}

export interface ListOptions {
  pageSize?: number;
  maxPageSize?: number;
}

export function listSubjects(
  query: SubjectQuery,
  options: ListOptions = {},
): Page<SubjectListItem> {
  const maxPageSize = options.maxPageSize ?? 200;
  const pageSize = Math.min(maxPageSize, Math.max(1, Math.round(query.pageSize ?? 48)));
  const requestedPage = Math.max(1, Math.round(query.page ?? 1));
  const sortKey = query.sort && SORT_EXPRESSIONS[query.sort] ? query.sort : 'updated';
  const direction = query.order === 'asc' ? 'ASC' : 'DESC';

  const where = buildWhere(query);
  const totalRow = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM collections c JOIN subjects s ON s.id = c.subject_id ${where.sql}`,
    where.params,
  );
  const total = Number(totalRow?.n ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const offset = (page - 1) * pageSize;

  const sortExpression = SORT_EXPRESSIONS[sortKey] ?? 'c.updated_at';
  const hasKeyword = Boolean(query.q && query.q.trim());
  // NULL 值统一排在最后，并用 id 作为稳定排序的兜底，保证分页不重复/不遗漏
  const rows = all<RawJoinedRow>(
    `SELECT ${selectColumns()}${hasKeyword ? `, ${MATCH_REASON_SQL}` : ''}
     FROM collections c
     JOIN subjects s ON s.id = c.subject_id
     ${where.sql}
     ORDER BY (${sortExpression}) IS NULL, ${sortExpression} ${direction}, s.id ASC
     LIMIT :limit OFFSET :offset`,
    { ...where.params, limit: pageSize, offset },
  );

  return {
    items: rows.map(mapSubjectRow),
    total,
    page,
    pageSize,
    pageCount,
    context: query.fromSubject ? buildContext(query, where) : null,
  };
}

/**
 * 来源上下文：从作品 A 点进某个制作人员时，用户期望「结果里至少还有作品 A」。
 * 这里用完全相同的 WHERE 条件去检查 A 是否命中，从而给出真实的提示，
 * 而不是在前端强行把 A 插进结果里。
 */
function buildContext(
  query: SubjectQuery,
  where: { sql: string; params: Record<string, unknown> },
): NonNullable<Page<SubjectListItem>['context']> | null {
  const subjectId = Number(query.fromSubject);
  if (!Number.isInteger(subjectId) || subjectId <= 0) return null;

  const row = one<{ title: string }>(
    `SELECT COALESCE(NULLIF(s.name_cn, ''), s.name) AS title FROM subjects s WHERE s.id = :id AND ${subjectVisibilityClause('s')}`,
    { id: subjectId },
  );
  if (!row) return null;

  const matched = one<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM collections c JOIN subjects s ON s.id = c.subject_id
     ${where.sql}${where.sql ? ' AND' : 'WHERE'} s.id = :contextSubjectId`,
    { ...where.params, contextSubjectId: subjectId },
  );
  const present = Number(matched?.n ?? 0) > 0;
  return {
    subjectId,
    title: row.title,
    relation: query.sourceRelation ?? '',
    present,
  };
}

function countRecordColumn(value: unknown, keys: readonly string[]): Record<string, number> {
  const parsed = parseJsonColumn<unknown>(value, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([key, count]) =>
    keys.includes(key) && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0));
}

export function getSubjectDetail(id: number): SubjectDetail | null {
  const row = one<RawJoinedRow & { source_personal_rate: number }>(
    `SELECT ${selectColumns()}, canonical_rate(c.rate) AS source_personal_rate
     FROM collections c
     JOIN subjects s ON s.id = c.subject_id
     WHERE s.id = :id`,
    { id },
  );
  if (!row) return null;
  // v1.5.3：被当前隐私设置隐藏的 NSFW 条目不下发任何内容（路由返回 subject_hidden）
  if (isSubjectHidden(id)) return null;

  const base = mapSubjectRow(row);
  const staff = all<{
    person_id: number | null;
    name: string;
    relation: string;
    career: string | null;
    source: string;
  }>(
    `SELECT canonical_positive_integer(person_id) AS person_id, name, relation, career, source
     FROM subject_staff WHERE subject_id = :id
     ORDER BY CASE relation WHEN '导演' THEN 0 WHEN '动画制作' THEN 1 WHEN '脚本' THEN 2 ELSE 3 END,
              name ASC`,
    { id },
  ).map<SubjectStaff>((entry) => ({
    id: entry.person_id ?? null,
    name: entry.name,
    relation: entry.relation,
    career: parseStringArrayColumn(entry.career),
    source: entry.source === 'person-api' ? 'person-api' : 'infobox',
  }));

  const relationRows = all<{
    related_id: number;
    relation: string;
    type: number;
    name: string;
    name_cn: string;
    in_collection: number | null;
    collection_type: number | null;
  }>(
    `SELECT r.related_id, r.relation, r.type, r.name, r.name_cn,
            CASE WHEN c.subject_id IS NULL THEN 0 ELSE 1 END AS in_collection,
            c.type AS collection_type
     FROM subject_relations r
     LEFT JOIN collections c ON c.subject_id = r.related_id
     WHERE r.subject_id = :id AND ${validRelationSql('r')}
       AND ${relatedSubjectVisibilityClause('r.related_id')}
     ORDER BY r.relation ASC, r.related_id ASC`,
    { id },
  );

  const storedInfobox = parseJsonColumn<unknown>(row.infobox, []);
  const infobox = Array.isArray(storedInfobox)
    ? storedInfobox.filter((item): item is { key: string; value: unknown } =>
        item !== null && typeof item === 'object' && typeof item.key === 'string')
    : [];

  // Subject → Series → Franchise：数据层始终存在归属（单成员系列同样有）。
  const seriesRow = one<{ key: string; title: string; title_state: string; state: string }>(
    `SELECT e.key, ${publicSeriesTitle('e')} AS title, e.title_state, e.state
     FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
     WHERE m.subject_id = :id AND m.role = 'primary' AND e.state <> 'stale'
       AND ${seriesVisibilityClause('e')}
     LIMIT 1`,
    { id },
  );
  const franchiseRow = one<{ key: string; title: string; title_state: string; state: string }>(
    `SELECT f.key, ${publicFranchiseTitle('f')} AS title, f.title_state, f.state
     FROM franchise_series fs
     JOIN franchise_entities f ON f.id = fs.franchise_id
     JOIN series_entity_members m ON m.series_id = fs.series_id
     WHERE m.subject_id = :id AND m.role = 'primary' AND f.state NOT IN ('stale','rejected') AND fs.state <> 'conflict'
       AND ${franchiseVisibilityClause('f')}
     ORDER BY ${manualFranchisePriority()} f.id
     LIMIT 1`,
    { id },
  );
  const toLink = (
    entry: { key: string; title: string; title_state: string; state: string } | undefined,
  ): EntityLink | null =>
    entry
      ? {
          key: entry.key,
          title: entry.title,
          titleState: entry.title_state as EntityLink['titleState'],
          state: entry.state,
        }
      : null;

  return {
    ...base,
    summary: row.summary ?? '',
    summaryState: buildSummaryState(Number(row.id), row.summary ?? ''),
    metaTags: parseStringArrayColumn(row.meta_tags),
    nsfw: Boolean(row.nsfw),
    locked: Boolean(row.locked),
    isSeries: Boolean(row.is_series),
    ratingDistribution: countRecordColumn(row.rating_dist, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']),
    collectionBreakdown: countRecordColumn(row.collection_stats, ['wish', 'collect', 'doing', 'on_hold', 'dropped']),
    infobox: infobox.map((item) => ({
      key: String(item.key ?? ''),
      values: parseInfoboxEntries(item.value),
    })),
    staff,
    relations: relationRows.map<SubjectRelation>((entry) => ({
      id: Number(entry.related_id),
      name: entry.name,
      nameCn: entry.name_cn,
      relation: entry.relation,
      type: Number(entry.type),
      inCollection: Boolean(entry.in_collection),
      collectionType: entry.collection_type === null ? null : (entry.collection_type as CollectionType),
    })),
    relationsSyncedAt: row.relations_synced_at ?? null,
    personsSyncedAt: row.persons_synced_at ?? null,
    rawSubject: personalHidesActive() ? null : parseJsonColumn<unknown>(row.raw, null),
    rawCollection: personalHidesActive() ? null : parseJsonColumn<unknown>(row.collection_raw, null),
    ...(base.collectionType === 1 ? {
      personalRatingHistory: personalRatingHistory(id),
      sourcePersonalRate: row.source_personal_rate || null,
    } : {}),
    series: toLink(seriesRow),
    franchise: toLink(franchiseRow),
  };
}

/** 该 Subject 是否因当前 NSFW 可见性策略被隐藏（用于路由区分 404 与「已隐藏」）。 */
export function isSubjectHidden(id: number): boolean {
  if (currentVisibility() === 'real') return false;
  return Boolean(one(`SELECT 1 FROM subjects s WHERE id=:id AND NOT (${subjectVisibilityClause('s')})`, {id}));
}

/** 该 Series 是否因任一 primary 成员为 NSFW 而整体隐藏。 */
export function isSeriesHidden(key: string): boolean {
  if (currentVisibility() === 'real') return false;
  const resolved = resolveEntityKey('series', key);
  if (!resolved) return false;
  const row = one<{ hidden: number }>(
    `SELECT CASE WHEN ${seriesVisibilityClause('e')} THEN 0 ELSE 1 END AS hidden
       FROM series_entities e WHERE e.id = :id`,
    { id: resolved.id },
  );
  return Number(row?.hidden ?? 0) === 1;
}

/** 该 Franchise 是否因所有成员 Series 都隐藏而整体隐藏。 */
export function isFranchiseHidden(key: string): boolean {
  if (currentVisibility() === 'real') return false;
  const resolved = resolveEntityKey('franchise', key);
  if (!resolved) return false;
  const row = one<{ hidden: number }>(
    `SELECT CASE WHEN ${franchiseVisibilityClause('f')} THEN 0 ELSE 1 END AS hidden
       FROM franchise_entities f WHERE f.id = :id`,
    { id: resolved.id },
  );
  return Number(row?.hidden ?? 0) === 1;
}

function parseInfoboxEntries(value: unknown): Array<{ key: string | null; value: string }> {
  return flattenInfoboxEntries(asInfoboxValue(value));
}

export function getFilterFacets(): FilterFacets {
  // v1.5.3：facets 是「当前可见收藏」的口径；真实总数单独用 realTotal 表达
  const base = `FROM collections c JOIN subjects s ON s.id = c.subject_id AND ${subjectVisibilityClause('s')}`;

  const years = all<{ value: number; count: number }>(
    `SELECT canonical_positive_integer(s.year) AS value, COUNT(*) AS count ${base}
     WHERE canonical_positive_integer(s.year) IS NOT NULL GROUP BY canonical_positive_integer(s.year) ORDER BY canonical_positive_integer(s.year) DESC`,
  ).map((row) => ({ value: Number(row.value), count: Number(row.count) }));

  const formatRows = all<{ value: string; count: number }>(
    `SELECT s.format AS value, COUNT(*) AS count ${base} GROUP BY s.format ORDER BY count DESC`,
  );

  const seasonRows = all<{ value: string; count: number }>(
    `SELECT s.season AS value, COUNT(*) AS count ${base}
     WHERE s.season IS NOT NULL GROUP BY s.season`,
  );

  const statusRows = all<{ value: number; count: number }>(
    `SELECT c.type AS value, COUNT(*) AS count ${base} GROUP BY c.type`,
  );

  // 标签不做截断：返回数据库中的全部去重标签，保证筛选器覆盖每一个标签
  const tagRows = all<{ value: string; count: number }>(
    `SELECT je.value AS value, COUNT(*) AS count
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.tag_names')}) je
     WHERE je.type = 'text' AND ${subjectVisibilityClause('s')}
     GROUP BY je.value
     ORDER BY count DESC, je.value ASC`,
  );

  // 制作公司 / 导演同样不做截断：只出现一次的公司或导演也必须能被检索到
  const studios = all<{ value: string; count: number }>(
    `SELECT je.value AS value, COUNT(*) AS count
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.studios')}) je
     WHERE je.type = 'text' AND ${subjectVisibilityClause('s')}
     GROUP BY je.value
     ORDER BY count DESC, je.value ASC`,
  );

  const directors = all<{ value: string; count: number }>(
    `SELECT je.value AS value, COUNT(*) AS count
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.directors')}) je
     WHERE je.type = 'text' AND ${subjectVisibilityClause('s')}
     GROUP BY je.value
     ORDER BY count DESC, je.value ASC`,
  );

  const staffTotal = one<{ n: number }>(
    `SELECT COUNT(DISTINCT st.name) AS n
     FROM collections c JOIN subject_staff st ON st.subject_id = c.subject_id
     WHERE ${collectionVisibilityClause('c')}`,
  );

  const stats = one<{ total: number; rated: number; min: number | null; max: number | null }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN 1 ELSE 0 END) AS rated,
            MIN(canonical_positive_integer(s.year)) AS min, MAX(canonical_positive_integer(s.year)) AS max ${base}`,
  );

  const realTotal = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM collections')?.n ?? 0);
  const hiddenCount = currentVisibility() === 'visible'
    ? Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM collections c JOIN subjects s ON s.id = c.subject_id
           WHERE NOT (${subjectVisibilityClause('s')})`,
        )?.n ?? 0,
      )
    : 0;

  const statusMap = new Map(statusRows.map((row) => [Number(row.value), Number(row.count)]));
  const formatMap = new Map(formatRows.map((row) => [row.value, Number(row.count)]));
  const seasonMap = new Map(seasonRows.map((row) => [row.value, Number(row.count)]));

  return {
    years,
    formats: [...formatMap.entries()]
      .map(([value, count]) => ({
        value: value as AnimeFormat,
        label: ANIME_FORMAT_LABEL[value as AnimeFormat] ?? value,
        count,
      }))
      .sort((a, b) => b.count - a.count),
    seasons: SEASONS.map((season) => ({
      value: season,
      count: seasonMap.get(season) ?? 0,
    })).filter((entry) => entry.count > 0),
    tags: tagRows.map((row) => ({ value: row.value, count: Number(row.count) })),
    tagTotal: tagRows.length,
    tagSingletonCount: tagRows.filter((row) => Number(row.count) === 1).length,
    studios: studios.map((row) => ({ value: row.value, count: Number(row.count) })),
    directors: directors.map((row) => ({ value: row.value, count: Number(row.count) })),
    staffTotal: Number(staffTotal?.n ?? 0),
    statuses: COLLECTION_TYPES.map((type) => ({
      value: type,
      count: statusMap.get(type) ?? 0,
    })).filter((entry) => entry.count > 0),
    total: Number(stats?.total ?? 0),
    realTotal,
    hiddenCount,
    ratedCount: Number(stats?.rated ?? 0),
    yearMin: stats?.min ?? null,
    yearMax: stats?.max ?? null,
  };
}

export function collectionTypeLabelOf(type: number): string {
  return COLLECTION_TYPE_LABEL[type as CollectionType] ?? String(type);
}

/**
 * 在「当前筛选结果」内聚合标签。
 *
 * 这是标签反向追溯的核心：例如先用 `staff=新海诚` 筛出作品，
 * 再对这批作品聚合标签，就能回答「这位制作人员的作品都涉及哪些标签」。
 * 与筛选器共用同一套 WHERE 条件，保证口径完全一致。
 */
export function aggregateTags(query: SubjectQuery): TagCountList {
  const where = buildWhere(query);
  const matched = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM collections c JOIN subjects s ON s.id = c.subject_id ${where.sql}`,
    where.params,
  );
  const rows = all<{ value: string; count: number }>(
    `SELECT je.value AS value, COUNT(*) AS count
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.tag_names')}) je
     ${where.sql ? `${where.sql} AND je.type = 'text'` : `WHERE je.type = 'text'`}
     GROUP BY je.value
     ORDER BY count DESC, je.value ASC`,
    where.params,
  );
  return {
    total: rows.length,
    matchedSubjects: Number(matched?.n ?? 0),
    tags: rows.map((row) => ({ value: row.value, count: Number(row.count) })),
  };
}

/**
 * 制作人员 / 公司检索。
 *
 * 覆盖 `subject_staff` 里的**全部**姓名（导演、音响监督、脚本、音乐、原画、制作公司…），
 * 不设「最少出现次数」门槛，只出现一次的人员同样可以搜到；
 * 关键词匹配按「完全匹配 → 前缀 → 包含」排序，再看参与作品数。
 */
export function searchStaff(options: { q?: string; limit?: number } = {}): StaffSearchResult {
  const limit = Math.min(300, Math.max(1, Math.round(options.limit ?? 60)));
  const keyword = (options.q ?? '').trim();
  const compact = keyword.replace(/[\s·・.,，。:：;；!！?？'"“”‘’()（）[\]【】\-_/\\|+&～~]/g, '');

  const totalRow = one<{ n: number }>(
    `SELECT COUNT(DISTINCT st.name) AS n
     FROM collections c JOIN subject_staff st ON st.subject_id = c.subject_id`,
  );
  const total = Number(totalRow?.n ?? 0);

  if (!keyword) {
    const visibleTotal = Number(
      one<{ n: number }>(
        `SELECT COUNT(DISTINCT st.name) AS n
         FROM collections c JOIN subject_staff st ON st.subject_id = c.subject_id
         WHERE ${collectionVisibilityClause('c')}`,
      )?.n ?? 0,
    );
    const rows = all<{ name: string; works: number; relations: string | null }>(
      `SELECT st.name AS name,
              COUNT(DISTINCT st.subject_id) AS works,
              GROUP_CONCAT(DISTINCT st.relation) AS relations
       FROM collections c JOIN subject_staff st ON st.subject_id = c.subject_id
       WHERE ${collectionVisibilityClause('c')}
       GROUP BY st.name
       ORDER BY works DESC, st.name ASC
       LIMIT :limit`,
      { limit },
    );
    return {
      total: visibleTotal,
      matched: visibleTotal,
      query: '',
      items: rows.map(mapStaffRow),
    };
  }

  const params = {
    exact: keyword,
    prefix: `${keyword}%`,
    like: `%${keyword}%`,
    compact: `%${compact}%`,
    limit,
  };
  const where = `
    WHERE (st.name LIKE :like
       OR st.name LIKE :prefix
       OR REPLACE(REPLACE(st.name, ' ', ''), '　', '') LIKE :compact)
      AND ${collectionVisibilityClause('c')}`;
  const rows = all<{ name: string; works: number; relations: string | null }>(
    `SELECT st.name AS name,
            COUNT(DISTINCT st.subject_id) AS works,
            GROUP_CONCAT(DISTINCT st.relation) AS relations
     FROM collections c JOIN subject_staff st ON st.subject_id = c.subject_id
     ${where}
     GROUP BY st.name
     ORDER BY
       CASE WHEN st.name = :exact THEN 0
            WHEN st.name LIKE :prefix THEN 1
            ELSE 2 END,
       works DESC,
       st.name ASC
     LIMIT :limit`,
    params,
  );
  const matched = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT st.name FROM collections c JOIN subject_staff st ON st.subject_id = c.subject_id
       ${where} GROUP BY st.name)`,
    // 计数查询只用到 where 里的两个参数，多余的命名参数会被 node:sqlite 拒绝
    { like: params.like, compact: params.compact },
  );

  return {
    total,
    matched: Number(matched?.n ?? 0),
    query: keyword,
    items: rows.map(mapStaffRow),
  };
}

function mapStaffRow(row: { name: string; works: number; relations: string | null }): StaffSearchItem {
  const relations = (row.relations ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    name: row.name,
    works: Number(row.works ?? 0),
    relations: [...new Set(relations)].slice(0, 6),
  };
}

/**
 * 全局实体检索：给主搜索栏提供「分类结果 + 相关作品数」。
 *
 * 作品数量直接复用 `buildWhere({ q })` 的统计口径，
 * 因此下拉里显示的「相关作品 N」与回车后的结果数完全一致。
 */
export function searchEntities(keyword: string, limit = 8): EntitySearchResult {
  const trimmed = keyword.trim();
  const empty: EntitySearchResult = {
    query: '',
    workTotal: 0,
    works: [],
    tags: [],
    staff: [],
    studios: [],
    directors: [],
  };
  if (!trimmed) return empty;

  const like = `%${escapeLike(trimmed)}%`;
  const prefix = `${escapeLike(trimmed)}%`;
  const lower = `%${escapeLike(trimmed.toLowerCase())}%`;

  const where = buildWhere({ q: trimmed });
  const totalRow = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM collections c JOIN subjects s ON s.id = c.subject_id ${where.sql}`,
    where.params,
  );

  const works = all<{
    id: number;
    title: string;
    original_title: string;
    year: number | null;
    cover_url: string | null;
    match_reasons: string | null;
  }>(
    `SELECT s.id,
            COALESCE(NULLIF(s.name_cn, ''), s.name) AS title,
            s.name AS original_title,
            canonical_positive_integer(s.year) AS year,
            s.cover_url AS cover_url,
            ${MATCH_REASON_SQL}
     FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE (s.name LIKE :qLike ESCAPE '\\' OR s.name_cn LIKE :qLike ESCAPE '\\'
        OR s.aliases LIKE :qLike ESCAPE '\\' OR CAST(s.id AS TEXT) = :qExact)
       AND ${subjectVisibilityClause('s')}
     ORDER BY
       CASE WHEN s.name_cn = :qExact OR s.name = :qExact THEN 0
            WHEN s.name_cn LIKE :qPrefix ESCAPE '\\' OR s.name LIKE :qPrefix ESCAPE '\\' THEN 1
            ELSE 2 END,
       s.id ASC
     LIMIT :limit`,
    { qLike: like, qExact: trimmed, qPrefix: prefix, limit },
  );

  const tagRows = all<{ value: string; count: number }>(
    `SELECT je.value AS value, COUNT(*) AS count
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.tag_names')}) je
     WHERE je.type = 'text' AND je.value LIKE :like ESCAPE '\\'
       AND ${subjectVisibilityClause('s')}
     GROUP BY je.value
     ORDER BY CASE WHEN je.value = :exact THEN 0 WHEN je.value LIKE :prefix ESCAPE '\\' THEN 1 ELSE 2 END,
              count DESC, je.value ASC
     LIMIT :limit`,
    { like, prefix, exact: trimmed, limit },
  );

  const studioRows = all<{ value: string; count: number }>(
    `SELECT je.value AS value, COUNT(*) AS count
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.studios')}) je
     WHERE je.type = 'text' AND je.value LIKE :like ESCAPE '\\'
       AND ${subjectVisibilityClause('s')}
     GROUP BY je.value
     ORDER BY CASE WHEN je.value = :exact THEN 0 WHEN je.value LIKE :prefix ESCAPE '\\' THEN 1 ELSE 2 END,
              count DESC, je.value ASC
     LIMIT :limit`,
    { like, prefix, exact: trimmed, limit },
  );

  const directorRows = all<{ value: string; count: number }>(
    `SELECT je.value AS value, COUNT(*) AS count
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.directors')}) je
     WHERE je.type = 'text' AND je.value LIKE :like ESCAPE '\\'
       AND ${subjectVisibilityClause('s')}
     GROUP BY je.value
     ORDER BY CASE WHEN je.value = :exact THEN 0 WHEN je.value LIKE :prefix ESCAPE '\\' THEN 1 ELSE 2 END,
              count DESC, je.value ASC
     LIMIT :limit`,
    { like, prefix, exact: trimmed, limit },
  );

  const staffResult = searchStaff({ q: trimmed, limit });

  return {
    query: trimmed,
    workTotal: Number(totalRow?.n ?? 0),
    works: works.map((row) => ({
      id: Number(row.id),
      title: row.title,
      originalTitle: row.original_title,
      year: row.year === null ? null : Number(row.year),
      cover: row.cover_url ?? null,
      reasons: (row.match_reasons ?? '').split(',').filter(Boolean),
    })),
    tags: tagRows.map((row) => ({ value: row.value, count: Number(row.count) })),
    staff: staffResult.items,
    studios: studioRows.map((row) => ({ value: row.value, count: Number(row.count) })),
    directors: directorRows.map((row) => ({ value: row.value, count: Number(row.count) })),
  };
}

/* ------------------------------------------------------------- 系列 / 家族 */

export type SeriesSort = 'size' | 'rate' | 'year' | 'title' | 'coverage' | 'completion';
export type FranchiseSort =
  | 'size'
  | 'collected'
  | 'year'
  | 'title'
  | 'coverage'
  | 'completion'
  | 'rate';

/** v1.8 Ranking：允许进入排名域的排序键（display ≠ rankable）。 */
export function rankingMetricOf(sort: SeriesSort | FranchiseSort | undefined): EntityRankingMetric | null {
  return sort === 'coverage' || sort === 'completion' || sort === 'rate' ? sort : null;
}

/** 行内 ranking 元数据：只在按指标排序时返回。 */
function rankingMetaOf(
  metric: EntityRankingMetric | null,
  row: { ranking_value?: number | null; ranking_sample?: number | null },
): EntityRankingMeta | undefined {
  if (!metric || row.ranking_value === undefined || row.ranking_sample === undefined) return undefined;
  const sample = Number(row.ranking_sample ?? 0);
  return {
    metric,
    value: row.ranking_value === null ? null : Number(row.ranking_value),
    sample,
    rankable: sample >= ENTITY_RANKING_MIN_SAMPLE,
  };
}

interface SeriesEntityRow {
  id: number;
  key: string;
  state: string;
  title: string;
  title_state: string;
  title_source: string;
  title_candidates: string;
  title_confirmed_at: string | null;
  evidence_coverage: string;
  member_count: number;
  confirmed_count: number;
  candidate_count: number;
  collected_count: number;
  total_episodes: number;
  average_rate: number | null;
  first_year: number | null;
  last_year: number | null;
  status_counts: string;
  cover_subjects: string;
  /** v1.8 Ranking：按指标排序时由 SQL 返回 */
  ranking_value?: number | null;
  ranking_sample?: number | null;
}

interface FranchiseEntityRow {
  id: number;
  key: string;
  state: string;
  title: string;
  title_state: string;
  title_source: string;
  title_candidates: string;
  series_count: number;
  confirmed_series_count: number;
  candidate_series_count: number;
  conflict_series_count: number;
  known_count: number;
  collected_count: number;
  average_rate: number | null;
  first_year: number | null;
  last_year: number | null;
  cover_subjects: string;
  /**
   * v1.8 OD2：两种口径按 canonical member-level 公式现算的平均分。
   */
  caliber_average_rate?: number | null;
  /** v1.8 Ranking：按指标排序时由 SQL 返回 */
  ranking_value?: number | null;
  ranking_sample?: number | null;
}

function mapSeriesEntity(
  row: SeriesEntityRow,
  rankingMetric: EntityRankingMetric | null = null,
): SeriesGroupSummary {
  const ranking = rankingMetaOf(rankingMetric, row);
  return {
    key: row.key,
    title: row.title,
    titleState: row.title_state as SeriesGroupSummary['titleState'],
    titleSource: row.title_source,
    state: row.state as SeriesGroupSummary['state'],
    memberCount: Number(row.member_count),
    collectedCount: Number(row.collected_count),
    confirmedCount: Number(row.confirmed_count),
    candidateCount: Number(row.candidate_count),
    totalEpisodes: Number(row.total_episodes),
    averageRate: row.average_rate === null ? null : Number(row.average_rate),
    firstYear: row.first_year === null ? null : Number(row.first_year),
    lastYear: row.last_year === null ? null : Number(row.last_year),
    statusCounts: parseJsonColumn<Record<string, number>>(row.status_counts, {}),
    evidenceCoverage: row.evidence_coverage as SeriesGroupSummary['evidenceCoverage'],
    coverSubjects: parseJsonColumn<Array<{ id: number; title: string }>>(row.cover_subjects, []),
    ...(ranking ? { ranking } : {}),
  };
}

function mapFranchiseEntity(
  row: FranchiseEntityRow,
  rankingMetric: EntityRankingMetric | null = null,
): FranchiseSummary {
  const ranking = rankingMetaOf(rankingMetric, row);
  const averageRate =
    row.caliber_average_rate === undefined
      ? row.average_rate === null
        ? null
        : Number(row.average_rate)
      : row.caliber_average_rate === null
        ? null
        : Number(row.caliber_average_rate);
  return {
    key: row.key,
    title: row.title,
    titleState: row.title_state as FranchiseSummary['titleState'],
    titleSource: row.title_source,
    state: row.state as FranchiseSummary['state'],
    seriesCount: Number(row.series_count),
    confirmedSeriesCount: Number(row.confirmed_series_count),
    candidateSeriesCount: Number(row.candidate_series_count),
    conflictSeriesCount: Number(row.conflict_series_count),
    collectedCount: Number(row.collected_count),
    knownCount: Number(row.known_count),
    averageRate,
    firstYear: row.first_year === null ? null : Number(row.first_year),
    lastYear: row.last_year === null ? null : Number(row.last_year),
    coverSubjects: parseJsonColumn<Array<{ id: number; title: string }>>(row.cover_subjects, []),
    ...(ranking ? { ranking } : {}),
  };
}

/** 旧实体投影可能仍存全部章节数；只读现算主成员话数，避免要求生产重算或迁移。 */
function seriesEpisodesSubquery(entityAlias: string): string {
  return `(SELECT COALESCE(SUM(${EPISODE_EXPRESSION}), 0)
    FROM series_entity_members m JOIN subjects s ON s.id = m.subject_id
    WHERE m.series_id = ${entityAlias}.id AND m.role = 'primary')`;
}

/** 年份读取当前合法来源，历史 materialization 不被覆写。 */
function entityYearSubquery(kind: 'series' | 'franchise', alias: string, aggregate: 'MIN' | 'MAX', visibility: Visibility): string {
  const from = kind === 'series'
    ? `series_entity_members m JOIN subjects s ON s.id = m.subject_id`
    : `franchise_series fs JOIN series_entities e2 ON e2.id = fs.series_id AND e2.state <> 'stale'
       JOIN series_entity_members m ON m.series_id = e2.id JOIN subjects s ON s.id = m.subject_id`;
  const scope = kind === 'series' ? `m.series_id = ${alias}.id`
    : `fs.franchise_id = ${alias}.id AND ${seriesVisibilityClause('e2', visibility)}`;
  return `(SELECT ${aggregate}(canonical_positive_integer(s.year)) FROM ${from}
    WHERE ${scope} AND m.role = 'primary' AND ${memberVisibilityClause('s', visibility)})`;
}

function entityYearsSelect(kind: 'series' | 'franchise', alias: string, visibility: Visibility): string {
  return `, ${entityYearSubquery(kind, alias, 'MIN', visibility)} AS first_year,
    ${entityYearSubquery(kind, alias, 'MAX', visibility)} AS last_year`;
}

function visibleFamilyCounters(alias: string, visibility: Visibility): string {
  if (!personalHidesActive() || visibility === 'real') return '';
  const from = `FROM franchise_series vfs JOIN series_entities ve ON ve.id=vfs.series_id
    WHERE vfs.franchise_id=${alias}.id AND ve.state<>'stale' AND ${seriesVisibilityClause('ve', visibility)}`;
  const linked = (condition:string) => `(SELECT COUNT(*) ${from} AND (${condition}))`;
  const memberFrom = `FROM franchise_series vfs JOIN series_entities ve ON ve.id=vfs.series_id
    JOIN series_entity_members vm ON vm.series_id=ve.id AND vm.role='primary'
    LEFT JOIN collections vc ON vc.subject_id=vm.subject_id
    WHERE vfs.franchise_id=${alias}.id AND ve.state<>'stale' AND ${seriesVisibilityClause('ve', visibility)}`;
  return `, ${linked('1=1')} AS series_count,
    ${linked("vfs.state IN ('confirmed','provisional')")} AS confirmed_series_count,
    ${linked("vfs.state='candidate'")} AS candidate_series_count,
    ${linked("vfs.state='conflict'")} AS conflict_series_count,
    (SELECT COUNT(DISTINCT vm.subject_id) ${memberFrom}) AS known_count,
    (SELECT COUNT(DISTINCT vc.subject_id) ${memberFrom}) AS collected_count`;
}

/** 代表图只取当前可见的成员（隐藏 NSFW 时不会用 NSFW Subject 的封面）。 */
function seriesCoverSubquery(): string {
  const visible = `AND ${subjectVisibilityClause('s')}`;
  return `
  (SELECT json_group_array(json_object('id', x.subject_id, 'title', x.title))
   FROM (
     SELECT m.subject_id, COALESCE(NULLIF(s.name_cn, ''), s.name) AS title
     FROM series_entity_members m
     JOIN subjects s ON s.id = m.subject_id
     WHERE m.series_id = e.id AND m.role = 'primary' AND s.cover_url IS NOT NULL ${visible}
     ORDER BY m.position ASC, m.subject_id ASC
     LIMIT 6
   ) x) AS cover_subjects
`;
}

function franchiseCoverSubquery(): string {
  const visible = `AND ${subjectVisibilityClause('s')}`;
  return `
  (SELECT json_group_array(json_object('id', x.subject_id, 'title', x.title))
   FROM (
     SELECT m.subject_id, COALESCE(NULLIF(s.name_cn, ''), s.name) AS title
     FROM franchise_series fs
     JOIN series_entities e2 ON e2.id = fs.series_id
     JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
     JOIN subjects s ON s.id = m.subject_id
     WHERE fs.franchise_id = f.id AND fs.state <> 'conflict' AND e2.state <> 'stale'
       AND ${seriesVisibilityClause('e2')} AND s.cover_url IS NOT NULL ${visible}
     ORDER BY fs.series_id ASC, m.position ASC, m.subject_id ASC
     LIMIT 6
   ) x) AS cover_subjects
`;
}

export function listSeries(
  options: { sort?: SeriesSort; includeSingletons?: boolean; limit?: number } = {},
): SeriesGroupSummary[] {
  const visibility: Visibility = currentVisibility();
  const rankingMetric = rankingMetricOf(options.sort);
  /*
   * v1.8 Ranking：排序在完整合法排序域上执行
   * （visibility 过滤 → 指标值/样本 → sample 门槛 → LIMIT）。
   * sample < 3 的实体仍然展示，但排在排名域之后（display ≠ rankable）。
   */
  const sortExpression =
    options.sort === 'year' ? entityYearSubquery('series', 'e', 'MIN', visibility) : options.sort === 'title' ? 'title' : 'member_count';
  const direction = options.sort === 'title' || options.sort === 'year' ? 'ASC' : 'DESC';
  const ranking = rankingMetric ? seriesRankingMetricSql(rankingMetric, visibility, 'e') : null;
  const rankingSelect = ranking
    ? `, ${ranking.value} AS ranking_value, ${ranking.sample} AS ranking_sample`
    : '';
  const orderBy = ranking
    ? `ORDER BY CASE WHEN (${ranking.sample}) >= ${ENTITY_RANKING_MIN_SAMPLE} THEN 0 ELSE 1 END,
                (${ranking.value}) IS NULL, (${ranking.value}) DESC, title ASC, id ASC`
    : `ORDER BY (${sortExpression}) IS NULL, ${sortExpression} ${direction}, title ASC, id ASC`;
  const rows = all<SeriesEntityRow>(
    `SELECT e.*,${publicSeriesTitle('e')} AS title${entityYearsSelect('series', 'e', visibility)}, ${seriesRankingMetricSql('rate', visibility, 'e').value} AS average_rate, ${seriesEpisodesSubquery('e')} AS total_episodes${rankingSelect}, ${seriesCoverSubquery()} FROM series_entities e
     WHERE e.state <> 'stale' AND ${seriesVisibilityClause('e', visibility)}
       ${options.includeSingletons ? '' : 'AND e.member_count >= 2'}
     ${orderBy}
     LIMIT :limit`,
    { limit: options.limit ?? 1000 },
  );
  return rows.map((row) => mapSeriesEntity(row, rankingMetric));
}

export function listFranchises(
  options: { sort?: FranchiseSort; state?: string; limit?: number; key?: string } = {},
): FranchiseSummary[] {
  const visibility: Visibility = currentVisibility();
  const rankingMetric = rankingMetricOf(options.sort);
  const sortExpression =
    options.sort === 'collected'
      ? 'collected_count'
      : options.sort === 'year'
        ? entityYearSubquery('franchise', 'f', 'MIN', visibility)
        : options.sort === 'title'
          ? 'title'
          : 'series_count';
  const direction = options.sort === 'title' || options.sort === 'year' ? 'ASC' : 'DESC';
  const conditions = [`state <> 'stale'`, franchiseVisibilityClause('f', visibility)];
  const params: Record<string, unknown> = { limit: options.limit ?? 500 };
  if (options.key !== undefined) {
    conditions.push('f.key = :key');
    params.key = options.key;
  }
  if (options.state && options.state !== 'all') {
    conditions.push('state = :state');
    params.state = options.state;
  }
  /*
   * 两种口径均按合法评分现算，避免旧 materialization 含非法评分；不改写历史投影。
   */
  const caliberAverage = `, ${franchiseAverageRateSql('f', visibility)} AS caliber_average_rate`;
  /*
   * v1.8 Ranking：与 Series 相同的排序域规则；franchise Rating 使用 canonical
   * caliber-aware 公式（hideNsfw=ON 时不得回退到 Real materialization）。
   */
  const ranking = rankingMetric ? franchiseRankingMetricSql(rankingMetric, visibility, 'f') : null;
  const rankingSelect = ranking
    ? `, ${ranking.value} AS ranking_value, ${ranking.sample} AS ranking_sample`
    : '';
  const orderBy = ranking
    ? `ORDER BY CASE WHEN (${ranking.sample}) >= ${ENTITY_RANKING_MIN_SAMPLE} THEN 0 ELSE 1 END,
                (${ranking.value}) IS NULL, (${ranking.value}) DESC, title ASC, id ASC`
    : `ORDER BY (${sortExpression}) IS NULL, ${sortExpression} ${direction}, title ASC, id ASC`;
  const rows = all<FranchiseEntityRow>(
    `SELECT f.*,${publicFranchiseTitle('f')} AS title${entityYearsSelect('franchise', 'f', visibility)}${caliberAverage}${visibleFamilyCounters('f', visibility)}${rankingSelect}, ${franchiseCoverSubquery()} FROM franchise_entities f
     WHERE ${conditions.join(' AND ')}
     ${orderBy}
     LIMIT :limit`,
    params,
  );
  return rows.map((row) => mapFranchiseEntity(row, rankingMetric));
}

/**
 * 系列的观看情况：**只以「我的收藏条目」为口径**。
 *
 * 明确不做的事：
 * - 不把未收藏的成员算作未看；
 * - 不用观看进度推断收藏状态；
 * - 只有全部收藏条目都是「看过」时才标记 allWatched。
 */
export function summarizeSeriesWatch(entries: SubjectListItem[]): SeriesWatchSummary {
  const statusCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const entry of entries) {
    const type = Number(entry.collectionType);
    statusCounts[type] = (statusCounts[type] ?? 0) + 1;
  }
  const collectedCount = entries.length;
  const watched = statusCounts[COLLECTION_TYPE.Done] ?? 0;
  const watching = statusCounts[COLLECTION_TYPE.Doing] ?? 0;
  const onHold = statusCounts[COLLECTION_TYPE.OnHold] ?? 0;
  const dropped = statusCounts[COLLECTION_TYPE.Dropped] ?? 0;
  const wish = statusCounts[COLLECTION_TYPE.Wish] ?? 0;

  return {
    knownMembers: collectedCount,
    collectedCount,
    candidateCount: 0,
    watched,
    wish,
    watching,
    onHold,
    dropped,
    allWatched: collectedCount > 0 && watched === collectedCount,
    anyStarted: watched + watching + onHold + dropped > 0,
    insufficient: collectedCount === 0 ? '该系列当前没有收藏条目，无法统计观看情况。' : null,
  };
}

function membershipReason(
  reasonCode: string,
  viaRelation: string | null,
  viaTitle: string | null,
): string {
  const [kind, relation] = reasonCode.split(':');
  const label = relation || viaRelation || '';
  switch (kind) {
    case 'continuity':
      return `${label} · 连续作品`;
    case 'derivation':
      return `${label} · 同一作品体的派生版本`;
    case 'derivative':
      return viaTitle ? `${label} · 来自《${viaTitle}》` : `${label} · 相关作品`;
    case 'heuristic':
      return '标题相近（推测，未经验证）';
    case 'anchor':
      return '系列起点（拓扑）';
    default:
      return '数据推算';
  }
}

export function getSeriesDetail(
  key: string,
  options: { visibility?: Visibility } = {},
): SeriesDetail | null {
  const resolvedKey = resolveEntityKey('series', key);
  if (!resolvedKey) return null;
  if (isSeriesHidden(key)) return null;
  const visibility: Visibility = options.visibility ?? currentVisibility();
  const row = one<SeriesEntityRow>(`SELECT e.*,${publicSeriesTitle('e')} AS title${entityYearsSelect('series', 'e', visibility)}, ${seriesRankingMetricSql('rate', visibility, 'e').value} AS average_rate, ${seriesEpisodesSubquery('e')} AS total_episodes FROM series_entities e WHERE id = :id`, {
    id: resolvedKey.id,
  });
  if (!row) return null;

  const memberRows = all<
    RawJoinedRow & {
      member_subject_id: number;
      member_role: string;
      member_state: string;
      reason_code: string;
      via_subject_id: number | null;
      via_relation: string | null;
      ref_name_cn: string | null;
      ref_name: string | null;
    }
  >(
    `SELECT ${selectColumns()}, m.subject_id AS member_subject_id,
            (SELECT r.name_cn FROM subject_relations r
              WHERE ${validRelationSql('r')} AND r.related_id = m.subject_id AND ${personallyVisibleId('r.subject_id')} AND r.name_cn <> ''
              ORDER BY r.subject_id, r.related_id LIMIT 1) AS ref_name_cn,
            (SELECT r.name FROM subject_relations r
              WHERE ${validRelationSql('r')} AND r.related_id = m.subject_id AND ${personallyVisibleId('r.subject_id')} AND r.name <> ''
              ORDER BY r.subject_id, r.related_id LIMIT 1) AS ref_name,
            m.role AS member_role, m.state AS member_state, m.reason_code,
            CASE WHEN ${personallyVisibleId('m.via_subject_id')} THEN m.via_subject_id END AS via_subject_id,
            CASE WHEN ${personallyVisibleId('m.via_subject_id')} THEN m.via_relation END AS via_relation
     FROM series_entity_members m
     LEFT JOIN subjects s ON s.id = m.subject_id
     LEFT JOIN collections c ON c.subject_id = m.subject_id
     WHERE m.series_id = :id AND ${personallyVisibleId('m.subject_id')}
     ORDER BY m.position ASC, m.subject_id ASC`,
    { id: resolvedKey.id },
  );

  const titleById = new Map<number, string>();
  const items: SubjectListItem[] = [];
  const members: SeriesMemberEntry[] = [];
  for (const member of memberRows) {
    const subjectId = Number(member.member_subject_id);
    const title = (member.name_cn || member.ref_name_cn || member.name || member.ref_name || '').trim();
    titleById.set(subjectId, title);
    const collected =
      member.id !== null &&
      member.collection_type !== null &&
      member.collection_type !== undefined;
    const item = collected ? mapSubjectRow(member) : null;
    // Watch statistics describe collected primary members, not candidate evidence.
    if (item && member.member_role === 'primary') items.push(item);
    const viaTitle = member.via_subject_id === null ? null : titleById.get(Number(member.via_subject_id)) ?? null;
    members.push({
      subjectId,
      title,
      originalTitle: member.name ?? member.ref_name ?? '',
      year: member.year === null ? null : Number(member.year),
      collected,
      relationOnly: member.id === null,
      role: member.member_role === 'candidate' ? 'candidate' : 'primary',
      state: member.member_state as SeriesMemberEntry['state'],
      reasonCode: member.reason_code,
      reason: membershipReason(member.reason_code, member.via_relation, viaTitle),
      viaSubjectId: member.via_subject_id === null ? null : Number(member.via_subject_id),
      viaRelation: member.via_relation,
      item,
    });
  }
  // via 标题可能来自排序更晚的成员，做一次回填
  for (const member of members) {
    if (!member.reason.includes('来自')) continue;
    if (member.viaSubjectId === null) continue;
    const viaTitle = titleById.get(member.viaSubjectId);
    if (viaTitle) member.reason = membershipReason(member.reasonCode, member.viaRelation, viaTitle);
  }

  const memberIds = new Set(members.map((entry) => entry.subjectId));
  const relatedRows = all<{
    subject_id: number;
    related_id: number;
    relation: string;
    rel_name: string | null;
    rel_name_cn: string | null;
    name: string | null;
    name_cn: string | null;
  }>(
    `SELECT r.subject_id, r.related_id, r.relation,
            r.name AS rel_name, r.name_cn AS rel_name_cn,
            s.name, s.name_cn
     FROM subject_relations r
     LEFT JOIN subjects s ON s.id = r.related_id
     WHERE ${validRelationSql('r')} AND r.subject_id IN (SELECT subject_id FROM series_entity_members WHERE series_id = :id)
       AND ${relatedSubjectVisibilityClause('r.related_id')} AND ${personallyVisibleId('r.subject_id')}
     ORDER BY r.related_id, r.relation`,
    { id: resolvedKey.id },
  );
  const relatedByTarget = new Map<number, SeriesRelatedEntry>();
  for (const related of relatedRows) {
    const targetId = Number(related.related_id);
    if (memberIds.has(targetId) || relatedByTarget.has(targetId)) continue;
    const kind = classifyRelation(related.relation ?? '');
    if (kind.klass === 'continuity' || kind.klass === 'derivation') continue;
    const title = (related.name_cn || related.rel_name_cn || related.name || related.rel_name || '').trim();
    let reason: string;
    switch (kind.klass) {
      case 'association':
        reason = `仅「${related.relation}」关联，证据不足，未纳入系列`;
        break;
      case 'alternate':
        reason = `「${related.relation}」，属于更高层家族候选，不并入系列`;
        break;
      case 'material':
        reason = `「${related.relation}」属于跨媒体素材，不参与系列成员`;
        break;
      case 'derivative':
        reason = `「${related.relation}」，与另一系列相关，未自动合并`;
        break;
      default:
        reason = `未识别的关系类型「${related.relation}」，默认不合并`;
        break;
    }
    relatedByTarget.set(targetId, {
      subjectId: targetId,
      title,
      relation: related.relation,
      relationClass: kind.klass,
      reason,
      coveredBy: Number(related.subject_id),
    });
  }
  const related = [...relatedByTarget.values()]
    .sort((a, b) => a.subjectId - b.subjectId)
    .slice(0, 50);

  // 候选合并：同家族内、证据含 derivative 的其他 Series。
  const mergeCandidates: SeriesMergeCandidate[] = [];
  const franchiseIds = all<{ franchise_id: number }>(
    'SELECT franchise_id FROM franchise_series WHERE series_id = :id',
    { id: resolvedKey.id },
  );
  for (const entry of personalHidesActive() ? [] : franchiseIds) {
    const siblings = all<{
      series_id: number;
      evidence: string;
      key: string;
      title: string;
      state: string;
    }>(
      `SELECT fs.series_id, fs.evidence, e.key, ${publicSeriesTitle('e')} AS title, e.state
       FROM franchise_series fs JOIN series_entities e ON e.id = fs.series_id
       WHERE fs.franchise_id = :fid AND fs.series_id <> :id AND e.state <> 'stale'
         AND ${seriesVisibilityClause('e')}`,
      { fid: Number(entry.franchise_id), id: resolvedKey.id },
    );
    for (const sibling of siblings) {
      const evidence = parseJsonColumn<{ classes?: string[]; relations?: string[] }>(
        sibling.evidence,
        {},
      );
      if (!evidence.classes?.includes('derivative')) continue;
      mergeCandidates.push({
        seriesKey: sibling.key,
        title: sibling.title,
        state: sibling.state as SeriesMergeCandidate['state'],
        relations: evidence.relations ?? [],
      });
    }
  }

  const watch = summarizeSeriesWatch(items);
  watch.knownMembers = Number(row.member_count);
  watch.candidateCount = personalHidesActive() ? members.filter(m=>m.role==='candidate').length : Number(row.candidate_count);

  const franchiseRow = one<{ key: string; title: string; title_state: string; state: string }>(
    `SELECT f.key, ${publicFranchiseTitle('f')} AS title, f.title_state, f.state
     FROM franchise_series fs JOIN franchise_entities f ON f.id = fs.franchise_id
     WHERE fs.series_id = :id AND fs.state <> 'conflict' AND f.state NOT IN ('stale','rejected')
       AND ${franchiseVisibilityClause('f')}
     ORDER BY ${manualFranchisePriority()} CASE f.state WHEN 'confirmed' THEN 0 WHEN 'provisional' THEN 1 ELSE 2 END, f.id
     LIMIT 1`,
    { id: resolvedKey.id },
  );

  return {
    ...mapSeriesEntity(row),
    ...(personalHidesActive() ? {candidateCount:watch.candidateCount} : {}),
    canonicalKey: resolvedKey.key,
    aliasedFrom: resolvedKey.aliasedFrom,
    members,
    related,
    mergeCandidates,
    titleCandidates: personalHidesActive() ? [] : projectTitleCandidates(row.title_candidates),
    titleConfirmedAt: row.title_confirmed_at ?? null,
    franchise: franchiseRow
      ? {
          key: franchiseRow.key,
          title: franchiseRow.title,
          titleState: franchiseRow.title_state as EntityLink['titleState'],
          state: franchiseRow.state,
        }
      : null,
    watch,
    analysis: seriesAnalysis(resolvedKey.id, visibility),
  };
}

export function getFranchiseDetail(
  key: string,
  options: { visibility?: Visibility } = {},
): FranchiseDetail | null {
  const resolvedKey = resolveEntityKey('franchise', key);
  if (!resolvedKey) return null;
  if (isFranchiseHidden(key)) return null;
  const visibility: Visibility = options.visibility ?? currentVisibility();
  // 同一 canonical 公式读取合法评分；旧 materialization 不作为评分事实。
  const caliberAverage = `, ${franchiseAverageRateSql('f', visibility)} AS caliber_average_rate`;
  const row = one<FranchiseEntityRow>(
    `SELECT f.*,${publicFranchiseTitle('f')} AS title${entityYearsSelect('franchise', 'f', visibility)}${caliberAverage}${visibleFamilyCounters('f', visibility)} FROM franchise_entities f WHERE f.id = :id`,
    { id: resolvedKey.id },
  );
  if (!row) return null;

  const identityVisibility = personalHidesActive() ? currentVisibility() : visibility;
  const linkRows = all<{ series_id: number; state: string; evidence: string }>(
    `SELECT fs.series_id, fs.state, fs.evidence
       FROM franchise_series fs
       JOIN series_entities e ON e.id = fs.series_id
      WHERE fs.franchise_id = :id AND e.state <> 'stale'
        AND ${seriesVisibilityClause('e', identityVisibility)}`,
    { id: resolvedKey.id },
  );
  const memberRows = all<RawJoinedRow & { series_id: number }>(
    `SELECT ${selectColumns()}, fs.series_id
     FROM franchise_series fs
     JOIN series_entities e2 ON e2.id = fs.series_id
     JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
     JOIN subjects s ON s.id = m.subject_id
     JOIN collections c ON c.subject_id = m.subject_id
     WHERE fs.franchise_id = :id
       AND e2.state <> 'stale' AND ${seriesVisibilityClause('e2', identityVisibility)}
       AND ${subjectVisibilityClause('s', identityVisibility)}
     ORDER BY fs.series_id ASC, m.position ASC`,
    { id: resolvedKey.id },
  );
  const itemsBySeries = new Map<number, SubjectListItem[]>();
  for (const member of memberRows) {
    const list = itemsBySeries.get(Number(member.series_id)) ?? [];
    list.push(mapSubjectRow(member));
    itemsBySeries.set(Number(member.series_id), list);
  }

  const series: FranchiseSeriesEntry[] = [];
  for (const link of linkRows) {
    const seriesRow = one<SeriesEntityRow>(`SELECT e.*, ${publicSeriesTitle('e')} AS title FROM series_entities e WHERE id = :id`, {
      id: Number(link.series_id),
    });
    if (!seriesRow) continue;
    const evidence = parseJsonColumn<{
      relations?: string[];
      classes?: string[];
      negativeRelations?: string[];
      brand?: string | null;
      tag?: string | null;
      source?: string | null;
    }>(link.evidence, {});
    const labels: string[] = [];
    if (evidence.relations?.length) labels.push(`关系：${evidence.relations.join('、')}`);
    if (evidence.brand) labels.push(`标题品牌：${evidence.brand}`);
    if (evidence.tag) labels.push(`共同标签：${evidence.tag}`);
    if (evidence.source) labels.push(`共同来源：${evidence.source}`);
    if (evidence.negativeRelations?.length)
      labels.push(`反向证据：${evidence.negativeRelations.join('、')}`);
    if (labels.length === 0) labels.push('证据不足');
    const entries = itemsBySeries.get(Number(link.series_id)) ?? [];
    series.push({
      key: seriesRow.key,
      title: seriesRow.title,
      state: seriesRow.state as FranchiseSeriesEntry['state'],
      linkState: link.state as FranchiseSeriesEntry['linkState'],
      evidence: labels,
      memberCount: Number(seriesRow.member_count),
      collectedCount: Number(seriesRow.collected_count),
      entries,
    });
  }
  series.sort((a, b) => b.collectedCount - a.collectedCount || a.key.localeCompare(b.key));

  /*
   * v1.8.4：身份冲突（Identity Conflict）只读视图。
   *
   * 家族链接指向 stale Series 时，若该 Series 存在可验证的 `rebuilt-into` 生命周期谱系，
   * 则给出可执行 supersede 治理的 from → to；没有谱系证据的一律标记为 unresolved，
   * 只展示、不允许自动迁移。
   */
  const identityConflicts = all<{ series_id: number; state: string }>(
    `SELECT fs.series_id, fs.state FROM franchise_series fs
      JOIN series_entities e ON e.id = fs.series_id
     WHERE fs.franchise_id = :id AND e.state = 'stale'
     ORDER BY fs.series_id`,
    { id: resolvedKey.id },
  ).map((link) => {
    const stale = one<{ key: string; title: string }>(
      'SELECT key, title FROM series_entities WHERE id = :id',
      { id: Number(link.series_id) },
    );
    const fromKey = stale?.key ?? `#${link.series_id}`;
    const supersession = stale ? findSeriesSupersession(stale.key) : null;
    return {
      fromSeriesKey: fromKey,
      fromSeriesTitle: stale?.title ?? '',
      toSeriesKey: supersession?.to.key ?? null,
      toSeriesTitle: supersession?.to.title ?? null,
      reason: (supersession ? 'superseded' : 'unresolved') as 'superseded' | 'unresolved',
      evidence: supersession
        ? {
            aliasReason: supersession.provenance.aliasReason,
            mergedEventId: supersession.provenance.mergedEventId,
            mergedAt: supersession.provenance.mergedAt,
            restoredEventId: supersession.provenance.restoredEventId,
            members: supersession.members.members,
            exact: supersession.members.exact,
            high: supersession.members.high,
          }
        : null,
    };
  });

  const summary = mapFranchiseEntity(row);

  return {
    ...summary,
    canonicalKey: resolvedKey.key,
    aliasedFrom: resolvedKey.aliasedFrom,
    titleCandidates: personalHidesActive() ? [] : projectTitleCandidates(row.title_candidates),
    series,
    exclusions: listFranchiseMemberExclusions(resolvedKey.id),
    identityConflicts,
    analysis: franchiseAnalysis(resolvedKey.id, visibility),
  };
}

/** 关系类型审计：覆盖数据库里出现的全部 relation，并暴露 unknown。 */
export function getRelationAudit(): RelationAudit {
  const rows = all<{ relation: string; n: number }>(
    `SELECT relation, COUNT(*) AS n FROM subject_relations r
      WHERE ${personallyVisibleId('r.subject_id')} AND ${personallyVisibleId('r.related_id')} GROUP BY relation`,
  );
  const entries: RelationAuditEntry[] = rows
    .map((row) => {
      const kind = classifyRelation(row.relation ?? '');
      return {
        relation: row.relation ?? '',
        klass: kind.klass,
        polarity: kind.polarity,
        note: kind.note,
        count: Number(row.n),
      };
    })
    .sort((a, b) => b.count - a.count || a.relation.localeCompare(b.relation, 'zh-Hans-CN'));
  return {
    total: entries.reduce((sum, entry) => sum + entry.count, 0),
    unknownCount: entries
      .filter((entry) => entry.klass === 'unknown')
      .reduce((sum, entry) => sum + entry.count, 0),
    entries,
    migration: {
      legacyGroups: Number(
        one<{ n: number }>('SELECT COUNT(*) AS n FROM series_legacy_snapshot')?.n ?? 0,
      ),
      aliasedGroups: Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM entity_aliases WHERE reason = 'legacy-key'`,
        )?.n ?? 0,
      ),
      unmappedGroups: Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM entity_events WHERE entity_kind = 'legacy' AND kind = 'unmapped'`,
        )?.n ?? 0,
      ),
      mergedTargets: Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM entity_events WHERE kind = 'legacy_merged'`,
        )?.n ?? 0,
      ),
      splitGroups: Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM entity_events WHERE kind = 'legacy_split'`,
        )?.n ?? 0,
      ),
    },
  };
}
