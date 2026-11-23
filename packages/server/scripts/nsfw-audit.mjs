/**
 * v1.5.3 NSFW 样本诊断：输出 subject.nsfw 与 Series / Franchise 归属。
 * 用法：node packages/server/scripts/nsfw-audit.mjs [dbPath]
 */
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2] ?? 'data/bangumi.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = db
  .prepare(
    `SELECT s.id, s.name, s.name_cn, s.nsfw,
       (SELECT e.key FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
        WHERE m.subject_id = s.id AND m.role = 'primary' AND e.state <> 'stale' LIMIT 1) AS series_key,
       (SELECT e.title FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
        WHERE m.subject_id = s.id AND m.role = 'primary' AND e.state <> 'stale' LIMIT 1) AS series_title,
       (SELECT e.member_count FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
        WHERE m.subject_id = s.id AND m.role = 'primary' AND e.state <> 'stale' LIMIT 1) AS series_members,
       (SELECT f.key FROM franchise_series fs JOIN franchise_entities f ON f.id = fs.franchise_id
        JOIN series_entity_members m ON m.series_id = fs.series_id
        WHERE m.subject_id = s.id AND m.role = 'primary' AND f.state <> 'stale'
          AND fs.state <> 'conflict' LIMIT 1) AS franchise_key
     FROM subjects s WHERE s.nsfw = 1 ORDER BY s.id`,
  )
  .all();

console.log('subject_id | title | subject.nsfw | series_key | franchise_key');
for (const row of rows) {
  console.log(
    [
      row.id,
      `${row.name_cn || row.name} (${row.name})`,
      row.nsfw === 1 ? 'true' : 'false',
      row.series_key
        ? `${row.series_key} [${row.series_title}, ${row.series_members} members]`
        : '(none)',
      row.franchise_key ?? '(none)',
    ].join(' | '),
  );
}

const tagRows = db
  .prepare(`SELECT id, name_cn, name, raw FROM subjects WHERE nsfw = 1 ORDER BY id`)
  .all();
console.log('\n--- tag 辅助观察（仅对照，不参与判定） ---');
for (const row of tagRows) {
  let tags = [];
  try {
    const raw = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw;
    tags = (raw?.tags ?? []).map((tag) => tag.name);
  } catch {
    tags = [];
  }
  console.log(row.id, row.name_cn || row.name, '=>', tags.slice(0, 12).join(' / '));
}

const summary = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM subjects) AS subjects,
       (SELECT COUNT(*) FROM collections) AS collections,
       (SELECT COUNT(*) FROM subject_relations) AS relations,
       (SELECT COUNT(*) FROM subjects WHERE nsfw = 1) AS nsfwSubjects,
       (SELECT COUNT(*) FROM collections c JOIN subjects s ON s.id = c.subject_id WHERE s.nsfw = 1) AS nsfwCollections,
       (SELECT COUNT(*) FROM series_entities WHERE state <> 'stale') AS series,
       (SELECT COUNT(*) FROM franchise_entities WHERE state <> 'stale') AS franchises,
       (SELECT COALESCE(SUM(rate), 0) FROM collections) AS ratingSum,
       (SELECT COALESCE(SUM(ep_status), 0) FROM collections) AS progressSum,
       (SELECT COUNT(*) FROM collections WHERE type = 2) AS doneCount,
       (SELECT integrity_check FROM pragma_integrity_check) AS integrity`,
  )
  .get();
console.log('\n--- totals ---');
console.log(summary);

// 回归样本对照：负样本（nsfw=0，正常显示）与隐藏样本
const samples = db
  .prepare(
    `SELECT id, name_cn, nsfw FROM subjects
      WHERE name_cn LIKE '%孤独摇滚%' OR name_cn LIKE '%超辉夜姬%' OR name_cn LIKE '%鬼父%'
      ORDER BY nsfw, id LIMIT 12`,
  )
  .all();
console.log('\n--- sample lookup ---');
for (const row of samples) console.log(row.id, row.name_cn, 'nsfw=', row.nsfw);
db.close();
