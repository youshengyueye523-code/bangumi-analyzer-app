import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

test('旧元数据资格、人数未知与合法零值在 API、实体、快照及详情保持一致', async ({ page, request }, testInfo) => {
  const health = await (await request.get('/api/health')).json();
  expect(health.collections).toBe(0);
  expect((await request.post('/api/data/import', { data: {
    format: 'bangumi-analyzer-export', version: 1,
    subjects: [{ id: 1, name: '合法元数据', year: 2010, score: 7, rating_total: 100, collection_total: 1000 },
      { id: 2, name: '旧异常元数据', year: 2020, score: 8, rank: 20, rating_total: 200, collection_total: 2000 },
      { kind: 'relation', subject_id: 1, related_id: 2, relation: '续集', type: 2 }],
    collections: [{ subject_id: 1, type: 2, rate: 8 }, { subject_id: 2, type: 1, rate: 7 }],
  } })).ok()).toBe(true);
  expect((await request.put('/api/config', { data: { hideNsfw: false, onboardingSeen: true } })).ok()).toBe(true);
  const db = new DatabaseSync(health.dbPath);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    db.exec("UPDATE subjects SET year='garbage',rank=-1,rating_total=NULL,collection_total=-1 WHERE id=2; UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='data_version'");
    const source = db.prepare('SELECT * FROM subjects ORDER BY id').all();
    const projection = db.prepare('SELECT * FROM series_entities ORDER BY id').all();
    const version = db.prepare("SELECT value FROM meta WHERE key='data_version'").get();
    expect(await (await request.get('/api/subjects/2')).json()).toMatchObject({ year: null, bgmRank: null, ratingTotal: null, collectionTotal: null, bgmScore: 8, delta: -1 });
    expect(await (await request.get('/api/stats/overview')).json()).toMatchObject({ total: 2, ratedCount: 2, averageRate: 7.5, yearRange: { min: 2010, max: 2010 } });
    expect((await (await request.get('/api/subjects?ratingMax=1000')).json()).items.map((row: { id: number }) => row.id)).toEqual([1]);
    const series = (await (await request.get('/api/series?includeSingletons=true')).json()).series;
    expect(series[0]).toMatchObject({ firstYear: 2010, lastYear: 2010 });
    const detail = await (await request.get(`/api/series/${series[0].key}`)).json();
    expect(detail.analysis.air.span).toMatchObject({ datedMembers: 1, totalMembers: 2, firstYear: 2010, lastYear: 2010 });
    expect(await (await request.get('/api/data/export/csv')).text()).not.toContain('garbage');
    await page.goto('/subjects/2');
    await expect(page.getByText('人数未知', { exact: true })).toBeVisible();
    await expect(page.getByText('评分人数未知', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('人数未知', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('round12-unknown-counts.png'), fullPage: true });
    expect(db.prepare('SELECT * FROM subjects ORDER BY id').all()).toEqual(source);
    expect(db.prepare('SELECT * FROM series_entities ORDER BY id').all()).toEqual(projection);
    expect(db.prepare("SELECT value FROM meta WHERE key='data_version'").get()).toEqual(version);
    const created = await request.post('/api/profile/snapshots', { data: { stageLabel: '第十二轮合法年份' } });
    expect(created.status()).toBe(201);
    const snapshot = db.prepare('SELECT dataset FROM profile_snapshots ORDER BY id DESC LIMIT 1').get()!;
    expect(JSON.parse(String(snapshot.dataset)).sample).toMatchObject({ yearFrom: 2010, yearTo: 2010, total: 2 });
    db.exec("UPDATE subjects SET rating_total=0,collection_total=0 WHERE id=2; UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='data_version'");
    expect(await (await request.get('/api/subjects/2')).json()).toMatchObject({ ratingTotal: 0, collectionTotal: 0 });
    await page.reload();
    await expect(page.getByText('共 0 人评分', { exact: true })).toBeVisible();
    await expect(page.getByText('人数未知', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { db.close(); }
});
