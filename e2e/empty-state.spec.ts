import { expect, test } from '@playwright/test';
import { expectNoErrorState, gotoAndWait } from './helpers.js';

/**
 * 空数据库（首次使用）的界面验证。
 *
 * 默认跳过，需要显式指定一个空数据目录后才运行，例如：
 *
 *   BANGUMI_DATA_DIR=.verify-empty PORT=8799 pnpm start
 *   E2E_EMPTY_DATA=1 E2E_BASE_URL=http://127.0.0.1:8799 pnpm exec playwright test e2e/empty-state.spec.ts
 */
test.skip(!process.env.E2E_EMPTY_DATA, '需要 E2E_EMPTY_DATA=1 并指向一个空数据目录');

test.describe('首次使用（空数据库）', () => {
  test('仪表盘给出引导而不是空图表', async ({ page }) => {
    await gotoAndWait(page, '/');
    await expectNoErrorState(page);
    await expect(page.getByText('开始建立你的本地动画数据库')).toBeVisible();
    await expect(page.getByRole('button', { name: '配置 Bangumi 账号' })).toBeVisible();
    await expect(page.getByText('还没有配置 Bangumi 用户名')).toBeVisible();
  });

  test('收藏库提示先同步数据', async ({ page }) => {
    await gotoAndWait(page, '/library');
    await expectNoErrorState(page);
    await expect(page.getByText('开始建立你的本地动画数据库')).toBeVisible();
  });

  test('设置页在空数据下仍可正常使用', async ({ page }) => {
    await gotoAndWait(page, '/settings');
    await expectNoErrorState(page);
    await expect(page.getByText('还没有同步记录。')).toBeVisible();
    await expect(page.getByText('还没有备份文件。')).toBeVisible();
  });

  test('同步按钮在未配置用户名时给出明确提示', async ({ page }) => {
    await gotoAndWait(page, '/');
    await page.getByRole('button', { name: /同步/ }).first().click();
    await expect(page.getByText('Bangumi 数据同步')).toBeVisible();
    await page.getByRole('button', { name: '增量同步' }).click();
    await expect(page.getByText(/尚未配置 Bangumi 用户名/).first()).toBeVisible();
  });
});
