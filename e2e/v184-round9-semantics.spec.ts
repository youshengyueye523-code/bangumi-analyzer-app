import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

test('第九轮：两种重复导入、未知话数、音乐单位、库存分母和CSV异常字段的实际HTTP/页面闭环', async ({ page, request }, testInfo) => {
  const health = await (await request.get('/api/health')).json();
  expect(health.subjects).toBe(0);
  const importOfficial = async (eps: number) => {
    expect((await request.post('/api/data/import', { data: { data: [{
      subject_id: 18624, subject_type: 2, type: 2, ep_status: 0, rate: 9,
      subject: { id: 18624, type: 2, name: '回转企鹅罐', name_cn: '回转企鹅罐', eps, date: '2011-07-07', tags: [] },
    }] } })).ok()).toBe(true);
  };
  // 初始12是模拟旧值；24/32与未知0/943、音乐0/6来自本轮公开事实。
  await importOfficial(12);
  await importOfficial(24);
  expect(await (await request.get('/api/subjects/18624')).json()).toMatchObject({ totalEpisodes: 24, watchedEpisodes: 24, progress: 1 });
  const exportPayload = (eps: number) => ({ format: 'bangumi-analyzer-export', version: 1,
    subjects: [{ id: 18624, eps, total_episodes: 32, format: 'TV', raw: { id: 18624, type: 2, eps, total_episodes: 32 } }], collections: [] });
  expect((await request.post('/api/data/import', { data: exportPayload(26) })).ok()).toBe(true);
  expect(await (await request.get('/api/subjects/18624')).json()).toMatchObject({ totalEpisodes: 26 });
  expect((await request.post('/api/data/import', { data: exportPayload(24) })).ok()).toBe(true);
  expect((await request.post('/api/data/import', { data: { format: 'bangumi-analyzer-export', version: 1,
    subjects: [
      { id: 18692, name: '哆啦A梦（模拟收藏）', eps: 0, total_episodes: 943, format: 'TV', raw: { id: 18692, type: 2, eps: 0, total_episodes: 943 } },
      { id: 814, type: 3, name: '星間飛行（模拟收藏）', eps: 0, total_episodes: 6, format: 'Music', raw: { id: 814, type: 3, eps: 0, total_episodes: 6 } },
      { id: 238, name: '攻壳机动队2 无罪（模拟收藏）', eps: 1, total_episodes: 5, format: 'Movie' },
    ],
    collections: [{ subject_id: 18692, type: 2, ep_status: 0 }, { subject_id: 814, subject_type: 3, type: 2, ep_status: 0 }, { subject_id: 238, type: 1, ep_status: 0 }],
  } })).ok()).toBe(true);
  expect((await request.put('/api/config', { data: { onboardingSeen: true, hideNsfw: false } })).ok()).toBe(true);
  expect(await (await request.get('/api/stats/overview')).json()).toMatchObject({ totalEpisodes: 30, watchedEpisodes: 30, completionRate: .75 });
  expect((await (await request.get('/api/profile/dataset')).json()).basics).toMatchObject({ totalEpisodes: 31, watchedEpisodes: 30, completionRate: .75 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/subjects/18624');
  await expect(page.getByText('24/24', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('24/24', { exact: true })).toBeVisible();
  await page.goto('/subjects/18692');
  await expect(page.getByText(/观看进度 100\.0%/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('round9-unknown.png'), fullPage: true });
  expect(await (await request.get('/api/subjects/18692')).json()).toMatchObject({ totalEpisodes: 0, watchedEpisodes: 0, progress: 1 });
  await page.goto('/subjects/814');
  await expect(page.getByText('6/6', { exact: true })).toBeVisible();
  await page.goto('/profile');
  await page.getByRole('button', { name: '保存当前阶段' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder(/第 .* 阶段/).fill('第九轮语义隔离');
  await dialog.getByRole('button', { name: '保存快照', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const snapshots = (await (await request.get('/api/profile/snapshots')).json()).snapshots;
  const db = new DatabaseSync(health.dbPath);
  try {
    const snapshot = db.prepare('SELECT dataset FROM profile_snapshots WHERE id=?').get(snapshots[0].id)!;
    expect(JSON.parse(String(snapshot.dataset)).basics).toMatchObject({ totalEpisodes: 31, watchedEpisodes: 30 });
    // 明确仅写隔离夹具：完整详情保护 + 历史异常JSON的真实导出HTTP。
    db.exec("UPDATE subjects SET detail_state='ok',tag_names='not-json' WHERE id=18624");
    expect((await request.post('/api/data/import', { data: exportPayload(32) })).ok()).toBe(true);
    expect(await (await request.get('/api/subjects/18624')).json()).toMatchObject({ totalEpisodes: 24 });
    const csv = await request.get('/api/data/export/csv');
    expect(csv.ok()).toBe(true);
    expect(await csv.text()).toContain('回转企鹅罐');
    expect(db.prepare('SELECT tag_names FROM subjects WHERE id=18624').get()).toMatchObject({ tag_names: 'not-json' });
  } finally { db.close(); }
  expect(errors).toEqual([]);
});
