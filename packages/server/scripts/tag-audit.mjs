/**
 * 标签数据只读审计工具（不修改任何数据）：
 *
 *   node packages/server/scripts/tag-audit.mjs
 *   BANGUMI_DATA_DIR=<dir> node packages/server/scripts/tag-audit.mjs
 *
 * 用于核对「数据库里的标签是否完整」，以及标签筛选 / 反向追溯的口径是否正确。
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.env.BANGUMI_DATA_DIR
  ? resolve(process.env.BANGUMI_DATA_DIR)
  : join(resolve(import.meta.dirname, '../../..'), 'data');
const dbFile = join(dataDir, 'bangumi.db');

if (!existsSync(dbFile)) {
  console.error(`找不到数据库：${dbFile}`);
  process.exit(1);
}

const db = new DatabaseSync(dbFile, { readOnly: true });
const one = (sql) => {
  const row = db.prepare(sql).get();
  return row ? Object.values(row)[0] : null;
};
const all = (sql) => db.prepare(sql).all();
const print = (label, value) => console.log(`${label.padEnd(38, ' ')} ${value}`);

console.log('\n标签数据审计（只读）');
console.log('-'.repeat(64));
print('数据目录', dataDir);
print('收藏条目', one('SELECT COUNT(*) FROM collections'));
print('条目记录', one('SELECT COUNT(*) FROM subjects'));

const fullDistinct = one(
  `SELECT COUNT(DISTINCT json_extract(je.value, '$.name')) FROM subjects s, json_each(s.tags) je`,
);
const filteredDistinct = one(
  `SELECT COUNT(DISTINCT je.value) FROM subjects s, json_each(s.tag_names) je`,
);

console.log('\n完整性（原始 tags vs 用于筛选的 tag_names）');
console.log('-'.repeat(64));
print('原始 tags 去重标签名', fullDistinct);
print('筛选用 tag_names 去重标签名', filteredDistinct);
print('缺失标签名数量', Number(fullDistinct ?? 0) - Number(filteredDistinct ?? 0));
print('原始 tags 标签条目数', one(`SELECT COUNT(*) FROM subjects s, json_each(s.tags) je`));
print(
  '筛选用 tag_names 标签条目数',
  one(`SELECT COUNT(*) FROM subjects s, json_each(s.tag_names) je`),
);
print('平均每条作品标签数（原始）', one(`SELECT ROUND(AVG(json_array_length(tags)), 1) FROM subjects`));
print(
  '平均每条作品标签数（筛选用）',
  one(`SELECT ROUND(AVG(json_array_length(tag_names)), 1) FROM subjects`),
);

const missingSample = all(
  `SELECT DISTINCT json_extract(je.value, '$.name') AS tag_name
   FROM subjects s, json_each(s.tags) je
   WHERE NOT EXISTS (
     SELECT 1 FROM subjects s2, json_each(s2.tag_names) je2
     WHERE je2.value = json_extract(je.value, '$.name')
   )
   LIMIT 15`,
);
if (missingSample.length > 0) {
  console.log('\n被筛选字段遗漏的标签（示例）');
  console.log('-'.repeat(64));
  console.log(`  ${missingSample.map((row) => row.tag_name).join('、')}`);
}

console.log('\n标签筛选器口径（facets 查询）');
console.log('-'.repeat(64));
print(
  'count>=2 的标签数',
  one(
    `SELECT COUNT(*) FROM (
        SELECT je.value AS v, COUNT(*) AS c
       FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(s.tag_names) je
       GROUP BY je.value HAVING COUNT(*) >= 2)`,
  ),
);
print(
  'count=1 的标签数',
  one(
    `SELECT COUNT(*) FROM (
        SELECT je.value AS v, COUNT(*) AS c
       FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(s.tag_names) je
       GROUP BY je.value HAVING COUNT(*) = 1)`,
  ),
);

console.log('\nTop 10 标签（按当前筛选字段统计）');
console.log('-'.repeat(64));
for (const row of all(
  `SELECT je.value AS tag_name, COUNT(*) AS n
   FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(s.tag_names) je
   GROUP BY je.value ORDER BY n DESC, je.value ASC LIMIT 10`,
)) {
  print(`  ${row.tag_name}`, row.n);
}

console.log('\n制作人员 → 作品（反向追溯数据源）');
console.log('-'.repeat(64));
for (const row of all(
  `SELECT name AS staff_name, COUNT(DISTINCT subject_id) AS works
   FROM subject_staff GROUP BY name ORDER BY works DESC LIMIT 5`,
)) {
  print(`  ${row.staff_name}`, `${row.works} 部作品`);
}

db.close();
console.log('');
