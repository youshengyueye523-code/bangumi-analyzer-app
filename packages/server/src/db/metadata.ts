/** 仅合法的关系身份及作品类型可成为图输入；原始历史行保留作证据。 */
export function collectionTotalSql(alias: string): string {
  return `CASE WHEN ${alias}.collection_total_known = 0 THEN NULL ELSE canonical_count(${alias}.collection_total) END`;
}

export function validRelationSql(alias: string): string {
  return `canonical_positive_integer(${alias}.subject_id) IS NOT NULL
    AND canonical_positive_integer(${alias}.related_id) IS NOT NULL
    AND ${alias}.type IN (1, 2, 3, 4, 6)`;
}
