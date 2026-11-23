/**
 * v1.8 Phase 2+3：Series Detail 的 A–F 分层与 sample / 口径语义。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityAnalysis, SeriesDetail, SubjectListItem } from '@bangumi-analyzer/shared';
import { SeriesDetailPage } from './SeriesDetailPage.js';
import { WITHHELD_EVIDENCE } from '../lib/evidenceDisplay.js';

function makeItem(id: number, overrides: Partial<SubjectListItem> = {}): SubjectListItem {
  return {
    id,
    name: `Work ${id}`,
    nameCn: `作品 ${id}`,
    cover: null,
    coverCached: false,
    platform: 'TV',
    format: 'TV',
    date: '2010-04-01',
    year: 2010,
    month: 4,
    season: '春',
    yearQuarter: '2010Q2',
    totalEpisodes: 12,
    collectionType: 2,
    rate: 8,
    epStatus: 12,
    watchedEpisodes: 12,
    progress: 1,
    comment: '',
    userTags: [],
    bgmScore: 7.5,
    bgmRank: 100,
    ratingTotal: 1000,
    collectionTotal: 5000,
    delta: 0.5,
    tags: [],
    studios: [],
    directors: [],
    collectionUpdatedAt: '2024-01-01T00:00:00+08:00',
    firstSeenAt: '2024-01-01T00:00:00Z',
    detailSyncedAt: '2024-01-02T00:00:00Z',
    seriesKey: 'sr_1',
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<EntityAnalysis> = {}): EntityAnalysis {
  return {
    visibility: 'visible',
    hidden: { series: 0, members: 2 },
    coverage: { value: 0.4, knownMembers: 5, localCollected: 2, relationOnly: 1 },
    completion: { value: 0.5, watched: 1, collectedCount: 2 },
    statusStructure: {
      counts: { '1': 0, '2': 1, '3': 0, '4': 1, '5': 0 },
      collectedCount: 2,
      available: true,
    },
    rating: {
      average: { value: 7.5, ratedCount: 1 },
      coverage: { value: 0.5, ratedCount: 1, collectedCount: 2 },
      delta: { value: 0.5, pairedCount: 1 },
    },
    air: {
      span: { firstYear: 2010, lastYear: 2020, datedMembers: 4, totalMembers: 5 },
      distribution: {
        years: [
          { year: 2010, count: 2 },
          { year: 2020, count: 2 },
        ],
        datedMembers: 4,
        totalMembers: 5,
      },
    },
    consumption: {
      watchedMembers: 1,
      watchedEpisodes: 12,
      estimatedWatchTime: {
        minutes: 288,
        isEstimate: true,
        contributingMembers: 1,
        excludedNoEpisodeData: 0,
      },
    },
    ...overrides,
  };
}

function makeDetail(overrides: Partial<SeriesDetail> = {}): SeriesDetail {
  return {
    key: 'sr_1',
    title: '测试系列',
    titleState: 'resolved',
    titleSource: 'anchor',
    state: 'stable',
    memberCount: 5,
    collectedCount: 2,
    confirmedCount: 4,
    candidateCount: 0,
    totalEpisodes: 48,
    averageRate: 7.5,
    firstYear: 2010,
    lastYear: 2020,
    statusCounts: { '2': 1, '4': 1 },
    evidenceCoverage: 'full',
    coverSubjects: [],
    canonicalKey: 'sr_1',
    aliasedFrom: null,
    titleCandidates: [],
    titleConfirmedAt: null,
    franchise: null,
    watch: {
      knownMembers: 5,
      collectedCount: 2,
      candidateCount: 0,
      watched: 1,
      wish: 0,
      watching: 0,
      onHold: 1,
      dropped: 0,
      allWatched: false,
      anyStarted: true,
      insufficient: null,
    },
    members: [
      {
        subjectId: 1,
        title: '测试系列 第一季',
        originalTitle: '',
        year: 2010,
        collected: true,
        relationOnly: false,
        role: 'primary',
        state: 'confirmed',
        reasonCode: 'anchor',
        reason: '系列起点（拓扑）',
        viaSubjectId: null,
        viaRelation: null,
        item: makeItem(1, { nameCn: '测试系列 第一季' }),
      },
      {
        subjectId: 2,
        title: '测试系列 第二季',
        originalTitle: '',
        year: 2020,
        collected: false,
        relationOnly: true,
        role: 'primary',
        state: 'probable',
        reasonCode: 'continuity:续集',
        reason: '续集关系',
        viaSubjectId: 1,
        viaRelation: '续集',
        item: null,
      },
    ],
    related: [],
    mergeCandidates: [],
    analysis: makeAnalysis(),
    ...overrides,
  };
}

function installFetch(detail: SeriesDetail) {
  const urls: string[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      if (url.includes('visibility=real')) {
        return json({
          ...detail,
          analysis: { ...detail.analysis, visibility: 'real' },
        });
      }
      return json(detail);
    }),
  );
  return urls;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/series/sr_1']}>
        <Routes>
          <Route path="/series/:key" element={<SeriesDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Series Detail：Entity Analysis A–F 分层', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('保留名称候选、成员和指标切换，但不请求或展示旧模式的证据', async () => {
    const detail = makeDetail();
    detail.presentation = { version: 1, mode: 'visible', privacyApplied: true, note: '默认显示安全审计摘要' };
    detail.titleCandidates = [{ title: '公开候选名', source: 'anchor', state: 'provisional', evidence: WITHHELD_EVIDENCE }];
    detail.members[0]!.reason = WITHHELD_EVIDENCE;
    const urls = installFetch(detail);
    renderPage();
    await screen.findByRole('heading', { name: '测试系列' });
    expect(screen.getByText(/公开候选名/)).toBeTruthy();
    expect(screen.getByText(/续集关系/)).toBeTruthy();
    expect(screen.queryByText(/默认显示安全审计摘要|受保护证据：原文完整保留/)).toBeNull();
    expect(screen.queryByRole('button', { name: '查看完整审计证据' })).toBeNull();
    fireEvent.click(screen.getByText('完整数据'));
    await waitFor(() => expect(urls.some((url) => url.includes('visibility=real'))).toBe(true));
    expect(urls.every((url) => !url.includes('evidence=real'))).toBe(true);
  });

  it('A 只保留身份；B 概览带样本量，C/D/E 各自成组', async () => {
    installFetch(makeDetail());
    renderPage();

    // A：标题 / 名称状态 / 结构规模，不混入分析数字
    expect(await screen.findByRole('heading', { level: 1, name: '测试系列' })).toBeTruthy();
    expect(screen.getByText(/已知成员 5 部 · 我的收藏 2 部/)).toBeTruthy();
    expect(screen.queryByText('平均我的评分')).toBeNull();

    // B：Coverage / Completion / Status
    expect(screen.getByText('覆盖率（Entity Coverage）')).toBeTruthy();
    expect(screen.getByText('40.0%')).toBeTruthy();
    expect(screen.getByText('n=5')).toBeTruthy();
    expect(screen.getAllByText(/其中 1 部仅由关系数据得知/).length).toBeGreaterThan(0);
    expect(screen.getByText('完成度（member 级）')).toBeTruthy();
    expect(screen.getAllByText('50.0%').length).toBeGreaterThan(0);
    expect(screen.getByText(/看过 1 \/ 收藏 2 部/)).toBeTruthy();
    expect(screen.getByText(/不是集数进度/)).toBeTruthy();

    // C：Rating Profile 三项成组
    expect(screen.getByText('我的平均分')).toBeTruthy();
    expect(screen.getByText('7.50')).toBeTruthy();
    expect(screen.getAllByText('单样本 · n=1').length).toBeGreaterThan(0);
    expect(screen.getByText('评分差值')).toBeTruthy();
    expect(screen.getByText('+0.50')).toBeTruthy();
    expect(screen.getByText(/我的评分 − Bangumi 评分/)).toBeTruthy();

    // D：Air facts
    expect(screen.getByText('2010 – 2020')).toBeTruthy();
    expect(screen.getByText(/基于 4 个有年份的成员（共 5 部）/)).toBeTruthy();
    expect(screen.getByText(/与我的收藏时间无关/)).toBeTruthy();

    // E：消费证据 + 估算
    expect(screen.getByText('估算')).toBeTruthy();
    expect(screen.getByText('4.8 小时')).toBeTruthy();
    expect(screen.queryByText(/实际观看时长/)).toBeNull();
    expect(screen.getByText(/不合成「投入分」/)).toBeTruthy();
  });

  it('F 证据：relation-only 成员标记为「仅关系数据」，评分样本可回溯', async () => {
    installFetch(makeDetail());
    renderPage();

    expect(await screen.findByText('测试系列 第二季')).toBeTruthy();
    expect(screen.getByText('仅关系数据')).toBeTruthy();
    // 评分样本行（C 层）链接到成员锚点
    const sampleLink = screen.getByRole('link', { name: '测试系列 第一季' });
    expect(sampleLink.getAttribute('href')).toBe('#member-1');
  });

  it('口径条：Visible 显示已隐藏范围，切换后整页重新按 Real 拉取', async () => {
    const urls = installFetch(makeDetail());
    renderPage();

    expect(await screen.findByText(/当前可见口径 · 已隐藏 2 个成员/)).toBeTruthy();
    fireEvent.click(screen.getByText('完整数据'));
    await waitFor(() =>
      expect(urls.some((url) => url.includes('/api/series/sr_1?visibility=real'))).toBe(true),
    );
    expect(await screen.findByText(/完整数据口径 · 已包含 2 个成员的隐藏内容/)).toBeTruthy();
  });

  it('无评分样本：显示「— 无样本」而不是 0', async () => {
    installFetch(
      makeDetail({
        members: [],
        analysis: makeAnalysis({
          hidden: { series: 0, members: 0 },
          rating: {
            average: { value: null, ratedCount: 0 },
            coverage: { value: null, ratedCount: 0, collectedCount: 2 },
            delta: { value: null, pairedCount: 0 },
          },
        }),
      }),
    );
    renderPage();

    await screen.findByText('我的平均分');
    expect(screen.getAllByText('— 无样本').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/当前没有可展示的评分样本/)).toBeTruthy();
  });

  it('评分样本点击：目标成员进入视口焦点（hash + 高亮 + 滚动），href 保留（v1.8.1）', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    installFetch(makeDetail());
    renderPage();

    const links = await screen.findAllByRole('link', { name: '测试系列 第一季' });
    const sampleLink = links[0]!;
    // 首个链接必须是评分样本（保留 href 供复制 / 中键）
    expect(sampleLink.getAttribute('href')).toBe('#member-1');
    fireEvent.click(sampleLink);

    const target = document.getElementById('member-1');
    expect(target).toBeTruthy();
    expect(target!.className).toContain('entity-member-focus');
    expect(window.location.hash).toBe('#member-1');
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
  });

  it('直接带 hash 打开：数据就绪后自动定位成员（v1.8.1）', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    window.history.replaceState(null, '', '#member-1');
    installFetch(makeDetail());
    renderPage();

    await screen.findByRole('heading', { level: 1, name: '测试系列' });
    await waitFor(() =>
      expect(document.getElementById('member-1')?.className).toContain('entity-member-focus'),
    );
    expect(scrollTo).toHaveBeenCalled();
  });
});
