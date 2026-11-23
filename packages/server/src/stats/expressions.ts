import type { AnimeFormat } from '@bangumi-analyzer/shared';
import { episodeCountSql } from '../db/episodeCount.js';

/**
 * 全局 canonical 统计表达式（v1.4.2 起冻结，v1.8 提取为共享模块）。
 *
 * 只在这里维护一份，stats 与 Entity Analysis 必须复用：
 * 任何「同名不同公式」都属于语义错误。
 */
export const EPISODE_EXPRESSION = episodeCountSql();

/** 与 shared.episodeProgress 一致；SQLite TEXT 不能借 MIN 的类型排序冒充满进度。 */
export const EP_STATUS_EXPRESSION = `CASE WHEN typeof(c.ep_status) IN ('integer','real')
  AND c.ep_status BETWEEN 0 AND 9007199254740991 AND c.ep_status = CAST(c.ep_status AS INTEGER)
  THEN c.ep_status ELSE 0 END`;

export const WATCHED_EXPRESSION = `CASE
  WHEN c.type = 2 THEN ${EPISODE_EXPRESSION}
  ELSE MIN(${EP_STATUS_EXPRESSION}, ${EPISODE_EXPRESSION})
END`;

/** 元数据是每部作品的字符串集合：异常值不参与、重复项只计一次，不改写源数据。 */
export function jsonArrayExpression(column: string): string {
  const array = `CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}) = 'array' THEN ${column} ELSE '[]' END ELSE '[]' END`;
  return `(SELECT json_group_array(DISTINCT metadata_item.value) FROM json_each(${array}) metadata_item WHERE metadata_item.type = 'text')`;
}

/** 各放送形态的单集时长估算（分钟），仅用于「估算观看时长」这类趣味统计。 */
export const MINUTES_PER_EPISODE: Record<AnimeFormat, number> = {
  TV: 24,
  Movie: 100,
  OVA: 30,
  ONA: 24,
  Special: 25,
  Music: 4,
  其他: 24,
};
