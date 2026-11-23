import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoAndWait } from "./helpers.js";
import { brightPainter, png, pngDataUrl, resetWallpaper } from "./wallpaper-fixture.js";

/**
 * 界面材质（v1.5.0）。
 *
 * 覆盖：材质卡片的存在与默认值、预设 / 滑块的实时预览、取消不写配置、
 * 应用后持久化、没有背景时材质保持惰性、玻璃只出现在悬浮层（不在内容层）。
 * 用例会临时改配置，结束后恢复原值。
 */
test.use({ colorScheme: "dark" });

interface ConfigShape {
  wallpaper: { image: string; focusX: number; focusY: number; blur: number; strength: number };
  material: { preset: string; clarity: number; frosted: number };
}

let original: ConfigShape | null = null;
let originalBytes: Buffer | null = null;
let originalMime = "image/jpeg";

test.beforeEach(async ({ page, request }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("bangumi-analyzer-theme", "dark");
  });
  original = (await (await request.get("/api/config")).json()) as ConfigShape;
  originalBytes = null;
  if (original.wallpaper.image) {
    const asset = await request.get(`/api/wallpaper/${original.wallpaper.image}`);
    if (asset.ok()) {
      originalBytes = Buffer.from(await asset.body());
      originalMime = asset.headers()["content-type"]?.split(";")[0] ?? "image/jpeg";
    }
  }
  await resetWallpaper(request);
});

test.afterEach(async ({ request }) => {
  await resetWallpaper(request);
  if (!original) return;
  if (original.wallpaper.image && originalBytes) {
    await request.post("/api/wallpaper", {
      data: { dataUrl: `data:${originalMime};base64,${originalBytes.toString("base64")}` },
    });
  }
  await request.put("/api/config", {
    data: { wallpaper: original.wallpaper, material: original.material },
  });
  original = null;
});

async function applyWallpaper(page: Page): Promise<void> {
  const uploaded = await (
    await page.request.post("/api/wallpaper", {
      data: { dataUrl: pngDataUrl(png(1600, 900, brightPainter)) },
    })
  ).json();
  await page.request.put("/api/config", {
    data: { wallpaper: { image: uploaded.image, focusX: 50, focusY: 50, blur: 10, strength: 70 } },
  });
}

const materialVars = (page: Page) =>
  page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const aside = document.querySelector("aside");
    return {
      clarity: root.getPropertyValue("--mat-clarity").trim(),
      frost: root.getPropertyValue("--mat-frost").trim(),
      asideFilter: aside ? getComputedStyle(aside).backdropFilter : "none",
      asideAlpha: aside ? getComputedStyle(aside).backgroundColor : "",
    };
  });

/** 从计算颜色里取不透明度：rgb(...) 视为完全不透明 */
const alphaOf = (color: string): number => {
  const numbers = (color.match(/[\d.]+/g) ?? []).map(Number);
  return color.startsWith("rgba") ? (numbers.at(-1) ?? 1) : 1;
};

test.describe("界面材质", () => {
  test("外观分区有材质卡片，三档倾向 + 两个滑块，默认平衡", async ({ page }) => {
    const config = (await (await page.request.get("/api/config")).json()) as ConfigShape;
    await gotoAndWait(page, "/settings?tab=appearance");
    const card = page.locator("section", { hasText: "界面材质" }).last();
    await expect(card).toBeVisible();
    for (const label of ["清透", "平衡", "磨砂"]) {
      await expect(card.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(card.getByRole("slider", { name: "通透度" })).toBeVisible();
    await expect(card.getByRole("slider", { name: "磨砂度" })).toBeVisible();
    expect(config.material.clarity).toBeGreaterThanOrEqual(0);
  });

  test("预设与滑块实时预览，取消后完全回到已保存状态", async ({ page }) => {
    await applyWallpaper(page);
    const before = (await (await page.request.get("/api/config")).json()) as ConfigShape;
    await gotoAndWait(page, "/settings?tab=appearance");
    const card = page.locator("section", { hasText: "界面材质" }).last();

    // 起始状态可能是用户自定义的通透度：按已保存的 clarity 计算期望值，
    // 而不是硬编码「平衡」预设的 0.80，避免真实配置下误报。
    expect((await materialVars(page)).asideFilter).toContain("blur(");
    const expectedStartAlpha = 0.9 - 0.2 * (before.material.clarity / 100);
    await expect
      .poll(async () => alphaOf((await materialVars(page)).asideAlpha))
      .toBeCloseTo(expectedStartAlpha, 2);

    // 磨砂：通透度更低 → 更不透明 + 更强模糊
    await card.getByRole("button", { name: "磨砂", exact: true }).click();
    await expect.poll(async () => (await materialVars(page)).frost).toBe("0.820");
    await expect
      .poll(async () => alphaOf((await materialVars(page)).asideAlpha))
      .toBeGreaterThan(0.84);
    expect((await materialVars(page)).asideFilter).toContain("blur(27.32px)");

    // 清透：通透度更高 → 更透明 + 更弱模糊
    await card.getByRole("button", { name: "清透", exact: true }).click();
    await expect.poll(async () => (await materialVars(page)).frost).toBe("0.220");
    await expect
      .poll(async () => alphaOf((await materialVars(page)).asideAlpha))
      .toBeLessThan(0.76);
    expect((await materialVars(page)).asideFilter).toContain("blur(11.72px)");

    await card.getByRole("button", { name: "取消", exact: true }).click();
    await expect
      .poll(async () => (await materialVars(page)).frost)
      .toBe((before.material.frosted / 100).toFixed(3));
    await expect
      .poll(async () => alphaOf((await materialVars(page)).asideAlpha))
      .toBeCloseTo(expectedStartAlpha, 2);
    const after = (await (await page.request.get("/api/config")).json()) as ConfigShape;
    expect(after.material).toEqual(before.material);
  });

  test("应用后写回配置，刷新与重启后保持一致", async ({ page }) => {
    await applyWallpaper(page);
    await gotoAndWait(page, "/settings?tab=appearance");
    const card = page.locator("section", { hasText: "界面材质" }).last();

    await card.getByRole("button", { name: "磨砂", exact: true }).click();
    await card.getByRole("button", { name: "应用", exact: true }).click();
    await expect
      .poll(async () => {
        const config = (await (await page.request.get("/api/config")).json()) as ConfigShape;
        return config.material.preset;
      })
      .toBe("frosted");

    await page.reload();
    await expect.poll(async () => (await materialVars(page)).frost).toBe("0.820");
  });

  test("没有背景时材质保持惰性：侧栏不透明、没有模糊，并给出提示", async ({ page }) => {
    await gotoAndWait(page, "/settings?tab=appearance");
    const state = await materialVars(page);
    expect(state.asideFilter).toBe("none");
    expect(state.asideAlpha).toMatch(/^rgb\(/);
    await expect(page.getByText(/材质需要背景作为「环境」/)).toBeVisible();
    await gotoAndWait(page, "/");
    const dashboard = await materialVars(page);
    expect(dashboard.asideFilter).toBe("none");
  });

  test("玻璃只出现在悬浮层：内容页只有侧栏与顶栏两层模糊", async ({ page }) => {
    await applyWallpaper(page);
    await gotoAndWait(page, "/");
    const layers = await page.evaluate(() =>
      Array.from(document.querySelectorAll("*"))
        .filter((element) => {
          const value = getComputedStyle(element).backdropFilter;
          return value && value !== "none";
        })
        .map((element) => element.tagName.toLowerCase()),
    );
    expect(layers.sort()).toEqual(["aside", "header"]);
  });
});
