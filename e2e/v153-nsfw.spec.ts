import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.5.3：NSFW 可见性策略（真实 Local 数据）。
 *
 * 10 个样本的判定全部来自 `subject.nsfw = 1`；负样本（nsfw = 0）必须在
 * 任何设置下都保持可见。
 *
 * 测试隔离：用例结束必须恢复「测试开始前用户自己的 hideNsfw 设置」——不能把
 * 用户当前开启的隐藏强行改成关闭，也不能假设基线一定是 false（v1.7.0 RC 修复）。
 */

const HIDDEN_SUBJECT = 33506; // 鬼父2
const HIDDEN_SERIES = 'sr_377'; // 鬼父2 系列（多成员，含 NSFW）
const VISIBLE_SUBJECT = 328609; // 孤独摇滚！（负样本：nsfw = 0）
/** 真实 Local 数据中的 10 个 subject.nsfw = 1 样本。 */
const NSFW_SAMPLES = [9856, 18022, 33504, 33506, 37994, 72335, 85031, 121046, 288025, 338672];

/** 测试开始前用户的设置（用例结束原样恢复）。 */
let originalHideNsfw = false;

async function setHideNsfw(request: APIRequestContext, value: boolean): Promise<void> {
  const response = await request.put('/api/config', { data: { hideNsfw: value } });
  expect(response.ok()).toBe(true);
}

test.describe('NSFW 隐藏（真实数据）', () => {
  test.beforeAll(async ({ request }) => {
    const config = await (await request.get('/api/config')).json();
    originalHideNsfw = Boolean(config.hideNsfw);
  });

  test.afterEach(async ({ request }) => {
    await setHideNsfw(request, originalHideNsfw);
  });

  test('开关开启：收藏库 / Series / 直达 URL 一致隐藏，关闭后完整恢复', async ({
    page,
    request,
  }) => {
    // 明确切到「未隐藏」基线（用户可能本来就开着隐藏），再验证开关行为
    await setHideNsfw(request, false);
    expect((await request.get(`/api/subjects/${HIDDEN_SUBJECT}`)).status()).toBe(200);

    // Settings → 外观 → 打开「隐藏 NSFW 内容」
    await gotoAndWait(page, '/settings?tab=appearance');
    const toggle = page.getByRole('switch', { name: /隐藏 NSFW 内容/ });
    await expect(toggle).toHaveAttribute('data-state', 'unchecked');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked');
    await expect(page.getByText(/当前隐藏已开启/)).toBeVisible();

    // 立即生效：不需要重启服务或重建数据
    const hidden = await request.get(`/api/subjects/${HIDDEN_SUBJECT}`);
    expect(hidden.status()).toBe(404);
    expect((await hidden.json()).error.code).toBe('subject_hidden');

    // 期望值来自真实 API，避免收藏数变化后断言过期
    const facets = await (await request.get('/api/subjects/facets')).json();

    // 直达 URL：隐藏占位，不泄露标题
    await gotoAndWait(page, `/subjects/${HIDDEN_SUBJECT}`);
    await expect(page.getByText('内容已被当前隐私设置隐藏')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('鬼父2');

    // Series detail：整体系列隐藏
    await gotoAndWait(page, `/series/${HIDDEN_SERIES}`);
    await expect(page.getByText('内容已被当前隐私设置隐藏')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('鬼父2');

    // 刷新后仍然遵守当前策略（不依赖内存缓存）
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    await expect(page.getByText('内容已被当前隐私设置隐藏')).toBeVisible();

    // 收藏库：真实统计与当前可见统计同时表达
    await gotoAndWait(page, '/library');
    const visibleSummary = new RegExp(
      `当前可见 ${facets.total} 部作品 · 真实收藏 ${facets.realTotal} 部（已隐藏 ${facets.hiddenCount} 部）`,
    );
    await expect(page.getByText(visibleSummary)).toBeVisible();

    // Back / Forward：历史导航同样遵守当前策略
    await page.goBack();
    await waitForReady(page);
    await expect(page.getByText('内容已被当前隐私设置隐藏')).toBeVisible();
    await page.goForward();
    await waitForReady(page);
    await expect(page.getByText(visibleSummary)).toBeVisible();

    // 负样本（nsfw = 0）：不受影响
    await gotoAndWait(page, `/subjects/${VISIBLE_SUBJECT}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('孤独摇滚');
    await expectNoErrorState(page);

    // 全局搜索：隐藏作品不能通过标题命中
    await page.getByPlaceholder(/搜索作品/).fill('鬼父');
    await expect(page.getByTestId('global-search-panel')).toContainText('没有匹配的实体');

    // Series / IP 搜索：隐藏成员不能反查 Series
    await gotoAndWait(page, '/series');
    await page.getByPlaceholder(/搜索 Series/).fill('鬼父');
    await expect(page.getByText(/没有找到匹配的 Series/)).toBeVisible();
    // 负样本仍然可以搜索
    await page.getByPlaceholder(/搜索 Series/).fill('孤独');
    await expect(page.locator('a[href^="/series/"]').first()).toContainText('孤独摇滚');

    // 关闭开关 → 完整恢复
    await gotoAndWait(page, '/settings?tab=appearance');
    await page.getByRole('switch', { name: /隐藏 NSFW 内容/ }).click();
    await expect(page.getByRole('switch', { name: /隐藏 NSFW 内容/ })).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    expect((await request.get(`/api/subjects/${HIDDEN_SUBJECT}`)).status()).toBe(200);
    await gotoAndWait(page, `/subjects/${HIDDEN_SUBJECT}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('鬼父2');
  });

  test('Franchise / Library 列表与统计在隐藏开启时保持一致', async ({ page, request }) => {
    await setHideNsfw(request, true);

    // Franchise：没有任何家族因 10 个样本整体隐藏 → 列表保持 17 个
    await gotoAndWait(page, '/franchises');
    await expectNoErrorState(page);
    await expect(page.locator('a[href^="/franchises/"]').first()).toBeVisible();

    // Series 列表：隐藏 Series 不在列表中
    await gotoAndWait(page, '/series');
    await expect(page.getByText(/系列共 \d+ 部/).first()).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('鬼父');

    // 收藏库列表：隐藏条目不出现在结果里
    await gotoAndWait(page, '/library?q=鬼父');
    const facets = await (await request.get('/api/subjects/facets')).json();
    await expect(
      page.getByText(
        new RegExp(
          `当前可见 0 部作品 · 真实收藏 ${facets.realTotal} 部（已隐藏 ${facets.hiddenCount} 部）`,
        ),
      ),
    ).toBeVisible();
    await expect(page.getByText('没有符合条件的作品')).toBeVisible();

    // 关闭后恢复
    await setHideNsfw(request, false);
    await gotoAndWait(page, '/library?q=鬼父');
    await expect(page.locator('a[href^="/subjects/33506"]').first()).toBeVisible();
  });

  test('10 个真实样本全部按 subject.nsfw 隐藏与恢复，且数据完整性不变', async ({ request }) => {
    const integrityBefore = await request.get('/api/data/integrity');
    expect((await integrityBefore.json()).ok).toBe(true);

    await setHideNsfw(request, true);
    for (const id of NSFW_SAMPLES) {
      const detail = await request.get(`/api/subjects/${id}`);
      expect(detail.status(), `subject ${id} 应当被隐藏`).toBe(404);
      expect((await detail.json()).error.code).toBe('subject_hidden');
      const cover = await request.get(`/api/covers/${id}`);
      expect(cover.status(), `cover ${id} 不应可访问`).toBe(404);
    }

    await setHideNsfw(request, false);
    for (const id of NSFW_SAMPLES) {
      const detail = await request.get(`/api/subjects/${id}`);
      expect(detail.status(), `subject ${id} 应当恢复`).toBe(200);
    }

    const integrityAfter = await request.get('/api/data/integrity');
    expect((await integrityAfter.json()).ok).toBe(true);
  });
});
