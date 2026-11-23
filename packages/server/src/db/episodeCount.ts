/** 动画统计正篇话数；上游 total_episodes 是章节记录数，不能补齐明确未知的 eps。 */
interface EpisodeSource {
  id: number;
  type: number;
  eps: number | null;
  total_episodes: number | null;
  raw: string | null;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function episodeCount(row: EpisodeSource): number {
  const legacy = row.total_episodes != null && row.total_episodes !== 0 ? row.total_episodes : row.eps ?? 0;
  if (row.type !== 2) return count(legacy) ? legacy : 0;
  if (count(row.eps) && row.eps > 0) return row.eps;
  try {
    const raw: unknown = JSON.parse(row.raw ?? 'null');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const source = raw as Record<string, unknown>;
      if (source.id === row.id && source.type === 2 && count(source.total_episodes)
          && (source.eps === undefined || source.eps === 0)) return 0;
    }
  } catch { /* 无法证明来源的旧总量保留兼容；不改写原始数据。 */ }
  return count(legacy) ? legacy : 0;
}

/** 与 episodeCount 相同的只读规则，供统计、排序、实体重算及 CSV 复用。 */
export function episodeCountSql(alias = 's'): string {
  const legacy = `COALESCE(NULLIF(${alias}.total_episodes, 0), ${alias}.eps, 0)`;
  const valid = (value: string) => `(typeof(${value}) IN ('integer','real') AND ${value} BETWEEN 0 AND 9007199254740991 AND ${value} = CAST(${value} AS INTEGER))`;
  const sourceUnknown = `CASE WHEN json_valid(${alias}.raw) THEN CASE
    WHEN json_type(${alias}.raw) = 'object'
      AND json_type(${alias}.raw, '$.id') IN ('integer','real')
      AND json_type(${alias}.raw, '$.type') IN ('integer','real')
      AND json_extract(${alias}.raw, '$.id') = ${alias}.id
      AND json_extract(${alias}.raw, '$.type') = 2
      AND json_type(${alias}.raw, '$.total_episodes') IN ('integer','real')
      AND ${valid(`json_extract(${alias}.raw, '$.total_episodes')`)}
      AND (json_type(${alias}.raw, '$.eps') IS NULL OR
           (json_type(${alias}.raw, '$.eps') IN ('integer','real') AND json_extract(${alias}.raw, '$.eps') = 0))
    THEN 1 ELSE 0 END ELSE 0 END`;
  return `CASE WHEN ${alias}.type = 2 THEN CASE
    WHEN ${valid(`${alias}.eps`)} AND ${alias}.eps > 0 THEN ${alias}.eps
    WHEN ${sourceUnknown} = 1 THEN 0
    WHEN ${valid(legacy)} THEN ${legacy} ELSE 0 END
    ELSE CASE WHEN ${valid(legacy)} THEN ${legacy} ELSE 0 END END`;
}
