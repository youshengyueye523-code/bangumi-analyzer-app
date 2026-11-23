import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.8.2：全局 Detail Navigation Scroll Policy。
 *
 * 关键点：必须用「真实用户路径」验证 —— 先把来源页滚到中段，再点击
 * **当前视口内已经可见**的链接（locator.click 会自动把元素滚入视口，会掩盖问题，
 * 因此这里用页面内 DOM 点击）。
 */

/** 新进入的详情必须从顶部开始：身份 / 标题区域在首屏可见且不被 sticky header 遮挡。 */
async function expectDetailAtTop(page: Page, label: string): Promise<void> {
  await waitForReady(page);
  // 等待「身份元素已进入首屏顶部」这一最终状态（策略有 0 / rAF / 160ms 三次校正）
  await page.waitForFunction(
    () => {
      const header = document.querySelector('header');
      const identity = document.querySelector('h1') ?? document.querySelector('.card-surface');
      if (!header || !identity) return false;
      const rect = identity.getBoundingClientRect();
      return (
        rect.top >= header.getBoundingClientRect().bottom - 1 &&
        rect.top < window.innerHeight * 0.5
      );
    },
    undefined,
    { timeout: 8000 },
  );
  const metrics = await page.evaluate(() => {
    const header = document.querySelector('header');
    const h1 = document.querySelector('h1');
    const identity = h1 ?? document.querySelector('.card-surface');
    const headerRect = header ? header.getBoundingClientRect() : null;
    const rect = identity ? identity.getBoundingClientRect() : null;
    return {
      scrollY: Math.round(window.scrollY),
      identityTop: rect ? Math.round(rect.top) : null,
      headerBottom: headerRect ? Math.round(headerRect.y + headerRect.height) : null,
      viewport: window.innerHeight,
    };
  });
  expect(metrics.identityTop, `${label}: 首屏身份元素必须存在`).not.toBeNull();
  expect(metrics.identityTop!, `${label}: 身份元素不得被页头遮挡`).toBeGreaterThanOrEqual(
    metrics.headerBottom! - 1,
  );
  expect(metrics.identityTop!, `${label}: 身份元素必须在首屏上半部`).toBeLessThan(
    metrics.viewport * 0.5,
  );
  expect(metrics.scrollY, `${label}: 新详情不应保留来源页滚动高度`).toBeLessThan(200);
}

/** 滚到指定比例后，点击当前视口内可见的链接（真实用户点击）。 */
async function scrollAndClickVisible(
  page: Page,
  selector: string,
  ratios: number[],
): Promise<{ href: string; sourceScrollY: number }> {
  const clickVisible = async (): Promise<string | null> =>
    page.evaluate((css) => {
      const links = Array.from(document.querySelectorAll(css));
      const target = links.find((element) => {
        const rect = element.getBoundingClientRect();
        const center = rect.top + rect.height / 2;
        const header = document.querySelector('header');
        const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
        return center > headerBottom + 40 && center < window.innerHeight - 40;
      });
      if (!target) return null;
      const value = target.getAttribute('href');
      (target as HTMLElement).click();
      return value;
    }, selector);

  for (const ratio of ratios) {
    const sourceScrollY = await page.evaluate((value) => {
      window.scrollTo(0, Math.round(document.documentElement.scrollHeight * value));
      return Math.round(window.scrollY);
    }, ratio);
    await page.waitForTimeout(200);
    const href = await clickVisible();
    if (href) return { href, sourceScrollY };
  }

  // 兜底：把第一个匹配链接滚到视口中央再点击（模拟用户滚动到该入口）
  const href = await page.evaluate((css) => {
    const element = document.querySelector(css);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, Math.round(rect.top + window.scrollY - window.innerHeight / 2)));
    return element.getAttribute('href');
  }, selector);
  if (!href) throw new Error(`页面不存在链接：${selector}`);
  await page.waitForTimeout(250);
  const sourceScrollY = await page.evaluate(() => Math.round(window.scrollY));
  await page.evaluate((css) => {
    const element = document.querySelector(css);
    if (element) (element as HTMLElement).click();
  }, selector);
  return { href, sourceScrollY };
}

async function firstSeriesWithMembers(
  request: APIRequestContext,
  minMembers: number,
): Promise<{ key: string; memberCount: number }> {
  const response = await request.get('/api/series?limit=1000&includeSingletons=1');
  const rows = (await response.json()).series as Array<{ key: string; memberCount: number }>;
  const found = rows.find((row) => row.memberCount >= minMembers);
  expect(found, `需要至少 ${minMembers} 个成员的 Series`).toBeTruthy();
  return found!;
}

async function firstFranchiseWithSeries(
  request: APIRequestContext,
): Promise<{ key: string; seriesCount: number }> {
  const response = await request.get('/api/franchises?limit=500');
  const rows = (await response.json()).franchises as Array<{ key: string; seriesCount: number }>;
  const found = rows.find((row) => row.seriesCount >= 2);
  expect(found, '需要至少包含 2 个系列的 Franchise').toBeTruthy();
  return found!;
}

test.describe('v1.8.2 全局 Detail 导航滚动策略（真实数据）', () => {
  test('Library → Subject：来源页滚到中段，详情仍从顶部开始', async ({ page }) => {
    await gotoAndWait(page, '/library');
    await expectNoErrorState(page);
    const click = await scrollAndClickVisible(page, 'a[href^="/subjects/"]', [0.45, 0.3, 0.6, 0.7]);
    expect(click.href).toContain('/subjects/');
    expect(click.sourceScrollY).toBeGreaterThan(400);
    await page.waitForURL(/\/subjects\/\d+/);
    await expectDetailAtTop(page, 'Library → Subject');
  });

  test('Series → Subject（成员）与 Series → Franchise 互跳都在顶部', async ({ page, request }) => {
    const series = await firstSeriesWithMembers(request, 5);
    await gotoAndWait(page, `/series/${encodeURIComponent(series.key)}`);
    await expectNoErrorState(page);

    // 成员入口：深滚动后点击成员
    const memberClick = await scrollAndClickVisible(page, 'a[href^="/subjects/"]', [0.4, 0.55, 0.7, 0.25]);
    expect(memberClick.sourceScrollY).toBeGreaterThan(300);
    await page.waitForURL(/\/subjects\/\d+/);
    await expectDetailAtTop(page, 'Series → Subject（成员）');

    // 家族入口：必须选一个「属于某个 Franchise」的成员 Series
    const franchise = await firstFranchiseWithSeries(request);
    const franchiseDetail = await (
      await request.get(`/api/franchises/${encodeURIComponent(franchise.key)}`)
    ).json();
    const memberSeriesKey = (franchiseDetail.series as Array<{ key: string }>)[0]?.key;
    expect(memberSeriesKey, 'Franchise 必须有成员 Series').toBeTruthy();
    await gotoAndWait(page, `/series/${encodeURIComponent(memberSeriesKey!)}`);
    await expectNoErrorState(page);
    const franchiseClick = await scrollAndClickVisible(page, 'a[href^="/franchises/"]', [0.15, 0.05, 0.3]);
    await page.waitForURL(/\/franchises\//);
    await expectDetailAtTop(page, 'Series → Franchise');

    // Franchise → Series：滚到系列卡区域再点击
    const seriesClick = await scrollAndClickVisible(page, 'a[href^="/series/"]', [0.5, 0.65, 0.8]);
    await page.waitForURL(/\/series\//);
    await expectDetailAtTop(page, 'Franchise → Series');
    expect(franchiseClick.href).toContain('/franchises/');
    expect(seriesClick.href).toContain('/series/');
  });

  test('Subject → Subject（含缓存热路径）都不继承上一详情滚动高度', async ({ page }) => {
    await gotoAndWait(page, '/subjects/1671');
    await expectNoErrorState(page);
    const first = await scrollAndClickVisible(page, 'a[href^="/subjects/"]', [0.5, 0.65, 0.35]);
    await page.waitForURL(/\/subjects\//);
    await expectDetailAtTop(page, 'Subject → Subject');

    // 回到上一个详情（缓存热），滚到中段后再次进入同一个目标详情
    await page.goBack();
    await page.waitForTimeout(600);
    await gotoAndWait(page, '/subjects/1671');
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(250);
    const targetPath = new URL(first.href, page.url()).pathname;
    const clicked = await page.evaluate((path) => {
      const link = document.querySelector(`a[href="${path}"]`);
      if (!link) return false;
      (link as HTMLElement).click();
      return true;
    }, targetPath);
    expect(clicked, '缓存热路径必须能找到目标链接').toBe(true);
    await page.waitForURL((url) => url.pathname === targetPath);
    await expectDetailAtTop(page, 'Subject → Subject（缓存热）');
  });

  test('统计入口（Dashboard / Analysis）→ Subject：从页面中段进入也在顶部', async ({ page }) => {
    await gotoAndWait(page, '/analysis?tab=bias');
    await expectNoErrorState(page);
    const analysisClick = await scrollAndClickVisible(page, 'a[href^="/subjects/"]', [0.5, 0.65, 0.8, 0.35]);
    await page.waitForURL(/\/subjects\/\d+/);
    await expectDetailAtTop(page, 'Analysis → Subject');
    expect(analysisClick.href).toContain('/subjects/');

    await gotoAndWait(page, '/');
    const dashboardClick = await scrollAndClickVisible(page, 'a[href^="/subjects/"]', [0.6, 0.75, 0.45, 0.85, 0.3]);
    await page.waitForURL(/\/subjects\/\d+/);
    await expectDetailAtTop(page, 'Dashboard → Subject');
    expect(dashboardClick.href).toContain('/subjects/');
  });

  test('全局搜索 → Subject：从搜索结果进入也在顶部', async ({ page, request }) => {
    const subjects = await (await request.get('/api/subjects?pageSize=5')).json();
    const probe = (subjects.items as Array<{ id: number; nameCn: string; name: string }>)[0];
    test.skip(!probe, '当前数据没有可搜索的作品');
    const keyword = (probe!.nameCn || probe!.name).slice(0, 4);

    await gotoAndWait(page, '/library');
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(250);
    const input = page.getByPlaceholder(/搜索作品/);
    await input.click();
    await input.fill(keyword);
    await page.waitForTimeout(600);
    // 作品行带有 `#<id>` meta，可作为唯一标识（避免命中「查看全部结果」按钮）
    const workResult = page.locator('button', { hasText: `#${probe!.id}` }).first();
    await expect(workResult).toBeVisible();
    await workResult.click();
    await page.waitForURL((url) => url.pathname === `/subjects/${probe!.id}`);
    await expectDetailAtTop(page, 'GlobalSearch → Subject');
  });

  test('Tag 反向追溯（/library?tags=）→ Subject：仍然是顶部', async ({ page, request }) => {
    const subjects = await (await request.get('/api/subjects?pageSize=5')).json();
    const tag = (subjects.items as Array<{ tags: string[] }>)[0]?.tags?.[0];
    test.skip(!tag, '当前数据没有可用于标签追溯的 tag');

    await gotoAndWait(page, `/library?tags=${encodeURIComponent(tag!)}`);
    await expectNoErrorState(page);
    const click = await scrollAndClickVisible(page, 'a[href^="/subjects/"]', [0.4, 0.55, 0.25]);
    await page.waitForURL(/\/subjects\/\d+/);
    await expectDetailAtTop(page, 'Tag → Subject');
    expect(click.href).toContain('/subjects/');
  });

  test('back / forward：forward 回到详情必须重新在顶部（列表恢复不受影响）', async ({ page }) => {
    await gotoAndWait(page, '/library');
    const click = await scrollAndClickVisible(page, 'a[href^="/subjects/"]', [0.45, 0.6, 0.3]);
    await page.waitForURL(/\/subjects\/\d+/);
    await expectDetailAtTop(page, 'forward 前的详情');

    // 在详情内部往下滚，然后 back → 列表 → forward → 详情必须回到顶部
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(250);
    await page.goBack();
    await page.waitForTimeout(700);
    expect(page.url()).toContain('/library');
    await page.goForward();
    await page.waitForTimeout(700);
    await expectDetailAtTop(page, 'forward 回到详情');
    expect(click.href).toContain('/subjects/');
  });

  test('异步加载：慢 API 下新进入详情仍然从顶部开始', async ({ page }) => {
    await page.route('**/api/subjects/*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await gotoAndWait(page, '/library');
    const click = await scrollAndClickVisible(page, 'a[href^="/subjects/"]', [0.45, 0.6, 0.3]);
    await page.waitForURL(/\/subjects\/\d+/);
    await expectDetailAtTop(page, '异步加载的详情');
    expect(click.href).toContain('/subjects/');
  });

  test('显式 member anchor 不被顶部策略覆盖（v1.8.1 兼容）', async ({ page, request }) => {
    const series = await firstSeriesWithMembers(request, 3);
    const detail = await (
      await request.get(`/api/series/${encodeURIComponent(series.key)}`)
    ).json();
    const member = (detail.members as Array<{ subjectId: number; collected: boolean }>).find(
      (entry) => entry.collected,
    );
    test.skip(!member, '该系列没有可定位的收藏成员');

    await page.goto(`/series/${encodeURIComponent(series.key)}#member-${member!.subjectId}`, {
      waitUntil: 'domcontentloaded',
    });
    await waitForReady(page);
    const metrics = await page.evaluate((hash) => {
      const element = document.querySelector(hash);
      const header = document.querySelector('header');
      const rect = element ? element.getBoundingClientRect() : null;
      const headerRect = header ? header.getBoundingClientRect() : null;
      return {
        top: rect ? Math.round(rect.top) : null,
        headerBottom: headerRect ? Math.round(headerRect.y + headerRect.height) : null,
        scrollY: Math.round(window.scrollY),
        hash: window.location.hash,
      };
    }, `#member-${member!.subjectId}`);
    expect(metrics.hash).toBe(`#member-${member!.subjectId}`);
    expect(metrics.top, '成员锚点必须进入视口').not.toBeNull();
    expect(metrics.top!).toBeGreaterThanOrEqual(metrics.headerBottom! - 1);
    expect(metrics.scrollY, '锚点定位不应被强制拉回顶部').toBeGreaterThan(0);
  });
});
