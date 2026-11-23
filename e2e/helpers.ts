import { expect, type Page } from '@playwright/test';

/** 等待页面结束加载态（骨架屏消失）。 */
export async function waitForReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 20_000 });
}

export async function gotoAndWait(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForReady(page);
}

/** 页面是否出现了错误提示（用于断言没有发生崩溃）。 */
export async function expectNoErrorState(page: Page): Promise<void> {
  const alerts = page.locator('[role="alert"]');
  const count = await alerts.count();
  if (count > 0) {
    const text = await alerts.first().innerText();
    throw new Error(`页面出现错误提示：${text}`);
  }
}
