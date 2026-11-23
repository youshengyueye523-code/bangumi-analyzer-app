/**
 * Franchise 平均我的评分 —— 唯一 canonical 读公式（v1.8 OD2）。
 *
 * 语义与 Series / engine 的 `memberStats` 完全一致：
 * - 只统计 `rate > 0` 的已收藏 primary 成员；
 * - 以 `subject_id` 去重（同一成员只计一次）；
 * - 算术平均并 round 2；无评分成员 → NULL；
 * - 严禁 mean-of-means：跨 Series 必须先展开到成员再平均。
 *
 * visibility：
 * - `real`    → 与 engine 写入的 Real materialization 同口径，用于 drift 校验；
 * - `visible` → 排除当前不可见的成员 Series（整 Series 隐藏语义）。
 *               hideNsfw=OFF 时与 Real 结果一致；hideNsfw=ON 时禁止用
 *               Real 值当 Visible 的展示 / 排序依据。
 */
import { one } from './index.js';
import { seriesVisibilityClause, type Visibility } from './visibility.js';

export function franchiseAverageRateSql(
  franchiseAlias = 'f',
  visibility: Visibility = 'real',
): string {
  const visibilityFilter = franchiseMemberVisibilityFilter(visibility);
  return `(SELECT ROUND(AVG(r.rate), 2) FROM (
      SELECT m.subject_id AS member_subject_id, MAX(effective_personal_rate(c.type,c.rate)) AS rate
      FROM franchise_series fs
      JOIN series_entities e ON e.id = fs.series_id
      JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
      JOIN collections c ON c.subject_id = m.subject_id
      WHERE fs.franchise_id = ${franchiseAlias}.id
        AND effective_personal_rate(c.type,c.rate) > 0 AND e.state <> 'stale'
        ${visibilityFilter}
      GROUP BY m.subject_id
    ) r)`;
}

/** 与 `franchiseAverageRateSql` 完全相同的成员范围，仅返回样本量（ratedCount）。 */
export function franchiseRatedCountSql(
  franchiseAlias = 'f',
  visibility: Visibility = 'real',
): string {
  return `(SELECT COUNT(*) FROM (
      SELECT m.subject_id AS member_subject_id, MAX(effective_personal_rate(c.type,c.rate)) AS rate
      FROM franchise_series fs
      JOIN series_entities e ON e.id = fs.series_id
      JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
      JOIN collections c ON c.subject_id = m.subject_id
      WHERE fs.franchise_id = ${franchiseAlias}.id
        AND effective_personal_rate(c.type,c.rate) > 0 AND e.state <> 'stale'
        ${franchiseMemberVisibilityFilter(visibility)}
      GROUP BY m.subject_id
    ) r)`;
}

function franchiseMemberVisibilityFilter(visibility: Visibility): string {
  return visibility === 'visible'
    ? `AND e.state <> 'stale' AND ${seriesVisibilityClause('e', visibility)}`
    : '';
}

/**
 * Real 口径下 average_rate materialization 与成员聚合不一致的 Franchise 数量
 * （含「有评分成员但列为 NULL」的漂移）。
 */
export function franchiseAverageRateDriftCount(): number {
  return Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM franchise_entities f
       WHERE f.state <> 'stale'
         AND f.average_rate IS NOT ${franchiseAverageRateSql('f', 'real')}`,
    )?.n ?? 0,
  );
}
