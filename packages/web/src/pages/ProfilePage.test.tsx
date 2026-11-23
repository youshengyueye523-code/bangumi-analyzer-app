import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../components/ui/overlay.js';
import { ToastProvider } from '../components/ui/toast.js';
import { ProfilePage } from './ProfilePage.js';

const DATASET = {
  generatedAt: '2026-09-16T02:00:00.000Z',
  dataVersion: 3,
  sample: { total: 431, rated: 228, highRated: 120, lowRated: 6, yearFrom: 1928, yearTo: 2026, datedSample: 431 },
  basics: {
    statusCounts: { '2': 226 },
    averageRate: 7.6,
    medianRate: 8,
    averageBgmScore: 7.4,
    meanDelta: 0.13,
    deltaStdDev: 0.93,
    completionRate: 0.52,
    watchedEpisodes: 3230,
    totalEpisodes: 5003,
  },
  tags: [{ name: '科幻', count: 88, share: 0.2, averageRate: 7.9, highShare: 0.3, lift: 1.5 }],
  tagPairs: [{ a: '科幻', b: '战斗', count: 26, share: 0.22, expected: 12.4, lift: 2.1 }],
  formats: [{ name: 'TV', count: 298, share: 0.69, averageRate: 7.6, highShare: 0.7, lift: 1.0 }],
  seasons: [],
  originals: [],
  studios: [],
  directors: [],
  length: [{ bucket: '14–26 集', minEpisodes: 14, maxEpisodes: 26, count: 120, averageRate: 7.8, highShare: 0.4 }],
  series: {
    groupedWorks: 73,
    standaloneWorks: 358,
    groupCount: 34,
    averageRateGrouped: 7.9,
    averageRateStandalone: 7.5,
    averageGroupSize: 2.1,
  },
  avoidance: [
    {
      name: '恋爱',
      dimension: '标签',
      count: 40,
      averageRate: 6.8,
      overallAverageRate: 7.6,
      gap: -0.8,
      statusCounts: { '2': 20 },
      abandoned: 6,
      wishOnly: 8,
      unratedCount: 10,
      pattern: 'low-rated',
      note: '接触 40 部、其中 30 部已评分，平均比你的整体平均分低 0.80 分',
    },
  ],
  periods: [
    { period: '2024', count: 20, ratedCount: 10, averageRate: 7.5, topTags: ['科幻'], newTags: ['科幻'], tagEntropy: 3.1, topFormat: 'TV' },
    { period: '2025', count: 30, ratedCount: 18, averageRate: 7.7, topTags: ['日常'], newTags: ['日常'], tagEntropy: 3.4, topFormat: 'TV' },
    { period: '2026', count: 12, ratedCount: 8, averageRate: 7.9, topTags: ['奇幻'], newTags: ['奇幻'], tagEntropy: 3.6, topFormat: 'Movie' },
  ],
  breadth: {
    distinctTags: 2939,
    distinctTagsInHighRated: 812,
    distinctStudios: 260,
    distinctDirectors: 480,
    distinctFormats: 4,
    top5TagShare: 0.62,
    concentration: 0.02,
    earlyPeriodEntropy: 3.1,
    recentPeriodEntropy: 3.6,
    verdict: '兴趣范围在扩大：早期阶段的标签分散度 3.1，最近阶段上升到 3.6。',
  },
  claims: [
    {
      id: 'core-template',
      title: '你的核心审美模板',
      statement: '高分作品中最稳定的标签组合是「科幻 + 战斗」。',
      evidence: ['高分作品共 120 部', '「科幻 + 战斗」共现 26 次'],
      kind: 'data',
      confidence: 'high',
    },
    {
      id: 'avoidance',
      title: '你可能会主动避开的模式',
      statement: '标签「恋爱」：平均比整体低 0.8 分。',
      evidence: ['「恋爱」40 部，平均我的评分 6.8'],
      kind: 'inference',
      confidence: 'medium',
    },
    {
      id: 'period-drift',
      title: '兴趣随时间的变化',
      statement: '当前数据的时间跨度不足，无法判断兴趣变化。',
      evidence: ['可分析的活动年份：1 个'],
      kind: 'data',
      confidence: 'low',
      insufficient: '需要至少 3 个年份的收藏活动记录。',
    },
  ],
  samples: { highRated: [], lowRated: [], abandoned: [] },
};

function installFetch(aiConfigured: boolean, report: unknown = null, snapshots: unknown[] = [], compareReason = '还没有保存过任何阶段快照。') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/profile/dataset')) return json(DATASET);
    if (url.startsWith('/api/config')) return json({ hideNsfw: false });
    if (url.startsWith('/api/profile/snapshots')) return json({ snapshots });
    if (url.startsWith('/api/profile/compare')) return json({ available: false, reason: compareReason, comparison: null });
    if (url.startsWith('/api/profile/ai')) {
      return json({
        configured: aiConfigured,
        enabled: aiConfigured,
        provider: 'openai-compatible',
        model: 'test-model',
        reason: aiConfigured ? '' : '未启用 AI 总结（可在「设置」中开启）',
        report,
      });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter>
            <ProfilePage />
          </MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('我的画像页面', () => {
  beforeEach(() => {
    installFetch(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('没有 AI 时也能完整显示统计画像', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '数据结论' })).toBeTruthy();
    expect(screen.getAllByText('你的核心审美模板').length).toBeGreaterThan(0);
    expect(screen.getByText(/高分作品共 120 部/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '结构明细' })).toBeTruthy();
    // 无 AI 时给出明确说明，而不是空白
    expect(await screen.findByText(/当前未启用 AI 总结/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '去配置 AI' })).toBeTruthy();
  });

  it('区分数据结论与推测，并标注数据不足', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '数据结论' });
    expect(screen.getByRole('heading', { name: '基于行为的推测' })).toBeTruthy();
    expect(screen.getByText(/^当前数据不足：需要至少 3 个年份/)).toBeTruthy();
  });

  it('显示阶段快照为空时的说明', async () => {
    renderPage();
    expect(await screen.findByText(/还没有阶段快照/)).toBeTruthy();
    expect(await screen.findByText(/等待下一阶段复盘数据/)).toBeTruthy();
  });

  it('区分 Real 与口径未确认的历史快照，并显示拒绝对比原因及删除入口', async () => {
    const summary = { createdAt: '2026-10-10T05:00:00Z', collectionCount: 10, ratedCount: 5,
      averageRate: 8, rankFrom: null, rankTo: null, note: '', hasCandidateList: false };
    installFetch(false, null, [
      { ...summary, id: 1, stageLabel: '历史夹具', visibility: null },
      { ...summary, id: 2, stageLabel: 'Real 夹具', visibility: 'real' },
    ], '历史快照口径未确认，不能进行阶段对比；历史记录仍可浏览和删除。');
    renderPage();
    expect(await screen.findByText(/^历史口径未确认 ·/)).toBeTruthy();
    expect(screen.getByText(/^完整数据 ·/)).toBeTruthy();
    expect(await screen.findByText(/不能进行阶段对比/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除快照 历史夹具' })).toBeTruthy();
    expect(screen.getByText(/完整数据画像（Real），不受隐藏设置影响/)).toBeTruthy();
  });

  it('AI 已配置并已有报告时展示总结与证据', async () => {
    installFetch(true, {
      id: 1,
      createdAt: '2026-09-16T02:10:00.000Z',
      provider: 'openai-compatible',
      model: 'test-model',
      datasetHash: 'abc',
      upToDate: true,
      usage: { promptTokens: 1200, completionTokens: 500 },
      output: {
        sections: [
          {
            id: 'what-you-like',
            title: '你到底喜欢什么',
            statement: '你稳定偏好的不是单一题材，而是「科幻 + 战斗」这类组合。',
            evidence: ['高分作品 120 部，其中 26 部同时具备这两个标签'],
            kind: 'data',
            confidence: 'high',
          },
        ],
        verdict: '整体来看，你的高分作品集中在少数几个结构模板上。',
        uncertainties: ['缺少跨阶段快照'],
        surprises: ['你收藏的恋爱类作品评分明显低于整体平均'],
      },
    });
    renderPage();
    expect(await screen.findByText(/你的高分作品集中在少数几个结构模板上/)).toBeTruthy();
    expect(screen.getByText(/你的高分作品集中在少数几个结构模板上/)).toBeTruthy();
    expect(screen.getByText('与你自己认知可能不同的地方')).toBeTruthy();
    expect(screen.getByText(/高分作品 120 部/)).toBeTruthy();
  });
});
