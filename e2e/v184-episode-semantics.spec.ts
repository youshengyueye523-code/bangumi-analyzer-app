import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

test('旧章节字段导入后，收藏/详情/Dashboard/Profile/Series/Franchise/Real 快照采用话数', async ({ page, request }, testInfo) => {
  // globalSetup 核验隔离服务目标；公开作品事实 + 模拟收藏/关系，不复制用户状态。
  const health = await (await request.get('/api/health')).json();
  expect(health.collections).toBe(0);
  expect(health.subjects).toBe(0);
  const facts = [
    { id: 18624, name: '回转企鹅罐', eps: 24, records: 32, format: 'TV', status: 2, progress: 0 },
    { id: 340, name: '虫师', eps: 26, records: 27, format: 'TV', status: 3, progress: 12 },
    { id: 238, name: '攻壳机动队2 无罪', eps: 1, records: 5, format: 'Movie', status: 2, progress: 0 },
    { id: 18882, name: '幻想嘉年华', eps: 12, records: 13, format: 'OVA', status: 2, progress: 0 },
    { id: 990009, name: '纯模拟未知话数', eps: 0, records: 8, format: 'TV', status: 2, progress: 0 },
  ];
  expect((await request.post('/api/data/import', { data: {
    format: 'bangumi-analyzer-export', version: 1,
    subjects: [
      ...facts.map((f) => ({ id: f.id, name: f.name, name_cn: f.name, type: 2, eps: f.eps, total_episodes: f.records,
        format: f.format, raw: { id: f.id, type: 2, eps: f.eps, total_episodes: f.records } })),
      // 完全模拟的关系，只用于验证 Franchise 聚合；不声明这些实际作品存在该关系。
      { kind: 'relation', subject_id: 18624, related_id: 340, type: 2, relation: '不同演绎' },
      { kind: 'relation', subject_id: 340, related_id: 18624, type: 2, relation: '不同演绎' },
    ],
    collections: facts.map((f) => ({ subject_id: f.id, subject_type: 2, type: f.status, ep_status: f.progress, rate: 7 })),
  } })).ok()).toBe(true);
  expect((await request.put('/api/config', { data: { onboardingSeen: true, hideNsfw: false } })).ok()).toBe(true);
  expect(await (await request.get('/api/subjects/18624')).json()).toMatchObject({ totalEpisodes: 24, epStatus: 0, watchedEpisodes: 24, progress: 1 });
  expect(await (await request.get('/api/stats/overview')).json()).toMatchObject({ totalEpisodes: 63, watchedEpisodes: 49 });
  expect(await (await request.get('/api/stats/habits')).json()).toMatchObject({ averageProgress: .865 });
  expect((await (await request.get('/api/profile/dataset')).json()).basics).toMatchObject({ totalEpisodes: 63, watchedEpisodes: 49 });
  const series = (await (await request.get('/api/series?includeSingletons=true')).json()).series;
  const penguin = series.find((entry: { totalEpisodes: number; title: string }) => entry.totalEpisodes === 24);
  expect(penguin).toBeTruthy();
  const detail = await (await request.get(`/api/series/${penguin.key}`)).json();
  expect(detail.analysis.consumption.watchedEpisodes).toBe(24);
  const franchises = (await (await request.get('/api/franchises')).json()).franchises;
  expect(franchises.length).toBe(1);
  expect((await (await request.get(`/api/franchises/${franchises[0].key}`)).json()).analysis.consumption.watchedEpisodes).toBe(36);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/subjects/18624');
  await expect(page.getByText('24/24', { exact: true })).toBeVisible();
  await expect(page.getByText('24 集', { exact: true })).toBeVisible();
  await expect(page.getByText(/观看进度 100\.0%/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('canonical-24.png'), fullPage: true });
  await page.reload();
  await expect(page.getByText('24/24', { exact: true })).toBeVisible();
  await page.goto('/subjects/340');
  await expect(page.getByText('12/26', { exact: true })).toBeVisible();
  await page.goto('/library');
  await expect(page.locator('article a[href="/subjects/18624"]')).toContainText('24 集');
  await expect(page.getByText('12/26', { exact: true })).toBeVisible();
  await page.goto(`/series/${penguin.key}`);
  await expect(page.getByText('24/24 集', { exact: false })).toBeVisible();
  await page.goto('/profile');
  await page.getByRole('button', { name: '保存当前阶段' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder(/第 .* 阶段/).fill('正确话数阶段');
  await dialog.getByRole('button', { name: '保存快照', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const snapshots = (await (await request.get('/api/profile/snapshots')).json()).snapshots;
  expect(snapshots[0]).toMatchObject({ visibility: 'real', collectionCount: 5 });
  // UI 写入后只读核验隔离数据库的完整快照（产品没有单个快照 GET）。
  const db = new DatabaseSync(health.dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const record = db.prepare('SELECT dataset FROM profile_snapshots WHERE id=?').get(snapshots[0].id)!;
    expect(JSON.parse(String(record.dataset)).basics).toMatchObject({ totalEpisodes: 63, watchedEpisodes: 49 });
  } finally { db.close(); }
  expect(errors).toEqual([]);
});
