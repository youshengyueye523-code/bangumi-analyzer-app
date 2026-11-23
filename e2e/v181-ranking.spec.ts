import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.8 Phase 4：Entity Ranking（真实 Local 副本）。
 *
 * 覆盖：Coverage / Completion / Rating 排序、sample ≥ 3 排名域、
 * hidden 不参与、partial hidden 使用 Visible 值、pagination 顺序、
 * search / filter 无回归、hideNsfw 开关不串口径、用户设置捕获与恢复。
 */

let originalHideNsfw = false;

async function setHideNsfw(request: APIRequestContext, value: boolean): Promise<void> {
  const response = await request.put('/api/config', { data: { hideNsfw: value } });
  expect(response.ok()).toBe(true);
}

interface RankingMeta {
  metric: string;
  value: number | null;
  sample: number;
  rankable: boolean;
}

interface RankedRow {
  key: string;
  title: string;
  state?: string;
  ranking?: RankingMeta;
}

function expectRankingDomain(rows: RankedRow[], metric: string): void {
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.ranking?.metric === metric)).toBe(true);
  expect(
    rows.every(
      (row) =>
        row.ranking !== undefined &&
        row.ranking.sample >= 0 &&
        typeof row.ranking.rankable === 'boolean',
    ),
  ).toBe(true);
  // 排名域（sample ≥ 3）整体排在低样本之前
  const firstNonRankable = rows.findIndex((row) => row.ranking && !row.ranking.rankable);
  const lastRankable = rows.map((row) => row.ranking?.rankable === true).lastIndexOf(true);
  if (firstNonRankable >= 0 && lastRankable >= 0) {
    expect(lastRankable).toBeLessThan(firstNonRankable);
  }
  // 排名域内值非升序；低样本不参与该序列
  const values = rows
    .filter((row) => row.ranking?.rankable)
    .map((row) => row.ranking!.value ?? 0);
  expect([...values].sort((a, b) => b - a)).toEqual(values);
  // rankable 与 sample ≥ 3 必须一致
  expect(rows.every((row) => (row.ranking!.sample >= 3) === row.ranking!.rankable)).toBe(true);
}

async function seriesRows(
  request: APIRequestContext,
  sort: string,
  limit = 1000,
): Promise<RankedRow[]> {
  const response = await request.get(`/api/series?sort=${sort}&limit=${limit}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).series as RankedRow[];
}

async function franchiseRows(
  request: APIRequestContext,
  sort: string,
  extra = '',
): Promise<RankedRow[]> {
  const response = await request.get(`/api/franchises?sort=${sort}&limit=500${extra}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).franchises as RankedRow[];
}

test.describe('v1.8 Phase 4 Ranking（真实数据）', () => {
  test.beforeAll(async ({ request }) => {
    const config = await (await request.get('/api/config')).json();
    originalHideNsfw = Boolean(config.hideNsfw);
    await setHideNsfw(request, false);
  });

  test.afterEach(async ({ request }) => {
    await setHideNsfw(request, originalHideNsfw);
  });

  test('Series：Coverage / Completion / Rating 满足排名域与样本门槛', async ({ request }) => {
    for (const [sort, metric] of [
      ['coverage', 'coverage'],
      ['completion', 'completion'],
      ['rate', 'rate'],
    ] as const) {
      const rows = await seriesRows(request, sort);
      expectRankingDomain(rows, metric);
    }

    // Rating：n < 3 一律不 rankable
    const rateRows = await seriesRows(request, 'rate');
    const lowRated = rateRows.filter((row) => row.ranking!.sample < 3);
    expect(lowRated.length).toBeGreaterThan(0);
    expect(lowRated.every((row) => !row.ranking!.rankable)).toBe(true);

    // Coverage：denominator < 3 一律不 rankable（真实数据有大量 denominator=1）
    const coverageRows = await seriesRows(request, 'coverage');
    const lowCoverage = coverageRows.filter((row) => row.ranking!.sample < 3);
    expect(lowCoverage.length).toBeGreaterThan(0);
    expect(lowCoverage.every((row) => !row.ranking!.rankable)).toBe(true);
  });

  test('列表 ranking 值与 Detail analysis 同源（抽样比对）', async ({ request }) => {
    const coverageRows = (await seriesRows(request, 'coverage')).slice(0, 8);
    for (const row of coverageRows) {
      const detail = await (
        await request.get(`/api/series/${encodeURIComponent(row.key)}`)
      ).json();
      expect(row.ranking!.value).toBe(detail.analysis.coverage.value);
      expect(row.ranking!.sample).toBe(detail.analysis.coverage.knownMembers);
    }

    const rateRows = (await seriesRows(request, 'rate')).slice(0, 8);
    for (const row of rateRows) {
      const detail = await (
        await request.get(`/api/series/${encodeURIComponent(row.key)}`)
      ).json();
      expect(row.ranking!.value).toBe(detail.analysis.rating.average.value);
      expect(row.ranking!.sample).toBe(detail.analysis.rating.average.ratedCount);
    }
  });

  test('Franchise：三个排序、ratedCount 与 canonical 平均分同源，不与 Series 混榜', async ({
    request,
  }) => {
    for (const [sort, metric] of [
      ['coverage', 'coverage'],
      ['completion', 'completion'],
      ['rate', 'rate'],
    ] as const) {
      const rows = await franchiseRows(request, sort);
      expectRankingDomain(rows, metric);
      // Franchise 榜单只包含 Franchise（有 seriesCount，无 memberCount）
      expect(rows.every((row) => 'seriesCount' in row && !('memberCount' in row))).toBe(true);
    }

    const rateRows = await franchiseRows(request, 'rate');
    for (const row of rateRows.slice(0, 8)) {
      const detail = await (
        await request.get(`/api/franchises/${encodeURIComponent(row.key)}`)
      ).json();
      // 与 canonical caliber-aware 平均分同源
      expect(row.ranking!.value).toBe(detail.averageRate);
      expect(row.ranking!.value).toBe(detail.analysis.rating.average.value);
      expect(row.ranking!.sample).toBe(detail.analysis.rating.average.ratedCount);
    }
  });

  test('pagination：limit 结果 = 完整排序域的前 N 条', async ({ request }) => {
    const fullSeries = await seriesRows(request, 'rate');
    const limitedSeries = await seriesRows(request, 'rate', 5);
    expect(limitedSeries.map((row) => row.key)).toEqual(
      fullSeries.slice(0, 5).map((row) => row.key),
    );

    const fullFranchises = await franchiseRows(request, 'coverage');
    const response = await request.get('/api/franchises?sort=coverage&limit=3');
    const limited = (await response.json()).franchises as RankedRow[];
    expect(limited.map((row) => row.key)).toEqual(
      fullFranchises.slice(0, 3).map((row) => row.key),
    );
  });

  test('search / filter 无回归：排序不污染搜索域，state 过滤仍生效', async ({ request }) => {
    const rows = await seriesRows(request, 'coverage');
    const probe = rows.find((row) => row.title.trim().length > 3);
    expect(probe).toBeTruthy();
    const search = await (
      await request.get(`/api/series/search?q=${encodeURIComponent(probe!.title)}`)
    ).json();
    expect(search.total).toBeGreaterThan(0);
    expect(
      (search.items as Array<{ key: string }>).some((item) => item.key === probe!.key),
    ).toBe(true);

    const confirmed = await franchiseRows(request, 'coverage', '&state=confirmed');
    expect(confirmed.length).toBeGreaterThan(0);
    expect(confirmed.every((row) => row.state === 'confirmed')).toBe(true);
  });

  test('hideNsfw ON/OFF：hidden 不参与、Visible 值不串 Real', async ({ request }) => {
    const offRows = await seriesRows(request, 'rate');
    await setHideNsfw(request, true);
    const onRows = await seriesRows(request, 'rate');

    // 隐藏 Series 不参与榜单（可见集合是 Real 集合的子集）
    expect(onRows.length).toBeLessThanOrEqual(offRows.length);
    const hiddenKey = process.env.E2E_HIDDEN_SERIES_KEY;
    if (hiddenKey) {
      expect(onRows.some((row) => row.key === hiddenKey)).toBe(false);
    }

    // Visible 排序值必须等于该实体 Visible Detail analysis（不串口径）
    for (const row of onRows.slice(0, 5)) {
      const detail = await (
        await request.get(`/api/series/${encodeURIComponent(row.key)}?visibility=visible`)
      ).json();
      expect(row.ranking!.value).toBe(detail.analysis.rating.average.value);
      expect(row.ranking!.sample).toBe(detail.analysis.rating.average.ratedCount);
    }

    // 部分隐藏 Franchise：Visible 与 Real 值不同，且各自与同口径 detail 一致
    const franchises = await franchiseRows(request, 'rate');
    let partial: RankedRow | null = null;
    for (const row of franchises) {
      const detail = await (
        await request.get(`/api/franchises/${encodeURIComponent(row.key)}?visibility=visible`)
      ).json();
      if (detail.analysis.hidden.members > 0) {
        partial = row;
        break;
      }
    }
    if (partial) {
      const realDetail = await (
        await request.get(`/api/franchises/${encodeURIComponent(partial.key)}?visibility=real`)
      ).json();
      expect(partial.ranking!.value).toBe(
        (
          await (
            await request.get(`/api/franchises/${encodeURIComponent(partial.key)}`)
          ).json()
        ).analysis.rating.average.value,
      );
      expect(partial.ranking!.value).not.toBe(realDetail.analysis.rating.average.value);
    }
  });

  test('UI：Series 列表可切换 Ranking 排序，行内携带样本量', async ({ page }) => {
    await gotoAndWait(page, '/series?sort=coverage');
    await expectNoErrorState(page);
    await expect(page.getByText(/按覆盖率排序：仅样本量 ≥ 3 的条目参与排名/)).toBeVisible();
    await expect(page.getByTestId('ranking-metric-line').first()).toBeVisible();
    await expect(page.getByText(/单样本 · n=1|样本不足 · n=2|n=\d+/).first()).toBeVisible();

    await page.getByRole('button', { name: '系列排序' }).click();
    await page.getByRole('menuitem', { name: /按我的评分/ }).click();
    await page.waitForURL(/sort=rate/);
    await waitForReady(page);
    await expect(page.getByText(/按我的评分排序：仅样本量 ≥ 3 的条目参与排名/)).toBeVisible();
    await expect(page.getByText(/n=\d+|单样本 · n=1|样本不足 · n=2|— 无样本/).first()).toBeVisible();
  });
});
