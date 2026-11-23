import { beforeEach, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { all, dataVersion, one, run } from '../src/db/index.js';
import { applyImport, previewImport } from '../src/data/import.js';
import { buildCsv, buildExportPayload } from '../src/data/export.js';
import { getFilterFacets, getFranchiseDetail, getSeriesDetail, getSubjectDetail, listFranchises, listSeries, listSubjects } from '../src/db/query.js';
import { overview } from '../src/stats/queries.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import { invalidateStatsCache } from '../src/stats/cache.js';
import { resetDatabase } from './helpers.js';
import { bgmRatingSchema, bgmSubjectRelationSchema } from '@bangumi-analyzer/shared';
import { recomputeSeries } from '../src/db/series.js';

beforeEach(() => { resetDatabase(); saveConfig({ hideNsfw: false }); });
function seed() {
  applyImport({ format: 'bangumi-analyzer-export', version: 1,
    subjects: [{ id: 1, name: '年份甲', year: 2010, rank: 1, rating_total: 100, score: 7 },
      { id: 2, name: '年份乙', year: 2020, rank: 2, rating_total: 200, score: 8 },
      { kind: 'relation', subject_id: 1, related_id: 2, relation: '续集', type: 2 }],
    collections: [{ subject_id: 1, type: 2, rate: 8 }, { subject_id: 2, type: 1, rate: 7 }] });
}
it.each([-1, 0, 2010.5, 'garbage', 'Infinity', '9007199254740993'])('旧非法/未知年份 %j 不进入年份统计，但收藏保留', (value) => {
  seed(); run('UPDATE subjects SET year=:value WHERE id=2', { value }); invalidateStatsCache();
  const source = all('SELECT * FROM subjects'); const version = dataVersion();
  expect(getSubjectDetail(2)?.year).toBeNull();
  expect(overview()).toMatchObject({ total: 2, yearRange: { min: 2010, max: 2010 } });
  expect(buildProfileDataset('real').sample).toMatchObject({ total: 2, yearFrom: 2010, yearTo: 2010 });
  expect(getFilterFacets().years).toEqual([{ value: 2010, count: 1 }]);
  expect(listSubjects({ yearFrom: 2011 }).items).toHaveLength(0);
  const series = listSeries({ includeSingletons: true })[0]!;
  expect(series).toMatchObject({ firstYear: 2010, lastYear: 2010 });
  expect(getSeriesDetail(series.key)?.analysis.air.span).toMatchObject({ firstYear: 2010, lastYear: 2010, datedMembers: 1, totalMembers: 2 });
  expect(all('SELECT * FROM subjects')).toEqual(source); expect(dataVersion()).toBe(version);
});
it.each([-1, 2.5, 'garbage', 'Infinity', '9007199254740993'])('旧非法排名/评分人数 %j 不产生排名或人数筛选事实', (value) => {
  seed(); run('UPDATE subjects SET rank=:value,rating_total=:value WHERE id=2', { value });
  const source = one('SELECT * FROM subjects WHERE id=2'); const version = dataVersion();
  expect(getSubjectDetail(2)?.bgmRank).toBeNull();
  expect(getSubjectDetail(2)?.ratingTotal).toBeNull();
  expect(listSubjects({ ratingMin: 1 }).items.map((row) => row.id)).toEqual([1]);
  expect(listSubjects({ ratingMax: 1000 }).items.map((row) => row.id)).toEqual([1]);
  const csv = buildCsv().split('\r\n'); const headers = csv[0]!.replace(/^\uFEFF/, '').split(',');
  const cells = csv.find((line) => line.startsWith('2,'))!.split(',');
  expect(cells[headers.indexOf('bgm_rank')]).toBe(''); expect(cells[headers.indexOf('rating_total')]).toBe('');
  expect(buildExportPayload().subjects.find((row) => row.id === 2)?.rating_total).toBe(value);
  expect(one('SELECT * FROM subjects WHERE id=2')).toEqual(source); expect(dataVersion()).toBe(version);
});

it('合法零人数、数字字符串和旧书年份保留；未知人数不取消合法评分资格', () => {
  seed();
  run("UPDATE subjects SET rating_total=0,collection_total=0,rank=0,year='1818',date='2020-01-01' WHERE id=2");
  expect(getSubjectDetail(2)).toMatchObject({ ratingTotal: 0, collectionTotal: 0, bgmRank: null, year: 1818, date: '2020-01-01' });
  expect(listSubjects({ ratingMax: 1 }).items.map((row) => row.id)).toEqual([2]);
  run('UPDATE subjects SET rating_total=NULL,collection_total=-1 WHERE id=2');
  expect(getSubjectDetail(2)).toMatchObject({ ratingTotal: null, collectionTotal: null, bgmScore: 8, rate: 7, delta: -1 });
  invalidateStatsCache();
  expect(overview()).toMatchObject({ total: 2, ratedCount: 2, averageRate: 7.5 });
  run("UPDATE subjects SET rating_total='200',collection_total='500',rank='2' WHERE id=2");
  expect(getSubjectDetail(2)).toMatchObject({ ratingTotal: 200, collectionTotal: 500, bgmRank: 2 });
});

it.each(['1e999', '-1e999'])('非有限 SQLite 数值 %s 不成为年份、排名或人数事实', (literal) => {
  seed(); run(`UPDATE subjects SET year=${literal},rank=${literal},rating_total=${literal},collection_total=${literal} WHERE id=2`);
  expect(getSubjectDetail(2)).toMatchObject({ year: null, bgmRank: null, ratingTotal: null, collectionTotal: null });
  expect(buildCsv()).not.toContain('Infinity');
});

it('缺失、错误类型或负人数在上游解析保留未知，明确零值保持零', () => {
  for (const total of [undefined, '100', -1, Infinity]) expect(bgmRatingSchema.parse({ total }).total).toBeNull();
  expect(bgmRatingSchema.parse({ total: 0 }).total).toBe(0);
});

it('非法旧关系不能成为详情或重算图的节点，原始行保留', () => {
  seed();
  run("INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at) VALUES(1,0,'续集',2,'非法零节点','','2026-01-01'),(1,3,'续集',5,'非法类型','','2026-01-01')");
  const source = all('SELECT * FROM subject_relations');
  expect(getSubjectDetail(1)?.relations.map((row) => row.id)).toEqual([2]);
  recomputeSeries();
  const key = listSeries({ includeSingletons: true })[0]!.key;
  expect(getSeriesDetail(key)?.members.map((row) => row.subjectId).sort()).toEqual([1, 2]);
  expect(all('SELECT * FROM subject_relations')).toEqual(source);
  expect(bgmSubjectRelationSchema.safeParse({ id: 0, relation: '续集' }).success).toBe(false);
  expect(bgmSubjectRelationSchema.safeParse({ id: 3, type: 5, relation: '续集' }).success).toBe(false);
});

it('合法 staff/relation 数字字符串与 JSON career 兼容旧导出', () => {
  seed();
  const result = applyImport({ format: 'bangumi-analyzer-export', version: 1, collections: [], subjects: [
    { kind: 'staff', subject_id: '1', person_id: '42', name: '导演甲', relation: '导演', career: '["director"]', source: 'person-api' },
    { kind: 'relation', subject_id: '2', related_id: '1', relation: '前传', type: '2', name: '年份甲' },
  ] });
  expect(result.skipped).toBe(0);
  expect(getSubjectDetail(1)?.staff).toContainEqual({ id: 42, name: '导演甲', relation: '导演', career: ['director'], source: 'person-api' });
});

it('非动画合法早期年份不套用动画日期范围，也不由冲突 date 覆盖', () => {
  applyImport({ format: 'bangumi-analyzer-export', version: 1,
    subjects: [{ id: 10, type: 1, name: '旧书年份兼容样本', year: 1818, date: '2020-01-01' }],
    collections: [{ subject_id: 10, subject_type: 1, type: 2 }] });
  expect(getSubjectDetail(10)).toMatchObject({ year: 1818, date: '2020-01-01' });
  expect(one('SELECT type FROM subjects WHERE id=10')).toEqual({ type: 1 });
  expect(buildProfileDataset('real').sample).toMatchObject({ yearFrom: 1818, yearTo: 1818 });
  expect(getFilterFacets().years).toEqual([{ value: 1818, count: 1 }]);
});

it('Franchise 列表、详情与分析从合法年份重读，保留冲突旧投影', () => {
  seed();
  applyImport({ format: 'bangumi-analyzer-export', version: 1, subjects: [
    { id: 3, name: '不同演绎', year: 2030 },
    { kind: 'relation', subject_id: 1, related_id: 3, relation: '不同演绎', type: 2 },
  ], collections: [{ subject_id: 3, type: 2 }] });
  run("UPDATE subjects SET year='garbage' WHERE id=3");
  const projection = all('SELECT * FROM franchise_entities'); const version = dataVersion();
  const franchise = listFranchises()[0]!;
  expect(franchise).toMatchObject({ firstYear: 2010, lastYear: 2020 });
  expect(getFranchiseDetail(franchise.key)).toMatchObject({ firstYear: 2010, lastYear: 2020,
    analysis: { air: { span: { firstYear: 2010, lastYear: 2020, datedMembers: 2, totalMembers: 3 } } } });
  expect(all('SELECT * FROM franchise_entities')).toEqual(projection); expect(dataVersion()).toBe(version);
});
it.each([
  { kind: 'staff', subject_id: [1], name: '合法姓名' },
  { kind: 'staff', subject_id: 1, person_id: true, name: '合法姓名', source: 'person-api' },
  { kind: 'staff', subject_id: 1, name: { name: '导演甲' }, relation: '导演' },
  { kind: 'staff', subject_id: 1, name: '导演甲', relation: ['导演'] },
  { kind: 'staff', subject_id: 1, name: '导演甲', career: [null, 'director'] },
  { kind: 'relation', subject_id: 1, related_id: [2], relation: '续集' },
  { kind: 'relation', subject_id: 1, related_id: 0, relation: '续集' },
  { kind: 'relation', subject_id: 1, related_id: 2, relation: ['续集'] },
  { kind: 'relation', subject_id: 1, related_id: 2, relation: '续集', type: 5 },
  { kind: 'relation', subject_id: 1, related_id: 2, relation: '续集', name: {} },
])('导出格式不强制转换非法 staff/relation 为事实：%j', (row) => {
  seed();
  const payload = { format: 'bangumi-analyzer-export', version: 1, subjects: [row], collections: [] };
  const before = all('SELECT * FROM subject_relations'); const staff = all('SELECT * FROM subject_staff');
  expect(previewImport(payload).skipped).toBe(1);
  expect(applyImport(payload).skipped).toBe(1);
  expect(all('SELECT * FROM subject_relations')).toEqual(before);
  expect(all('SELECT * FROM subject_staff')).toEqual(staff);
});
