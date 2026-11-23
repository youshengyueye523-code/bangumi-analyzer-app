import { test } from '@playwright/test';
import { gotoAndWait } from './helpers.js';

/**
 * 视觉走查：把主要页面按深色 / 浅色两种主题整页截图，
 * 便于人工确认排版、留白与图表风格（输出到 test-results/screenshots）。
 */
const PAGES: Array<{ name: string; path: string; fullPage?: boolean }> = [
  { name: 'dashboard', path: '/' },
  { name: 'library', path: '/library' },
  { name: 'library-list', path: '/library?status=2&sort=rate&order=desc' },
  { name: 'analysis-timeline', path: '/analysis' },
  { name: 'analysis-studio', path: '/analysis?tab=studio' },
  { name: 'series', path: '/series' },
  { name: 'profile', path: '/profile' },
  { name: 'me', path: '/me' },
  { name: 'settings', path: '/settings' },
];

for (const theme of ['dark', 'light'] as const) {
  test(`截图（${theme}）`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      window.localStorage.setItem('bangumi-analyzer-theme', value);
    }, theme);

    for (const target of PAGES) {
      await gotoAndWait(page, target.path);
      // 触发懒加载封面：整页截图前先滚动一遍
      await page.evaluate(async () => {
        const step = window.innerHeight;
        for (let offset = 0; offset < document.body.scrollHeight; offset += step) {
          window.scrollTo(0, offset);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(900);
      await page.screenshot({
        path: `test-results/screenshots/${theme}-${target.name}.png`,
        fullPage: target.fullPage ?? true,
      });
    }
  });
}

test('截图：作品详情页', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bangumi-analyzer-theme', 'dark');
  });
  await gotoAndWait(page, '/library');
  await page.locator('article a').first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/screenshots/dark-subject-detail.png', fullPage: true });
});

test('截图：高级筛选面板（标签完整性 + 反向追溯）', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bangumi-analyzer-theme', 'dark');
  });
  await gotoAndWait(page, '/library');
  await page.getByRole('button', { name: /高级筛选/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/screenshots/dark-filter-panel.png' });
  // 标签区块在面板下方，滚动后单独截一张
  const tags = page.getByText('当前结果的标签（反向追溯）');
  await tags.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/screenshots/dark-filter-tags.png' });
});

test('截图：画像页（AI 未配置时的完整统计画像）', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bangumi-analyzer-theme', 'dark');
  });
  await gotoAndWait(page, '/profile');
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/screenshots/dark-profile-full.png', fullPage: true });
});

test('截图：制作人员反向检索 + 来源作品上下文', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bangumi-analyzer-theme', 'dark');
  });
  await gotoAndWait(page, '/library');
  await page.locator('article a').first().click();
  await page.waitForTimeout(800);

  const staffChip = page.locator('a[href^="/library?"]').first();
  await staffChip.click();
  await page.waitForTimeout(900);
  await page.screenshot({
    path: 'test-results/screenshots/dark-staff-context.png',
    fullPage: false,
  });

  // 展开筛选面板，截取人员检索与反向追溯区块
  await page.getByRole('button', { name: /高级筛选/ }).click();
  await page.waitForTimeout(700);
  await page.getByText('制作人员 / 公司').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screenshots/dark-staff-search.png' });
});

test('截图：主搜索栏全局搜索下拉', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bangumi-analyzer-theme', 'dark');
  });
  await gotoAndWait(page, '/library');
  const searchBox = page.getByRole('searchbox', { name: /搜索作品 \/ 标签/ });
  await searchBox.fill('黄段子');
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/screenshots/dark-search-dropdown.png' });

  // 回车后的全局搜索结果（含命中原因标注）
  await searchBox.press('Enter');
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/screenshots/dark-search-results.png', fullPage: false });
});

test('截图：系列详情页（观看状态按我的收藏条目统计）', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bangumi-analyzer-theme', 'dark');
  });
  const list = await (await page.request.get('/api/series?limit=300')).json();
  const mixed = list.series.find(
    (item: { statusCounts: Record<string, number> }) =>
      item.statusCounts['2'] > 0 && Number(item.statusCounts['1'] ?? 0) > 0,
  );
  if (!mixed) return;
  await gotoAndWait(page, `/series/${encodeURIComponent(mixed.key)}`);
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let offset = 0; offset < document.body.scrollHeight; offset += step) {
      window.scrollTo(0, offset);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/screenshots/dark-series-detail.png', fullPage: true });
});

test('截图：设置分区与个人资料', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bangumi-analyzer-theme', 'dark');
  });
  for (const tab of ['bangumi', 'ai', 'appearance', 'data', 'about'] as const) {
    await gotoAndWait(page, `/settings?tab=${tab}`);
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `test-results/screenshots/dark-settings-${tab}.png`,
      fullPage: true,
    });
  }
  await gotoAndWait(page, '/me');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/screenshots/dark-me.png', fullPage: true });
});

test('截图：窄窗口（420px）关键页面', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('bangumi-analyzer-theme', 'dark');
  });
  await page.setViewportSize({ width: 420, height: 900 });
  for (const [name, path] of [
    ['dashboard', '/'],
    ['library', '/library'],
    ['me', '/me'],
    ['settings', '/settings?tab=bangumi'],
    ['series', '/series'],
  ] as const) {
    await gotoAndWait(page, path);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/screenshots/mobile-${name}.png`, fullPage: false });
  }
});
