import { expect, test, type Page } from '@playwright/test';

async function expectPage(page: Page, number: number) {
  await expect(page.getByText(new RegExp(`第 ${number} / 4 页`))).toBeVisible();
  await expect(page.locator('main a[href^="/subjects/"]').first()).toContainText(`分页夹具 ${String((number - 1) * 24 + 1).padStart(3, '0')}`);
}

async function scrollBottom(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);
}

async function expectListTop(page: Page) {
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(100);
  const rect = await page.locator('main a[href^="/subjects/"]').first().boundingBox();
  expect(rect?.y).toBeGreaterThan(56);
  expect(rect?.y).toBeLessThan(400);
}

test.beforeAll(async ({ request }) => {
  expect((await (await request.get('/api/health')).json()).collections).toBe(0);
  const ids = Array.from({ length: 96 }, (_, index) => 910001 + index);
  const imported = await request.post('/api/data/import', { data: {
    format: 'bangumi-analyzer-export', version: 1,
    subjects: ids.map((id, index) => ({ id, name: `分页夹具 ${String(index + 1).padStart(3, '0')}`, eps: 12, format: 'TV' })),
    collections: ids.map((id) => ({ subject_id: id, type: 2, rate: 8 })),
  } });
  expect(imported.ok()).toBe(true);
  expect((await request.put('/api/config', { data: { onboardingSeen: true } })).ok()).toBe(true);
});

test('长收藏列表主动翻页回顶；详情返回及 POP 保留滚动恢复', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('bangumi-analyzer-library-view', 'list'));
  await page.goto('/library?pageSize=24&sort=title&order=asc');
  await expectPage(page, 1);
  await scrollBottom(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expectPage(page, 2);
  await expectListTop(page);
  await page.screenshot({ path: testInfo.outputPath('next-page-top.png') });

  await scrollBottom(page);
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expectPage(page, 1);
  await expectListTop(page);
  for (const number of [2, 3]) {
    await scrollBottom(page);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expectPage(page, number);
    await expectListTop(page);
  }

  // 从实际可见列表行进入详情，避免 locator 自动滚入视口掩盖恢复位置。
  await page.evaluate(() => window.scrollTo(0, 950));
  const beforeDetail = await page.evaluate(() => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>('main a[href^="/subjects/"]')]
      .find((entry) => { const rect = entry.getBoundingClientRect(); return rect.top > 80 && rect.bottom < innerHeight - 80; });
    if (!link) throw new Error('fixture requires a visible subject link');
    const position = window.scrollY;
    link.click();
    return position;
  });
  await page.waitForURL(/\/subjects\/\d+/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(100);
  await page.goBack();
  await expectPage(page, 3);
  await expect.poll(() => page.evaluate((expected) => Math.abs(window.scrollY - expected), beforeDetail)).toBeLessThan(80);
  await page.goForward();
  await page.waitForURL(/\/subjects\/\d+/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(100);
  await page.goBack();
  await expectPage(page, 3);

  await page.goBack();
  await expectPage(page, 2);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);
  await page.goForward();
  await expectPage(page, 3);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);

  // 现有指定页入口是 URL，没有新增页码按钮。
  await page.goto('/library?page=4&pageSize=24&sort=title&order=asc');
  await expectPage(page, 4);
  await expectListTop(page);
  expect(errors).toEqual([]);
});

test('慢请求只在目标页提交后回顶，途中历史返回取消回顶意图', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bangumi-analyzer-library-view', 'list'));
  await page.goto('/library?pageSize=24&sort=title&order=asc');
  await expectPage(page, 1);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/api/subjects?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('page') === '2') {
      started();
      await pending;
    }
    await route.continue();
  });
  await scrollBottom(page);
  const previous = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', { name: '下一页' }).click();
  await requested;
  await expect(page.getByText(/正在更新/)).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(previous);
  release();
  await expectPage(page, 2);
  await expectListTop(page);
  await page.unroute('**/api/subjects?*');

  // 请求第三页时立刻 POP，迟到响应不得把恢复的第二页拉到顶部。
  let releaseThird!: () => void;
  let thirdStarted!: () => void;
  const thirdPending = new Promise<void>((resolve) => { releaseThird = resolve; });
  const thirdRequested = new Promise<void>((resolve) => { thirdStarted = resolve; });
  await page.route('**/api/subjects?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('page') === '3') {
      thirdStarted();
      await thirdPending;
    }
    await route.continue();
  });
  await scrollBottom(page);
  const saved = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', { name: '下一页' }).click();
  await thirdRequested;
  await page.goBack();
  releaseThird();
  await expectPage(page, 2);
  await expect.poll(() => page.evaluate((expected) => Math.abs(window.scrollY - expected), saved)).toBeLessThan(80);
  await page.goForward();
  await expectPage(page, 3);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);
});

test('卡片视图保留筛选/排序/每页数量上下文，主动分页仍回顶', async ({ page }) => {
  await page.goto('/library?pageSize=48&sort=title&order=desc&status=2');
  await expect(page.getByText(/第 1 \/ 2 页/)).toBeVisible();
  await scrollBottom(page);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText(/第 2 \/ 2 页/)).toBeVisible();
  await expectListTop(page);
  await expect(page).toHaveURL(/status=2/);
  await expect(page).toHaveURL(/sort=title/);
  await expect(page).toHaveURL(/order=desc/);
});
