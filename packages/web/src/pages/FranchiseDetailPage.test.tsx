/**
 * v1.7.0：Franchise 成员 / 名称治理 UI（Preview → Execute → Verify）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityAnalysis, FranchiseDetail } from '@bangumi-analyzer/shared';
import { FranchiseDetailPage } from './FranchiseDetailPage.js';
import { WITHHELD_EVIDENCE } from '../lib/evidenceDisplay.js';

describe('直接家族治理的失败、等待及不确定结果', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['escape','cancel'] as const)('否决确认后立即%s仍保持提交上下文',async(close)=>{
    let release!: (value:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      if(String(input).endsWith('/reject')&&init?.method==='POST')return new Promise<Response>(r=>release=r);
      return new Response(JSON.stringify(makeDetail({state:'candidate'})),{headers:{'content-type':'application/json'}});
    }));
    renderPage();fireEvent.click(await screen.findByRole('button',{name:'否决该家族'}));
    const button=screen.getByRole('button',{name:'确认否决'});
    // Dispatch both events in one React batch to exercise the pre-pending render gap.
    const {act}=await import('@testing-library/react');
    act(()=>{fireEvent.click(button);if(close==='cancel')fireEvent.click(screen.getByRole('button',{name:'取消'}));else fireEvent.keyDown(document,{key:'Escape'});});
    expect(screen.queryByRole('dialog')).toBeTruthy();await waitFor(()=>expect(release).toBeTypeOf('function'));
    release(new Response('{"error":{"message":"503"}}',{status:503}));
    await screen.findAllByText(/否决未成功/);
  });
  it.each([
    ['confirm', 'candidate', '确认该家族', 'confirmed'],
    ['reopen', 'rejected', '重新进入评估', 'candidate'],
    ['reject', 'candidate', '确认否决', 'rejected'],
  ] as const)('%s慢失败不能重复提交，失败后原操作可重试', async (action, initial, label, next) => {
    let state: string = initial, count=0, failing=true, release!: (value: Response) => void;
    const json=(value: unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
    vi.stubGlobal('fetch',vi.fn(async (input: RequestInfo | URL, init?: RequestInit)=>{
      const url=String(input);
      if(url.includes('/'+action) && init?.method==='POST'){
        count++;
        if(failing) return new Promise<Response>(resolve=>{release=resolve;});
        state=next;return json({[action==='confirm'?'confirmed':action==='reopen'?'reopened':'rejected']:true});
      }
      if(url.startsWith('/api/franchises/'))return json(makeDetail({state:state as FranchiseDetail['state']}));
      return json({error:{message:'未使用接口'}},404);
    }));
    renderPage();
    if(action==='reject')fireEvent.click(await screen.findByRole('button',{name:'否决该家族'}));
    const button=await screen.findByRole('button',{name:label});fireEvent.click(button);fireEvent.click(button);
    await waitFor(()=>expect(count).toBe(1));expect((button as HTMLButtonElement).disabled).toBe(true);
    release(json({error:{code:'isolated_failure',message:'隔离503'}},503));
    await waitFor(()=>expect(screen.getAllByText(/未成功/).length).toBeGreaterThan(0));expect(state).toBe(initial);
    failing=false;fireEvent.click(await screen.findByRole('button',{name:label}));await waitFor(()=>expect(state).toBe(next));expect(count).toBe(2);
  });
  it('提交后响应丢失不称未执行，先读取真实状态再解锁',async()=>{
    let state: FranchiseDetail['state']='candidate',posts=0;
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      if(String(input).endsWith('/confirm') && init?.method==='POST'){posts++;state='confirmed';throw new Error('响应丢失');}
      return new Response(JSON.stringify(makeDetail({state})),{headers:{'content-type':'application/json'}});
    }));
    renderPage();fireEvent.click(await screen.findByRole('button',{name:'确认该家族'}));
    expect(await screen.findByText(/确认结果尚未确认/)).toBeTruthy();
    expect((screen.getByRole('button',{name:'确认该家族'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'读取当前状态'}));
    expect(await screen.findByText(/已确认 · 自动重算不会覆盖/)).toBeTruthy();expect(posts).toBe(1);
  });
});

function makeAnalysis(overrides: Partial<EntityAnalysis> = {}): EntityAnalysis {
  return {
    visibility: 'visible',
    hidden: { series: 0, members: 0 },
    coverage: { value: 0.67, knownMembers: 12, localCollected: 8, relationOnly: 2 },
    completion: { value: 0.5, watched: 4, collectedCount: 8 },
    statusStructure: {
      counts: { '1': 2, '2': 4, '3': 1, '4': 1, '5': 0 },
      collectedCount: 8,
      available: true,
    },
    rating: {
      average: { value: 7.5, ratedCount: 6 },
      coverage: { value: 0.75, ratedCount: 6, collectedCount: 8 },
      delta: { value: 0.4, pairedCount: 6 },
    },
    air: {
      span: { firstYear: 2010, lastYear: 2020, datedMembers: 10, totalMembers: 12 },
      distribution: {
        years: [{ year: 2010, count: 1 }],
        datedMembers: 10,
        totalMembers: 12,
      },
    },
    consumption: {
      watchedMembers: 4,
      watchedEpisodes: 48,
      estimatedWatchTime: {
        minutes: 1152,
        isEstimate: true,
        contributingMembers: 4,
        excludedNoEpisodeData: 0,
      },
    },
    ...overrides,
  };
}

function makeDetail(overrides: Partial<FranchiseDetail> = {}): FranchiseDetail {
  return {
    key: 'fr_1',
    title: 'LoveLive',
    titleState: 'resolved',
    titleSource: 'brand:members',
    state: 'rejected',
    seriesCount: 3,
    confirmedSeriesCount: 0,
    candidateSeriesCount: 2,
    conflictSeriesCount: 0,
    collectedCount: 8,
    knownCount: 12,
    averageRate: 7.5,
    firstYear: 2010,
    lastYear: 2020,
    coverSubjects: [],
    canonicalKey: 'fr_1',
    aliasedFrom: null,
    titleCandidates: [],
    identityConflicts: [],
    series: [
      {
        key: 'sr_11',
        title: '机动战士高达',
        state: 'stable',
        linkState: 'candidate',
        evidence: ['关系：不同演绎'],
        memberCount: 20,
        collectedCount: 3,
        entries: [],
      },
    ],
    exclusions: [],
    analysis: makeAnalysis(),
    ...overrides,
  };
}

function makePreview(kind: string, overrides: Record<string, unknown> = {}) {
  const next =
    kind === 'reopen-franchise-member'
      ? '排除标记为已撤销；该系列是否重新属于这个家族由当前证据决定（不强制加回，也不会自动确认）。'
      : '家族成员不再包含「机动战士高达」';
  return {
    kind,
    label: '移出家族成员',
    allowed: true,
    message: '',
    preview: {
      current: '家族「LoveLive」当前包含 3 个系列',
      next,
      reason: '你否决了这条 membership 推断',
      source: '用户在家族页面移出成员',
      directlyChanges: ['成员排除治理记录：fr_1 × sr_11'],
      derivedChanges: ['Franchise 成员链接与计数'],
      untouched: ['Series identity 与成员构成', 'Relation 原始关系数据'],
      chain: [
        { layer: 'governance', label: '写入成员排除', detail: '记录原因与证据快照' },
        { layer: 'search', label: '搜索投影', detail: '被移出的系列不再命中该家族' },
      ],
    },
    ...overrides,
  };
}

function makeResult() {
  return {
    ok: true,
    repair: { kind: 'exclude-franchise-member', label: '移出家族成员', target: 'fr_1', value: 'sr_11' },
    verification: {
      verified: true,
      partial: false,
      summary: '修复完成，并已通过重新检测与各受影响层（source / projection / search / API）验证。',
      resolvedIssueIds: [],
      remainingIssueIds: [],
      checks: [
        {
          layer: 'governance',
          label: '成员排除决定已写入（含证据快照）',
          ok: true,
          detail: 'franchise_member_exclusions #1',
        },
        {
          layer: 'projection',
          label: '成员链接已移除',
          ok: true,
          detail: '当前成员 2 个系列',
        },
      ],
    },
    report: {
      generatedAt: '2026-10-03T00:00:00.000Z',
      durationMs: 10,
      dataVersion: 200,
      hideNsfw: false,
      lastMutation: { scope: 'governance', at: '2026-10-03T00:00:00.000Z', detail: null },
      scope: { subjects: 755, collections: 755, relations: 9893, series: 388, franchises: 17, staleSeries: 5 },
      summary: { error: 0, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 0, total: 0 },
      modules: [],
      issues: [],
    },
  };
}

function installFetch(detail: FranchiseDetail | ((url: string) => FranchiseDetail)) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.includes('/governance/preview')) {
        const kind = new URLSearchParams(url.split('?')[1]).get('kind') ?? 'exclude-franchise-member';
        return json(makePreview(kind));
      }
      if (url.includes('/governance') && method === 'POST') {
        return json(makeResult());
      }
      if (url.startsWith('/api/franchises/')) return json(typeof detail === 'function' ? detail(url) : detail);
      return json({ error: { code: 'not_found', message: 'x' } }, 404);
    }),
  );
  return { calls };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/franchises/fr_1']}>
        <Routes>
          <Route path="/franchises/:key" element={<FranchiseDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe('Franchise 成员治理 UI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('保留可见家族成员、证据和排除状态，不显示占位引用或旧模式入口', async () => {
    const detail = makeDetail();
    detail.presentation = { version: 1, mode: 'visible', privacyApplied: true, note: '安全审计摘要' };
    detail.series[0]!.evidence.push(WITHHELD_EVIDENCE);
    detail.exclusions = [{
      identityProtected: true, seriesKey: 'protected-opaque', seriesTitle: '受保护历史成员',
      state: 'active', reason: WITHHELD_EVIDENCE, evidence: WITHHELD_EVIDENCE,
      createdAt: '2026-10-03T00:00:00.000Z', revokedAt: null, revokedReason: null,
    }];
    detail.identityConflicts = [{
      evidenceProtected: true, fromSeriesKey: 'protected-opaque', fromSeriesTitle: '受保护身份冲突',
      toSeriesKey: null, toSeriesTitle: null, reason: 'superseded', evidence: null,
    }];
    installFetch(detail);
    renderPage();
    await screen.findByRole('heading', { name: 'LoveLive' });
    expect(screen.getByRole('link', { name: '机动战士高达' }).getAttribute('href')).toBe('/series/sr_11');
    expect(screen.getByText(/关系：不同演绎/)).toBeTruthy();
    expect(screen.getByText('受保护历史成员')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '撤销排除（重新评估）' }).disabled).toBe(true);
    expect(screen.queryByText(/完整审计证据|protected-opaque/)).toBeNull();
    expect(screen.queryByRole('button', { name: '查看完整审计证据' })).toBeNull();
  });

  it('移出成员：预览 → 执行 → 展示逐层验证结果', async () => {
    const { calls } = installFetch(makeDetail());
    renderPage();

    expect(await screen.findByText('LoveLive')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /移出该家族/ }));

    // 预览必须说明当前 / 将修改为 / 影响链 / 不会修改
    expect(await screen.findByText('移出这个家族成员？')).toBeTruthy();
    expect(await screen.findByText('家族「LoveLive」当前包含 3 个系列')).toBeTruthy();
    expect(screen.getByText('直接修改')).toBeTruthy();
    expect(screen.getByText('自动派生（系统负责重算）')).toBeTruthy();
    expect(screen.getByText('不会修改')).toBeTruthy();
    expect(screen.getByText('影响链')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /执行修复/ }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.method === 'POST' && entry.url.includes('/governance'));
      expect(call?.body).toMatchObject({ kind: 'exclude-franchise-member', series: 'sr_11' });
    });
    expect(await screen.findByText('修复完成并已验证')).toBeTruthy();
    expect(screen.getByText(/成员排除决定已写入/)).toBeTruthy();
    expect(screen.getByText(/成员链接已移除/)).toBeTruthy();
  });

  it('设置家族名称：先输入名称，再预览影响，最后执行', async () => {
    const { calls } = installFetch(
      makeDetail({
        title: '未确认家族（2 个系列）',
        titleState: 'unresolved',
        titleSource: 'fallback',
        state: 'confirmed',
      }),
    );
    renderPage();

    expect(await screen.findByText('未确认家族（2 个系列）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '设置名称' }));

    const input = await screen.findByLabelText('家族名称');
    fireEvent.change(input, { target: { value: '孤岛系列' } });
    fireEvent.click(screen.getByRole('button', { name: '查看变更预览' }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.includes('/governance/preview'));
      expect(call?.url).toContain('title=');
    });
    fireEvent.click(await screen.findByRole('button', { name: /执行修复/ }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.method === 'POST' && entry.url.includes('/governance'));
      expect(call?.body).toMatchObject({ kind: 'adopt-franchise-title', title: '孤岛系列' });
    });
  });

  it('已有成员排除：显示 provenance，并提供撤销排除入口', async () => {
    installFetch(
      makeDetail({
        series: [],
        seriesCount: 2,
        exclusions: [
          {
            seriesKey: 'sr_11',
            seriesTitle: '机动战士高达',
            state: 'active',
            reason: '归组错误',
            evidence: '{"series":{"key":"sr_11"}}',
            createdAt: '2026-10-03T01:00:00.000Z',
            revokedAt: null,
            revokedReason: null,
          },
        ],
      }),
    );
    renderPage();

    expect(await screen.findByTestId('franchise-exclusion-row')).toBeTruthy();
    expect(screen.getByText('已移出')).toBeTruthy();
    expect(screen.getByText(/原因：归组错误/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /撤销排除（重新评估）/ }));
    expect(await screen.findByText('撤销成员排除？')).toBeTruthy();
    expect(await screen.findByText(/不强制加回/)).toBeTruthy();
  });

  it('Entity Analysis：B–E 层按跨 Series 聚合语义展示，隐藏内容有口径条与说明', async () => {
    installFetch(
      makeDetail({
        analysis: makeAnalysis({ hidden: { series: 1, members: 2 } }),
      }),
    );
    renderPage();

    expect(await screen.findByText('LoveLive')).toBeTruthy();
    // A 层结构规模与当前 analysis 口径同源
    expect(screen.getByText(/1 个系列 · 已知 12 个成员 · 我的收藏 8 部/)).toBeTruthy();
    // A 层不再直接放平均分；C 层成组展示
    expect(screen.queryByText('平均我的评分')).toBeNull();
    expect(screen.getByText('我的平均分')).toBeTruthy();
    expect(screen.getByText('7.50')).toBeTruthy();
    expect(screen.getByText('评分差值')).toBeTruthy();
    // B 层明确「跨 Series 聚合」
    expect(screen.getByText(/跨 Series 聚合：成员是系列/)).toBeTruthy();
    // D / E 层
    expect(screen.getByText('2010 – 2020')).toBeTruthy();
    expect(screen.getByText('估算')).toBeTruthy();
    expect(screen.getByText(/不合成「投入分」/)).toBeTruthy();
    // 口径条 + 隐藏说明
    expect(screen.getByText(/当前可见口径 · 已隐藏 2 个成员（来自 1 个系列）/)).toBeTruthy();
    expect(screen.getByText(/可在页面顶部切换完整数据/)).toBeTruthy();
  });

  it.each(['visible', 'real'] as const)('无隐藏成员：%s 口径不显示隐藏说明', async (visibility) => {
    installFetch(makeDetail({ analysis: makeAnalysis({ visibility }) }));
    renderPage();
    expect(await screen.findByText('LoveLive')).toBeTruthy();
    expect(screen.queryByText(/可在页面顶部切换完整数据/)).toBeNull();
    expect(screen.queryByRole('button', { name: '完整数据' })).toBeNull();
  });

  it('完整口径保留隐藏上下文，但不宣称已展示的成员被排除；连续切换与失效后仍一致', async () => {
    let hidden = { series: 1, members: 2 };
    const { calls } = installFetch((url) => {
      const visibility = new URLSearchParams(url.split('?')[1]).get('visibility') === 'real' ? 'real' : 'visible';
      return makeDetail({ analysis: makeAnalysis({ visibility, hidden }) });
    });
    const { queryClient } = renderPage();
    expect(await screen.findByText(/可在页面顶部切换完整数据/)).toBeTruthy();
    for (let index = 0; index < 2; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: '完整数据' }));
      expect(await screen.findByText(/完整数据口径 · 已包含 2 个成员/)).toBeTruthy();
      expect(screen.queryByText(/不参与当前口径的统计/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '当前可见' }));
      expect(await screen.findByText(/当前可见口径 · 已隐藏 2 个成员/)).toBeTruthy();
      expect(screen.getByText(/可在页面顶部切换完整数据/)).toBeTruthy();
    }
    expect(calls.some((call) => call.url.includes('visibility=real'))).toBe(true);
    expect(calls.some((call) => call.url.includes('visibility=visible'))).toBe(true);
    hidden = { series: 0, members: 0 };
    await queryClient.invalidateQueries({ queryKey: ['franchiseDetail'] });
    await waitFor(() => expect(screen.queryByText(/可在页面顶部切换完整数据/)).toBeNull());
    expect(screen.queryByRole('button', { name: '完整数据' })).toBeNull();
  });

  it('身份冲突：展示被取代成员并提供「迁移已被取代的成员」入口（v1.8.4）', async () => {
    installFetch(
      makeDetail({
        identityConflicts: [
          {
            fromSeriesKey: 'sr_401',
            fromSeriesTitle: '爱上火车-Last Run!!-',
            toSeriesKey: 'sr_391',
            toSeriesTitle: '爱上火车',
            reason: 'superseded',
            evidence: {
              aliasReason: 'rebuilt-into',
              mergedEventId: 3823,
              mergedAt: '2026-10-04T15:32:24.723Z',
              restoredEventId: 3822,
              members: [305045],
              exact: true,
              high: false,
            },
          },
          {
            fromSeriesKey: 'sr_777',
            fromSeriesTitle: '无谱系旧身份',
            toSeriesKey: null,
            toSeriesTitle: null,
            reason: 'unresolved',
            evidence: null,
          },
        ],
      }),
    );
    renderPage();

    expect(await screen.findByTestId('franchise-identity-conflicts')).toBeTruthy();
    expect(screen.getByText(/生命周期证据：alias rebuilt-into · merged #3823/)).toBeTruthy();
    expect(screen.getByText('迁移已被取代的成员')).toBeTruthy();
    expect(screen.getByText(/缺少可验证的 rebuilt-into \/ merged 谱系/)).toBeTruthy();
  });
});
