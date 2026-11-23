import { expect, test } from '@playwright/test';
import type { FranchiseDetail } from '@bangumi-analyzer/shared';

let mixedKey = '';
let cleanKey = '';

test.beforeAll(async ({ request }) => {
  // globalSetup 已核对真实服务目标；本文件只在空的临时 DB 中创建模拟夹具。
  const health = await (await request.get('/api/health')).json();
  expect(health.collections).toBe(0);
  expect(health.subjects).toBe(0);
  const ids = [900001, 900002, 900003, 900004];
  const response = await request.post('/api/data/import', {
    data: {
      format: 'bangumi-analyzer-export', version: 1,
      collections: ids.map((id) => ({ subject_id: id, subject_type: 2, type: 2, rate: 8, ep_status: 12 })),
      subjects: [
        ...ids.map((id) => ({ id, name: `审计夹具 ${id}`, name_cn: `审计夹具 ${id}`, year: 2020, format: 'TV', eps: 12, nsfw: id === 900002 })),
        ...[[900001, 900002], [900002, 900001], [900003, 900004], [900004, 900003]].map(([from, to]) => ({ kind: 'relation', subject_id: from, related_id: to, type: 2, relation: '不同演绎' })),
      ],
    },
  });
  expect(response.ok()).toBe(true);
  const list = await (await request.get('/api/franchises')).json();
  for (const entry of list.franchises) {
    const detail: FranchiseDetail = await (await request.get(`/api/franchises/${entry.key}`)).json();
    const memberIds = detail.series.flatMap((series) => series.entries.map((member) => member.id));
    if (memberIds.includes(900001)) mixedKey = detail.key;
    if (memberIds.includes(900003)) cleanKey = detail.key;
  }
  expect(mixedKey).toBeTruthy();
  expect(cleanKey).toBeTruthy();
  expect(mixedKey).not.toBe(cleanKey);
  expect((await request.put('/api/config', { data: { hideNsfw: true, onboardingSeen: true } })).ok()).toBe(true);
});

test('Franchise 口径：连续切换、刷新、导航返回与无隐藏成员', async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/franchises/${mixedKey}`);
  const seriesLinks = page.locator('a[href^="/series/sr_"]');
  await expect(page.getByText(/当前可见口径 · 已隐藏 1 个成员/)).toBeVisible();
  await expect(seriesLinks).toHaveCount(1);
  await expect(page.getByText(/不参与当前口径的统计/)).toBeVisible();
  await expect(page.getByText('12/12 集', { exact: false })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('visible.png'), fullPage: true });
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole('button', { name: '完整数据', exact: true }).click();
    await expect(page.getByText(/完整数据口径 · 已包含 1 个成员/)).toBeVisible();
    await expect(seriesLinks).toHaveCount(2);
    await expect(page.getByText(/不参与当前口径的统计/)).toHaveCount(0);
    await page.getByRole('button', { name: '当前可见', exact: true }).click();
    await expect(seriesLinks).toHaveCount(1);
    await expect(page.getByText(/不参与当前口径的统计/)).toBeVisible();
  }
  await page.getByRole('button', { name: '完整数据', exact: true }).click();
  await expect(seriesLinks).toHaveCount(2);
  await expect(page.getByText('12/12 集', { exact: false })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('real.png'), fullPage: true });
  await page.reload();
  // 整页切换不跨访问记忆：刷新与离开后返回均重新采用默认当前可见口径。
  await expect(page.getByText(/当前可见口径 · 已隐藏 1 个成员/)).toBeVisible();
  await expect(seriesLinks).toHaveCount(1);
  await page.getByRole('link', { name: '全部家族', exact: true }).click();
  await expect(page.getByText('作品家族（Franchise）', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(seriesLinks).toHaveCount(1);
  await expect(page.getByText(/不参与当前口径的统计/)).toBeVisible();
  await page.goto(`/franchises/${cleanKey}`);
  await expect(seriesLinks).toHaveCount(2);
  await expect(page.getByText(/不参与当前口径的统计/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '完整数据', exact: true })).toHaveCount(0);
  // 通过设置正式 UI 切换触发全局 query invalidation，而不是测试替换缓存。
  await page.goto('/settings?tab=appearance');
  await page.getByRole('switch', { name: /隐藏 NSFW 内容/ }).click();
  await expect(page.getByRole('switch', { name: /隐藏 NSFW 内容/ })).toHaveAttribute('data-state', 'unchecked');
  await page.goto(`/franchises/${mixedKey}`);
  await expect(seriesLinks).toHaveCount(2);
  await expect(page.getByText(/完整数据口径/)).toBeVisible();
  await expect(page.getByText(/不参与当前口径的统计/)).toHaveCount(0);
  expect((await (await request.get(`/api/franchises/${mixedKey}`)).json()).analysis.visibility).toBe('real');
  expect(errors).toEqual([]);
});
