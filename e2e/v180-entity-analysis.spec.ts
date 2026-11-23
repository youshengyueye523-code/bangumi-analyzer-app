import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.8 Phase 2+3：Entity Analysis（真实 Local 副本）。
 *
 * 口径 / 隐藏场景依赖用户设置与环境夹具：
 * - hideNsfw 在 beforeAll 捕获、afterEach 原样恢复（Constitution §14.4）；
 * - 部分隐藏家族 / 整体隐藏 Series 需要隔离副本中注入 NSFW 夹具，
 *   未提供时明确 skip（不用 0 伪造通过）。
 */

let originalHideNsfw = false;

async function setHideNsfw(request: APIRequestContext, value: boolean): Promise<void> {
  const response = await request.put('/api/config', { data: { hideNsfw: value } });
  expect(response.ok()).toBe(true);
}

interface AnalysisLike {
  visibility: string;
  hidden: { series: number; members: number };
  coverage: { localCollected: number; knownMembers: number; relationOnly: number };
  completion: { watched: number; collectedCount: number };
  statusStructure: { counts: Record<string, number> };
  rating: {
    average: { value: number | null; ratedCount: number };
    delta: { pairedCount: number };
  };
}

interface SeriesDetailLike {
  key: string;
  titleState: string;
  members: Array<{ collected: boolean; relationOnly: boolean }>;
  analysis: AnalysisLike;
}

async function fetchSeriesDetail(
  request: APIRequestContext,
  key: string,
): Promise<SeriesDetailLike> {
  const response = await request.get(`/api/series/${encodeURIComponent(key)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as SeriesDetailLike;
}

test.describe('v1.8 Entity Analysis（真实数据）', () => {
  test.beforeAll(async ({ request }) => {
    const config = await (await request.get('/api/config')).json();
    originalHideNsfw = Boolean(config.hideNsfw);
  });

  test.afterEach(async ({ request }) => {
    await setHideNsfw(request, originalHideNsfw);
  });

  test('Series Detail：A–F 分层、样本量、估算与 relation-only 证据', async ({ page, request }) => {
    const list = await (await request.get('/api/series?limit=300')).json();
    let picked: { key: string } | null = null;
    let detail: SeriesDetailLike | null = null;
    for (const item of (list.series as Array<{ key: string }>).slice(0, 60)) {
      const candidate = await fetchSeriesDetail(request, item.key);
      if (candidate.members.some((member) => member.relationOnly)) {
        picked = item;
        detail = candidate;
        break;
      }
    }
    test.skip(!picked || !detail, '当前数据没有可抽样的 relation-only 系列');

    await gotoAndWait(page, `/series/${encodeURIComponent(picked!.key)}`);
    await expectNoErrorState(page);

    // A：身份层只有标题 / 状态 / 结构规模（不混入分析数字）
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // B：概览 + 状态结构（data-status 与 analysis counts 同源）
    await expect(page.getByText('我与这个系列的关系')).toBeVisible();
    await expect(page.getByText('覆盖率（Entity Coverage）')).toBeVisible();
    await expect(
      page.getByText(
        `看过 ${detail!.analysis.completion.watched} / 收藏 ${detail!.analysis.completion.collectedCount} 部`,
      ),
    ).toBeVisible();
    for (const [status, label] of [
      [2, '看过'],
      [1, '想看'],
      [3, '在看'],
      [4, '搁置'],
      [5, '抛弃'],
    ] as Array<[number, string]>) {
      const card = page.locator(`[data-status="${status}"]`);
      await expect(card).toBeVisible();
      await expect(card).toContainText(label);
      await expect(card).toContainText(
        String(detail!.analysis.statusStructure.counts[String(status)] ?? 0),
      );
    }
    // C：Rating Profile 三项成组（样本量必须可见）
    await expect(page.getByText('我的平均分', { exact: true })).toBeVisible();
    await expect(page.getByText('评分覆盖', { exact: true })).toBeVisible();
    await expect(page.getByText('评分差值', { exact: true })).toBeVisible();
    const ratedCount = detail!.analysis.rating.average.ratedCount;
    if (ratedCount >= 3) {
      await expect(page.getByText(`n=${ratedCount}`).first()).toBeVisible();
    } else if (ratedCount === 1) {
      await expect(page.getByText('单样本 · n=1').first()).toBeVisible();
    } else if (ratedCount === 2) {
      await expect(page.getByText('样本不足 · n=2').first()).toBeVisible();
    } else {
      await expect(page.getByText('— 无样本').first()).toBeVisible();
    }
    // D / E：Air facts 与消费证据（估算标记永久可见）
    await expect(page.getByText('放送时间形状')).toBeVisible();
    await expect(page.getByText('消费证据')).toBeVisible();
    await expect(page.getByText('估算观看时长')).toBeVisible();
    await expect(page.getByText('估算').first()).toBeVisible();
    await expect(page.getByText(/实际观看时长/)).toHaveCount(0);
    // F：relation-only 证据可达
    await expect(page.getByText('仅关系数据').first()).toBeVisible();
  });

  test('样本量语义：单样本 / 样本不足 / n>=3 / 无评分样本', async ({ page, request }) => {
    const list = await (await request.get('/api/series?limit=388')).json();
    const found: Record<string, SeriesDetailLike | null> = {
      one: null,
      two: null,
      many: null,
      none: null,
    };
    for (const item of (list.series as Array<{ key: string }>).slice(0, 140)) {
      const detail = await fetchSeriesDetail(request, item.key);
      const n = detail.analysis.rating.average.ratedCount;
      if (n === 1 && !found.one) found.one = detail;
      if (n === 2 && !found.two) found.two = detail;
      if (n >= 3 && !found.many) found.many = detail;
      if (n === 0 && detail.analysis.coverage.localCollected > 0 && !found.none) {
        found.none = detail;
      }
      if (found.one && found.two && found.many && found.none) break;
    }
    test.skip(!found.one && !found.two && !found.many && !found.none, '当前数据没有可抽样的评分样本');

    if (found.one) {
      await gotoAndWait(page, `/series/${encodeURIComponent(found.one.key)}`);
      await expect(page.getByText('单样本 · n=1').first()).toBeVisible();
    }
    if (found.two) {
      await gotoAndWait(page, `/series/${encodeURIComponent(found.two.key)}`);
      await expect(page.getByText('样本不足 · n=2').first()).toBeVisible();
    }
    if (found.many) {
      await gotoAndWait(page, `/series/${encodeURIComponent(found.many.key)}`);
      await expect(
        page.getByText(`n=${found.many.analysis.rating.average.ratedCount}`).first(),
      ).toBeVisible();
    }
    if (found.none) {
      await gotoAndWait(page, `/series/${encodeURIComponent(found.none.key)}`);
      await expect(page.getByText('— 无样本').first()).toBeVisible();
    }
  });

  test('provisional 标题只影响身份层，不进入指标语义', async ({ page, request }) => {
    const list = await (await request.get('/api/series?limit=388')).json();
    const provisional = (list.series as Array<{ key: string; titleState: string }>).find(
      (item) => item.titleState === 'provisional',
    );
    test.skip(!provisional, '当前数据没有 provisional 系列');

    const detail = await fetchSeriesDetail(request, provisional!.key);
    await gotoAndWait(page, `/series/${encodeURIComponent(provisional!.key)}`);
    await expect(page.getByText('推测').first()).toBeVisible();
    // 指标照常渲染：标题不确定 ≠ 指标不确定
    await expect(page.getByText('我与这个系列的关系')).toBeVisible();
    await expect(page.getByText(`n=${detail.analysis.coverage.knownMembers}`).first()).toBeVisible();
  });

  test('整体隐藏的 Series：HiddenState，不显示 0 / null / 分析数字', async ({ page, request }) => {
    const key = process.env.E2E_HIDDEN_SERIES_KEY;
    test.skip(!key, '未提供隐藏 Series 夹具（E2E_HIDDEN_SERIES_KEY）');
    await setHideNsfw(request, true);

    const response = await request.get(`/api/series/${encodeURIComponent(key!)}`);
    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('series_hidden');

    await gotoAndWait(page, `/series/${encodeURIComponent(key!)}`);
    await expect(page.getByText('内容已被当前隐私设置隐藏')).toBeVisible();
    await expect(page.getByText('我与这个系列的关系')).toHaveCount(0);
    await expect(page.getByText('— 无样本')).toHaveCount(0);
    await expect(page.getByText('0%')).toHaveCount(0);
  });

  test('部分隐藏家族：Visible 口径 + 完整数据切换后整页重算', async ({ page, request }) => {
    await setHideNsfw(request, true);

    const list = await (await request.get('/api/franchises')).json();
    let picked: { key: string } | null = null;
    let visibleDetail: { analysis: AnalysisLike } | null = null;
    for (const item of list.franchises as Array<{ key: string }>) {
      const response = await request.get(`/api/franchises/${encodeURIComponent(item.key)}`);
      if (!response.ok()) continue;
      const detail = await response.json();
      if (detail.analysis?.hidden?.members > 0 && detail.analysis.visibility === 'visible') {
        picked = item;
        visibleDetail = detail;
        break;
      }
    }
    test.skip(!picked || !visibleDetail, '当前真实数据没有部分隐藏的家族（需要隔离副本夹具）');

    const realResponse = await request.get(
      `/api/franchises/${encodeURIComponent(picked!.key)}?visibility=real`,
    );
    expect(realResponse.ok()).toBe(true);
    const realDetail = await realResponse.json();
    expect(realDetail.analysis.visibility).toBe('real');
    expect(realDetail.analysis.coverage.knownMembers).toBeGreaterThan(
      visibleDetail!.analysis.coverage.knownMembers,
    );

    await gotoAndWait(page, `/franchises/${encodeURIComponent(picked!.key)}`);
    await expectNoErrorState(page);
    await expect(page.getByText(/当前可见口径 · 已隐藏/)).toBeVisible();

    await page.getByRole('button', { name: '完整数据' }).click();
    await waitForReady(page);
    await expect(page.getByText(/完整数据口径 · 已包含/)).toBeVisible();
    await expect(
      page.getByText(`n=${realDetail.analysis.coverage.knownMembers}`).first(),
    ).toBeVisible();
  });
});
