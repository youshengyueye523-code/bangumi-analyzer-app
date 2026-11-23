/**
 * v1.8 Phase 4：Entity Ranking 的 SQL 表达式（value + sample）。
 *
 * 语义与 `entityAnalysis.ts`（Detail analysis）完全同源：
 * - Coverage：collected primary members / known primary members（含 relation-only）；
 * - Completion：看过（type = 2）的 collected primary members / collected primary members；
 * - Rating：成员级 mean(rate)（ratedCount ≥ 3 才进入排名域）；
 * - candidate 永不参与；hidden Entity 在列表层已被 visibility 过滤。
 *
 * 本模块只定义「值 / 样本」；eligibility（sample ≥ 3）由调用方显式表达。
 */
import type { EntityRankingMetric } from '@bangumi-analyzer/shared';
import { franchiseAverageRateSql, franchiseRatedCountSql } from './franchiseAverage.js';
import { memberVisibilityClause, seriesVisibilityClause, type Visibility } from './visibility.js';

export interface RankingMetricSql {
  value: string;
  sample: string;
}

function seriesCollectedMembers(alias: string, visibility: Visibility): string {
  return `(SELECT COUNT(DISTINCT m.subject_id)
      FROM series_entity_members m
      JOIN collections c ON c.subject_id = m.subject_id
      LEFT JOIN subjects s ON s.id = m.subject_id
      WHERE m.series_id = ${alias}.id AND m.role = 'primary'
        AND ${memberVisibilityClause('s', visibility)})`;
}

function seriesKnownMembers(alias: string, visibility: Visibility): string {
  return `(SELECT COUNT(DISTINCT m.subject_id)
      FROM series_entity_members m
      LEFT JOIN subjects s ON s.id = m.subject_id
      WHERE m.series_id = ${alias}.id AND m.role = 'primary'
        AND ${memberVisibilityClause('s', visibility)})`;
}

function seriesWatchedMembers(alias: string, visibility: Visibility): string {
  return `(SELECT COUNT(DISTINCT m.subject_id)
      FROM series_entity_members m
      JOIN collections c ON c.subject_id = m.subject_id
      LEFT JOIN subjects s ON s.id = m.subject_id
      WHERE m.series_id = ${alias}.id AND m.role = 'primary' AND c.type = 2
        AND ${memberVisibilityClause('s', visibility)})`;
}

function seriesRatedCount(alias: string, visibility: Visibility): string {
  return `(SELECT COUNT(DISTINCT m.subject_id)
      FROM series_entity_members m
      JOIN collections c ON c.subject_id = m.subject_id
      LEFT JOIN subjects s ON s.id = m.subject_id
      WHERE m.series_id = ${alias}.id AND m.role = 'primary' AND effective_personal_rate(c.type,c.rate) > 0
        AND ${memberVisibilityClause('s', visibility)})`;
}

function seriesAverageRate(alias: string, visibility: Visibility): string {
  return `(SELECT ROUND(AVG(r.rate), 2) FROM (
      SELECT m.subject_id AS member_subject_id, MAX(effective_personal_rate(c.type,c.rate)) AS rate
      FROM series_entity_members m
      JOIN collections c ON c.subject_id = m.subject_id
      LEFT JOIN subjects s ON s.id = m.subject_id
      WHERE m.series_id = ${alias}.id AND m.role = 'primary' AND effective_personal_rate(c.type,c.rate) > 0
        AND ${memberVisibilityClause('s', visibility)}
      GROUP BY m.subject_id
    ) r)`;
}

function franchiseMemberWhere(
  alias: string,
  visibility: Visibility,
  collectOnly: boolean,
): string {
  return `FROM franchise_series fs
      JOIN series_entities e2 ON e2.id = fs.series_id AND e2.state <> 'stale'
      JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
      ${collectOnly ? 'JOIN collections c ON c.subject_id = m.subject_id' : 'LEFT JOIN collections c ON c.subject_id = m.subject_id'}
      LEFT JOIN subjects s ON s.id = m.subject_id
      WHERE fs.franchise_id = ${alias}.id
        AND ${seriesVisibilityClause('e2', visibility)}
        AND ${memberVisibilityClause('s', visibility)}`;
}

function franchiseCount(
  alias: string,
  visibility: Visibility,
  extra: string,
): string {
  return `(SELECT COUNT(DISTINCT m.subject_id) ${franchiseMemberWhere(alias, visibility, false)}
      ${extra})`;
}

export function seriesRankingMetricSql(
  metric: EntityRankingMetric,
  visibility: Visibility,
  alias = 'e',
): RankingMetricSql {
  const known = seriesKnownMembers(alias, visibility);
  const collected = seriesCollectedMembers(alias, visibility);
  if (metric === 'coverage') {
    return { value: `ROUND(1.0 * (${collected}) / NULLIF((${known}), 0), 4)`, sample: known };
  }
  if (metric === 'completion') {
    const watched = seriesWatchedMembers(alias, visibility);
    return { value: `ROUND(1.0 * (${watched}) / NULLIF((${collected}), 0), 4)`, sample: collected };
  }
  return { value: seriesAverageRate(alias, visibility), sample: seriesRatedCount(alias, visibility) };
}

export function franchiseRankingMetricSql(
  metric: EntityRankingMetric,
  visibility: Visibility,
  alias = 'f',
): RankingMetricSql {
  const known = franchiseCount(alias, visibility, '');
  const collected = franchiseCount(alias, visibility, 'AND c.subject_id IS NOT NULL');
  if (metric === 'coverage') {
    return { value: `ROUND(1.0 * (${collected}) / NULLIF((${known}), 0), 4)`, sample: known };
  }
  if (metric === 'completion') {
    const watched = franchiseCount(alias, visibility, 'AND c.type = 2');
    return { value: `ROUND(1.0 * (${watched}) / NULLIF((${collected}), 0), 4)`, sample: collected };
  }
  // Rating：与 Phase 1 的 canonical materialization / caliber-aware read 共用同一公式
  return { value: franchiseAverageRateSql(alias, visibility), sample: franchiseRatedCountSql(alias, visibility) };
}
