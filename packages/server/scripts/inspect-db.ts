/**
 * 数据库概况查看工具：
 *
 *   pnpm -C packages/server run inspect
 *
 * 用于排查同步质量（详情覆盖率、字段缺失、系列分组等），
 * 不会修改任何数据。
 */

import { all, closeDatabase, integrityCheck, one, openDatabase, schemaVersion } from '../src/db/index.js';
import { paths } from '../src/config.js';

function line(label: string, value: unknown): void {
  console.log(`${label.padEnd(26, ' ')} ${value}`);
}

openDatabase();

const counts = one<{ collections: number; subjects: number; staff: number; relations: number }>(
  `SELECT (SELECT COUNT(*) FROM collections) AS collections,
          (SELECT COUNT(*) FROM subjects) AS subjects,
          (SELECT COUNT(*) FROM subject_staff) AS staff,
          (SELECT COUNT(*) FROM subject_relations) AS relations`,
);

console.log('\n数据库概况');
console.log('─'.repeat(56));
line('数据目录', paths.dataDir);
line('数据库文件', `${paths.dbFile}（schema v${schemaVersion()}）`);
line('自检结果', integrityCheck());
line('收藏条目', counts?.collections ?? 0);
line('条目记录', counts?.subjects ?? 0);
line('制作人员记录', counts?.staff ?? 0);
line('条目关系记录', counts?.relations ?? 0);
line('已评分作品', one<{ n: number }>('SELECT COUNT(*) AS n FROM collections WHERE rate > 0')?.n ?? 0);

const coverage = one<{ details: number; relations: number; persons: number; failed: number }>(
  `SELECT SUM(CASE WHEN detail_state = 'ok' THEN 1 ELSE 0 END) AS details,
          SUM(CASE WHEN relations_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS relations,
          SUM(CASE WHEN persons_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS persons,
          SUM(CASE WHEN detail_state = 'failed' THEN 1 ELSE 0 END) AS failed
   FROM subjects`,
);
line('详情覆盖率', `${coverage?.details ?? 0} / ${counts?.subjects ?? 0}`);
line('系列关系统计', `${coverage?.relations ?? 0} 条`);
line('制作人员统计', `${coverage?.persons ?? 0} 条`);
line('详情同步失败', coverage?.failed ?? 0);

console.log('\n放送形态分布');
console.log('─'.repeat(56));
for (const row of all<{ format: string; n: number }>(
  `SELECT s.format AS format, COUNT(*) AS n FROM collections c JOIN subjects s ON s.id = c.subject_id
   GROUP BY s.format ORDER BY n DESC`,
)) {
  line(row.format, row.n);
}

console.log('\n字段覆盖率（非空比例）');
console.log('─'.repeat(56));
const fields = one<{ total: number; studios: number; directors: number; score: number; rating: number }>(
  `SELECT COUNT(*) AS total,
          SUM(CASE WHEN s.studios <> '[]' THEN 1 ELSE 0 END) AS studios,
          SUM(CASE WHEN s.directors <> '[]' THEN 1 ELSE 0 END) AS directors,
          SUM(CASE WHEN s.score > 0 THEN 1 ELSE 0 END) AS score,
          SUM(CASE WHEN s.rating_total IS NOT NULL AND s.rating_total > 0 THEN 1 ELSE 0 END) AS rating
   FROM collections c JOIN subjects s ON s.id = c.subject_id`,
);
const total = Number(fields?.total ?? 0) || 1;
const percent = (value: number | null | undefined) => `${(((value ?? 0) / total) * 100).toFixed(1)}%`;
line('制作公司（studios）', percent(fields?.studios));
line('导演（directors）', percent(fields?.directors));
line('Bangumi 评分', percent(fields?.score));
line('评分人数', percent(fields?.rating));

console.log('\n系列分组');
console.log('─'.repeat(56));
for (const row of all<{ source: string; n: number; members: number }>(
  `SELECT source, COUNT(*) AS n, SUM(count) AS members FROM series GROUP BY source`,
)) {
  line(row.source, `${row.n} 组 / 覆盖 ${row.members} 部作品`);
}

const failures = all<{ id: number; title: string; error: string | null }>(
  `SELECT id, COALESCE(NULLIF(name_cn, ''), name) AS title, detail_error AS error
   FROM subjects WHERE detail_state = 'failed' LIMIT 10`,
);
if (failures.length > 0) {
  console.log('\n详情同步失败的条目');
  console.log('─'.repeat(56));
  for (const row of failures) line(`#${row.id} ${row.title}`, row.error ?? '');
}

console.log('');
closeDatabase();
