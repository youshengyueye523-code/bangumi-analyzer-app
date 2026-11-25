import type { ExportPayload } from '@bangumi-analyzer/shared';
import { watchedEpisodes } from '@bangumi-analyzer/shared';
import { APP_VERSION } from '../config.js';
import { all } from '../db/index.js';
import { subjectVisibilityClause, type Visibility } from '../db/visibility.js';
import { nowIso, parseStringArrayColumn } from '../util.js';
import { EPISODE_EXPRESSION, EP_STATUS_EXPRESSION } from '../stats/expressions.js';

/** 导出为可长期保存的 JSON：包含全部字段与原始数据。 */
export function buildExportPayload(): ExportPayload {
  const subjects = all<Record<string, unknown>>('SELECT * FROM subjects ORDER BY id ASC');
  const collections = all<Record<string, unknown>>('SELECT * FROM collections ORDER BY subject_id ASC');
  const staff = all<Record<string, unknown>>('SELECT * FROM subject_staff ORDER BY subject_id ASC');
  const relations = all<Record<string, unknown>>(
    'SELECT * FROM subject_relations ORDER BY subject_id ASC',
  );

  return {
    format: 'bangumi-analyzer-export',
    version: 1,
    exportedAt: nowIso(),
    app: { version: APP_VERSION },
    counts: {
      collections: collections.length,
      subjects: subjects.length,
      staff: staff.length,
      relations: relations.length,
    },
    collections: collections.map((row) => ({ ...row, kind: 'collection' })),
    subjects: [
      ...subjects.map((row) => ({ ...row, kind: 'subject' })),
      ...staff.map((row) => ({ ...row, kind: 'staff' })),
      ...relations.map((row) => ({ ...row, kind: 'relation' })),
    ],
  };
}

function csvCell(value: unknown, numericText = false): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && !numericText && (/^\s*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))) {
    // CSV 引号只保护分隔符，不能阻止 Excel 把上游标题/评论解释为公式。
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

const CSV_COLUMNS = [
  'id',
  'name',
  'name_cn',
  'year',
  'season',
  'format',
  'platform',
  'collection_type',
  'collection_type_label',
  'rate',
  'ep_status',
  'total_episodes',
  'progress',
  'bgm_score',
  'bgm_rank',
  'rating_total',
  'delta',
  'tags',
  'user_tags',
  'studios',
  'directors',
  'collection_updated_at',
  'comment',
  'bangumi_url',
] as const;

/** 导出 CSV（带 BOM，Excel 直接打开不会乱码）。 */
export function buildCsv(visibility: Visibility = 'real'): string {
  const rows = all<{
    id: number;
    name: string | null;
    name_cn: string | null;
    year: number | null;
    season: string | null;
    format: string | null;
    platform: string | null;
    type: number;
    rate: number;
    ep_status: number;
    total_episodes: number | null;
    eps: number | null;
    score: number | null;
    rank: number | null;
    rating_total: number | null;
    tag_names: string | null;
    user_tags: string | null;
    studios: string | null;
    directors: string | null;
    collection_updated_at: string | null;
    comment: string | null;
  }>(
    `SELECT s.id, s.name, s.name_cn, canonical_positive_integer(s.year) AS year, s.season, s.format, s.platform,
            c.type, effective_personal_rate(c.type,c.rate) AS rate, ${EP_STATUS_EXPRESSION} AS ep_status,
            ${EPISODE_EXPRESSION} AS total_episodes,
            s.eps, canonical_score(s.score) AS score, canonical_positive_integer(s.rank) AS rank, canonical_count(s.rating_total) AS rating_total,
            s.tag_names, c.tags AS user_tags, s.studios, s.directors,
            c.updated_at AS collection_updated_at, c.comment
     FROM collections c JOIN subjects s ON s.id = c.subject_id
     WHERE ${subjectVisibilityClause('s', visibility)}
     ORDER BY c.updated_at DESC NULLS LAST, s.id ASC`,
  );

  const statusLabels: Record<number, string> = { 1: '想看', 2: '看过', 3: '在看', 4: '搁置', 5: '抛弃' };
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    const totalEpisodes = Number(row.total_episodes ?? 0);
    const watched = watchedEpisodes({ collectionType: row.type, epStatus: row.ep_status, totalEpisodes });
    const progress = totalEpisodes > 0 ? (watched / totalEpisodes).toFixed(4) : '';
    const delta =
      row.rate > 0 && row.score && row.score > 0 ? (row.rate - row.score).toFixed(2) : '';
    const tags = parseStringArrayColumn(row.tag_names);
    const userTags = parseStringArrayColumn(row.user_tags);
    const studios = parseStringArrayColumn(row.studios);
    const directors = parseStringArrayColumn(row.directors);
    lines.push(
      [
        row.id,
        row.name,
        row.name_cn,
        row.year,
        row.season,
        row.format,
        row.platform,
        row.type,
        statusLabels[row.type] ?? row.type,
        row.rate,
        row.ep_status,
        totalEpisodes,
        progress,
        row.score,
        row.rank,
        row.rating_total,
        delta,
        tags.join('|'),
        userTags.join('|'),
        studios.join('|'),
        directors.join('|'),
        row.collection_updated_at,
        row.comment,
        `https://bgm.tv/subject/${row.id}`,
      ]
        .map((value, index) => csvCell(value, CSV_COLUMNS[index] === 'delta'))
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
