import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

test('旧非法评分不污染统计分母；矛盾 Real 快照在 API 与页面均拒绝比较', async ({ page, request }, testInfo) => {
  const health = await (await request.get('/api/health')).json();
  expect(health.collections).toBe(0);
  expect((await request.post('/api/data/import', { data: {
    format: 'bangumi-analyzer-export', version: 1,
    subjects: [{ id: 1, name: '有效评分', score: 7, eps: 12, tag_names: ['验证'] }, { id: 2, name: '旧非法评分', score: 9, eps: 12, tag_names: ['验证'] }],
    collections: [{ subject_id: 1, type: 1, rate: 8 }, { subject_id: 2, type: 2, rate: 9 }],
  } })).ok()).toBe(true);
  expect((await request.put('/api/config', { data: { hideNsfw: false, onboardingSeen: true } })).ok()).toBe(true);
  const db = new DatabaseSync(health.dbPath);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    db.exec("UPDATE collections SET rate='garbage' WHERE subject_id=2; UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='data_version'");
    const source = db.prepare('SELECT * FROM collections WHERE subject_id=2').get();
    expect(await (await request.get('/api/stats/overview')).json()).toMatchObject({ total: 2, ratedCount: 1, averageRate: 8, meanDelta: 1 });
    expect(await (await request.get('/api/subjects/2')).json()).toMatchObject({ rate: 0, delta: null });
    expect((await (await request.get('/api/profile/dataset')).json()).basics).toMatchObject({ averageRate: 8, meanDelta: 1 });
    expect(await (await request.get('/api/data/export/csv')).text()).not.toContain('garbage');
    const snapshots: number[] = [];
    for (const stageLabel of ['修复后的 Real', '矛盾历史 Real']) {
      const response = await request.post('/api/profile/snapshots', { data: { stageLabel } });
      expect(response.status()).toBe(201); snapshots.push((await response.json()).snapshot.id);
    }
    const compareUrl = `/api/profile/compare?from=${snapshots[0]}&to=${snapshots[1]}`;
    expect(await (await request.get(compareUrl)).json()).toMatchObject({ available: true });
    db.prepare("UPDATE profile_snapshots SET dataset=json_set(dataset,'$.tags[0].count',999) WHERE id=?").run(snapshots[1]!);
    const history = db.prepare('SELECT * FROM profile_snapshots ORDER BY id').all();
    const version = db.prepare("SELECT value FROM meta WHERE key='data_version'").get();
    expect(await (await request.get(compareUrl)).json()).toMatchObject({ available: false, comparison: null });
    await page.goto('/profile');
    await expect(page.getByText(/结构异常/)).toBeVisible();
    await expect(page.getByText('矛盾历史 Real', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(/结构异常/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('round11-comparison-refused.png'), fullPage: true });
    expect(db.prepare('SELECT * FROM profile_snapshots ORDER BY id').all()).toEqual(history);
    expect(db.prepare('SELECT * FROM collections WHERE subject_id=2').get()).toEqual(source);
    expect(db.prepare("SELECT value FROM meta WHERE key='data_version'").get()).toEqual(version);
    expect(errors).toEqual([]);
  } finally { db.close(); }
});
