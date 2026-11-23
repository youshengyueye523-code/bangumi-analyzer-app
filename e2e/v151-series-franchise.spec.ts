import { expect, test } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.5.1 Series / Franchise 真实集成回归。
 *
 * 这些用例针对「真实运行实例」的关键路径：
 * 封面、计数、卡片可点击、旧 key alias、Franchise 列表与详情。
 * 数据为空时自动按空状态断言，不会伪造通过。
 */

test.describe('v1.5.1 Series / Franchise 集成', () => {
  test('Series 列表：封面、真实计数、卡片可点击进入详情', async ({ page }) => {
    await gotoAndWait(page, '/series');
    await expectNoErrorState(page);

    const cards = page.locator('a[href^="/series/"]');
    const cardCount = await cards.count();
    test.skip(cardCount === 0, '当前数据库没有多成员系列');

    // 计数必须是真实数字，而不是空值（曾经出现「系列共 部」）
    await expect(page.getByText(/系列共 \d+ 部/).first()).toBeVisible();
    // 封面视觉识别必须存在
    expect(await page.locator('a[href^="/series/"] img').count()).toBeGreaterThan(0);

    const first = cards.first();
    await first.click();
    await page.waitForURL(/\/series\/[^/]+$/);
    await waitForReady(page);
    await expectNoErrorState(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /系列成员/ })).toBeVisible();
    // 详情页可以返回
    await page.goBack();
    await page.waitForURL(/\/series$/);
    await expect(page.getByRole('heading', { name: '系列 / 家族' })).toBeVisible();
  });

  test('旧 bgm: key 通过 alias 进入 canonical Series', async ({ page }) => {
    const probe = await page.request.get('/api/series/bgm%3A233');
    test.skip(!probe.ok(), '当前数据库没有 bgm:233 旧 key');
    const detail = await probe.json();

    await gotoAndWait(page, '/series/bgm%3A233');
    // 前端应把地址栏替换成 canonical key
    await page.waitForURL(new RegExp(`/series/${detail.canonicalKey}$`));
    await waitForReady(page);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(detail.title);
  });

  test('Franchise：列表、状态、详情与 Series 链接', async ({ page }) => {
    await gotoAndWait(page, '/series');
    await page.getByRole('button', { name: 'Franchise' }).click();
    await page.waitForURL(/\/franchises$/);
    await waitForReady(page);
    await expectNoErrorState(page);

    const cards = page.locator('a[href^="/franchises/"]');
    const cardCount = await cards.count();
    if (cardCount === 0) {
      await expect(page.getByText(/暂时没有足够证据的家族/)).toBeVisible();
      return;
    }

    // 状态必须明确标注（候选 / 暂定 / 已确认 / 争议）
    await expect(page.getByText(/候选家族|暂定家族|已确认家族|存在争议/).first()).toBeVisible();

    await cards.first().click();
    await page.waitForURL(/\/franchises\/[^/]+$/);
    await waitForReady(page);
    await expectNoErrorState(page);

    // 家族内按 Series 分组，且 Series 可点击
    const seriesLinks = page.locator('a[href^="/series/"]');
    await expect(seriesLinks.first()).toBeVisible();
    const href = await seriesLinks.first().getAttribute('href');
    expect(href).toMatch(/^\/series\//);
    await seriesLinks.first().click();
    await page.waitForURL(/\/series\/[^/]+$/);
    await waitForReady(page);
    await expectNoErrorState(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('单成员 Series：默认隐藏，切换后可见且可进入详情', async ({ page }) => {
    const response = await page.request.get('/api/series?includeSingletons=1&limit=1000');
    const payload = await response.json();
    const singletons = payload.series.filter(
      (entry: { memberCount: number }) => entry.memberCount === 1,
    );
    test.skip(singletons.length === 0, '当前数据库没有单成员系列');

    await gotoAndWait(page, '/series');
    // 默认不出现单成员（列表数据到达后卡片数应等于多成员数量）
    const defaultCards = payload.series.filter(
      (entry: { memberCount: number }) => entry.memberCount >= 2,
    ).length;
    await expect(page.locator('a[href^="/series/"]')).toHaveCount(defaultCards);

    await page.getByRole('button', { name: '包含单成员' }).click();
    await expect
      .poll(async () => page.locator('a[href^="/series/"]').count())
      .toBeGreaterThan(defaultCards);

    // 从 API 直接打开一个单成员 Series 详情
    await gotoAndWait(page, `/series/${encodeURIComponent(singletons[0].key)}`);
    await waitForReady(page);
    await expectNoErrorState(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('Title Review：确认当前名称 → 人工确认持久化 → 恢复自动解析', async ({ page }) => {
    await gotoAndWait(page, '/series/sr_18');
    await waitForReady(page);
    await expectNoErrorState(page);

    const heading = page.getByRole('heading', { level: 1 });
    const originalTitle = (await heading.textContent())?.trim() ?? '';
    expect(originalTitle.length).toBeGreaterThan(0);

    // 若上一次运行留下人工确认，先恢复，保证用例可重复执行
    const resetButton = page.getByRole('button', { name: '恢复自动解析' });
    if ((await resetButton.count()) > 0) {
      await resetButton.click();
      await expect(page.getByRole('button', { name: '确认当前名称' })).toBeVisible();
    }

    await page.getByRole('button', { name: '确认当前名称' }).click();
    await expect(page.getByRole('button', { name: '恢复自动解析' })).toBeVisible();
    await expect(heading).toContainText(originalTitle);

    // 持久化：刷新后依然是人工确认
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: '恢复自动解析' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(originalTitle);

    // 可回退：恢复自动解析后回到自动结果（保持真实库不被本用例改写）
    await page.getByRole('button', { name: '恢复自动解析' }).click();
    await expect(page.getByRole('button', { name: '确认当前名称' })).toBeVisible();
    await expect(page.getByRole('button', { name: '恢复自动解析' })).toHaveCount(0);
  });
});
