import { expect, test } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.6.0 数据中枢（真实 Local 数据，只读验证）。
 *
 * 本 spec 不执行任何会修改用户数据的修复：
 * - 验证导航、真实报告、证据与影响范围；
 * - 验证 Repair Preview 的完整内容后取消；
 * - 验证 Title Review 深链可以打开候选列表。
 */

test.describe('数据中枢', () => {
  test('导航位置与页面结构：Settings 上方、Profile 下方', async ({ page }) => {
    await gotoAndWait(page, '/');

    const navLabels = await page.locator('nav a').allInnerTexts();
    const profileIndex = navLabels.findIndex((label) => label.includes('我的画像'));
    const dataCenterIndex = navLabels.findIndex((label) => label.includes('数据中枢'));
    const settingsIndex = navLabels.findIndex((label) => label.includes('设置'));
    expect(dataCenterIndex).toBeGreaterThan(profileIndex);
    expect(dataCenterIndex).toBeLessThan(settingsIndex);

    await page.getByRole('link', { name: '数据中枢' }).click();
    await page.waitForURL(/\/diagnostics$/);
    await waitForReady(page);
    await expectNoErrorState(page);
    await expect(page.getByRole('heading', { name: '数据中枢' })).toBeVisible();
    await expect(page.getByText('存储与数据库')).toBeVisible();
    await expect(page.getByText(/最后检查/)).toBeVisible();
  });

  test('真实报告：模块状态、真实问题与「暂定不是错误」的语义', async ({ page }) => {
    await gotoAndWait(page, '/diagnostics');

    // 数据规模与检测范围来自真实数据
    // （隐藏 NSFW 开启时，可见性模块也会出现「… Series · … Franchise」文案，这里取页头第一条）
    await expect(page.getByText(/Subjects · .*Series · .*Franchise/).first()).toBeVisible();
    await expect(page.getByText(/共检查 [\d,]+ 条记录/)).toBeVisible();

    /*
     * 待确认家族候选（若当前存在）：证据 + 影响范围 + 修复动作。
     * 真实数据中的家族会被用户逐个人工处理，因此这里按当前报告自适应，
     * 不把「必须还有候选」写死（治理结果由用户决定）。
     */
    const report = await (await page.request.get('/api/diagnostics?refresh=1')).json();
    const hasFranchiseCandidate = (report.issues as Array<{ id: string }>).some((issue) =>
      issue.id.startsWith('franchise.awaiting-review:'),
    );
    if (hasFranchiseCandidate) {
      const franchiseIssue = page
        .locator('div.card-surface', { hasText: '等待人工确认' })
        .first();
      await expect(franchiseIssue).toBeVisible();
      await expect(franchiseIssue.getByText('证据', { exact: true })).toBeVisible();
      await expect(franchiseIssue.getByText('影响范围', { exact: true })).toBeVisible();
      await expect(franchiseIssue.getByRole('button', { name: /确认该家族/ })).toBeVisible();
    }

    // 暂定标题属于「当前不确定」，不是错误，也没有修复按钮
    const provisional = page.locator('div.card-surface', { hasText: '标题仍是暂定' }).first();
    await expect(provisional).toBeVisible();
    await expect(provisional.getByText('当前不确定')).toBeVisible();
    await expect(provisional.getByRole('button', { name: /重建|修复/ })).toHaveCount(0);
    await expect(provisional.getByRole('link', { name: /去 Title Review 处理/ })).toBeVisible();
  });

  test('Repair Preview：展示改什么 / 为什么 / 影响什么 / 不碰什么；取消不修改数据', async ({
    page,
    request,
  }) => {
    const beforeReport = await (await request.get('/api/diagnostics?refresh=1')).json();
    const beforeIssueIds = beforeReport.issues.map((issue: { id: string }) => issue.id);

    // 找一个当前真实存在的、带修复动作的问题（不写死具体类型）
    const repairable = (beforeReport.issues as Array<{
      id: string;
      actions: Array<{ kind: string; label: string; repairKind?: string }>;
    }>).find((issue) => issue.actions.some((action) => action.kind === 'repair'));
    test.skip(!repairable, '当前真实报告没有带修复动作的问题（治理队列已处理完）');
    if (!repairable) return;
    const repairAction = repairable.actions.find((action) => action.kind === 'repair')!;

    await gotoAndWait(page, '/diagnostics');
    await page.getByRole('button', { name: repairAction.label }).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('修复预览')).toBeVisible();
    await expect(dialog.getByText('当前', { exact: true })).toBeVisible();
    await expect(dialog.getByText('将修改为', { exact: true })).toBeVisible();
    await expect(dialog.getByText('为什么修改')).toBeVisible();
    await expect(dialog.getByText('修改来源')).toBeVisible();
    await expect(dialog.getByText('直接修改')).toBeVisible();
    await expect(dialog.getByText('自动派生（系统负责重算）')).toBeVisible();
    await expect(dialog.getByText('不会修改')).toBeVisible();
    await expect(dialog.getByText('影响链')).toBeVisible();

    // 取消：不执行修复，真实数据与报告保持不变
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const after = await request.get('/api/diagnostics?refresh=1');
    const afterReport = await after.json();
    expect(afterReport.issues.map((issue: { id: string }) => issue.id)).toEqual(beforeIssueIds);
  });

  test('Title Review 深链：从数据中枢直接打开候选列表', async ({ page }) => {
    await gotoAndWait(page, '/diagnostics');
    const link = page.getByRole('link', { name: /去 Title Review 处理/ }).first();
    const href = await link.getAttribute('href');
    expect(href).toContain('/series/');
    expect(href).toContain('review=1');

    await link.click();
    await page.waitForURL(/\/series\/[^/?]+\?review=1$/);
    await waitForReady(page);
    await expectNoErrorState(page);
    // 候选列表默认展开：按钮显示「收起候选」，并且候选来源可见
    await expect(page.getByRole('button', { name: '收起候选' })).toBeVisible();
  });
});
