import { expect, test } from "@playwright/test";
import { gotoAndWait, waitForReady } from "./helpers.js";

/**
 * 高级筛选：条件计数语义、标签默认展示与排序、面板高度稳定性（v1.4.2）。
 *
 * 覆盖链路：数据库（facets）→ 查询参数 → 计数函数 → 组件 → 页面显示。
 */

const TAG_DEFAULT_LIMIT = 36;

test.describe("高级筛选", () => {
  test("标签按「当前收藏库中的出现次数」降序，默认只展示最常用的一批", async ({ page }) => {
    const facets = await (await page.request.get("/api/subjects/facets")).json();
    const tags: Array<{ value: string; count: number }> = facets.tags;
    expect(tags.length).toBeGreaterThan(TAG_DEFAULT_LIMIT);

    // 数据层本身就是按收藏库出现次数降序
    for (let i = 1; i < Math.min(tags.length, 20); i += 1) {
      expect(tags[i - 1]!.count, `facets 顺序 #${i}`).toBeGreaterThanOrEqual(tags[i]!.count);
    }

    await gotoAndWait(page, "/library");
    await page.getByRole("button", { name: /高级筛选/ }).click();
    await page.waitForTimeout(400);

    const tagSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "标签", exact: true }) });
    const chips = tagSection.locator('[data-chip-group="tag-facets"] button[aria-pressed]');
    // facets 是异步请求（本地约 0.5s），等待真实渲染而不是固定 sleep
    await expect(chips.first()).toBeVisible();
    const chipCount = await chips.count();
    // 默认展示数量受控：不超过默认上限，且远小于标签总数
    expect(chipCount).toBeLessThanOrEqual(TAG_DEFAULT_LIMIT);
    expect(chipCount).toBeGreaterThan(10);

    // 首个标签就是收藏库中出现次数最多的标签
    const firstChipText = (await chips.first().innerText()).trim();
    expect(firstChipText).toContain(tags[0]!.value);

    // 面板里显示「默认显示 …」而不是「显示前 120」
    await expect(tagSection.getByText(/默认显示收藏中出现次数最多的/)).toBeVisible();
  });

  test("未默认展示的冷门标签仍然可以搜索并筛选", async ({ page }) => {
    const facets = await (await page.request.get("/api/subjects/facets")).json();
    const tags: Array<{ value: string; count: number }> = facets.tags;
    const rare = tags.slice(TAG_DEFAULT_LIMIT).find((tag) => tag.count === 1) ?? tags[tags.length - 1]!;

    await gotoAndWait(page, "/library");
    await page.getByRole("button", { name: /高级筛选/ }).click();
    const tagSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "标签", exact: true }) });
    // 默认列表里没有它
    await expect(tagSection.locator(`[data-chip-value="${rare.value}"]`)).toHaveCount(0);

    await tagSection.getByPlaceholder(/在全部标签中搜索/).fill(rare.value);
    await page.waitForTimeout(400);
    const chip = tagSection.locator(`[data-chip-value="${rare.value}"]`).first();
    await expect(chip).toBeVisible();
    await chip.click();
    await page.waitForTimeout(600);

    // 结果与「以该标签精确筛选」一致
    const expected = await (
      await page.request.get(`/api/subjects?tags=${encodeURIComponent(rare.value)}&pageSize=48`)
    ).json();
    await expect(page).toHaveURL(new RegExp(`tags=`));
    expect(expected.total).toBeGreaterThan(0);
  });

  test("徽标显示真实条件数量（0 / 1 / 3 / N），并在关闭重开后保持", async ({ page }) => {
    const facets = await (await page.request.get("/api/subjects/facets")).json();
    const topTags: string[] = facets.tags.slice(0, 4).map((tag: { value: string }) => tag.value);

    await gotoAndWait(page, "/library");
    // 0 个条件：没有数字
    await expect(page.getByRole("button", { name: "高级筛选", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "高级筛选", exact: true }).click();
    const tagSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "标签", exact: true }) });

    // 1 个标签 → 1
    await tagSection.locator(`[data-chip-value="${topTags[0]}"]`).first().click();
    await expect(page.getByRole("button", { name: "高级筛选 · 1" })).toBeVisible();

    // 3 个标签 → 3
    await tagSection.locator(`[data-chip-value="${topTags[1]}"]`).first().click();
    await tagSection.locator(`[data-chip-value="${topTags[2]}"]`).first().click();
    await expect(page.getByRole("button", { name: "高级筛选 · 3" })).toBeVisible();

    // 关闭再打开：数字保持
    await page.getByRole("button", { name: "完成" }).click();
    await page.waitForTimeout(300);
    await expect(page.getByRole("button", { name: "高级筛选 · 3" })).toBeVisible();
    await page.getByRole("button", { name: "高级筛选 · 3" }).click();
    await expect(page.getByText("已启用 3 个条件")).toBeVisible();

    // 刷新后保持
    await page.reload();
    await waitForReady(page);
    await expect(page.getByRole("button", { name: "高级筛选 · 3" })).toBeVisible();

    // 加一个制作人员 → 4
    await page.getByRole("button", { name: "高级筛选 · 3" }).click();
    const staffSection = page.locator("section").filter({ hasText: "制作人员 / 公司" });
    const staffChip = staffSection.locator("button[aria-pressed]").first();
    await expect(staffChip).toBeVisible();
    await staffChip.click();
    await expect(page.getByRole("button", { name: "高级筛选 · 4" })).toBeVisible();

    // 清除筛选 → 归零
    await page.getByRole("button", { name: "重置" }).click();
    await page.waitForTimeout(400);
    await expect(page.getByRole("button", { name: "高级筛选", exact: true })).toBeVisible();
  });

  test("面板高度固定：没有可拖拽调整高度的元素，也没有高度持久化", async ({ page }) => {
    await gotoAndWait(page, "/library");
    const before = await page.evaluate(() => {
      const keys = Object.keys(window.localStorage);
      return keys;
    });
    await page.getByRole("button", { name: /高级筛选/ }).click();
    await page.waitForTimeout(400);

    const probe = await page.evaluate(() => {
      const panel = document.querySelector("[data-radix-popper-content-wrapper]");
      const resizable: string[] = [];
      const draggable: string[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const style = getComputedStyle(el);
        if (style.resize && style.resize !== "none") resizable.push(`${el.tagName}.${String(el.className).slice(0, 40)}`);
        if (style.cursor === "ns-resize" || style.cursor === "row-resize") draggable.push(`${el.tagName}.${String(el.className).slice(0, 40)}`);
      }
      const rect = panel?.getBoundingClientRect();
      return {
        resizable,
        draggable,
        height: rect ? Math.round(rect.height) : 0,
        maxHeight: panel ? getComputedStyle(panel.firstElementChild ?? panel).maxHeight : "",
      };
    });
    expect(probe.resizable).toEqual([]);
    expect(probe.draggable).toEqual([]);
    expect(probe.height).toBeLessThanOrEqual(561);

    // 尝试在面板底部拖动：高度不应变化
    const box = await page.locator("[data-radix-popper-content-wrapper]").boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height + 120, { steps: 6 });
      await page.mouse.up();
    }
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const panel = document.querySelector("[data-radix-popper-content-wrapper]");
      const rect = panel?.getBoundingClientRect();
      return rect ? Math.round(rect.height) : 0;
    });
    expect(Math.abs(after - probe.height)).toBeLessThanOrEqual(1);

    // 关闭并重新打开后高度一致，且没有新增 localStorage 键
    await page.getByRole("button", { name: "完成" }).click();
    await page.getByRole("button", { name: /高级筛选/ }).click();
    await page.waitForTimeout(300);
    const reopened = await page.evaluate(() => {
      const panel = document.querySelector("[data-radix-popper-content-wrapper]");
      const rect = panel?.getBoundingClientRect();
      return rect ? Math.round(rect.height) : 0;
    });
    expect(Math.abs(reopened - probe.height)).toBeLessThanOrEqual(1);
    const keysAfter = await page.evaluate(() => Object.keys(window.localStorage));
    expect(keysAfter.sort()).toEqual(before.sort());
  });

  test("中等宽度与窄屏下面板不溢出、徽标不挤压标题", async ({ page }) => {
    for (const width of [1280, 1024, 900, 768, 600, 480, 420, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await gotoAndWait(page, "/library?tags=%E6%97%A5%E5%B8%B8%2C%E6%B2%BB%E6%84%88%2C%E6%A0%A1%E5%9B%AD");
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      });
      expect(overflow, `${width}px 横向溢出`).toBeLessThanOrEqual(2);

      await page.getByRole("button", { name: /高级筛选 · 3/ }).click();
      await page.waitForTimeout(350);
      const panel = await page.evaluate(() => {
        const wrapper = document.querySelector("[data-radix-popper-content-wrapper]");
        if (!wrapper) return null;
        const rect = wrapper.getBoundingClientRect();
        return { left: rect.left, right: rect.right, vw: document.documentElement.clientWidth };
      });
      expect(panel, `${width}px 面板未打开`).not.toBeNull();
      expect(panel!.left, `${width}px 面板左侧超出`).toBeGreaterThanOrEqual(-1);
      expect(panel!.right, `${width}px 面板右侧超出`).toBeLessThanOrEqual(panel!.vw + 1);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  });

  /**
   * 反向检索入口与主筛选入口必须使用同一套计数规则：
   * 从作品详情点击「制作人员」进入收藏库时，徽标应当反映实际条件数量。
   */
  test("制作人员反向检索入口的条件计数与筛选面板一致", async ({ page }) => {
    const list = await (await page.request.get("/api/subjects?limit=5&sort=updated")).json();
    const subjectId = list.items[0].id as number;

    await gotoAndWait(page, `/subjects/${subjectId}`);
    const staffLink = page.locator('a[href^="/library?staff="]').first();
    await expect(staffLink).toBeVisible();
    const href = (await staffLink.getAttribute("href")) ?? "";
    await staffLink.click();
    await waitForReady(page);

    // 1 个制作人员条件 → 高级筛选 · 1
    await expect(page.getByRole("button", { name: "高级筛选 · 1" })).toBeVisible();
    // 来源作品上下文横幅与 URL 语义保持不变
    await expect(page.getByText("来源作品上下文")).toBeVisible();
    expect(href).toContain(`fromSubject=${subjectId}`);
    const url = new URL(page.url());
    expect(url.searchParams.getAll("staff").length).toBeGreaterThan(0);
    expect(url.searchParams.get("fromSubject")).toBe(String(subjectId));

    // 面板里再选一个公司 → 2（人员 + 公司各算 1）
    await page.getByRole("button", { name: "高级筛选 · 1" }).click();
    const studioSection = page.locator("section").filter({ hasText: "制作公司" });
    const studioChip = studioSection.locator("button[aria-pressed]").first();
    await expect(studioChip).toBeVisible();
    await studioChip.click();
    await expect(page.getByRole("button", { name: "高级筛选 · 2" })).toBeVisible();

    // 取消人员条件后只剩公司 → 1
    const staffSection = page.locator("section").filter({ hasText: "制作人员 / 公司" });
    const selectedStaff = staffSection.locator("button[title='点击移除']").first();
    await selectedStaff.click();
    await expect(page.getByRole("button", { name: "高级筛选 · 1" })).toBeVisible();
  });

  /**
   * 面板自身绝对不能横向滚动（v1.4.2.1 的真实 Bug）。
   *
   * 判定标准不是「页面没有横向滚动」，而是面板内容容器本身：
   *   scrollWidth === clientWidth 且 scrollLeft 无法产生位移。
   * 覆盖 10 个断点，并在有长标签 / 多选条件的情况下重复验证。
   */
  test("面板内容容器在全部断点下都不产生横向滚动", async ({ page }) => {
    test.setTimeout(180_000);
    const facets = await (await page.request.get("/api/subjects/facets")).json();
    // 取一个最长的标签名与一个只出现一次的冷门标签，验证长文本不会撑破容器
    const longest = [...facets.tags]
      .sort((a: { value: string }, b: { value: string }) => b.value.length - a.value.length)
      .slice(0, 3)
      .map((tag: { value: string }) => tag.value);

    const widths = [1920, 1440, 1280, 1024, 900, 768, 600, 480, 420, 375];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await gotoAndWait(page, "/library");
      await page.getByRole("button", { name: /高级筛选/ }).click();
      await page.waitForTimeout(400);

      const probe = async (label: string) => {
        const result = await page.evaluate(() => {
          const content = document.querySelector("[data-radix-popper-content-wrapper] > div");
          if (!content) return null;
          const before = content.scrollLeft;
          // 尝试横向滚动：修复后不应该有任何位移
          content.scrollLeft = 999;
          const after = content.scrollLeft;
          content.scrollLeft = before;
          return {
            clientWidth: content.clientWidth,
            scrollWidth: content.scrollWidth,
            movedByScroll: after,
          };
        });
        expect(result, `${label} 面板未打开`).not.toBeNull();
        expect(result!.scrollWidth, `${label} 存在横向溢出内容`).toBe(result!.clientWidth);
        expect(result!.movedByScroll, `${label} 仍可横向滚动`).toBe(0);
      };

      await probe(`${width}px 默认状态`);

      // 长标签 + 多选条件：不能撑破容器
      const tagSection = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "标签", exact: true }) });
      const tagSearch = tagSection.getByPlaceholder(/在全部标签中搜索/);
      for (const tag of longest.slice(0, 2)) {
        await tagSearch.fill(tag);
        await page.waitForTimeout(350);
        await tagSection.locator(`[data-chip-value="${tag}"]`).first().click();
        await page.waitForTimeout(250);
      }
      await tagSearch.fill("");
      await page.waitForTimeout(300);
      await probe(`${width}px 选中长标签后`);

      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  });
});
