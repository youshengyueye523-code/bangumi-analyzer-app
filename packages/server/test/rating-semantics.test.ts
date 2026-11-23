import { beforeEach, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { all, dataVersion, one, run } from '../src/db/index.js';
import { applyImport } from '../src/data/import.js';
import { buildCsv, buildExportPayload } from '../src/data/export.js';
import { getSubjectDetail, listSubjects, listSeries, getSeriesDetail } from '../src/db/query.js';
import { currentMembers, createSnapshot, getSnapshot } from '../src/db/profileSnapshots.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import { overview, distributions } from '../src/stats/queries.js';
import { invalidateStatsCache } from '../src/stats/cache.js';
import { resetDatabase } from './helpers.js';

beforeEach(() => { resetDatabase(); saveConfig({ hideNsfw: false }); });
function seed() {
  applyImport({ format: 'bangumi-analyzer-export', version: 1,
    subjects: [{ id: 1, score: 7, eps: 12, format: 'TV' }, { id: 2, score: 9, eps: 12, format: 'TV' },
      { kind: 'relation', subject_id: 1, related_id: 2, type: 2, relation: '续集' }],
    collections: [{ subject_id: 1, type: 3, rate: 8 }, { subject_id: 2, type: 2, rate: 9 }] });
}
it.each([-1, 11, 5.5, 'garbage', '[9]', 'Infinity', '9007199254740993'])('旧非法我的评分 %j 不进入评分分母；收藏库存仍保留', (value) => {
  seed(); run('UPDATE collections SET rate=:value WHERE subject_id=2', { value }); invalidateStatsCache();
  const source = all('SELECT * FROM collections'); const version = dataVersion();
  expect(overview()).toMatchObject({ total: 2, ratedCount: 1, unratedCount: 1, averageRate: 8, medianRate: 8, averageBgmScore: 8, meanDelta: 1 });
  expect(getSubjectDetail(2)).toMatchObject({ rate: 0, delta: null });
  expect(listSubjects({ rated: 'rated' }).items.map((row) => row.id)).toEqual([1]);
  expect(listSubjects({ rated: 'unrated' }).items.map((row) => row.id)).toEqual([2]);
  expect(distributions().rate.find((bucket) => bucket.key === 'unrated')?.count).toBe(1);
  const dataset = buildProfileDataset('real');
  expect(dataset.sample).toMatchObject({ total: 2, rated: 1 });
  expect(dataset.basics).toMatchObject({ averageRate: 8, medianRate: 8, meanDelta: 1 });
  expect(currentMembers()['2']).toEqual([2, 0]);
  expect(getSnapshot(createSnapshot({ stageLabel: '旧非法评分', dataset, members: currentMembers() }).id)!.averageRate).toBe(8);
  const series = listSeries({ includeSingletons: true })[0]!;
  expect(series.averageRate).toBe(8);
  expect(getSeriesDetail(series.key)!.analysis.rating).toMatchObject({ average: { ratedCount: 1, value: 8 } });
  expect(buildCsv()).not.toContain('garbage');
  expect(buildExportPayload().collections.find((row) => row.subject_id === 2)?.rate).toBe(value);
  expect(all('SELECT * FROM collections')).toEqual(source); expect(dataVersion()).toBe(version);
});
it.each([-1, 11, 'garbage', 'Infinity'])('旧非法上游评分 %j 只排除上游及配对样本，不排除合法我的评分', (value) => {
  seed(); run('UPDATE subjects SET score=:value WHERE id=2', { value }); invalidateStatsCache();
  const source = one('SELECT * FROM subjects WHERE id=2'); const version = dataVersion();
  expect(overview()).toMatchObject({ ratedCount: 2, averageRate: 8.5, averageBgmScore: 7, meanDelta: 1 });
  expect(getSubjectDetail(2)).toMatchObject({ rate: 9, bgmScore: null, delta: null });
  expect(buildProfileDataset('real').basics).toMatchObject({ averageRate: 8.5, averageBgmScore: 7, meanDelta: 1 });
  expect(one('SELECT * FROM subjects WHERE id=2')).toEqual(source); expect(dataVersion()).toBe(version);
});

it('SQLite 非有限 REAL 不变为评分事实；零值和缺失上游评分仍是未知', () => {
  seed(); run('UPDATE collections SET rate=1e999 WHERE subject_id=2');
  run('UPDATE subjects SET score=1e999 WHERE id=2'); invalidateStatsCache();
  expect(overview()).toMatchObject({ total: 2, ratedCount: 1, averageRate: 8, averageBgmScore: 7, meanDelta: 1 });
  expect(buildExportPayload().collections.find((row) => row.subject_id === 2)?.rate).toBe('Infinity');
  run('UPDATE collections SET rate=0 WHERE subject_id=2');
  run('UPDATE subjects SET score=NULL WHERE id=2'); invalidateStatsCache();
  expect(getSubjectDetail(2)).toMatchObject({ rate: 0, bgmScore: null, delta: null });
  run("UPDATE collections SET rate='8' WHERE subject_id=2");
  run('UPDATE subjects SET score=0 WHERE id=2'); invalidateStatsCache();
  expect(overview()).toMatchObject({ total: 2, ratedCount: 2, averageRate: 8, averageBgmScore: 7, meanDelta: 1 });
});
