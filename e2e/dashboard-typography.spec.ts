import { expect, test } from "@playwright/test";
import { gotoAndWait } from "./helpers.js";

/**
 * Dashboard 排版回归（v1.4.2）。
 *
 * 数据分析型界面的可读性下限：
 *   - 指标数字 ≥ 24px，且明显大于正文（13px）；
 *   - 指标说明 / 数据标签 ≥ 12px；
 *   - 面板标题 ≥ 14px；
 *   - 列表数据行标题 ≥ 13px、meta ≥ 12px。
 * 断点：1920 / 1440 / 1280 / 1024 / 768 / 375。
 */

const BREAKPOINTS = [1920, 1440, 1280, 1024, 768, 375];

async function readTypography(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const px = (value: string) => Number.parseFloat(value);
    const label = document.querySelector("[data-stat-label]");
    const valueNode = document.querySelector("[data-stat-value]");
    const chartTitle = document.querySelector("section h3");
    const chartDesc = chartTitle?.parentElement?.querySelector("p") ?? null;
    const rowTitle = document.querySelector("a[href^='/subjects/'] span");
    const rowMeta = document.querySelector("a[href^='/subjects/'] div > div");
    const size = (el: Element | null | undefined) =>
      el ? px(getComputedStyle(el).fontSize) : null;
    return {
      label: size(label),
      value: size(valueNode),
      chartTitle: size(chartTitle),
      chartDesc: size(chartDesc),
      rowTitle: size(rowTitle),
      rowMeta: size(rowMeta),
      bodyFont: px(getComputedStyle(document.body).fontSize),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test.describe("Dashboard 排版回归", () => {
  test("指标数字 / 标签 / 面板标题 / 数据行在整个断点范围内保持工具型可读性", async ({ page }) => {
    test.setTimeout(180_000);
    for (const width of BREAKPOINTS) {
      await page.setViewportSize({ width, height: 900 });
      await gotoAndWait(page, "/");
      await page.waitForTimeout(900);
      const m = await readTypography(page);

      expect(m.value, `${width}px 指标数字`).toBeGreaterThanOrEqual(24);
      // 核心数字必须明显大于正文（至少 1.6 倍）
      expect(m.value!, `${width}px 数字 / 正文比例`).toBeGreaterThanOrEqual(m.bodyFont * 1.6);
      expect(m.label, `${width}px 指标说明`).toBeGreaterThanOrEqual(12);
      expect(m.chartTitle, `${width}px 图表标题`).toBeGreaterThanOrEqual(14);
      expect(m.chartDesc, `${width}px 图表说明`).toBeGreaterThanOrEqual(12);
      expect(m.rowTitle, `${width}px 列表行标题`).toBeGreaterThanOrEqual(13);
      expect(m.rowMeta, `${width}px 列表行 meta`).toBeGreaterThanOrEqual(12);
      expect(m.overflow, `${width}px 横向溢出`).toBeLessThanOrEqual(2);
    }
  });

  test("图表文字规格：坐标轴 11px / 图例与提示 12px", async ({ page }) => {
    // 通过 ECharts 实例的 option 断言文字规格，避免依赖 canvas 像素
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAndWait(page, "/");
    await page.waitForTimeout(1500);
    const fonts = await page.evaluate(() => {
      const holder = document.querySelector("div[_echarts_instance_]");
      const instance = holder
        ? (window as unknown as { echarts?: { getInstanceByDom: (el: Element) => { getOption: () => Record<string, unknown> } } })
            .echarts?.getInstanceByDom(holder)
        : null;
      if (!instance) return null;
      const option = instance.getOption() as {
        xAxis?: Array<{ axisLabel?: { fontSize?: number } }>;
        legend?: Array<{ textStyle?: { fontSize?: number } }>;
        tooltip?: Array<{ textStyle?: { fontSize?: number } }>;
      };
      return {
        axis: option.xAxis?.[0]?.axisLabel?.fontSize ?? null,
        legend: option.legend?.[0]?.textStyle?.fontSize ?? null,
        tooltip: option.tooltip?.[0]?.textStyle?.fontSize ?? null,
      };
    });
    test.skip(!fonts, "页面未暴露 ECharts 实例（生产构建不挂载全局实例）");
    expect(fonts!.axis).toBeGreaterThanOrEqual(11);
    expect(fonts!.legend ?? 0).toBeGreaterThanOrEqual(12);
  });

  /**
   * KPI 语义（v1.4.2.1）：标题 / 主数字 / 辅助文本 / 分母必须同源，
   * 且不能把「集数进度」当成「收藏完成度」。
   */
  test("完成率与收藏状态使用 canonical 收藏状态，集数进度单独命名", async ({ page }) => {
    const overview = await (await page.request.get("/api/stats/overview")).json();
    const done = overview.statusCounts['2'];
    const total = overview.total;

    await gotoAndWait(page, "/");
    await page.waitForTimeout(800);

    const cardText = async (label: string) =>
      page.evaluate((name) => {
        const labelEl = Array.from(document.querySelectorAll("[data-stat-label]")).find(
          (el) => el.textContent?.trim() === name,
        );
        return labelEl?.closest(".card-surface")?.textContent?.replace(/\s+/g, " ").trim() ?? null;
      }, label);

    // 完成率 = 看过 / 收藏总量，辅助文本给出分子与分母
    const completion = await cardText("完成率");
    expect(completion).toContain(`${((done / total) * 100).toFixed(1)}%`);
    expect(completion).toContain(`已看 ${done} / 收藏 ${total}`);
    expect(completion).not.toContain("未完成");

    // 收藏状态卡片：主数字 + 各状态分布
    const status = await cardText("收藏状态");
    expect(status).toContain(`${done} / ${total}`);
    expect(status).toContain(`想看 ${overview.statusCounts['1']}`);
    expect(status).toContain(`在看 ${overview.statusCounts['3']}`);
    expect(status).toContain(`搁置 ${overview.statusCounts['4']}`);
    expect(status).toContain(`抛弃 ${overview.statusCounts['5']}`);

    // 集数进度：标题与说明都点明「集数」层面，不再叫「累计观看进度」
    const episodes = await cardText("已看集数进度");
    expect(episodes).toContain("集");
    expect(episodes).toContain("不含想看");
    await expect(page.getByText("累计观看进度")).toHaveCount(0);

    // 五个状态之和 = 收藏总量（同一套 canonical 数据）
    const sum = [2, 1, 3, 4, 5].reduce((acc, key) => acc + (overview.statusCounts[String(key)] ?? 0), 0);
    expect(sum).toBe(total);
  });
});
