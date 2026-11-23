import { pick, parseJsonColumn, toJson } from '../util.js';
import { all, one, run, transaction } from './index.js';
import type { CollectionRow, RelationRow, StaffRow, SubjectRow } from '../bangumi/normalize.js';

const SUBJECT_INSERT_COLUMNS = [
  'id',
  'type',
  'name',
  'name_cn',
  'aliases',
  'platform',
  'format',
  'date',
  'year',
  'month',
  'season',
  'year_month',
  'year_quarter',
  'eps',
  'total_episodes',
  'volumes',
  'score',
  'rank',
  'rating_total',
  'collection_total',
  'collection_total_known',
  'tags',
  'tag_names',
  'summary',
  'images',
  'cover_url',
  'created_at',
  'updated_at',
] as const;

/**
 * 收藏列表（slim subject）写入。
 *
 * 关键点：slim 数据字段较少，不允许覆盖已经完整同步过的详情字段，
 * 否则每次收藏同步都会把制作公司、评分分布等数据抹掉。
 */
const UPSERT_SLIM_SQL = /* sql */ `
  INSERT INTO subjects (${SUBJECT_INSERT_COLUMNS.join(', ')}, detail_state)
  VALUES (${SUBJECT_INSERT_COLUMNS.map((column) => `:${column}`).join(', ')}, 'pending')
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type,
    name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE subjects.name END,
    name_cn = CASE WHEN excluded.name_cn <> '' THEN excluded.name_cn ELSE subjects.name_cn END,
    format = CASE WHEN subjects.detail_state = 'ok' THEN subjects.format ELSE excluded.format END,
    date = COALESCE(excluded.date, subjects.date),
    year = COALESCE(excluded.year, subjects.year),
    month = COALESCE(excluded.month, subjects.month),
    season = COALESCE(excluded.season, subjects.season),
    year_month = COALESCE(excluded.year_month, subjects.year_month),
    year_quarter = COALESCE(excluded.year_quarter, subjects.year_quarter),
    eps = CASE
      WHEN excluded.type = 2 THEN CASE
        WHEN subjects.detail_state = 'ok' AND CASE WHEN json_valid(subjects.raw) THEN
          json_type(subjects.raw) = 'object'
          AND json_type(subjects.raw, '$.id') IN ('integer','real')
          AND json_extract(subjects.raw, '$.id') = subjects.id
          AND json_type(subjects.raw, '$.type') IN ('integer','real')
          AND json_extract(subjects.raw, '$.type') = 2
          AND json_type(subjects.raw, '$.eps') IN ('integer','real')
          AND json_extract(subjects.raw, '$.eps') BETWEEN 0 AND 9007199254740991
          AND json_extract(subjects.raw, '$.eps') = CAST(json_extract(subjects.raw, '$.eps') AS INTEGER)
          ELSE 0 END THEN subjects.eps
        WHEN :eps_provided THEN excluded.eps ELSE subjects.eps END
      WHEN excluded.eps > 0 THEN excluded.eps ELSE subjects.eps END,
    total_episodes = CASE
      WHEN subjects.detail_state = 'ok' THEN subjects.total_episodes
      WHEN excluded.type = 2 AND :eps_provided THEN excluded.total_episodes
      WHEN excluded.total_episodes > 0 THEN excluded.total_episodes
      ELSE subjects.total_episodes END,
    volumes = CASE WHEN excluded.volumes > 0 THEN excluded.volumes ELSE subjects.volumes END,
    score = COALESCE(excluded.score, subjects.score),
    rank = COALESCE(excluded.rank, subjects.rank),
    collection_total = CASE WHEN excluded.collection_total_known = 1
      THEN excluded.collection_total ELSE subjects.collection_total END,
    collection_total_known = CASE WHEN excluded.collection_total_known = 1
      THEN 1 ELSE subjects.collection_total_known END,
    tags = CASE WHEN subjects.detail_state = 'ok' THEN subjects.tags ELSE excluded.tags END,
    tag_names = CASE WHEN subjects.detail_state = 'ok' THEN subjects.tag_names ELSE excluded.tag_names END,
    summary = CASE WHEN subjects.summary = '' THEN excluded.summary ELSE subjects.summary END,
    images = CASE WHEN excluded.images <> '{}' THEN excluded.images ELSE subjects.images END,
    cover_path = CASE WHEN COALESCE(excluded.cover_url, subjects.cover_url) IS subjects.cover_url
      THEN subjects.cover_path ELSE NULL END,
    cover_cached_at = CASE WHEN COALESCE(excluded.cover_url, subjects.cover_url) IS subjects.cover_url
      THEN subjects.cover_cached_at ELSE NULL END,
    cover_url = COALESCE(excluded.cover_url, subjects.cover_url),
    updated_at = excluded.updated_at
`;

export function upsertSubjectSlim(row: SubjectRow, timestamp: string): void {
  run(UPSERT_SLIM_SQL, {
    ...pick(row, SUBJECT_INSERT_COLUMNS),
    collection_total_known: row.collection_total_known ?? null,
    eps_provided: (row.eps_provided ?? row.eps > 0) ? 1 : 0,
    created_at: timestamp,
    updated_at: timestamp,
  });
}

const DETAIL_COLUMNS = [
  'type',
  'name',
  'name_cn',
  'aliases',
  'platform',
  'format',
  'date',
  'year',
  'month',
  'season',
  'year_month',
  'year_quarter',
  'eps',
  'total_episodes',
  'volumes',
  'score',
  'rank',
  'rating_total',
  'rating_dist',
  'collection_stats',
  'collection_total',
  'collection_total_known',
  'meta_tags',
  'tags',
  'tag_names',
  'infobox',
  'studios',
  'directors',
  'originals',
  'summary',
  'images',
  'cover_url',
  'nsfw',
  'locked',
  'is_series',
  'raw',
] as const;

const UPSERT_DETAIL_SQL = /* sql */ `
  UPDATE subjects SET
    cover_path = CASE WHEN :cover_url IS cover_url THEN cover_path ELSE NULL END,
    cover_cached_at = CASE WHEN :cover_url IS cover_url THEN cover_cached_at ELSE NULL END,
    ${DETAIL_COLUMNS.map((column) => `${column} = :${column}`).join(',\n    ')},
    detail_state = 'ok',
    detail_synced_at = :synced_at,
    detail_attempts = 0,
    detail_error = NULL,
    updated_at = :updated_at
  WHERE id = :id
`;

export function upsertSubjectDetail(row: SubjectRow, timestamp: string): void {
  run(UPSERT_DETAIL_SQL, {
    ...pick(row, ['id', ...DETAIL_COLUMNS] as const),
    collection_total_known: row.collection_total_known ?? null,
    synced_at: timestamp,
    updated_at: timestamp,
  });
}

export function markDetailFailure(subjectId: number, message: string, timestamp: string): void {
  run(
    `UPDATE subjects SET
       detail_state = 'failed',
       detail_attempts = detail_attempts + 1,
       detail_error = :error,
       updated_at = :updated_at
     WHERE id = :id`,
    { id: subjectId, error: message.slice(0, 500), updated_at: timestamp },
  );
}

export function markRelationsSynced(subjectId: number, timestamp: string): void {
  run(
    `UPDATE subjects SET relations_state = 'ok', relations_synced_at = :ts,
       relations_attempts = 0, updated_at = :ts WHERE id = :id`,
    { id: subjectId, ts: timestamp },
  );
}

export function markRelationsFailure(subjectId: number, timestamp: string): void {
  run(
    `UPDATE subjects SET relations_state = 'failed', relations_attempts = relations_attempts + 1,
       updated_at = :ts WHERE id = :id`,
    { id: subjectId, ts: timestamp },
  );
}

export function markPersonsSynced(subjectId: number, timestamp: string): void {
  run(
    `UPDATE subjects SET persons_state = 'ok', persons_synced_at = :ts,
       persons_attempts = 0, updated_at = :ts WHERE id = :id`,
    { id: subjectId, ts: timestamp },
  );
}

export function markPersonsFailure(subjectId: number, timestamp: string): void {
  run(
    `UPDATE subjects SET persons_state = 'failed', persons_attempts = persons_attempts + 1,
       updated_at = :ts WHERE id = :id`,
    { id: subjectId, ts: timestamp },
  );
}

export function getSubjectRow(id: number): SubjectRow | undefined {
  return one<SubjectRow>('SELECT * FROM subjects WHERE id = :id', { id });
}

/* --------------------------------------------------------------- 收藏写入 */

const UPSERT_COLLECTION_SQL = /* sql */ `
  INSERT INTO collections (
    subject_id, subject_type, type, rate, ep_status, vol_status, comment, tags,
    private, updated_at, first_seen_at, synced_at, raw
  ) VALUES (
    :subject_id, :subject_type, :type, :rate, :ep_status, :vol_status, :comment, :tags,
    :private, :updated_at, :first_seen_at, :synced_at, :raw
  )
  ON CONFLICT(subject_id) DO UPDATE SET
    subject_type = excluded.subject_type,
    type = excluded.type,
    rate = excluded.rate,
    ep_status = excluded.ep_status,
    vol_status = excluded.vol_status,
    comment = excluded.comment,
    tags = excluded.tags,
    private = excluded.private,
    updated_at = excluded.updated_at,
    synced_at = excluded.synced_at,
    raw = excluded.raw
`;

export function upsertCollection(
  row: CollectionRow,
  firstSeenAt: string,
  syncedAt: string,
): void {
  run(UPSERT_COLLECTION_SQL, {
    ...row,
    first_seen_at: firstSeenAt,
    synced_at: syncedAt,
  });
}

/**
 * `first_seen_at` = 本地首次入库时间，仅在首次写入时确定、后续同步不更新。
 * 禁止把它当作「收藏时间」：Bangumi 不提供收藏创建时间（v1.8 P0-C）。
 */
export function firstSeenAt(subjectId: number): string | null {
  const row = one<{ first_seen_at: string }>(
    'SELECT first_seen_at FROM collections WHERE subject_id = :id',
    { id: subjectId },
  );
  return row?.first_seen_at ?? null;
}

export function deleteCollections(subjectIds: number[]): number {
  if (subjectIds.length === 0) return 0;
  let removed = 0;
  transaction(() => {
    for (const id of subjectIds) {
      const result = run('DELETE FROM collections WHERE subject_id = :id', { id });
      removed += result.changes;
      // 条目本身保留：用户取消收藏不等于数据无价值，重新收藏时无需重新抓取详情
      run('UPDATE subjects SET series_key = NULL WHERE id = :id AND series_key IS NOT NULL', {
        id,
      });
    }
  });
  return removed;
}

export function countCollections(): number {
  const row = one<{ n: number }>('SELECT COUNT(*) AS n FROM collections');
  return Number(row?.n ?? 0);
}

export function getCollectionRow(subjectId: number): CollectionRow | undefined {
  return one<CollectionRow>('SELECT * FROM collections WHERE subject_id = :id', {
    id: subjectId,
  });
}

/* ------------------------------------------------------------- 待同步队列 */

export interface EnrichQueueOptions {
  /** 详情缓存有效期（天）；超过该时间的条目会被重新抓取 */
  refreshDays: number;
  /** 失败条目的最大尝试次数，超过后跳过（forceDetail 可强制重试） */
  maxAttempts: number;
  limit?: number;
}

/** 需要补充/刷新详情的条目：优先最近有收藏变动的作品。 */
export function detailQueue(options: EnrichQueueOptions): number[] {
  const cutoff = new Date(Date.now() - options.refreshDays * 86_400_000).toISOString();
  const rows = all<{ id: number }>(
    `SELECT s.id
     FROM collections c
     JOIN subjects s ON s.id = c.subject_id
     WHERE (
       s.detail_synced_at IS NULL
       OR s.detail_synced_at < :cutoff
     )
     AND (
       s.detail_synced_at IS NOT NULL
       OR s.detail_attempts < :maxAttempts
     )
     ORDER BY c.updated_at DESC NULLS LAST, s.id ASC
     ${options.limit ? 'LIMIT :limit' : ''}`,
    {
      cutoff,
      maxAttempts: options.maxAttempts,
      ...(options.limit ? { limit: options.limit } : {}),
    },
  );
  return rows.map((row) => Number(row.id));
}

/** 强制重新抓取所有收藏条目（忽略刷新期限与尝试次数上限）。 */
export function pendingDetailQueue(limit?: number): number[] {
  const rows = all<{ id: number }>(
    `SELECT s.id
     FROM collections c
     JOIN subjects s ON s.id = c.subject_id
     ORDER BY c.updated_at DESC NULLS LAST, s.id ASC
     ${limit ? 'LIMIT :limit' : ''}`,
    limit ? { limit } : {},
  );
  return rows.map((row) => Number(row.id));
}

export function relationsQueue(options: { staleDays: number; maxAttempts: number }): number[] {
  const cutoff = new Date(Date.now() - options.staleDays * 86_400_000).toISOString();
  const rows = all<{ id: number }>(
    `SELECT s.id
     FROM collections c
     JOIN subjects s ON s.id = c.subject_id
     WHERE s.detail_state = 'ok'
       AND (s.relations_synced_at IS NULL OR s.relations_synced_at < :cutoff)
       AND (s.relations_synced_at IS NOT NULL OR s.relations_attempts < :maxAttempts)
     ORDER BY c.updated_at DESC NULLS LAST, s.id ASC`,
    { cutoff, maxAttempts: options.maxAttempts },
  );
  return rows.map((row) => Number(row.id));
}

export function personsQueue(options: { staleDays: number; maxAttempts: number }): number[] {
  const cutoff = new Date(Date.now() - options.staleDays * 86_400_000).toISOString();
  const rows = all<{ id: number }>(
    `SELECT s.id
     FROM collections c
     JOIN subjects s ON s.id = c.subject_id
     WHERE s.detail_state = 'ok'
       AND (s.persons_synced_at IS NULL OR s.persons_synced_at < :cutoff)
       AND (s.persons_synced_at IS NOT NULL OR s.persons_attempts < :maxAttempts)
     ORDER BY c.updated_at DESC NULLS LAST, s.id ASC`,
    { cutoff, maxAttempts: options.maxAttempts },
  );
  return rows.map((row) => Number(row.id));
}

/* --------------------------------------------------------------- 人员/关系 */

export function replaceStaff(
  subjectId: number,
  rows: StaffRow[],
  options: { replaceRelations?: string[] } = {},
): void {
  transaction(() => {
    if (options.replaceRelations && options.replaceRelations.length > 0) {
      for (const relation of options.replaceRelations) {
        run(
          `DELETE FROM subject_staff
           WHERE subject_id = :id AND source = 'infobox' AND relation = :relation`,
          { id: subjectId, relation },
        );
      }
    } else {
      run(`DELETE FROM subject_staff WHERE subject_id = :id AND source = 'infobox'`, {
        id: subjectId,
      });
    }
    for (const row of rows) {
      run(
        `INSERT INTO subject_staff (subject_id, person_id, name, relation, career, source)
         VALUES (:subject_id, :person_id, :name, :relation, :career, :source)
         ON CONFLICT(subject_id, name, relation, source) DO UPDATE SET
           person_id = excluded.person_id,
           career = excluded.career`,
        row,
      );
    }
  });
}

export function replaceRelations(subjectId: number, rows: RelationRow[], timestamp: string): void {
  transaction(() => {
    run('DELETE FROM subject_relations WHERE subject_id = :id', { id: subjectId });
    for (const row of rows) {
      run(
        `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
         VALUES (:subject_id, :related_id, :relation, :type, :name, :name_cn, :created_at)
         ON CONFLICT(subject_id, related_id) DO UPDATE SET
           relation = excluded.relation, type = excluded.type,
           name = excluded.name, name_cn = excluded.name_cn`,
        { ...row, created_at: timestamp },
      );
    }
  });
}

const STUDIO_RELATIONS = ['动画制作', '制作', '製作', '制作公司', '动画制作公司'];
const DIRECTOR_RELATIONS = ['导演', '監督', '监督', '总导演', '総監督', 'アニメーション監督'];

/**
 * 重新计算「制作公司」「导演」两个分析字段。
 * 数据来源是 subject_staff（infobox 解析结果 ∪ 官方 persons 接口），
 * 因此无论人员数据来自哪一级同步，统计口径都是一致的。
 */
export function recomputeSubjectFacets(subjectId: number): void {
  const rows = all<{ name: string; relation: string }>(
    'SELECT name, relation FROM subject_staff WHERE subject_id = :id',
    { id: subjectId },
  );
  const studios: string[] = [];
  const directors: string[] = [];
  for (const row of rows) {
    const relation = (row.relation ?? '').trim();
    const name = (row.name ?? '').trim();
    if (!name) continue;
    if (STUDIO_RELATIONS.includes(relation) && !studios.includes(name)) studios.push(name);
    if (DIRECTOR_RELATIONS.includes(relation) && !directors.includes(name)) directors.push(name);
  }
  run(
    `UPDATE subjects SET studios = :studios, directors = :directors, updated_at = :ts WHERE id = :id`,
    {
      id: subjectId,
      studios: toJson(studios),
      directors: toJson(directors),
      ts: new Date().toISOString(),
    },
  );
}

export function readStaffRelations(subjectId: number): string[] {
  const rows = all<{ relation: string }>(
    'SELECT DISTINCT relation FROM subject_staff WHERE subject_id = :id',
    { id: subjectId },
  );
  return rows.map((row) => row.relation);
}
