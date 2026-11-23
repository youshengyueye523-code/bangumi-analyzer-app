import { expect, test } from '@playwright/test';
import { expectNoErrorState, gotoAndWait } from './helpers.js';

test.describe('较窄窗口下的布局', () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test('侧边栏收起后可通过抽屉导航', async ({ page }) => {
    await gotoAndWait(page, '/');
    await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible();
    await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByRole('link', { name: '收藏库', exact: true }).click();
    await expect(page).toHaveURL(/\/library/);
    await expectNoErrorState(page);
  });

  test('仪表盘与收藏库在窄窗口不出现横向溢出', async ({ page }) => {
    for (const path of ['/', '/library', '/analysis']) {
      await gotoAndWait(page, path);
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      });
      expect(overflow, `${path} 出现横向滚动`).toBeLessThanOrEqual(2);
    }
  });
});

test.describe('移动端尺寸', () => {
  test.use({ viewport: { width: 420, height: 780 } });

  test('手机宽度下核心页面可用', async ({ page }) => {
    await gotoAndWait(page, '/');
    await expect(page.getByText('收藏总量')).toBeVisible();

    await gotoAndWait(page, '/library');
    await expect(page.locator('article').first()).toBeVisible();
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(2);
  });
});

/**
 * 全站断点扫描：在多个宽度下渲染所有主要页面，
 * 断言没有横向溢出、没有按钮文字被压到不可点击的尺寸。
 * 这条用例是「渲染正确性」的守门人，新增页面时请把它加进 ROUTES。
 */
const ROUTES = [
  ['仪表盘', '/'],
  ['收藏库', '/library'],
  ['作品详情', null], // 运行时取第一部收藏
  ['统计分析', '/analysis'],
  ['系列 / IP', '/series'],
  ['我的画像', '/profile'],
  ['个人资料', '/me'],
  ['设置', '/settings'],
] as const;

const WIDTHS = [1280, 900, 420, 375];

test.describe('多断点渲染检查', () => {
  test('主要页面在 1280 / 900 / 420 / 375 下无横向溢出', async ({ page }) => {
    test.setTimeout(180_000);
    const list = await (await page.request.get('/api/subjects?limit=1&sort=updated')).json();
    const firstId = list.items?.[0]?.id as number | undefined;

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const [label, path] of ROUTES) {
        const target = path ?? (firstId ? `/subjects/${firstId}` : null);
        if (!target) continue;
        await gotoAndWait(page, target);
        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          return doc.scrollWidth - doc.clientWidth;
        });
        expect(overflow, `${label} 在 ${width}px 出现横向滚动`).toBeLessThanOrEqual(2);
      }
    }
  });

  test('窄窗口下弹窗与下拉不超出视口', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 780 });
    // 高级筛选面板（收藏库最复杂的浮层）
    await gotoAndWait(page, '/library');
    await page.getByRole('button', { name: /高级筛选/ }).click();
    await page.waitForTimeout(400);
    const panelOverflow = await page.evaluate(() => {
      const panel = document.querySelector('[data-radix-popper-content-wrapper]');
      if (!panel) return -1;
      const rect = panel.getBoundingClientRect();
      return Math.max(0, Math.round(rect.right - document.documentElement.clientWidth));
    });
    expect(panelOverflow).toBeLessThanOrEqual(1);

    // 阶段快照弹窗（Dialog 在手机宽度下必须完整可见）
    await gotoAndWait(page, '/profile');
    const saveStage = page.getByRole('button', { name: '保存当前阶段' });
    if ((await saveStage.count()) > 0) {
      await saveStage.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      const dialogOverflow = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return -1;
        const rect = dialog.getBoundingClientRect();
        return Math.round(Math.max(rect.right - window.innerWidth, -rect.left));
      });
      expect(dialogOverflow).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
    }
  });

  test('收藏库工具条在窄窗口可横向滚动且按钮完整可点', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 780 });
    await gotoAndWait(page, '/library');
    const filterButton = page.getByRole('button', { name: /高级筛选/ });
    await expect(filterButton).toBeVisible();
    const box = await filterButton.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(60);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(376);
  });
});
