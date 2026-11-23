import { expect, test } from "@playwright/test";
import { gotoAndWait } from "./helpers.js";

/**
 * 简介双语展示（v1.4.0）。
 *
 * 数据前提由服务端保证：
 *   - 官方中文简介 → 直接显示，标注来源，不调用 AI；
 *   - 日文简介     → 中文（AI 翻译）+ 日文原文（默认折叠）；
 *   - 其他语言     → 保留原文并说明暂不支持；
 *   - 无简介       → 暂无简介。
 */
test.describe("作品简介双语", () => {
  test("已翻译的日文作品：中文优先、原文可折叠、标注来源", async ({ page }) => {
    // 找一个「日文原文 + 已有 AI 翻译」的真实条目
    const status = await (await page.request.get("/api/translate/summary")).json();
    test.skip(status.totals.translated === 0, "当前数据库还没有完成翻译的日文条目");

    const list = await (await page.request.get("/api/subjects?limit=200&pageSize=200")).json();
    let target: { id: number; nameCn: string; name: string } | null = null;
    for (const item of list.items as Array<{ id: number; nameCn: string; name: string }>) {
      const detail = await (await page.request.get(`/api/subjects/${item.id}`)).json();
      if (detail.summaryState?.chineseSource === "ai" && detail.summaryState?.chinese) {
        target = item;
        break;
      }
    }
    expect(target, "应当存在一条已翻译的日文条目").not.toBeNull();

    const detail = await (await page.request.get(`/api/subjects/${target!.id}`)).json();
    await gotoAndWait(page, `/subjects/${target!.id}`);

    // 中文简介默认展开，并明确标注为 AI 翻译
    await expect(page.getByText("中文简介", { exact: true })).toBeVisible();
    await expect(page.getByText("AI 翻译").first()).toBeVisible();
    await expect(page.getByText(detail.summaryState.chinese.slice(0, 24), { exact: false }).first()).toBeVisible();

    // 日文原文默认折叠；展开后不影响中文
    const originalToggle = page.getByRole("button", { name: /Bangumi 原文/ });
    await expect(originalToggle).toHaveAttribute("aria-expanded", "false");
    await originalToggle.click();
    await expect(originalToggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/Bangumi 原文（日文）/)).toBeVisible();
    await expect(page.getByText(detail.summaryState.chinese.slice(0, 24), { exact: false }).first()).toBeVisible();

    // 展开状态必须独立：再次点击只折叠原文
    await originalToggle.click();
    await expect(originalToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText(detail.summaryState.chinese.slice(0, 24), { exact: false }).first()).toBeVisible();
  });

  test("官方中文简介：标注 Bangumi 官方，不出现翻译按钮", async ({ page }) => {
    const list = await (await page.request.get("/api/subjects?limit=200&pageSize=200")).json();
    let target: { id: number } | null = null;
    for (const item of list.items as Array<{ id: number }>) {
      const detail = await (await page.request.get(`/api/subjects/${item.id}`)).json();
      if (detail.summaryState?.chineseSource === "bangumi") {
        target = item;
        break;
      }
    }
    test.skip(!target, "当前数据库没有官方中文简介条目");

    const detail = await (await page.request.get(`/api/subjects/${target!.id}`)).json();
    await gotoAndWait(page, `/subjects/${target!.id}`);
    await expect(page.getByText("官方中文").first()).toBeVisible();
    await expect(page.getByText("中文简介", { exact: true })).toBeVisible();
    await expect(page.getByText(detail.summaryState.chinese.slice(0, 20), { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "立即翻译" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重新翻译" })).toHaveCount(0);
  });

  test("没有简介的条目：显示暂无简介，不提供翻译入口", async ({ page }) => {
    const list = await (await page.request.get("/api/subjects?limit=200&pageSize=200")).json();
    let target: { id: number } | null = null;
    for (const item of list.items as Array<{ id: number }>) {
      const detail = await (await page.request.get(`/api/subjects/${item.id}`)).json();
      // 真正的「没有简介」= 中文与原文都为空（纯官方中文简介的 original 也是空的）
      if (!detail.summaryState?.original && !detail.summaryState?.chinese) {
        target = item;
        break;
      }
    }
    test.skip(!target, "当前收藏里所有条目都有简介");

    await gotoAndWait(page, `/subjects/${target!.id}`);
    await expect(page.getByText(/暂无简介/)).toBeVisible();
    await expect(page.getByRole("button", { name: /翻译/ })).toHaveCount(0);
  });

  test("设置页可以看到翻译队列与开关", async ({ page }) => {
    await gotoAndWait(page, "/settings?tab=ai");
    await expect(page.getByText("简介翻译（非中文简介 → 中文）")).toBeVisible();
    await expect(page.getByText("同步后自动翻译非中文简介")).toBeVisible();
    await expect(page.getByText("翻译并发数")).toBeVisible();
    // 队列总览的四个状态卡片
    await expect(page.getByText("待翻译", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("翻译中", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("已翻译", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "重新扫描并补齐队列" })).toBeVisible();
  });

  /**
   * Bangumi 的混合双语简介：「日文原文 + [中文简介] + 官方中文」。
   * 这类条目的中文必须来自 Bangumi（不是 AI），且分隔标记不能出现在页面上。
   */
  test("Bangumi 双语简介：中文标注官方来源、原文可对照、不显示分隔标记", async ({ page }) => {
    const list = await (await page.request.get("/api/subjects?limit=200&pageSize=200")).json();
    let target: { id: number } | null = null;
    let detail: {
      summaryState: { chinese: string; original: string; bilingual: boolean; chineseSource: string };
    } | null = null;
    for (const item of list.items as Array<{ id: number }>) {
      const body = await (await page.request.get(`/api/subjects/${item.id}`)).json();
      if (body.summaryState?.bilingual) {
        target = item;
        detail = body;
        break;
      }
    }
    test.skip(!target, "当前数据库没有「日文 + 官方中文」混合双语条目");

    await gotoAndWait(page, `/subjects/${target!.id}`);
    // 中文来自 Bangumi 官方，不是 AI
    await expect(page.getByText("官方中文").first()).toBeVisible();
    await expect(page.getByText(/Bangumi 双语简介/).first()).toBeVisible();
    await expect(page.getByText(detail!.summaryState.chinese.slice(0, 20), { exact: false }).first()).toBeVisible();

    // 分隔标记不能出现在简介区域（原始 JSON 查看器属于折叠的调试信息，不算介绍正文）
    const summaryBlock = page
      .locator("section")
      .filter({ has: page.getByText("中文简介", { exact: true }) })
      .last();
    await expect(summaryBlock.getByText("[中文简介]", { exact: false })).toHaveCount(0);
    // 不应该提供 AI 翻译入口（已有官方中文）
    await expect(page.getByRole("button", { name: "立即翻译" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重新翻译" })).toHaveCount(0);

    // 原文默认折叠，展开后与中文同为正文层级
    const toggle = page.getByRole("button", { name: /Bangumi 原文/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    const original = page.getByText(detail!.summaryState.original.slice(0, 20), { exact: false }).first();
    await expect(original).toBeVisible();
    const sizes = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("p")).filter((node) =>
        (node.className ?? "").toString().includes("leading-7"),
      );
      return nodes.map((node) => getComputedStyle(node).fontSize);
    });
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sizes).size).toBe(1);
  });
});
