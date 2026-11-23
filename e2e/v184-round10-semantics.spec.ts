import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

test('第十轮：异常数值、真人/Special 来源和新 Real 快照的实际 HTTP 与页面解释一致', async ({ page, request }, testInfo) => {
  const health = await (await request.get('/api/health')).json();
  expect(health.subjects).toBe(0);
  const bad = { format: 'bangumi-analyzer-export', version: 1, subjects: [{ id: 999, score: [9] }], collections: [{ subject_id: 999, type: 2 }] };
  expect(await (await request.post('/api/data/import?dryRun=true', { data: bad })).json()).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: 2 });
  expect(await (await request.post('/api/data/import', { data: bad })).json()).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: 2 });
  // 真实公开属性与模拟收藏明确分开：前3项是冲突/异常反例，后3项元数据来自公开 GET。
  const data = { format: 'bangumi-analyzer-export', version: 1,
    subjects: [
      { id: 1, name: '旧异常进度', eps: 24, total_episodes: 32, format: 'TV' },
      { id: 2, type: 6, name: '真人冲突反例', eps: 12, total_episodes: 15, format: '其他' },
      { id: 3, name: '未知动画', eps: 0, total_episodes: 99, raw: { id: 3, type: 2, eps: 0, total_episodes: 99 } },
      { id: 88473, name: '蟲師 特別篇 日蝕む翳', platform: 'TV', format: 'TV', eps: 1, total_episodes: 1, tag_names: ['OVA', '蟲師'], date: '2014-01-04' },
      { id: 30619, type: 6, name: '孤独のグルメ', platform: '日剧', eps: 12, total_episodes: 12, date: '2012-01-05' },
      { id: 160547, type: 6, name: '孤独のグルメ お正月スペシャル!', platform: '日剧', eps: 1, total_episodes: 1, format: 'Special', date: '2016-01-01', tag_names: ['SP'] },
    ], collections: [
      { subject_id: 1, type: 3 }, { subject_id: 2, subject_type: 6, type: 2 }, { subject_id: 3, type: 2 },
      { subject_id: 88473, type: 2 }, { subject_id: 30619, subject_type: 6, type: 3, ep_status: 5 }, { subject_id: 160547, subject_type: 6, type: 2 },
    ] };
  expect((await request.post('/api/data/import', { data })).ok()).toBe(true);
  expect((await request.put('/api/config', { data: { onboardingSeen: true, hideNsfw: false } })).ok()).toBe(true);
  const db = new DatabaseSync(health.dbPath);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    for (const value of [-3, 'NaN', '9007199254740993', 'Infinity']) {
      if (value === 'Infinity') db.exec('UPDATE collections SET ep_status=1e999 WHERE subject_id=1');
      else db.prepare('UPDATE collections SET ep_status=? WHERE subject_id=1').run(value);
      db.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='data_version'");
      const source = db.prepare('SELECT CAST(ep_status AS TEXT) AS value FROM collections WHERE subject_id=1').get();
      const version = db.prepare("SELECT value FROM meta WHERE key='data_version'").get();
      expect(await (await request.get('/api/subjects/1')).json()).toMatchObject({ totalEpisodes: 24, epStatus: 0, watchedEpisodes: 0, progress: 0 });
      expect(await (await request.get('/api/stats/overview')).json()).toMatchObject({ totalEpisodes: 53, watchedEpisodes: 22 });
      expect((await (await request.get('/api/profile/dataset')).json()).basics).toMatchObject({ totalEpisodes: 53, watchedEpisodes: 22 });
      const csv = await request.get('/api/data/export/csv');
      expect(csv.ok()).toBe(true);
      expect((await csv.text()).split('\r\n').find((line) => line.startsWith('1,'))).toContain(',0,24,0.0000,');
      const exported = await (await request.get('/api/data/export/json')).json();
      expect(exported.collections.find((row: { subject_id: number }) => row.subject_id === 1).ep_status).toBe(value);
      expect(db.prepare('SELECT CAST(ep_status AS TEXT) AS value FROM collections WHERE subject_id=1').get()).toEqual(source);
      expect(db.prepare("SELECT value FROM meta WHERE key='data_version'").get()).toEqual(version);
    }
    await page.goto('/subjects/1');
    await expect(page.getByText('0/24', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('0/24', { exact: true })).toBeVisible();
    await page.goto('/subjects/88473');
    await expect(page.getByText('1/1', { exact: true })).toBeVisible();
    expect(await (await request.get('/api/subjects/88473')).json()).toMatchObject({ format: 'TV', platform: 'TV' });
    await page.goto('/subjects/30619');
    await expect(page.getByText('5/12', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('round10-live-action.png'), fullPage: true });
    await page.goto('/');
    await expect(page.getByText('22 / 53 集', { exact: true })).toBeVisible();
    await page.goto('/profile');
    await page.getByRole('button', { name: '保存当前阶段' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder(/第 .* 阶段/).fill('第十轮数值语义');
    await dialog.getByRole('button', { name: '保存快照', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const snapshot = db.prepare('SELECT dataset FROM profile_snapshots ORDER BY id DESC LIMIT 1').get()!;
    expect(JSON.parse(String(snapshot.dataset)).basics).toMatchObject({ totalEpisodes: 53, watchedEpisodes: 22 });
    expect(errors).toEqual([]);
  } finally { db.close(); }
});
