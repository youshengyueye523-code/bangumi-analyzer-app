import { expect, test } from "@playwright/test";
import { gotoAndWait, waitForReady } from "./helpers.js";

/**
 * 二级选择（下拉）视觉一致性回归（v1.4.2.2）。
 *
 * 背景：二级选择原本用原生 <select>，其展开层由浏览器 / 系统绘制，
 * 不读取页面 CSS，因此在深色界面 + 浅色系统下会出现白底黑字的「黑白割裂」。
 * 现在统一改用 `SelectMenu`（Radix Dropdown + 设计 token）。
 *
 * 本用例验证四件事：
 *   1. 页面上不再有原生 <select>；
 *   2. 展开层来自统一组件（背景 = --surface、圆角 12px、选中标记）；
 *   3. 选项内容 / 顺序 / 默认值不变，选择后的行为与之前一致；
 *   4. 键盘可用、点击外部可关闭、不产生横向溢出。
 */

async function expectThemedMenu(page: import("@playwright/test").Page, label: string) {
  const menu = page.locator('[data-radix-popper-content-wrapper] [role="menu"]');
  await expect(menu).toBeVisible();
  const style = await menu.evaluate((el) => {
    const s = getComputedStyle(el);
    // 用 token 本身作为期望值，而不是复制一份颜色字面量
    const probe = document.createElement("div");
    /*
     * 浮层始终使用面板色（rgb(--surface-rgb)）。v1.5.0 起它带上一层玻璃材质，
     * 允许极轻微的通透，但不透明度必须保持在「几乎不透」的区间：
     * 背景板再透也不能把菜单内容透出去。这里只比较颜色通道，不要求 alpha 恰好为 1。
     */
    probe.style.backgroundColor = "rgb(var(--surface-rgb))";
    document.body.appendChild(probe);
    const expectedSurface = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { background: s.backgroundColor, radius: s.borderRadius, expectedSurface };
  });
  const numbers = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).map(Number);
  const [expectedRed, expectedGreen, expectedBlue] = numbers(style.expectedSurface);
  const [red, green, blue, alpha = 1] = numbers(style.background);
  // 展开层必须走设计 token（而不是系统绘制的白色列表）
  expect([red, green, blue], `${label} 展开层颜色`).toEqual([
    expectedRed,
    expectedGreen,
    expectedBlue,
  ]);
  // 并且必须保持足够不透明：背景板不能把浮层「透」出去
  expect(alpha, `${label} 展开层不透明度`).toBeGreaterThanOrEqual(0.9);
  expect(style.background, `${label} 不能是浏览器默认白底`).not.toBe("rgb(255, 255, 255)");
  expect(style.radius, `${label} 圆角`).toBe("12px");
  const item = await page
    .locator('[role="menuitem"]')
    .first()
    .evaluate((el) => {
      const probe = document.createElement("div");
      probe.style.color = "var(--text)";
      document.body.appendChild(probe);
      const expectedText = getComputedStyle(probe).color;
      probe.remove();
      return { color: getComputedStyle(el).color, expectedText };
    });
  expect(item.color, `${label} 选项文字色`).toBe(item.expectedText);
}

test.describe("二级选择视觉一致性", () => {
  // 用户报告的问题是深色界面下的割裂，这里显式使用深色主题
  test.use({ colorScheme: "dark" });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("bangumi-analyzer-theme", "dark");
    });
  });

  test("设置 → AI → 翻译并发数：统一组件、选项不变、保存行为不变", async ({ page }) => {
    const before = await (await page.request.get("/api/config")).json();
    try {
      await gotoAndWait(page, "/settings?tab=ai");
      // 页面里不应再有原生 select
      expect(await page.locator("select").count()).toBe(0);

      const trigger = page.getByRole("button", { name: "翻译并发数" });
      await expect(trigger).toBeVisible();
      await expect(trigger).toContainText(`${before.summaryConcurrency} 个并发`);

      await trigger.click();
      await expectThemedMenu(page, "翻译并发数");
      const labels = (await page.locator('[role="menuitem"]').allTextContents()).map((text) =>
        text.replace("✓", "").trim(),
      );
      expect(labels).toEqual(["1 个并发", "2 个并发", "3 个并发", "4 个并发", "6 个并发", "8 个并发"]);

      const target = before.summaryConcurrency === 4 ? 3 : 4;
      await page.getByRole("menuitem", { name: new RegExp(`${target} 个并发`) }).click();
      await expect(page.getByRole("button", { name: "翻译并发数" })).toContainText(`${target} 个并发`);
      // 行为与原生 select 一致：仍然写回配置
      await expect
        .poll(async () => (await (await page.request.get("/api/config")).json()).summaryConcurrency)
        .toBe(target);
    } finally {
      await page.request.put("/api/config", { data: { summaryConcurrency: before.summaryConcurrency } });
    }
  });

  test("系列 / IP → 按作品数：统一组件、排序行为不变", async ({ page }) => {
    await gotoAndWait(page, "/series");
    expect(await page.locator("select").count()).toBe(0);

    const trigger = page.getByRole("button", { name: "系列排序" });
    await expect(trigger).toContainText("按作品数");

    await trigger.click();
    await expectThemedMenu(page, "系列排序");
    const labels = (await page.locator('[role="menuitem"]').allTextContents()).map((text) =>
      text.replace("✓", "").trim(),
    );
    expect(labels).toEqual(["按作品数", "按平均评分", "按起始年份", "按名称"]);

    await page.getByRole("menuitem", { name: "按平均评分" }).click();
    // 仍走既有的 URL 参数
    await expect(page).toHaveURL(/sort=rate/);
    await waitForReady(page);
    await expect(page.getByRole("button", { name: "系列排序" })).toContainText("按平均评分");
  });

  test("收藏库：每页数量与观看进度也使用统一二级选择", async ({ page }) => {
    await gotoAndWait(page, "/library");
    expect(await page.locator("select").count()).toBe(0);

    const pageSize = page.getByRole("button", { name: "每页数量" });
    await pageSize.scrollIntoViewIfNeeded();
    await expect(pageSize).toContainText("每页 48");
    await pageSize.click();
    await expectThemedMenu(page, "每页数量");
    await page.getByRole("menuitem", { name: "每页 96" }).click();
    await expect(page).toHaveURL(/pageSize=96/);
    await waitForReady(page);
    await expect(page.getByRole("button", { name: "每页数量" })).toContainText("每页 96");

    // 高级筛选面板内的「观看进度」
    await page.getByRole("button", { name: /高级筛选/ }).click();
    const progress = page.getByRole("button", { name: "观看进度" });
    await expect(progress).toBeVisible();
    await progress.click();
    await expectThemedMenu(page, "观看进度");
    const options = await page.locator('[role="menuitem"]').allTextContents();
    expect(options.length).toBeGreaterThan(3);
    await page.locator('[role="menuitem"]').nth(1).click();
    await expect(page).toHaveURL(/progress=/);
  });

  test("键盘可用 / 点击外部关闭 / 不产生横向溢出", async ({ page }) => {
    await gotoAndWait(page, "/series");
    const trigger = page.getByRole("button", { name: "系列排序" });
    await trigger.focus();
    // 键盘打开
    await page.keyboard.press("Enter");
    await expect(page.locator('[role="menu"]')).toBeVisible();
    // Esc 关闭
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="menu"]')).toHaveCount(0);

    // 点击外部关闭
    await trigger.click();
    await expect(page.locator('[role="menu"]')).toBeVisible();
    await page.mouse.click(10, 400);
    await expect(page.locator('[role="menu"]')).toHaveCount(0);

    // 展开状态下不产生横向溢出
    await trigger.click();
    await expect(page.locator('[role="menu"]')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);

    // 窄屏同样不溢出
    for (const width of [900, 480, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const narrow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(narrow, `${width}px 横向溢出`).toBeLessThanOrEqual(2);
    }
  });
});
