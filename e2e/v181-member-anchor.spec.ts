import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.8.1：Entity 成员锚点定位（`#member-{subjectId}`）。
 *
 * 实测根因：sticky header 56px 覆盖 + 异步渲染后不重新定位。
 * 这里用真实几何验证「目标不被页头遮挡、确实进入视口」。
 */

interface SeriesRow {
  key: string;
  title: string;
  memberCount: number;
  collectedCount: number;
}

async function allSeries(request: APIRequestContext): Promise<SeriesRow[]> {
  const response = await request.get('/api/series?limit=1000&includeSingletons=1');
  expect(response.ok()).toBe(true);
  return (await response.json()).series as SeriesRow[];
}

interface SeriesWithSample {
  key: string;
  title: string;
  subjectId: number;
  ratedCount: number;
}

async function pickSeriesWithSample(
  request: APIRequestContext,
  predicate: (row: SeriesRow) => boolean,
): Promise<SeriesWithSample | null> {
  const candidates = (await allSeries(request)).filter(predicate).slice(0, 40);
  for (const row of candidates) {
    const response = await request.get(`/api/series/${encodeURIComponent(row.key)}`);
    if (!response.ok()) continue;
    const detail = await response.json();
    const rated = detail.analysis?.rating?.average?.ratedCount ?? 0;
    const sample = (detail.members ?? []).find(
      (member: { item?: { rate?: number } | null }) => member.item && (member.item.rate ?? 0) > 0,
    );
    if (sample) {
      return { key: row.key, title: row.title, subjectId: sample.subjectId, ratedCount: rated };
    }
  }
  return null;
}

interface AnchorGeometry {
  top: number;
  bottom: number;
  headerBottom: number;
  viewport: number;
}

async function anchorGeometry(page: Page): Promise<AnchorGeometry | null> {
  return page.evaluate(() => {
    const element = document.querySelector(window.location.hash);
    const header = document.querySelector('header');
    if (!element || !header) return null;
    const rect = element.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      headerBottom: headerRect.y + headerRect.height,
      viewport: window.innerHeight,
    };
  });
}

function expectFocused(geometry: AnchorGeometry | null, label: string): void {
  expect(geometry, `${label}: 目标元素必须存在`).toBeTruthy();
  const g = geometry!;
  // 不被 sticky header 遮挡
  expect(g.top, `${label}: 目标顶部不得被页头覆盖`).toBeGreaterThanOrEqual(g.headerBottom - 1);
  // 明确进入视口（不是"刚好在底部外面"）
  expect(g.top, `${label}: 目标应进入视口上半部`).toBeLessThan(g.viewport * 0.6);
  expect(g.bottom, `${label}: 目标高度有效`).toBeGreaterThan(g.top);
}

test.describe('v1.8.1 成员锚点定位（真实数据）', () => {
  test('评分样本点击：目标进入视口、避开页头，并有短暂高亮', async ({ page, request }) => {
    const target = await pickSeriesWithSample(request, (row) => /物语/.test(row.title));
    test.skip(!target, '当前数据没有可抽样的物语系列');

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error.message)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await gotoAndWait(page, `/series/${encodeURIComponent(target!.key)}`);
    await expectNoErrorState(page);

    const link = page.locator(`a[href="#member-${target!.subjectId}"]`).first();
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(new RegExp(`#member-${target!.subjectId}$`));
    // 轻量高亮（1.6s 内可见）
    await expect(page.locator(`#member-${target!.subjectId}`)).toHaveClass(/entity-member-focus/);
    expectFocused(await anchorGeometry(page), '样本点击');
    /*
     * 只过滤「资源 404」：隔离副本没有 data/covers 缓存，封面请求会 404；
     * 这里关心的是应用运行时错误（pageerror / 脚本异常）。
     */
    expect(errors.filter((text) => !text.startsWith('Failed to load resource'))).toEqual([]);
  });

  test('不同滚动位置下连续点击两个样本：每次定位都正确', async ({ page, request }) => {
    const target = await pickSeriesWithSample(
      request,
      (row) => row.memberCount >= 8 && row.collectedCount >= 3,
    );
    test.skip(!target || target.ratedCount < 2, '当前数据没有 ≥2 个评分样本的系列');

    await gotoAndWait(page, `/series/${encodeURIComponent(target!.key)}`);
    await expectNoErrorState(page);

    const sampleLinks = page.locator('a[href^="#member-"]');
    expect(await sampleLinks.count()).toBeGreaterThanOrEqual(2);

    await sampleLinks.nth(0).click();
    expectFocused(await anchorGeometry(page), '第一次点击');

    // 人为改变滚动位置（模拟用户在页面中段继续操作）
    await page.evaluate(() => window.scrollBy(0, -420));
    await sampleLinks.nth(1).click();
    expectFocused(await anchorGeometry(page), '滚动位置变化后的第二次点击');
  });

  test('直接带 hash 打开（API 延迟、成员晚于 fragment 定位渲染）', async ({ page, request }) => {
    const target = await pickSeriesWithSample(request, (row) => row.memberCount >= 5);
    test.skip(!target, '当前数据没有可抽样的系列');

    const delayMs = 1200;
    await page.route(`**/api/series/${encodeURIComponent(target!.key)}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.continue();
    });
    await page.goto(`/series/${encodeURIComponent(target!.key)}#member-${target!.subjectId}`, {
      waitUntil: 'domcontentloaded',
    });
    await waitForReady(page);

    await expect(page.locator(`#member-${target!.subjectId}`)).toHaveClass(/entity-member-focus/, {
      timeout: 10000,
    });
    expectFocused(await anchorGeometry(page), '直接 hash（延迟渲染）');
    expect(new URL(page.url()).hash).toBe(`#member-${target!.subjectId}`);
  });

  test('短 / 中 / 长 Series 都能正确定位', async ({ page, request }) => {
    const buckets: Array<[string, (row: SeriesRow) => boolean]> = [
      ['短 Series（1–2 成员）', (row) => row.memberCount <= 2],
      ['中 Series（3–20 成员）', (row) => row.memberCount >= 3 && row.memberCount <= 20],
      ['长 Series（≥60 成员）', (row) => row.memberCount >= 60],
    ];
    let checked = 0;
    for (const [label, predicate] of buckets) {
      const target = await pickSeriesWithSample(request, predicate);
      if (!target) continue;
      await gotoAndWait(page, `/series/${encodeURIComponent(target.key)}`);
      await expectNoErrorState(page);
      const link = page.locator(`a[href="#member-${target.subjectId}"]`).first();
      await link.click();
      expectFocused(await anchorGeometry(page), label);
      checked += 1;
    }
    expect(checked, '至少验证一个长度档位').toBeGreaterThan(0);
  });

  test('样本显示：value 与 sample 用 · 分隔', async ({ page, request }) => {
    const target = await pickSeriesWithSample(request, (row) => row.collectedCount >= 2);
    test.skip(!target, '当前数据没有可抽样的系列');

    await gotoAndWait(page, `/series/${encodeURIComponent(target!.key)}`);
    await expectNoErrorState(page);
    const line = page.getByText('我的平均分', { exact: true }).locator('..');
    await expect(line).toContainText(/·\s*(n=\d+|单样本|样本不足)/);
  });
});
