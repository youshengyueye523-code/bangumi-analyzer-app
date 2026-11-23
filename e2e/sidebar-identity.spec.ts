import { expect, test } from "@playwright/test";
import { gotoAndWait, waitForReady } from "./helpers.js";

/**
 * 侧栏身份区与「个人资料」必须共用同一份配置数据：
 * 修改昵称 / 头像后侧栏立刻同步，刷新与重启后仍然一致。
 */
test.describe("左侧导航身份区", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  test("侧栏显示本地昵称与头像，并在修改后立即同步", async ({ page }) => {
    const before = await (await page.request.get("/api/config")).json();
    const nickname = `侧栏昵称 ${Date.now() % 100000}`;
    try {
      await gotoAndWait(page, "/me");
      const sidebar = page.locator("aside");

      // 未设置昵称时回退到 Bangumi 用户名（以文本形式出现，而不是 @ 前缀）
      await expect(sidebar.getByText(before.nickname || before.username, { exact: false }).first()).toBeVisible();

      await page.getByRole("button", { name: "编辑资料" }).click();
      await page.getByLabel("昵称").fill(nickname);
      await page.locator('input[type="file"]').setInputFiles({
        name: "avatar.png",
        mimeType: "image/png",
        buffer: PNG,
      });
      await page.getByRole("button", { name: "保存资料" }).click();

      // 不刷新页面：侧栏立即同步
      await expect(sidebar.getByText(nickname)).toBeVisible();
      const sidebarAvatar = sidebar.locator('img[alt$="的头像"]').first();
      await expect(sidebarAvatar).toHaveAttribute("src", /^data:image\/png;base64,/);

      // 刷新后保持一致
      await page.reload();
      await waitForReady(page);
      await expect(page.locator("aside").getByText(nickname)).toBeVisible();
      await expect(page.locator("aside").locator('img[alt$="的头像"]').first()).toHaveAttribute(
        "src",
        /^data:image\/png;base64,/,
      );

      // 其他页面（例如仪表盘）同样显示本地昵称
      await gotoAndWait(page, "/");
      await expect(page.locator("aside").getByText(nickname)).toBeVisible();
    } finally {
      await page.request.put("/api/config", {
        data: { nickname: before.nickname ?? "", avatar: before.avatar ?? "" },
      });
    }
  });

  test("删除头像后回退为默认头像，长昵称被截断且不破坏布局", async ({ page }) => {
    const before = await (await page.request.get("/api/config")).json();
    const longName = "这是一个非常长的昵称用来验证侧边栏不会被撑破布局并会被截断显示";
    try {
      await page.request.put("/api/config", { data: { nickname: longName, avatar: "" } });
      await gotoAndWait(page, "/");
      const sidebar = page.locator("aside");
      const nameNode = sidebar.getByText(longName);
      await expect(nameNode).toBeVisible();
      await expect(nameNode).toHaveAttribute("title", new RegExp("Bangumi"));

      // 没有头像时使用 fallback（不是破损的 img）
      await expect(sidebar.locator('img[alt$="的头像"]')).toHaveCount(0);

      // 侧栏没有被撑宽（固定 220px）
      const box = await sidebar.boundingBox();
      expect(Math.round(box?.width ?? 0)).toBe(220);
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(2);
    } finally {
      await page.request.put("/api/config", {
        data: { nickname: before.nickname ?? "", avatar: before.avatar ?? "" },
      });
    }
  });
});
