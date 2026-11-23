import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.6.2 治理闭环收口（真实 Local）。
 *
 * 1) 标题候选 Reject → 数据中枢「重新进入评估」（Preview → Execute → Verify）；
 * 2) 治理历史只读展示真实事件（否决 / 重新进入评估）。
 *
 * 两处都是真实治理 mutation，测试结尾（含失败时）恢复基线：把仍处于否决的候选重新进入评估。
 */

interface PickedTarget {
  key: string;
  title: string;
  candidate: string;
}

let rejectedTarget: PickedTarget | null = null;

/**
 * 动态挑选目标：从当前 provisional 清单里找一个「非人工确认、存在非当前展示名的有效候选」的 Series。
 * 真实数据会持续变化（例如用户把某个系列人工确认了），因此不硬编码 key。
 */
async function pickTarget(request: APIRequestContext): Promise<PickedTarget | null> {
  const report = await (await request.get('/api/diagnostics?refresh=1')).json();
  const issue = report.issues.find(
    (entry: { id: string }) => entry.id === 'titles.provisional',
  );
  const keys: string[] = (issue?.affected ?? [])
    .map((entry: { href?: string }) => entry.href?.match(/\/series\/([^?]+)/)?.[1])
    .filter((key: string | undefined): key is string => Boolean(key));
  for (const key of keys.slice(0, 12)) {
    const detail = await (await request.get(`/api/series/${key}`)).json();
    if (detail.titleState === 'manual') continue;
    const candidate =
      detail.titleCandidates.find(
        (entry: { title: string; valid?: boolean }) =>
          entry.valid === true && entry.title !== detail.title,
      ) ?? detail.titleCandidates.find((entry: { valid?: boolean }) => entry.valid === true);
    if (candidate) return { key, title: detail.title, candidate: candidate.title };
  }
  return null;
}

async function restoreBaseline(request: APIRequestContext): Promise<void> {
  if (!rejectedTarget) return;
  try {
    const response = await request.get(`/api/series/${rejectedTarget.key}`);
    if (response.ok()) {
      const body = await response.json();
      const candidate = body.titleCandidates.find(
        (entry: { title: string; rejected?: boolean }) => entry.title === rejectedTarget!.candidate,
      );
      if (candidate?.rejected) {
        await request.post(`/api/series/${rejectedTarget.key}/title/candidates/reopen`, {
          data: { title: rejectedTarget.candidate },
        });
      }
    }
  } finally {
    rejectedTarget = null;
  }
}

test.describe('v1.6.2 治理闭环', () => {
  test.afterEach(async ({ request }) => {
    await restoreBaseline(request);
  });

  test('标题候选 Reject → 重新进入评估（Preview → Execute → Verify）→ 真实状态恢复', async ({
    page,
    request,
  }) => {
    const picked = await pickTarget(request);
    test.skip(!picked, '当前数据库没有可用于候选治理验证的 provisional Series');
    if (!picked) return;
    rejectedTarget = picked;
    const target = { title: picked.candidate };
    const titleBefore = picked.title;

    // 1) Title Review：否决该候选（真实治理动作）
    await gotoAndWait(page, `/series/${picked.key}?review=1`);
    const row = page
      .locator('[data-testid="title-candidate-row"]')
      .filter({ has: page.getByText(target.title, { exact: true }) })
      .first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '否决' }).click();
    await waitForReady(page);

    const afterReject = await (await request.get(`/api/series/${picked.key}`)).json();
    const rejectedCandidate = afterReject.titleCandidates.find(
      (entry: { title: string }) => entry.title === target.title,
    );
    expect(rejectedCandidate.valid).toBe(false);
    expect(rejectedCandidate.rejected).toBe(true);

    // Title Review 里出现「重新进入评估」入口（另一个合法入口）
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForReady(page);
    const rejectedRow = page
      .locator('[data-testid="title-candidate-rejected-row"]')
      .filter({ has: page.getByText(target.title, { exact: true }) })
      .first();
    await expect(rejectedRow.getByRole('button', { name: '重新进入评估' })).toBeVisible();

    // 2) 数据中枢：被否决候选清单 → Repair Preview → Execute → Verify
    await gotoAndWait(page, '/diagnostics');
    const issueCard = page.locator('div.card-surface', { hasText: '个标题候选已被人工否决' }).first();
    await expect(issueCard).toBeVisible();
    await issueCard.getByRole('button', { name: /重新进入评估「/ }).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('修复预览')).toBeVisible();
    await expect(dialog.getByText('直接修改')).toBeVisible();
    await expect(dialog.getByText('影响链')).toBeVisible();
    await expect(dialog.getByText(/不会变成人工确认/)).toBeVisible();
    await dialog.getByRole('button', { name: /执行修复/ }).click();
    await expect(page.getByText('修复完成并已验证').first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('候选重新进入竞争').first()).toBeVisible();
    await expect(page.getByText('不会静默变为人工确认').first()).toBeVisible();

    // 3) 真实状态验证：候选回到竞争、旧否决保留为 superseded、展示名不变、未变成 manual
    const after = await (await request.get(`/api/series/${picked.key}`)).json();
    const restored = after.titleCandidates.find(
      (entry: { title: string }) => entry.title === target.title,
    );
    expect(restored.valid).toBe(true);
    expect(restored.rejected ?? false).toBe(false);
    expect(after.titleState).not.toBe('manual');
    expect(after.title).toBe(titleBefore);
    rejectedTarget = null;
  });

  test('治理历史：只读展示真实的否决 / 重新进入评估记录与证据', async ({ page, request }) => {
    const picked = await pickTarget(request);
    test.skip(!picked, '当前数据库没有可用于候选治理验证的 provisional Series');
    if (!picked) return;
    rejectedTarget = picked;

    // 产生一次真实的否决 + 重新进入评估
    await request.post(`/api/series/${picked.key}/title/candidates/reject`, {
      data: { title: picked.candidate, reason: 'e2e 历史验证' },
    });
    await gotoAndWait(page, '/diagnostics');
    const issueCard = page.locator('div.card-surface', { hasText: '个标题候选已被人工否决' }).first();
    await issueCard.getByRole('button', { name: /重新进入评估「/ }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: /执行修复/ }).click();
    await expect(page.getByText('修复完成并已验证').first()).toBeVisible({ timeout: 60_000 });
    rejectedTarget = null;

    // 历史区：真实事件（否决标题候选 + 候选重新进入评估）+ 证据快照
    const history = page.getByTestId('governance-history');
    await expect(history).toBeVisible();
    // 历史里同时存在大量引擎事件；切到「用户决定」只看治理动作
    await history.getByRole('button', { name: '用户决定' }).click();
    await waitForReady(page);
    await expect(history.getByText('否决标题候选').first()).toBeVisible();
    await expect(history.getByText(/候选重新进入评估：/).first()).toBeVisible();
    await expect(history.getByText('本地用户').first()).toBeVisible();
    await expect(history.getByText('证据快照').first()).toBeVisible();
    await expectNoErrorState(page);

    // 只读：历史区没有确认 / 否决 / 重新进入评估 / 执行修复这类治理动作
    const actionButtons = await history
      .locator('button')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.textContent?.trim() ?? '')
          .filter((text) => /确认|否决|重新进入评估|执行修复/.test(text)),
      );
    expect(actionButtons).toEqual([]);

    // 历史筛选：只看 Series 时仍然包含刚才的记录
    await page.getByRole('button', { name: 'Series', exact: true }).click();
    await waitForReady(page);
    await expect(page.getByTestId('governance-history').getByText('否决标题候选').first()).toBeVisible();
  });

  test('治理历史：展开与「显示更多」都不跳位，每次追加 20 条且无重复', async ({ page }) => {
    await gotoAndWait(page, '/diagnostics');
    const history = page.getByTestId('governance-history');
    await history.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    /**
     * 用鼠标坐标点击，并确保目标在测量前已经完整可见：
     * 直接 locator.click() 会对「部分可见」的元素先做驱动级滚动，那会把测量结果污染成假跳位。
     */
    const ensureInView = async (locator: import('@playwright/test').Locator) => {
      // 把目标放到视口中央（驱动侧准备动作），随后再开始测量，避免把准备滚动算成「跳位」
      await locator.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(250);
      const box = await locator.boundingBox();
      if (!box) throw new Error('target not visible');
      return box;
    };
    const clickAt = async (box: { x: number; y: number; width: number; height: number }) => {
      await page.mouse.click(box.x + Math.min(box.width / 2, 60), box.y + Math.min(box.height / 2, 10));
    };

    // 1) 展开一条记录：滚动位置保持稳定
    const details = history.locator('details').nth(5);
    const expandBox = await ensureInView(details.locator('summary'));
    const beforeExpand = await page.evaluate(() => Math.round(window.scrollY));
    await clickAt(expandBox);
    await page.waitForTimeout(400);
    const afterExpand = await page.evaluate(() => Math.round(window.scrollY));
    expect(Math.abs(afterExpand - beforeExpand)).toBeLessThanOrEqual(4);
    expect(await details.evaluate((node) => node.open)).toBe(true);

    // 2) 显示更多：追加 20 条，且当前位置不跳
    const rowsBefore = await history.locator('details').count();
    const summariesBefore = await history
      .locator('div.rounded-\\[10px\\] > div > span.text-note')
      .allInnerTexts();
    const more = page.getByRole('button', { name: /显示更多/ });
    const moreBox1 = await ensureInView(more);
    const beforeMore = await page.evaluate(() => Math.round(window.scrollY));
    await clickAt(moreBox1);
    await page.waitForTimeout(700);
    const rowsAfter = await history.locator('details').count();
    const afterMore = await page.evaluate(() => Math.round(window.scrollY));
    expect(rowsAfter).toBe(rowsBefore + 20);
    expect(Math.abs(afterMore - beforeMore)).toBeLessThanOrEqual(4);

    // 3) 再点一次：继续 +20，且原有记录顺序与内容保持不动（追加而非替换 / 重复）
    const moreBox2 = await ensureInView(more);
    await clickAt(moreBox2);
    await page.waitForTimeout(700);
    expect(await history.locator('details').count()).toBe(rowsBefore + 40);
    const summaries = await history
      .locator('div.rounded-\\[10px\\] > div > span.text-note')
      .allInnerTexts();
    expect(summaries.slice(0, rowsBefore)).toEqual(summariesBefore);
    await expectNoErrorState(page);
  });
});
