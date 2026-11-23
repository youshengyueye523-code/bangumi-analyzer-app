import type {
  CountItem,
  DistributionStats,
  HabitsStats,
  OverviewStats,
  RatingBiasStats,
  StudioStats,
  TimelinePoint,
  TimelineStats,
} from '@bangumi-analyzer/shared';
import {
  ANIME_FORMAT_LABEL,
  ApiError,
  COLLECTION_TYPE_LABEL,
  COLLECTION_TYPES,
  SCORE_BANDS,
  SEASONS,
  type AnimeFormat,
} from '@bangumi-analyzer/shared';
import { all, one } from '../db/index.js';
import { lastSuccessfulSyncAt, latestSyncRun } from '../db/syncRuns.js';
import { getMeta, dataVersion } from '../db/index.js';
import {
  collectionVisibilityClause,
  subjectVisibilityClause,
  type Visibility,
} from '../db/visibility.js';
import { round } from '../util.js';
import { cached } from './cache.js';
import { EPISODE_EXPRESSION, MINUTES_PER_EPISODE, WATCHED_EXPRESSION, jsonArrayExpression } from './expressions.js';

interface AggregateRow {
  key: string | number | null;
  label?: string | null;
  count: number;
  rated: number | null;
  highRated: number | null;
  averageRate: number | null;
  averageBgmScore: number | null;
}

function toCountItems(rows: AggregateRow[], labelOf: (key: string) => string): CountItem[] {
  const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
  const highTotal = rows.reduce((sum, row) => sum + Number(row.highRated ?? 0), 0);
  return rows.map((row) => {
    const key = String(row.key ?? '');
    const count = Number(row.count);
    return {
      key,
      label: labelOf(key),
      count,
      share: total > 0 ? Number((count / total).toFixed(4)) : 0,
      averageRate: round(row.averageRate ?? null),
      averageBgmScore: round(row.averageBgmScore ?? null),
      highRatedShare:
        highTotal > 0 ? Number((Number(row.highRated ?? 0) / highTotal).toFixed(4)) : null,
    };
  });
}

/**
 * 通用分组统计：count / 平均我的评分 / 平均 Bangumi 评分 / 高分数量。
 * 所有分组走同一条 SQL 模板，保证各维度统计口径完全一致。
 * v1.8：同一模板必须同时带上同一个 visibility 口径。
 */
function groupBy(
  expression: string,
  options: { visibility: Visibility; where?: string; extra?: string },
): AggregateRow[] {
  const conditions = [subjectVisibilityClause('s', options.visibility)];
  if (options.where) conditions.push(options.where);
  return all<AggregateRow>(
    `SELECT ${expression} AS key,
            COUNT(*) AS count,
            SUM(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN 1 ELSE 0 END) AS rated,
            SUM(CASE WHEN effective_personal_rate(c.type,c.rate) >= 8 THEN 1 ELSE 0 END) AS highRated,
            AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN effective_personal_rate(c.type,c.rate) END) AS averageRate,
            AVG(CASE WHEN canonical_score(s.score) > 0 THEN canonical_score(s.score) END) AS averageBgmScore
     FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY key
     ORDER BY count DESC, key ASC`,
  );
}

export function overview(scope?: Visibility): OverviewStats {
  return cached('overview', (visibility) => {
    const visible = subjectVisibilityClause('s', visibility);
    const row = one<{
      total: number;
      wish: number;
      done: number;
      doing: number;
      onhold: number;
      dropped: number;
      rated: number;
      high: number;
      low: number;
      unfinished: number;
      avgRate: number | null;
      avgScore: number | null;
      delta: number | null;
      minYear: number | null;
      maxYear: number | null;
      details: number;
      relations: number;
    }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN c.type = 1 THEN 1 ELSE 0 END) AS wish,
         SUM(CASE WHEN c.type = 2 THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN c.type = 3 THEN 1 ELSE 0 END) AS doing,
         SUM(CASE WHEN c.type = 4 THEN 1 ELSE 0 END) AS onhold,
         SUM(CASE WHEN c.type = 5 THEN 1 ELSE 0 END) AS dropped,
         SUM(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN 1 ELSE 0 END) AS rated,
         SUM(CASE WHEN effective_personal_rate(c.type,c.rate) >= 8 THEN 1 ELSE 0 END) AS high,
         SUM(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 AND effective_personal_rate(c.type,c.rate) <= 5 THEN 1 ELSE 0 END) AS low,
         /*
          * 「未完成」= 非「看过」的全部收藏（想看 + 在看 + 搁置 + 抛弃）。
          * 之前这里统计的是「在看 + 搁置 + 抛弃」，被界面当成「未完成」展示，
          * 语义错误（搁置 ≠ 全部未完成）。完成率与它必须来自同一套 canonical 状态：
          *   completionRate = 看过 / 收藏总量
          *   unfinished     = 收藏总量 - 看过
          */
         SUM(CASE WHEN c.type <> 2 THEN 1 ELSE 0 END) AS unfinished,
         AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN effective_personal_rate(c.type,c.rate) END) AS avgRate,
         AVG(CASE WHEN canonical_score(s.score) > 0 THEN canonical_score(s.score) END) AS avgScore,
         AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 AND canonical_score(s.score) > 0 THEN effective_personal_rate(c.type,c.rate) - canonical_score(s.score) END) AS delta,
         MIN(canonical_positive_integer(s.year)) AS minYear, MAX(canonical_positive_integer(s.year)) AS maxYear,
         SUM(CASE WHEN s.detail_state = 'ok' THEN 1 ELSE 0 END) AS details,
         SUM(CASE WHEN s.relations_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS relations
        FROM collections c JOIN subjects s ON s.id = c.subject_id
        WHERE ${visible}`,
    );

    const progress = one<{ watched: number | null; totalEpisodes: number | null; counted: number | null }>(
      `SELECT
         SUM(${WATCHED_EXPRESSION}) AS watched,
         SUM(${EPISODE_EXPRESSION}) AS totalEpisodes,
         SUM(CASE WHEN ${EPISODE_EXPRESSION} > 0 THEN 1 ELSE 0 END) AS counted
       FROM collections c JOIN subjects s ON s.id = c.subject_id
       WHERE c.type IN (2, 3, 4, 5) AND ${visible}`,
    );

    const perFormat = all<{ format: string; watched: number | null }>(
      `SELECT s.format AS format, SUM(${WATCHED_EXPRESSION}) AS watched
       FROM collections c JOIN subjects s ON s.id = c.subject_id
       WHERE c.type IN (2, 3, 4, 5) AND ${EPISODE_EXPRESSION} > 0 AND ${visible}
       GROUP BY s.format`,
    );

    const estimatedMinutes = perFormat.reduce((sum, entry) => {
      const minutes = MINUTES_PER_EPISODE[(entry.format as AnimeFormat) ?? '其他'] ?? 24;
      return sum + Number(entry.watched ?? 0) * minutes;
    }, 0);

    const ratedRates = all<{ rate: number }>(
      `SELECT effective_personal_rate(c.type,c.rate) AS rate FROM collections c
       WHERE effective_personal_rate(c.type,c.rate) > 0 AND ${collectionVisibilityClause('c', visibility)}
       ORDER BY effective_personal_rate(c.type,c.rate) ASC`,
    ).map((entry) => Number(entry.rate));
    const medianRate =
      ratedRates.length === 0
        ? null
        : ratedRates.length % 2 === 1
          ? ratedRates[(ratedRates.length - 1) / 2]!
          : (ratedRates[ratedRates.length / 2 - 1]! + ratedRates[ratedRates.length / 2]!) / 2;

    const total = Number(row?.total ?? 0);
    const watchedEpisodes = Number(progress?.watched ?? 0);
    const totalEpisodes = Number(progress?.totalEpisodes ?? 0);
    const lastRun = latestSyncRun();

    return {
      total,
      statusCounts: {
        '1': Number(row?.wish ?? 0),
        '2': Number(row?.done ?? 0),
        '3': Number(row?.doing ?? 0),
        '4': Number(row?.onhold ?? 0),
        '5': Number(row?.dropped ?? 0),
      },
      ratedCount: Number(row?.rated ?? 0),
      unratedCount: total - Number(row?.rated ?? 0),
      averageRate: round(row?.avgRate ?? null),
      medianRate: round(medianRate),
      averageBgmScore: round(row?.avgScore ?? null),
      completionRate: total > 0 ? Number((Number(row?.done ?? 0) / total).toFixed(4)) : 0,
      highRatedCount: Number(row?.high ?? 0),
      lowRatedCount: Number(row?.low ?? 0),
      unfinishedCount: Number(row?.unfinished ?? 0),
      watchedEpisodes,
      totalEpisodes,
      progressRatio: totalEpisodes > 0 ? Number((watchedEpisodes / totalEpisodes).toFixed(4)) : 0,
      progressCountedSubjects: Number(progress?.counted ?? 0),
      estimatedMinutes,
      meanDelta: round(row?.delta ?? null),
      yearRange: {
        min: row?.minYear === null || row?.minYear === undefined ? null : Number(row.minYear),
        max: row?.maxYear === null || row?.maxYear === undefined ? null : Number(row.maxYear),
      },
      detailCoverage: {
        synced: Number(row?.details ?? 0),
        total,
        ratio: total > 0 ? Number((Number(row?.details ?? 0) / total).toFixed(4)) : 0,
      },
      relationsCoverage: {
        synced: Number(row?.relations ?? 0),
        total,
        ratio: total > 0 ? Number((Number(row?.relations ?? 0) / total).toFixed(4)) : 0,
      },
      lastSyncAt: getMeta('last_sync_at') ?? lastSuccessfulSyncAt(),
      lastSyncSummary: lastRun
        ? {
            added: lastRun.counters.added,
            updated: lastRun.counters.updated,
            removed: lastRun.counters.removed,
          }
        : null,
      dataVersion: dataVersion(),
    };
  }, scope);
}

export function distributions(scope?: Visibility): DistributionStats {
  return cached('distributions', (visibility) => {
    const visible = subjectVisibilityClause('s', visibility);
    const status = toCountItems(
      groupBy('c.type', { visibility }).sort((a, b) => Number(a.key) - Number(b.key)),
      (key) => COLLECTION_TYPE_LABEL[Number(key) as 1] ?? key,
    );

    const rate = toCountItems(
      groupBy(
        `CASE WHEN effective_personal_rate(c.type,c.rate) <= 0 THEN 'unrated'
              WHEN effective_personal_rate(c.type,c.rate) <= 4 THEN '1-4'
              ELSE CAST(effective_personal_rate(c.type,c.rate) AS TEXT) END`,
        { visibility },
      ),
      (key) => SCORE_BANDS.find((band) => band.key === key)?.label ?? key,
    ).sort(
      (a, b) =>
        SCORE_BANDS.findIndex((band) => band.key === a.key) -
        SCORE_BANDS.findIndex((band) => band.key === b.key),
    );

    const bgmScore = toCountItems(
      groupBy(
        `CASE WHEN canonical_score(s.score) IS NULL OR canonical_score(s.score) <= 0 THEN 'unknown'
              WHEN canonical_score(s.score) < 5 THEN '<5'
              WHEN canonical_score(s.score) < 6 THEN '5-6'
              WHEN canonical_score(s.score) < 7 THEN '6-7'
              WHEN canonical_score(s.score) < 8 THEN '7-8'
              WHEN canonical_score(s.score) < 9 THEN '8-9'
              ELSE '9+' END`,
        { visibility },
      ),
      (key) => (key === 'unknown' ? '暂无评分' : key),
    ).sort((a, b) => a.label.localeCompare(b.label));

    const year = toCountItems(
      groupBy('canonical_positive_integer(s.year)', { visibility, where: 'canonical_positive_integer(s.year) IS NOT NULL' }).sort(
        (a, b) => Number(a.key) - Number(b.key),
      ),
      (key) => `${key} 年`,
    );

    const format = toCountItems(
      groupBy('s.format', { visibility }),
      (key) => ANIME_FORMAT_LABEL[key as AnimeFormat] ?? key,
    );

    const season = toCountItems(
      groupBy('s.season', { visibility, where: `s.season IS NOT NULL` }),
      (key) => `${key}季`,
    ).sort((a, b) => SEASONS.indexOf(a.key as never) - SEASONS.indexOf(b.key as never));

    const tag = toCountItems(
      all<AggregateRow>(
        `SELECT je.value AS key,
                COUNT(*) AS count,
                SUM(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN 1 ELSE 0 END) AS rated,
                SUM(CASE WHEN effective_personal_rate(c.type,c.rate) >= 8 THEN 1 ELSE 0 END) AS highRated,
                AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN effective_personal_rate(c.type,c.rate) END) AS averageRate,
                AVG(CASE WHEN canonical_score(s.score) > 0 THEN canonical_score(s.score) END) AS averageBgmScore
         FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.tag_names')}) je
         WHERE je.type = 'text' AND ${visible}
         GROUP BY je.value
         ORDER BY count DESC, je.value ASC
         LIMIT 40`,
      ),
      (key) => key,
    );

    const original = toCountItems(
      all<AggregateRow>(
        `SELECT je.value AS key,
                COUNT(*) AS count,
                SUM(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN 1 ELSE 0 END) AS rated,
                SUM(CASE WHEN effective_personal_rate(c.type,c.rate) >= 8 THEN 1 ELSE 0 END) AS highRated,
                AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN effective_personal_rate(c.type,c.rate) END) AS averageRate,
                AVG(CASE WHEN canonical_score(s.score) > 0 THEN canonical_score(s.score) END) AS averageBgmScore
         FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.originals')}) je
         WHERE je.type = 'text' AND ${visible}
         GROUP BY je.value
         ORDER BY count DESC, je.value ASC
         LIMIT 20`,
      ),
      (key) => key,
    );

    return { status, rate, bgmScore, year, format, season, tag, original };
  }, scope);
}

export function timeline(granularity: 'year' | 'quarter' | 'month', scope?: Visibility): TimelineStats {
  const snapshot = cached(`timeline:${granularity}`, (visibility): TimelineStats => {
    /*
     * P0-C：按 Bangumi `updated_at` 字符串本身分桶（返回值为 +08:00 本地时间），
     * 不与 UTC 时间戳（如 `first_seen_at`）混入同一条轴。
     */
    const keyExpression =
      granularity === 'year'
        ? `substr(c.updated_at, 1, 4)`
        : granularity === 'quarter'
          ? `substr(c.updated_at, 1, 4) || 'Q' || ((CAST(substr(c.updated_at, 6, 2) AS INTEGER) - 1) / 3 + 1)`
          : `substr(c.updated_at, 1, 7)`;

    const rows = all<{
      period: string;
      count: number;
      episodes: number | null;
      averageRate: number | null;
      doneCount: number | null;
      ratedCount: number;
      ratingSum: number;
    }>(
      `SELECT ${keyExpression} AS period,
              COUNT(*) AS count,
              SUM(CASE WHEN c.type IN (2, 3, 4, 5) THEN ${WATCHED_EXPRESSION} ELSE 0 END) AS episodes,
              AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN effective_personal_rate(c.type,c.rate) END) AS averageRate,
              SUM(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN 1 ELSE 0 END) AS ratedCount,
              SUM(effective_personal_rate(c.type,c.rate)) AS ratingSum,
              SUM(CASE WHEN c.type = 2 THEN 1 ELSE 0 END) AS doneCount
       FROM collections c JOIN subjects s ON s.id = c.subject_id
       WHERE c.updated_at IS NOT NULL AND c.updated_at <> ''
         AND ${subjectVisibilityClause('s', visibility)}
       GROUP BY period
       ORDER BY period ASC`,
    );

    const byPeriod = new Map(rows.map((row) => [String(row.period), row]));
    const periods = buildPeriodRange(rows.map((row) => String(row.period)), granularity);
    let cumulative = 0;

    const points: TimelinePoint[] = periods.map((period) => {
      const row = byPeriod.get(period);
      const count = Number(row?.count ?? 0);
      cumulative += count;
      return {
        period,
        label: formatPeriodLabel(period, granularity),
        added: count,
        updated: Number(row?.doneCount ?? 0),
        total: cumulative,
        episodes: Number(row?.episodes ?? 0),
        averageRate: round(row?.averageRate ?? null),
        ratingSample: { ratedCount: Number(row?.ratedCount ?? 0), ratingSum: Number(row?.ratingSum ?? 0) },
      };
    });

    return {
      granularity,
      basis: 'collection-updated-at',
      note:
        'Bangumi 未提供「收藏时间」字段，这里使用条目的最后更新时间做近似，' +
        '因此曲线反映的是「该时间段内有变动的收藏数量」，而不是严格的收藏时间。',
      points,
      context: {
        contextVersion: 1,
        visibility,
        dataVersion: dataVersion(),
        viewReferenceAt: '',
        referenceMonth: '',
        calendarZone: 'Asia/Shanghai',
        sourceRefreshedAt: null,
        sequence: { kind: 'full', complete: true, from: periods[0] ?? null, to: periods.at(-1) ?? null },
        timeCoverage: {
          datedCollections: cumulative,
          undatedCollections: Number(one<{ count: number }>(
            `SELECT COUNT(*) AS count FROM collections c JOIN subjects s ON s.id=c.subject_id
             WHERE (c.updated_at IS NULL OR c.updated_at='') AND ${subjectVisibilityClause('s', visibility)}`,
          )?.count ?? 0),
        },
      },
    };
  }, scope);
  // Calendar context belongs to this read, while source aggregates retain their versioned cache.
  const reference = new Date();
  return { ...snapshot, context: {
    ...snapshot.context!,
    viewReferenceAt: reference.toISOString(),
    sourceRefreshedAt: getMeta('last_sync_at') ?? lastSuccessfulSyncAt(),
    referenceMonth: new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    }).format(reference),
  } };
}

function buildPeriodRange(periods: string[], granularity: 'year' | 'quarter' | 'month'): string[] {
  if (periods.length === 0) return [];
  const pattern = granularity === 'year' ? /^\d{4}$/
    : granularity === 'quarter' ? /^\d{4}Q[1-4]$/ : /^\d{4}-(0[1-9]|1[0-2])$/;
  const periodsPerYear = granularity === 'year' ? 1 : granularity === 'quarter' ? 4 : 12;
  let first = Infinity;
  let last = -Infinity;
  // Validate every bucket before allocation, including invalid interior buckets.
  // Four-digit years bound the complete domain to at most 120,000 months;
  // never return a successful prefix in place of a complete calendar range.
  for (const period of periods) {
    const match = pattern.exec(period);
    if (!match || match[0] !== period) {
      throw new ApiError('时间归集周期无效，无法生成完整时间序列。', {
        code: 'invalid_timeline_period',
        hint: '归集周期须符合四位年份、Q1–Q4 或 01–12 月格式；原始数据未修改，请检查收藏最后更新时间来源。',
      });
    }
    const offset = granularity === 'year' ? 0 : Number(period.slice(5)) - 1;
    const ordinal = Number(period.slice(0, 4)) * periodsPerYear + offset;
    first = Math.min(first, ordinal);
    last = Math.max(last, ordinal);
  }
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const ordinal = first + index;
    const year = String(Math.floor(ordinal / periodsPerYear)).padStart(4, '0');
    if (granularity === 'year') return year;
    const part = ordinal % periodsPerYear + 1;
    return granularity === 'quarter' ? `${year}Q${part}` : `${year}-${String(part).padStart(2, '0')}`;
  });
}

function formatPeriodLabel(period: string, granularity: 'year' | 'quarter' | 'month'): string {
  if (granularity === 'year') return `${period} 年`;
  if (granularity === 'quarter') return `${period.slice(0, 4)} 年 Q${period.slice(5)}`;
  return `${period.slice(0, 4)} 年 ${Number(period.slice(5, 7))} 月`;
}

export function ratingBias(limit = 12, scope?: Visibility): RatingBiasStats {
  return cached(`bias:${limit}`, (visibility) => {
    const rows = all<{
      id: number;
      name: string;
      name_cn: string;
      cover_url: string | null;
      rate: number;
      score: number;
      rating_total: number | null;
      year: number | null;
      format: string | null;
    }>(
      `SELECT s.id, s.name, s.name_cn, s.cover_url, effective_personal_rate(c.type,c.rate) AS rate, canonical_score(s.score) AS score, canonical_count(s.rating_total) AS rating_total, canonical_positive_integer(s.year) AS year, s.format
       FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE effective_personal_rate(c.type,c.rate) > 0 AND canonical_score(s.score) > 0
       AND ${subjectVisibilityClause('s', visibility)}`,
    );

    const items = rows.map((row) => ({
      id: Number(row.id),
      name: row.name ?? '',
      nameCn: row.name_cn ?? '',
      cover: row.cover_url ?? null,
      myRate: Number(row.rate),
      bgmScore: Number(row.score),
      delta: Number((Number(row.rate) - Number(row.score)).toFixed(2)),
      ratingTotal: row.rating_total,
      year: row.year === null ? null : Number(row.year),
      format: (row.format ?? '其他') as AnimeFormat,
    }));

    const deltas = items.map((item) => item.delta);
    const mean = deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null;
    const variance =
      mean === null || deltas.length < 2
        ? null
        : deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (deltas.length - 1);

    const byDeltaDesc = [...items].sort(
      (a, b) => b.delta - a.delta || (b.ratingTotal ?? -1) - (a.ratingTotal ?? -1),
    );

    return {
      count: items.length,
      matchedCount: items.length,
      meanDelta: round(mean),
      stdDev: variance === null ? null : round(Math.sqrt(variance)),
      overratedCount: items.filter((item) => item.delta > 0).length,
      underratedCount: items.filter((item) => item.delta < 0).length,
      over: byDeltaDesc.filter((item) => item.delta > 0).slice(0, limit),
      under: byDeltaDesc.filter((item) => item.delta < 0).slice(-limit).reverse(),
      scatter: items.map((item) => ({
        id: item.id,
        name: item.nameCn || item.name,
        myRate: item.myRate,
        bgmScore: item.bgmScore,
        delta: item.delta,
      })),
    };
  }, scope);
}

interface PreferenceRow {
  name: string;
  total: number;
  rated: number | null;
  averageRate: number | null;
  averageBgmScore: number | null;
  highRatedCount: number | null;
  averageDelta: number | null;
}

function preferenceQuery(jsonColumn: string, limit: number, visibility: Visibility): PreferenceRow[] {
  return all<PreferenceRow>(
    `SELECT je.value AS name,
            COUNT(*) AS total,
            SUM(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN 1 ELSE 0 END) AS rated,
            AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 THEN effective_personal_rate(c.type,c.rate) END) AS averageRate,
            AVG(CASE WHEN canonical_score(s.score) > 0 THEN canonical_score(s.score) END) AS averageBgmScore,
            SUM(CASE WHEN effective_personal_rate(c.type,c.rate) >= 8 THEN 1 ELSE 0 END) AS highRatedCount,
            AVG(CASE WHEN effective_personal_rate(c.type,c.rate) > 0 AND canonical_score(s.score) > 0 THEN effective_personal_rate(c.type,c.rate) - canonical_score(s.score) END) AS averageDelta
     FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression(`s.${jsonColumn}`)}) je
     WHERE je.type = 'text' AND ${subjectVisibilityClause('s', visibility)}
     GROUP BY je.value
     ORDER BY total DESC, je.value ASC
     LIMIT :limit`,
    { limit },
  );
}

export function studios(limit = 20, scope?: Visibility): StudioStats {
  return cached(`studios:${limit}`, (visibility) => ({
    items: preferenceQuery('studios', limit, visibility).map((row) => ({
      name: row.name,
      total: Number(row.total),
      rated: Number(row.rated ?? 0),
      averageRate: round(row.averageRate ?? null),
      averageBgmScore: round(row.averageBgmScore ?? null),
      highRatedCount: Number(row.highRatedCount ?? 0),
      highRatedShare:
        Number(row.rated ?? 0) > 0
          ? Number((Number(row.highRatedCount ?? 0) / Number(row.rated)).toFixed(4))
          : null,
      averageDelta: round(row.averageDelta ?? null),
    })),
  }), scope);
}

export function directors(limit = 20, scope?: Visibility): StudioStats {
  return cached(`directors:${limit}`, (visibility) => ({
    items: preferenceQuery('directors', limit, visibility).map((row) => ({
      name: row.name,
      total: Number(row.total),
      rated: Number(row.rated ?? 0),
      averageRate: round(row.averageRate ?? null),
      averageBgmScore: round(row.averageBgmScore ?? null),
      highRatedCount: Number(row.highRatedCount ?? 0),
      highRatedShare:
        Number(row.rated ?? 0) > 0
          ? Number((Number(row.highRatedCount ?? 0) / Number(row.rated)).toFixed(4))
          : null,
      averageDelta: round(row.averageDelta ?? null),
    })),
  }), scope);
}

export function habits(scope?: Visibility): HabitsStats {
  return cached('habits', (visibility) => {
    // P0-C：热力图 / 星期分布同样按 `updated_at` 字符串分桶（与 timeline 同一规则）。
    const visibleCollections = collectionVisibilityClause('c', visibility);
    const heatmapRows = all<{ year: number; quarter: number; count: number }>(
      `SELECT CAST(substr(c.updated_at, 1, 4) AS INTEGER) AS year,
              (CAST(substr(c.updated_at, 6, 2) AS INTEGER) - 1) / 3 + 1 AS quarter,
              COUNT(*) AS count
       FROM collections c
       WHERE c.updated_at IS NOT NULL AND c.updated_at <> ''
         AND ${visibleCollections}
       GROUP BY year, quarter
       ORDER BY year ASC, quarter ASC`,
    );
    const heatmap = heatmapRows.map((row) => ({
      year: Number(row.year),
      quarter: Number(row.quarter),
      count: Number(row.count),
    }));

    const busiestYear = heatmap.reduce<{ year: number; count: number } | null>((best, entry) => {
      const totals = heatmap
        .filter((item) => item.year === entry.year)
        .reduce((sum, item) => sum + item.count, 0);
      if (!best || totals > best.count) return { year: entry.year, count: totals };
      return best;
    }, null);

    const busiestQuarter = heatmap.reduce<{ year: number; quarter: number; count: number } | null>(
      (best, entry) => (!best || entry.count > best.count ? entry : best),
      null,
    );

    const years = [...new Set(heatmap.map((entry) => entry.year))].sort();
    const spanYears = years.length > 0 ? years[years.length - 1]! - years[0]! + 1 : 0;
    const total = heatmap.reduce((sum, entry) => sum + entry.count, 0);
    const activeYears = years.length;

    const episodeStats = one<{ watched: number | null; total: number | null; avgProgress: number | null }>(
      `SELECT SUM(${WATCHED_EXPRESSION}) AS watched,
              SUM(${EPISODE_EXPRESSION}) AS total,
              AVG(CASE WHEN ${EPISODE_EXPRESSION} > 0
                    THEN (${WATCHED_EXPRESSION}) * 1.0 / (${EPISODE_EXPRESSION}) END) AS avgProgress
       FROM collections c JOIN subjects s ON s.id = c.subject_id
       WHERE c.type IN (2, 3, 4, 5) AND ${subjectVisibilityClause('s', visibility)}`,
    );

    const weekdayRows = all<{ key: string; count: number }>(
      `SELECT strftime('%w', substr(c.updated_at, 1, 10)) AS key, COUNT(*) AS count
       FROM collections c
       WHERE c.updated_at IS NOT NULL AND c.updated_at <> ''
         AND ${visibleCollections}
       GROUP BY key ORDER BY key ASC`,
    );
    const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const weekdayTotal = weekdayRows.reduce((sum, row) => sum + Number(row.count), 0);
    const weekdayMap = new Map(weekdayRows.map((row) => [String(row.key), Number(row.count)]));

    return {
      averagePerYear: activeYears > 0 ? Number((total / activeYears).toFixed(1)) : null,
      busiestYear,
      busiestQuarter,
      activeYears,
      spanYears,
      averageProgress: round(episodeStats?.avgProgress ?? null, 3),
      heatmap,
      weekdayDistribution: weekdayLabels.map((label, index) => {
        const count = weekdayMap.get(String(index)) ?? 0;
        return {
          key: String(index),
          label,
          count,
          share: weekdayTotal > 0 ? Number((count / weekdayTotal).toFixed(4)) : 0,
        };
      }),
      averageEpisodesPerYear:
        activeYears > 0 && episodeStats?.watched
          ? Number((Number(episodeStats.watched) / activeYears).toFixed(1))
          : null,
    };
  }, scope);
}

export function highRatedTagShare(): Array<{ name: string; count: number; share: number }> {
  return cached('high-rated-tags', () => {
    const totalHigh = one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM collections c WHERE effective_personal_rate(c.type,c.rate) >= 8',
    );
    const rows = all<{ name: string; count: number }>(
      `SELECT je.value AS name, COUNT(*) AS count
       FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(${jsonArrayExpression('s.tag_names')}) je
       WHERE je.type = 'text' AND effective_personal_rate(c.type,c.rate) >= 8
       GROUP BY je.value ORDER BY count DESC LIMIT 20`,
    );
    const denominator = Number(totalHigh?.n ?? 0);
    return rows.map((row) => ({
      name: row.name,
      count: Number(row.count),
      share: denominator > 0 ? Number((Number(row.count) / denominator).toFixed(4)) : 0,
    }));
  });
}

export function formatLabelOf(key: string): string {
  return ANIME_FORMAT_LABEL[key as AnimeFormat] ?? key;
}

export function statusOrder(): number[] {
  return [...COLLECTION_TYPES];
}
