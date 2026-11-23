import { expect, test } from '@playwright/test';

test('导入后隐藏切换不改变 Real 快照；创建、比较、刷新和删除一致', async ({ page, request }) => {
  // globalSetup 已验证实际服务使用本轮空临时目录，禁止复用真实 Local。
  const health = await (await request.get('/api/health')).json();
  expect(health.collections).toBe(0);
  const ids = [930001, 930002];
  expect((await request.post('/api/data/import', { data: {
    format: 'bangumi-analyzer-export', version: 1,
    subjects: ids.map((id) => ({ id, name: `快照夹具 ${id}`, eps: 12, format: 'TV', nsfw: id === 930002 })),
    collections: ids.map((id) => ({ subject_id: id, type: 2, rate: 8 })),
  } })).ok()).toBe(true);
  expect((await request.put('/api/config', { data: { hideNsfw: true, onboardingSeen: true } })).ok()).toBe(true);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/profile');
  await expect(page.getByText(/完整数据画像（Real），不受隐藏设置影响/)).toBeVisible();
  async function saveStage(label: string) {
    await page.getByRole('button', { name: '保存当前阶段' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder(/第 .* 阶段/).fill(label);
    await dialog.getByRole('button', { name: '保存快照', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await saveStage('隐藏开启阶段');
  let snapshots = (await (await request.get('/api/profile/snapshots')).json()).snapshots;
  expect(snapshots[0]).toMatchObject({ visibility: 'real', collectionCount: 2 });
  expect((await (await request.get('/api/profile/dataset')).json()).sample.total).toBe(1);
  await page.goto('/settings?tab=appearance');
  await page.getByRole('switch', { name: /隐藏 NSFW 内容/ }).click();
  await expect(page.getByRole('switch', { name: /隐藏 NSFW 内容/ })).toHaveAttribute('data-state', 'unchecked');
  await page.goto('/profile');
  await saveStage('隐藏关闭阶段');
  snapshots = (await (await request.get('/api/profile/snapshots')).json()).snapshots;
  expect(snapshots).toHaveLength(2);
  expect(snapshots.every((entry: { visibility: string; collectionCount: number }) => entry.visibility === 'real' && entry.collectionCount === 2)).toBe(true);
  const comparison = (await (await request.get('/api/profile/compare')).json()).comparison;
  expect(comparison.stageWorks).toMatchObject({ newWorks: 0, removedWorks: 0 });
  await expect(page.getByText(/^完整数据 ·/)).toHaveCount(2);
  await page.reload();
  await expect(page.getByText(/^完整数据 ·/)).toHaveCount(2);
  await page.getByRole('button', { name: '删除快照 隐藏开启阶段' }).click();
  await expect(page.getByText('隐藏开启阶段', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/目前只有 1 个阶段快照/)).toBeVisible();
  expect(errors).toEqual([]);
});
