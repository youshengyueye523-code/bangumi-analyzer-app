/**
 * v1.7.0：Franchise 成员 / 名称治理（真实 Local）。
 *
 * Case A：fr_1（LoveLive + 机动战士高达）→ 移出错误成员 → 验证 → 撤销排除 → 验证；
 * Case B：fr_7（钢之炼金术师 + 黄泉使者）→ 重复同一闭环；
 * Case C：已确认但没有可靠名称的家族 → 设置人工名称 → 验证 → 恢复自动解析 → 验证。
 *
 * 三个用例都执行真实治理 mutation，测试结尾（含失败时）恢复基线：
 * 撤销测试创建的排除、恢复自动解析，并把人工否决过的家族重新置回 rejected。
 * 排除记录 / 治理事件会作为 provenance 保留（不是「临时治理状态」）。
 */
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

interface TrackedFranchise {
  key: string;
  /** 测试结束需要恢复到的治理状态（仅在非 confirmed 时需要）。 */
  restoreState: string | null;
  adoptedTitle: boolean;
}

const tracked: TrackedFranchise[] = [];

function track(entry: TrackedFranchise): TrackedFranchise {
  tracked.push(entry);
  return entry;
}

async function franchiseDetail(request: APIRequestContext, key: string) {
  const response = await request.get(`/api/franchises/${key}`);
  return response.ok() ? await response.json() : null;
}

async function runGovernance(
  request: APIRequestContext,
  key: string,
  data: Record<string, unknown>,
): Promise<{ verified: boolean; partial: boolean; checks: Array<{ layer: string; ok: boolean }> }> {
  const response = await request.post(`/api/franchises/${key}/governance`, { data });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  return body.verification;
}

/** 恢复基线：撤销排除 → 恢复自动解析 → 重新置回原有治理状态。 */
async function restoreBaseline(request: APIRequestContext): Promise<void> {
  for (const entry of tracked.splice(0)) {
    let detail = await franchiseDetail(request, entry.key);
    if (!detail) continue;
    for (const exclusion of detail.exclusions ?? []) {
      if (exclusion.state !== 'active') continue;
      await runGovernance(request, entry.key, {
        kind: 'reopen-franchise-member',
        series: exclusion.seriesKey,
        reason: 'E2E 恢复基线：撤销测试创建的成员排除',
      });
    }
    detail = await franchiseDetail(request, entry.key);
    if (entry.adoptedTitle && detail?.titleState === 'manual') {
      await runGovernance(request, entry.key, {
        kind: 'reset-franchise-title',
        reason: 'E2E 恢复基线：恢复自动解析',
      });
    }
    detail = await franchiseDetail(request, entry.key);
    if (entry.restoreState && detail && detail.state !== entry.restoreState) {
      const response = await request.post(`/api/franchises/${entry.key}/reject`, {
        data: { reason: 'E2E 恢复基线：恢复原有否决状态' },
      });
      expect(response.ok()).toBe(true);
    }
  }
}

async function executeGovernanceDialog(page: Page, expectedTitle: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(expectedTitle)).toBeVisible();
  await expect(dialog.getByText('直接修改')).toBeVisible();
  await expect(dialog.getByText('自动派生（系统负责重算）')).toBeVisible();
  await expect(dialog.getByText('不会修改')).toBeVisible();
  await expect(dialog.getByText('影响链')).toBeVisible();
  await dialog.getByRole('button', { name: /执行修复/ }).click();
  await expect(page.getByText('修复完成并已验证').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('v1.7.0 Franchise 成员 / 名称治理（真实 Local）', () => {
  test.afterEach(async ({ request }) => {
    await restoreBaseline(request);
  });

  test('Case A：fr_1 移出机动战士高达 → Verify → 撤销排除 → Verify', async ({ page, request }) => {
    const before = await franchiseDetail(request, 'fr_1');
    test.skip(!before, '当前真实数据没有 fr_1');
    if (!before) return;
    const polluter = (before.series as Array<{ key: string; title: string }>).find((entry) =>
      entry.title.includes('高达'),
    );
    test.skip(!polluter, 'fr_1 当前没有「机动战士高达」成员（已被治理）');
    if (!polluter) return;
    track({ key: 'fr_1', restoreState: before.state, adoptedTitle: false });
    const versionBefore = (await (await request.get('/api/diagnostics')).json()).dataVersion;

    await gotoAndWait(page, '/franchises/fr_1');
    await expectNoErrorState(page);
    const memberCard = page
      .locator('section.card-surface')
      .filter({ hasText: polluter.title })
      .first();
    await expect(memberCard).toBeVisible();
    await memberCard.getByRole('button', { name: '移出该家族' }).click();
    await executeGovernanceDialog(page, '移出这个家族成员？');
    await page.getByRole('button', { name: '完成' }).click();

    // 真实状态：排除已写入、成员被移出、不会自动确认
    const afterExclude = await franchiseDetail(request, 'fr_1');
    expect(
      (afterExclude.series as Array<{ key: string }>).some((entry) => entry.key === polluter.key),
    ).toBe(false);
    const exclusion = (afterExclude.exclusions as Array<{ seriesKey: string; state: string }>).find(
      (entry) => entry.seriesKey === polluter.key,
    );
    expect(exclusion?.state).toBe('active');
    expect(afterExclude.state).not.toBe('confirmed');
    // 家族内其他成员保留
    expect((afterExclude.series as unknown[]).length).toBeGreaterThanOrEqual(1);
    // 搜索：被移出的成员不再命中该家族
    const search = await (
      await request.get(`/api/franchises/search?q=${encodeURIComponent(polluter.title)}`)
    ).json();
    expect(
      (search.items as Array<{ key: string }>).some((item) => item.key === 'fr_1'),
    ).toBe(false);
    // Mutation Contract：数据版本推进，诊断报告可重新检测且没有新的派生错误
    const report = await (await request.get('/api/diagnostics?refresh=1')).json();
    expect(report.dataVersion).toBeGreaterThan(versionBefore);
    expect(
      (report.issues as Array<{ id: string }>).some((issue) => issue.id === 'franchise.counter-drift'),
    ).toBe(false);

    // 重新进入评估：按当前证据重新纳入（不强制、不自动确认）
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    const exclusionRow = page
      .locator('[data-testid="franchise-exclusion-row"]')
      .filter({ hasText: polluter.title })
      .first();
    await expect(exclusionRow.getByText('已移出')).toBeVisible();
    await exclusionRow.getByRole('button', { name: /撤销排除（重新评估）/ }).click();
    await executeGovernanceDialog(page, '撤销成员排除？');
    await page.getByRole('button', { name: '完成' }).click();

    const afterReopen = await franchiseDetail(request, 'fr_1');
    expect(
      (afterReopen.series as Array<{ key: string }>).some((entry) => entry.key === polluter.key),
    ).toBe(true);
    expect(afterReopen.state).not.toBe('confirmed');
    expect(
      (afterReopen.exclusions as Array<{ state: string }>).every((entry) => entry.state === 'revoked'),
    ).toBe(true);
  });

  test('Case B：fr_7 移出黄泉使者 → Verify → 撤销排除 → Verify', async ({ page, request }) => {
    const before = await franchiseDetail(request, 'fr_7');
    test.skip(!before, '当前真实数据没有 fr_7');
    if (!before) return;
    const polluter = (before.series as Array<{ key: string; title: string }>).find((entry) =>
      entry.title.includes('黄泉使者'),
    );
    test.skip(!polluter, 'fr_7 当前没有「黄泉使者」成员（已被治理）');
    if (!polluter) return;
    track({ key: 'fr_7', restoreState: before.state, adoptedTitle: false });

    await gotoAndWait(page, '/franchises/fr_7');
    await expectNoErrorState(page);
    const memberCard = page
      .locator('section.card-surface')
      .filter({ hasText: polluter.title })
      .first();
    await memberCard.getByRole('button', { name: '移出该家族' }).click();
    await executeGovernanceDialog(page, '移出这个家族成员？');
    await page.getByRole('button', { name: '完成' }).click();

    const afterExclude = await franchiseDetail(request, 'fr_7');
    expect(
      (afterExclude.series as Array<{ key: string }>).some((entry) => entry.key === polluter.key),
    ).toBe(false);
    expect(afterExclude.state).not.toBe('confirmed');
    // 「钢之炼金术师」家族成员保留，原始 Series 数据仍然存在
    expect((afterExclude.series as unknown[]).length).toBeGreaterThanOrEqual(1);
    const seriesStillExists = await request.get(`/api/series/${polluter.key}`);
    expect(seriesStillExists.ok()).toBe(true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    const exclusionRow = page
      .locator('[data-testid="franchise-exclusion-row"]')
      .filter({ hasText: polluter.title })
      .first();
    await exclusionRow.getByRole('button', { name: /撤销排除（重新评估）/ }).click();
    await executeGovernanceDialog(page, '撤销成员排除？');
    await page.getByRole('button', { name: '完成' }).click();

    const afterReopen = await franchiseDetail(request, 'fr_7');
    expect(
      (afterReopen.series as Array<{ key: string }>).some((entry) => entry.key === polluter.key),
    ).toBe(true);
    expect(afterReopen.state).not.toBe('confirmed');
  });

  test('Case C：没有可靠名称的已确认家族 → 人工命名 → 恢复自动解析', async ({ page, request }) => {
    const list = await (await request.get('/api/franchises?limit=100')).json();
    const target = (list.franchises as Array<{ key: string; state: string; titleState: string }>).find(
      (entry) => entry.state === 'confirmed' && entry.titleState === 'unresolved',
    );
    test.skip(!target, '当前真实数据没有「已确认但名称为 fallback」的家族');
    if (!target) return;
    const before = await franchiseDetail(request, target.key);
    const membersBefore = (before.series as Array<{ key: string }>).map((entry) => entry.key).sort();
    track({ key: target.key, restoreState: null, adoptedTitle: true });
    const manualTitle = 'E2E 人工命名验证';

    await gotoAndWait(page, `/franchises/${target.key}`);
    await page.getByRole('button', { name: '设置名称' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('家族名称').fill(manualTitle);
    await dialog.getByRole('button', { name: '查看变更预览' }).click();
    await executeGovernanceDialog(page, `设置家族名称`);
    await page.getByRole('button', { name: '完成' }).click();

    const afterAdopt = await franchiseDetail(request, target.key);
    expect(afterAdopt.title).toBe(manualTitle);
    expect(afterAdopt.titleState).toBe('manual');
    expect(afterAdopt.state).toBe('confirmed');
    // 名称治理不改变成员构成
    expect(
      (afterAdopt.series as Array<{ key: string }>).map((entry) => entry.key).sort(),
    ).toEqual(membersBefore);
    // 搜索 / API / UI 同步
    const search = await (
      await request.get(`/api/franchises/search?q=${encodeURIComponent(manualTitle)}`)
    ).json();
    expect((search.items as Array<{ key: string }>).some((item) => item.key === target.key)).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    await expect(page.getByText(manualTitle).first()).toBeVisible();
    await expect(page.getByText('人工确认名称')).toBeVisible();

    // 恢复自动解析：名称回到当前证据决定，成员仍然不变
    await page.getByRole('button', { name: '恢复自动解析' }).click();
    await executeGovernanceDialog(page, '恢复自动解析？');
    await page.getByRole('button', { name: '完成' }).click();

    const afterReset = await franchiseDetail(request, target.key);
    expect(afterReset.titleState).not.toBe('manual');
    expect(afterReset.title).toBe(before.title);
    expect(afterReset.state).toBe('confirmed');
    expect(
      (afterReset.series as Array<{ key: string }>).map((entry) => entry.key).sort(),
    ).toEqual(membersBefore);
  });
});
