import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.6.1 候选治理与验证增强（真实 Local）。
 *
 * 两个测试都执行真实的治理 mutation，并在结尾恢复基线：
 * - 家族候选：Reject → 验证 → 「重新进入评估」恢复候选；
 * - 标题截断：采纳完整候选（manual）→ 验证 → 「恢复自动解析」回到自动结果。
 * 失败时 afterEach 也会尽力恢复，避免污染用户数据库。
 */

let mutatingFranchiseKey: string | null = null;
let mutatingSeriesKey: string | null = null;

async function restoreBaseline(request: APIRequestContext): Promise<void> {
  if (mutatingFranchiseKey) {
    const detail = await request.get(`/api/franchises/${mutatingFranchiseKey}`);
    if (detail.ok()) {
      const body = await detail.json();
      if (body.state === 'rejected') {
        await request.post(`/api/franchises/${mutatingFranchiseKey}/reopen`, { data: {} });
      }
    }
    mutatingFranchiseKey = null;
  }
  if (mutatingSeriesKey) {
    const detail = await request.get(`/api/series/${mutatingSeriesKey}`);
    if (detail.ok()) {
      const body = await detail.json();
      if (body.titleState === 'manual') {
        await request.post(`/api/series/${mutatingSeriesKey}/title/reset`, { data: {} });
      }
    }
    mutatingSeriesKey = null;
  }
}

test.describe('v1.6.1 候选治理', () => {
  test.afterEach(async ({ request }) => {
    await restoreBaseline(request);
  });

  test('家族候选：Reject → 真实状态验证 → 重新进入评估（可逆）', async ({ page, request }) => {
    const before = await (await request.get('/api/diagnostics?refresh=1')).json();
    const target = before.issues.find(
      (issue: { id: string; title: string }) =>
        issue.id.startsWith('franchise.awaiting-review:') && issue.title.includes('LoveLive'),
    );
    /*
     * 家族候选属于用户治理队列：用户确认 / 否决之后就不会再有 LoveLive 候选。
     * 这里按当前真实报告自适应（候选不存在时跳过），治理语义本身由 server 测试覆盖。
     */
    test.skip(!target, '当前真实数据没有待确认的 LoveLive 家族候选（用户已完成治理）');
    if (!target) return;
    const franchiseKey = String(target.id).split(':')[1];
    mutatingFranchiseKey = franchiseKey;

    await gotoAndWait(page, '/diagnostics');
    const card = page.locator('div.card-surface', { hasText: '家族候选' }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText('这是 Analyzer 的推断，不是系统事实')).toBeVisible();

    await card.getByRole('button', { name: /否决该候选/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('修复预览')).toBeVisible();
    await expect(dialog.getByText('直接修改')).toBeVisible();
    await expect(dialog.getByText('自动派生（系统负责重算）')).toBeVisible();
    await expect(dialog.getByText('不会修改')).toBeVisible();
    await expect(dialog.getByText('影响链')).toBeVisible();
    await expect(dialog.getByText(/写入否决决定/)).toBeVisible();
    await expect(dialog.getByText(/新证据可重开/)).toBeVisible();

    await dialog.getByRole('button', { name: /执行修复/ }).click();
    await expect(page.getByText('修复完成并已验证').first()).toBeVisible();
    await expect(page.getByText('否决决定与证据保留').first()).toBeVisible();

    // 真实治理状态
    const detail = await (await request.get(`/api/franchises/${franchiseKey}`)).json();
    expect(detail.state).toBe('rejected');

    // detector：问题消失
    const after = await (await request.get('/api/diagnostics?refresh=1')).json();
    expect(after.issues.some((issue: { id: string }) => issue.id === target.id)).toBe(false);

    // 家族页面：已否决 + 可重新评估
    await gotoAndWait(page, `/franchises/${franchiseKey}`);
    await expectNoErrorState(page);
    await expect(page.getByText('已否决').first()).toBeVisible();
    await page.getByRole('button', { name: /重新进入评估/ }).click();
    await waitForReady(page);
    await expect(page.getByText(/候选家族|暂定家族|存在争议/).first()).toBeVisible();
    const restored = await (await request.get(`/api/franchises/${franchiseKey}`)).json();
    expect(['candidate', 'provisional', 'contested']).toContain(restored.state);

    // 数据中枢恢复显示该候选
    const restoredReport = await (await request.get('/api/diagnostics?refresh=1')).json();
    expect(
      restoredReport.issues.some((issue: { id: string }) => issue.id === target.id),
    ).toBe(true);
    mutatingFranchiseKey = null;
  });

  test('展示标题截断：采纳完整候选 → 验证 → 恢复自动解析（可逆）', async ({ page, request }) => {
    const report = await (await request.get('/api/diagnostics?refresh=1')).json();
    const issue = report.issues.find(
      (entry: { id: string }) => entry.id === 'titles.display-truncated',
    );
    test.skip(
      !issue,
      '真实数据当前没有疑似截断的展示标题（已通过采纳 → 恢复自动解析被 resolver 永久修正）',
    );
    if (!issue) return;
    const adopt = issue.actions.find(
      (action: { kind: string; repairKind?: string }) =>
        action.kind === 'repair' && action.repairKind === 'adopt-title-candidate',
    );
    expect(adopt).toBeTruthy();
    const seriesKey = String(adopt.target);
    const candidateTitle = String(adopt.value);
    mutatingSeriesKey = seriesKey;

    const beforeDetail = await (await request.get(`/api/series/${seriesKey}`)).json();
    expect(beforeDetail.titleState).not.toBe('manual');

    await gotoAndWait(page, '/diagnostics');
    const card = page.locator('div.card-surface', { hasText: '展示标题疑似截断' }).first();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /采纳完整候选/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('修复预览')).toBeVisible();
    await expect(dialog.getByText(/^展示标题「/).first()).toBeVisible();
    await expect(dialog.getByText('影响链')).toBeVisible();
    await dialog.getByRole('button', { name: /执行修复/ }).click();
    await expect(page.getByText('修复完成并已验证').first()).toBeVisible();

    // 真实标题 + 搜索 + detector
    const detail = await (await request.get(`/api/series/${seriesKey}`)).json();
    expect(detail.title).toBe(candidateTitle);
    expect(detail.titleState).toBe('manual');
    const search = await (
      await request.get(`/api/series/search?q=${encodeURIComponent(candidateTitle)}`)
    ).json();
    expect(search.items.some((item: { key: string }) => item.key === seriesKey)).toBe(true);

    // 可逆：恢复自动解析（resolver 会再次给出截断标题，检测重新报告）
    const reset = await request.post(`/api/series/${seriesKey}/title/reset`, { data: {} });
    expect(reset.ok()).toBe(true);
    const afterReset = await (await request.get(`/api/series/${seriesKey}`)).json();
    expect(afterReset.titleState).not.toBe('manual');
    const afterReport = await (await request.get('/api/diagnostics?refresh=1')).json();
    // 恢复自动解析后，该 Series 不应再出现在截断问题里（resolver 会保留更完整的名称；
    // 其他 Series 若仍截断会各自继续报告）
    const truncatedIssue = afterReport.issues.find(
      (entry: { id: string }) => entry.id === 'titles.display-truncated',
    );
    if (truncatedIssue) {
      expect(
        truncatedIssue.affected.some((entity: { href?: string }) =>
          entity.href?.startsWith(`/series/${seriesKey}`),
        ),
      ).toBe(false);
    }
    mutatingSeriesKey = null;
  });
});
