/**
 * NSFW 可见性策略（v1.5.3 / v1.8）。
 *
 * 官方 NSFW 事实与本机主动隐藏记录独立；Visible 排除两者的并集。
 * 本模块只生成 SQL 片段，不修改任何数据：
 * - 关闭隐藏（默认）：全部片段退化为 `1=1`，行为与之前完全一致；
 * - 打开隐藏：NSFW Subject / 含 NSFW 成员的 Series / 无可见 Series 的 Franchise 被排除。
 *
 * v1.8：可见性升级为一等计算口径（Real / Visible）。
 * - `visibility` 应在请求 / 查询边界解析一次，并显式传入查询；
 * - Real = canonical truth（完整数据），Visible = 当前可见投影；
 * - 未显式传入的旧调用点退化为当前配置，保持既有行为不变。
 *
 * 说明：relation-only 成员（未收藏、无 subject 行）没有 nsfw 数据，
 * 按「不猜测」原则不参与判定。
 */

import { loadConfig } from '../config.js';
import { one, schemaVersion } from './index.js';

export type Visibility = 'real' | 'visible';

export function hideNsfwEnabled(): boolean {
  try {
    return loadConfig().hideNsfw === true;
  } catch {
    return false;
  }
}

/**
 * 当前配置对应的数据口径。
 *
 * 隐藏关闭时可见投影与完整数据完全等价，因此直接返回 `real`
 * （只在真正隐藏时才需要单独计算 Visible 投影）。
 */
export function currentVisibility(): Visibility {
  return hideNsfwEnabled() || personalHidesActive() ? 'visible' : 'real';
}

export function personalHidesActive(): boolean {
  return schemaVersion() >= 15 && Boolean(one("SELECT 1 FROM subject_user_hides WHERE revoked_at IS NULL LIMIT 1"));
}

/** SQL arguments are internal column expressions, never request text. */
export function personallyVisibleId(id: string): string {
  return schemaVersion() < 15 ? '1=1'
    : `NOT EXISTS (SELECT 1 FROM subject_user_hides ph WHERE ph.subject_id=${id} AND ph.revoked_at IS NULL)`;
}

export function subjectVisibilityClause(
  alias = 's',
  visibility: Visibility = currentVisibility(),
): string {
  return visibility === 'visible'
    ? `(${hideNsfwEnabled() ? `${alias}.nsfw = 0` : '1=1'} AND ${personallyVisibleId(`${alias}.id`)})`
    : '1=1';
}

export function relatedSubjectVisibilityClause(id: string): string {
  return `(${personallyVisibleId(id)} AND ${hideNsfwEnabled()
    ? `NOT EXISTS (SELECT 1 FROM subjects rhs WHERE rhs.id=${id} AND rhs.nsfw=1)`
    : '1=1'})`;
}

/** Derived names can have hidden candidates or related works as provenance. */
export function personalSeriesNameSafe(id: string): string {
  if (!personalHidesActive()) return '1=1';
  return `NOT EXISTS (
    SELECT 1 FROM series_entity_members pn
    WHERE pn.series_id=${id} AND (
      NOT (${personallyVisibleId('pn.subject_id')}) OR EXISTS (
        SELECT 1 FROM subject_relations pr WHERE pr.subject_id=pn.subject_id
        AND NOT (${personallyVisibleId('pr.related_id')})
      )
    )
  )`;
}

export function publicSeriesTitle(alias: string): string {
  return `CASE WHEN ${personalSeriesNameSafe(`${alias}.id`)} THEN ${alias}.title ELSE '受保护系列' END`;
}

export function personalFranchiseNameSafe(id: string): string {
  return !personalHidesActive() ? '1=1' : `NOT EXISTS (
    SELECT 1 FROM franchise_series pf WHERE pf.franchise_id=${id}
    AND NOT (${personalSeriesNameSafe('pf.series_id')})
  )`;
}

export function publicFranchiseTitle(alias: string): string {
  return `CASE WHEN ${personalFranchiseNameSafe(`${alias}.id`)} THEN ${alias}.title ELSE '受保护家族' END`;
}

/**
 * 成员级别（LEFT JOIN subjects 时使用）：
 * - relation-only 成员没有 subjects 行 → 没有 nsfw 依据，必须保留（不猜测）；
 * - 因此 Visible 下只排除「本地已知且 nsfw=1」的成员。
 */
export function memberVisibilityClause(
  alias = 's',
  visibility: Visibility = currentVisibility(),
): string {
  return visibility === 'visible' ? `(${alias}.id IS NULL OR ${subjectVisibilityClause(alias,visibility)})` : '1=1';
}

/** 收藏级别（只 join 了 collections 时使用）。 */
export function collectionVisibilityClause(
  collectionAlias = 'c',
  visibility: Visibility = currentVisibility(),
): string {
  return visibility === 'visible'
    ? relatedSubjectVisibilityClause(`${collectionAlias}.subject_id`)
    : '1=1';
}

/** Series 级别：任一 primary 成员是 NSFW → 整个 Series 当前不可见。 */
export function seriesVisibilityClause(
  alias = 'e',
  visibility: Visibility = currentVisibility(),
): string {
  return visibility === 'visible'
    ? `NOT EXISTS (
         SELECT 1 FROM series_entity_members hm
         WHERE hm.series_id = ${alias}.id AND hm.role = 'primary'
           AND NOT (${relatedSubjectVisibilityClause('hm.subject_id')})
       )`
    : '1=1';
}

/** Franchise 级别：所有成员 Series 都不可见时，Franchise 也不可见。 */
export function franchiseVisibilityClause(
  alias = 'f',
  visibility: Visibility = currentVisibility(),
): string {
  return visibility === 'visible'
    ? `EXISTS (
         SELECT 1 FROM franchise_series vfs
         JOIN series_entities ve ON ve.id = vfs.series_id
         WHERE vfs.franchise_id = ${alias}.id
           AND vfs.state <> 'conflict'
           AND ve.state <> 'stale'
           AND ${seriesVisibilityClause('ve', visibility)}
       )`
    : '1=1';
}
