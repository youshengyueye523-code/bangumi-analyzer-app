import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoAndWait } from "./helpers.js";
import {
  brightPainter,
  darkPainter,
  png,
  pngDataUrl,
  readWallpaper,
  resetWallpaper,
  writeFixture,
} from "./wallpaper-fixture.js";

/**
 * 背景板系统（v1.4.3）。
 *
 * 覆盖：无背景基线、上传 → 预览 → 应用、取消不污染配置、构图拖动、
 * 强度 / 模糊度只作用于背景、清除背景、浮层层级、断点无溢出、深浅色。
 * 每个用例结束后都会把背景恢复成「无背景」，不会污染真实配置。
 */
test.use({ colorScheme: "dark" });

/**
 * 用例会临时改真实配置，因此开始前把原来的背景记下来、结束后原样恢复
 * （文件名按内容寻址：重新上传同一份字节就能拿回同一个文件名）。
 */
let original: Awaited<ReturnType<typeof readWallpaper>> | null = null;
let originalBytes: Buffer | null = null;
let originalMime = "image/png";

test.beforeEach(async ({ page, request }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("bangumi-analyzer-theme", "dark");
  });
  original = await readWallpaper(request);
  originalBytes = null;
  originalMime = "image/png";
  if (original.image) {
    const asset = await request.get(`/api/wallpaper/${original.image}`);
    if (asset.ok()) {
      originalBytes = Buffer.from(await asset.body());
      originalMime = asset.headers()["content-type"]?.split(";")[0] ?? "image/png";
    }
  }
  await resetWallpaper(request);
});

test.afterEach(async ({ request }) => {
  await resetWallpaper(request);
  if (!original) return;
  if (original.image && originalBytes) {
    await request.post("/api/wallpaper", {
      data: { dataUrl: `data:${originalMime};base64,${originalBytes.toString("base64")}` },
    });
  }
  await request.put("/api/config", { data: { wallpaper: original } });
  original = null;
});

/** 首卡片（面板）背景色：用于判断面板是否随背景强度变透明 */
async function cardBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const card = document.querySelector(".card-surface");
    return card ? getComputedStyle(card).backgroundColor : "";
  });
}

/**
 * 「背景」卡片本身。
 * 外观分区里还有「界面材质」卡片，两者都有「应用 / 取消」，因此按钮必须限定在卡片内。
 */
function wallpaperCard(page: Page) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "背景", exact: true }) });
}

async function layerFilter(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const image = document.querySelector('[data-testid="wallpaper-image"]');
    return image ? getComputedStyle(image).filter : null;
  });
}

async function docOverflowX(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** 背景图通过接口落盘（用于快速准备状态，不经过 UI） */
async function applyWallpaper(page: Page, buffer: Buffer): Promise<string> {
  const uploaded = await (
    await page.request.post("/api/wallpaper", { data: { dataUrl: pngDataUrl(buffer) } })
  ).json();
  await page.request.put("/api/config", {
    data: { wallpaper: { image: uploaded.image, focusX: 50, focusY: 50, blur: 10, strength: 60 } },
  });
  return uploaded.image as string;
}

test.describe("背景板系统", () => {
  test("无背景时保持 v1.4.2.2：没有图层、面板不透明、无横向溢出", async ({ page }) => {
    await gotoAndWait(page, "/");
    expect(await page.locator('[data-testid="wallpaper-layer"]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.dataset.wallpaper ?? null)).toBeNull();
    // 面板不透明（没有透明度分量）
    expect(await cardBackground(page)).toBe("rgb(18, 21, 29)");
    expect(await docOverflowX(page)).toBe(0);
  });

  test("上传 → 预览 → 应用：全局生效、刷新后仍在、接口可读取", async ({ page }) => {
    const file = writeFixture("landscape.png", png(1920, 1080, brightPainter));
    await gotoAndWait(page, "/settings?tab=appearance");

    await page.locator('[data-testid="wallpaper-file"]').setInputFiles(file);
    // 预览态：整站立刻生效，但正式配置还没写
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toBeVisible();
    await expect(page.getByText("预览中 · 未应用")).toBeVisible();
    expect((await readWallpaper(page.request)).image).toBe("");
    expect(await cardBackground(page)).toMatch(/^rgba\(18, 21, 29, 0\.9/);

    await wallpaperCard(page).getByRole("button", { name: "应用", exact: true }).click();
    await expect
      .poll(async () => (await readWallpaper(page.request)).image)
      .not.toBe("");
    const applied = await readWallpaper(page.request);
    expect(applied.blur).toBe(10);
    expect(applied.strength).toBe(60);

    // 背景图可被服务端读取（离线也能显示，不依赖外网）
    const asset = await page.request.get(`/api/wallpaper/${applied.image}`);
    expect(asset.status()).toBe(200);
    expect(asset.headers()["content-type"]).toContain("image/png");

    // 刷新后仍然生效
    await page.reload();
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toBeVisible();
    // 页面切换后仍然一致（全局同一个背景）
    await gotoAndWait(page, "/library");
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toBeVisible();
    await gotoAndWait(page, "/series");
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toBeVisible();
    await gotoAndWait(page, "/settings?tab=appearance");
    await expect(page.getByText("已应用", { exact: true })).toBeVisible();
  });

  test("取消预览：不写正式配置、不影响已保存状态、不残留样式", async ({ page }) => {
    const before = await readWallpaper(page.request);
    const file = writeFixture("landscape.png", png(1920, 1080, brightPainter));
    await gotoAndWait(page, "/settings?tab=appearance");

    await page.locator('[data-testid="wallpaper-file"]').setInputFiles(file);
    const strength = page.getByRole("slider", { name: "背景强度" });
    await strength.focus();
    await page.keyboard.press("End");
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toBeVisible();

    await wallpaperCard(page).getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toHaveCount(0);
    expect(await readWallpaper(page.request)).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.dataset.wallpaper ?? null)).toBeNull();
    expect(await cardBackground(page)).toBe("rgb(18, 21, 29)");
  });

  test("拖动预览调整构图：全局同步、不改变页面布局、应用后落库", async ({ page }) => {
    await applyWallpaper(page, png(1920, 1080, brightPainter));
    await gotoAndWait(page, "/settings?tab=appearance");
    const preview = page.locator('[data-testid="wallpaper-preview"]');
    const box = (await preview.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 8 });
    await page.mouse.up();

    const position = await page.evaluate(() => {
      const image = document.querySelector('[data-testid="wallpaper-image"]');
      return image ? getComputedStyle(image).backgroundPosition : "";
    });
    expect(position).not.toBe("50% 50%");
    // 预览态：配置还没有变
    const pending = await readWallpaper(page.request);
    expect([50, 50]).toEqual([pending.focusX, pending.focusY]);
    // 拖动不会拖动页面本身
    expect(await docOverflowX(page)).toBe(0);

    await wallpaperCard(page).getByRole("button", { name: "应用", exact: true }).click();
    await expect
      .poll(async () => (await readWallpaper(page.request)).focusX)
      .not.toBe(50);
  });

  test("背景强度 / 模糊度只作用于背景层，不影响内容排版", async ({ page }) => {
    await applyWallpaper(page, png(1920, 1080, brightPainter));
    await gotoAndWait(page, "/settings?tab=appearance");
    const fontSizeBefore = await page.evaluate(
      () => getComputedStyle(document.body).fontSize,
    );

    const strength = page.getByRole("slider", { name: "背景强度" });
    await strength.focus();
    await page.keyboard.press("End");
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--wp-strength"))).toBe(
      "1.000",
    );
    expect(await cardBackground(page)).toMatch(/^rgba\(18, 21, 29, 0\.88\)/);

    const blur = page.getByRole("slider", { name: "模糊度" });
    await blur.focus();
    await page.keyboard.press("End");
    await expect.poll(async () => layerFilter(page)).toBe("blur(40px)");

    // 内容层没有被模糊，字号层级也没有变化
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe(fontSizeBefore);
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector(".card-surface")!).filter),
    ).toBe("none");

    await wallpaperCard(page).getByRole("button", { name: "应用", exact: true }).click();
    await expect.poll(async () => (await readWallpaper(page.request)).strength).toBe(100);
    await expect.poll(async () => (await readWallpaper(page.request)).blur).toBe(40);
  });

  test("清除背景：恢复无背景状态", async ({ page }) => {
    await applyWallpaper(page, png(900, 1600, darkPainter));
    await gotoAndWait(page, "/settings?tab=appearance");
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toBeVisible();

    await wallpaperCard(page).getByRole("button", { name: "清除背景" }).click();
    await wallpaperCard(page).getByRole("button", { name: "应用", exact: true }).click();
    await expect.poll(async () => (await readWallpaper(page.request)).image).toBe("");
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toHaveCount(0);
    expect(await cardBackground(page)).toBe("rgb(18, 21, 29)");
  });

  test("浮层与对话框始终在背景之上，并保持不透明", async ({ page }) => {
    await applyWallpaper(page, png(1920, 1080, brightPainter));

    await gotoAndWait(page, "/library");
    await page.locator('button[aria-label="每页数量"]').click();
    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();
    const menuProbe = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12);
      return {
        alpha: (() => {
          const value = getComputedStyle(element).backgroundColor;
          const numbers = (value.match(/[\d.]+/g) ?? []).map(Number);
          return value.startsWith("rgba") ? (numbers.at(-1) ?? 1) : 1;
        })(),
        hitInsideMenu: Boolean(hit?.closest('[role="menu"]')),
      };
    });
    // v1.5.0 起浮层带玻璃材质：允许极轻微通透，但必须保持在「几乎不透」的区间
    expect(menuProbe.alpha).toBeGreaterThanOrEqual(0.9);
    expect(menuProbe.hitInsideMenu).toBe(true);
    await page.keyboard.press("Escape");

    await gotoAndWait(page, "/me");
    await page.getByRole("button", { name: /编辑/ }).first().click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    const dialogAlpha = await dialog.evaluate((element) => {
      const value = getComputedStyle(element).backgroundColor;
      const numbers = (value.match(/[\d.]+/g) ?? []).map(Number);
      return value.startsWith("rgba") ? (numbers.at(-1) ?? 1) : 1;
    });
    expect(dialogAlpha).toBeGreaterThanOrEqual(0.9);
  });

  test("断点 1920 / 1440 / 1280 / 375：无横向溢出、无新增滚动容器", async ({ page }) => {
    await applyWallpaper(page, png(1920, 1080, brightPainter));
    const countScrollers = () =>
      page.evaluate(
        () =>
          Array.from(document.querySelectorAll("*")).filter((element) => {
            const style = getComputedStyle(element);
            return (
              (style.overflowY === "auto" || style.overflowY === "scroll") &&
              element.scrollHeight > element.clientHeight + 4 &&
              element.getBoundingClientRect().height > 0
            );
          }).length,
      );

    for (const width of [1920, 1440, 1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await gotoAndWait(page, "/library");
      expect(await docOverflowX(page), `${width}px 页面横向溢出`).toBeLessThanOrEqual(2);
      const layer = await page.evaluate(() => {
        const element = document.querySelector('[data-testid="wallpaper-layer"]')!;
        const style = getComputedStyle(element);
        return {
          position: style.position,
          pointerEvents: style.pointerEvents,
          overflow: style.overflow,
          scrollLeft: element.scrollLeft,
        };
      });
      expect(layer.position).toBe("fixed");
      expect(layer.pointerEvents).toBe("none");
      // 背景层内部不允许用户滚动（模糊外扩的部分被裁掉，且不接收指针事件）
      expect(layer.overflow).toBe("hidden");
      expect(layer.scrollLeft).toBe(0);
    }

    // 有背景时不应产生新的内部滚动容器
    const withWallpaper = await countScrollers();
    await resetWallpaper(page.request);
    await gotoAndWait(page, "/library");
    expect(await countScrollers()).toBe(withWallpaper);
  });

  test("浅色主题：背景同样生效且使用浅色暗化层", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("bangumi-analyzer-theme", "light");
    });
    await applyWallpaper(page, png(1920, 1080, brightPainter));
    await gotoAndWait(page, "/");
    await expect(page.locator('[data-testid="wallpaper-layer"]')).toBeVisible();
    const scrim = await page.evaluate(() => {
      const element = document.querySelector('[data-testid="wallpaper-scrim"]')!;
      return getComputedStyle(element).backgroundImage;
    });
    expect(scrim).toContain("rgba(255, 255, 255");
    expect(await cardBackground(page)).toMatch(/^rgba\(255, 255, 255, 0\.9/);
    expect(await docOverflowX(page)).toBe(0);
  });
});
