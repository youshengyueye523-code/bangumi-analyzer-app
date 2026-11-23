/**
 * v1.8 Phase 4：Series / Franchise 列表的 Ranking UI（排序项、门槛说明、行内样本量）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FranchiseSummary, SeriesGroupSummary } from '@bangumi-analyzer/shared';
import { FranchisePage } from './FranchisePage.js';
import { SeriesPage } from './SeriesPage.js';

function makeSeries(overrides: Partial<SeriesGroupSummary> = {}): SeriesGroupSummary {
  return {
    key: 'sr_1',
    title: '测试系列',
    titleState: 'resolved',
    titleSource: 'anchor',
    state: 'stable',
    memberCount: 5,
    collectedCount: 3,
    confirmedCount: 4,
    candidateCount: 0,
    totalEpisodes: 48,
    averageRate: 7.5,
    firstYear: 2010,
    lastYear: 2020,
    statusCounts: { '2': 2, '4': 1 },
    evidenceCoverage: 'full',
    coverSubjects: [],
    ...overrides,
  };
}

function makeFranchise(overrides: Partial<FranchiseSummary> = {}): FranchiseSummary {
  return {
    key: 'fr_1',
    title: '测试家族',
    titleState: 'resolved',
    titleSource: 'brand:members',
    state: 'confirmed',
    seriesCount: 3,
    confirmedSeriesCount: 3,
    candidateSeriesCount: 0,
    conflictSeriesCount: 0,
    collectedCount: 6,
    knownCount: 9,
    averageRate: 8.67,
    firstYear: 2010,
    lastYear: 2020,
    coverSubjects: [],
    ...overrides,
  };
}

function installFetch(payload: { series?: SeriesGroupSummary[]; franchises?: FranchiseSummary[] }) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      if (url.startsWith('/api/series')) return json({ series: payload.series ?? [] });
      if (url.startsWith('/api/franchises')) return json({ franchises: payload.franchises ?? [] });
      if (url.startsWith('/api/config')) return json({ hideNsfw: false });
      return json({});
    }),
  );
  return urls;
}

function renderAt(path: string, ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Series 列表 Ranking UI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('按覆盖率排序：展示门槛说明与行内样本量，低样本仍展示', async () => {
    const urls = installFetch({
      series: [
        makeSeries({
          key: 'sr_a',
          title: '覆盖系列',
          ranking: { metric: 'coverage', value: 0.75, sample: 5, rankable: true },
        }),
        makeSeries({
          key: 'sr_b',
          title: '单样本系列',
          ranking: { metric: 'coverage', value: 1, sample: 1, rankable: false },
        }),
      ],
    });
    renderAt('/series?sort=coverage', <SeriesPage />);

    expect(
      await screen.findByText(/按覆盖率排序：仅样本量 ≥ 3 的条目参与排名/),
    ).toBeTruthy();
    expect(await screen.findByText('n=5')).toBeTruthy();
    // 低样本仍展示数值，但明确标记未参与排名
    expect(await screen.findByText('单样本 · n=1')).toBeTruthy();
    expect(screen.getByText('100.0%')).toBeTruthy();
    expect(urls.some((url) => url.includes('sort=coverage'))).toBe(true);
  });

  it('切换排序到「按我的评分」：URL 与请求同步更新，并显示 n=', async () => {
    const urls = installFetch({
      series: [
        makeSeries({
          ranking: { metric: 'rate', value: 8.4, sample: 7, rankable: true },
        }),
      ],
    });
    renderAt('/series?sort=size', <SeriesPage />);

    const trigger = await screen.findByRole('button', { name: '系列排序' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const options = await screen.findAllByRole('menuitem');
    const rate = options.find((item) => item.textContent?.includes('按我的评分'));
    expect(rate).toBeTruthy();
    rate!.focus();
    fireEvent.keyDown(rate!, { key: 'Enter' });

    await waitFor(() => expect(urls.some((url) => url.includes('sort=rate'))).toBe(true));
    expect(await screen.findByText(/按我的评分排序：仅样本量 ≥ 3 的条目参与排名/)).toBeTruthy();
    expect(await screen.findByText('8.40')).toBeTruthy();
    expect(screen.getByText('n=7')).toBeTruthy();
    // 行内不再重复展示无样本的平均分
    expect(screen.queryByText(/平均我的评分/)).toBeNull();
  });
});

describe('Franchise 列表 Ranking UI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('按我的评分排序：行内显示 rating + ratedCount，并说明门槛', async () => {
    installFetch({
      franchises: [
        makeFranchise({
          ranking: { metric: 'rate', value: 8.67, sample: 6, rankable: true },
        }),
      ],
    });
    renderAt('/franchises?sort=rate', <FranchisePage />);

    expect(await screen.findByText(/按我的评分排序：仅样本量 ≥ 3 的家族参与排名/)).toBeTruthy();
    expect(await screen.findByText('8.67')).toBeTruthy();
    expect(screen.getByText('n=6')).toBeTruthy();
    expect(screen.queryByText(/^平均 8\.67$/)).toBeNull();
  });
});
