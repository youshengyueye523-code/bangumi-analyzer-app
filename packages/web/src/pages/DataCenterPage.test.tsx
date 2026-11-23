import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsReport } from '@bangumi-analyzer/shared';
import { ToastProvider } from '../components/ui/toast.js';
import { DataCenterPage } from './DataCenterPage.js';

function makeReport(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    generatedAt: '2026-10-02T00:00:00.000Z',
    durationMs: 120,
    dataVersion: 79,
    hideNsfw: false,
    lastMutation: { scope: 'sync', at: '2026-10-02T00:00:00.000Z', detail: 'test' },
    scope: {
      subjects: 755,
      collections: 755,
      relations: 9893,
      series: 388,
      franchises: 17,
      staleSeries: 5,
    },
    summary: { error: 1, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 0, total: 1 },
    modules: [
      {
        id: 'storage',
        label: '存储与数据库',
        description: 'SQLite 完整性',
        status: 'ok',
        checked: 11403,
        details: ['integrity_check = ok'],
      },
      {
        id: 'visibility',
        label: 'NSFW 可见性',
        description: '隐藏策略执行一致性',
        status: 'skipped',
        checked: 0,
        details: ['隐藏开关当前关闭'],
      },
    ],
    issues: [
      {
        id: 'series.counter-drift',
        detector: 'series.entities',
        category: 'Series 派生数据',
        severity: 'error',
        title: 'Series 计数与成员明细不一致',
        explanation: '计数与成员表对不上。',
        evidence: [{ label: '计数不一致的 Series', value: '1 个' }],
        impact: [{ kind: 'series', label: 'Series 列表 / 详情', href: '/series' }],
        affected: [{ label: '测试系列', href: '/series/sr_1' }],
        affectedCount: 1,
        actions: [
          {
            kind: 'repair',
            repairKind: 'recompute-derived',
            label: '重建 Series 派生数据',
            preview: {
              current: '1 个 Series 的计数与成员明细不一致',
              next: '按当前真实数据重新计算全部派生投影',
              reason: '派生数据必须与 source-of-truth 保持一致',
              source: '重新运行 Series / Franchise 引擎',
              directlyChanges: ['派生投影（系统自动重算）'],
              derivedChanges: ['Series 实体与成员计数', 'API / UI 中的系列页面'],
              untouched: ['Collection（评分 / 进度 / 状态）', 'Relation（官方关系原始数据）'],
              chain: [
                { layer: 'source', label: '真实数据', detail: '保持不动' },
                { layer: 'projection', label: 'Series 重建', detail: '按证据重算' },
                { layer: 'api', label: 'API / UI', detail: '立即读到新结果' },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function installFetch(options: {
  report: DiagnosticsReport;
  repairResult?: unknown;
  repairStatus?: number;
  history?: unknown;
  historyStatus?: number;
}) {
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
      if (url.startsWith('/api/diagnostics/history')) {
        if (options.historyStatus && options.historyStatus >= 400) {
          return json({ error: { code: 'history_failed', message: '历史读取失败' } }, options.historyStatus);
        }
        return json(
          options.history ?? {
            entries: [],
            total: 0,
            filters: { entityKind: 'all', actor: 'all', limit: 20 },
          },
        );
      }
      if (url.startsWith('/api/diagnostics/repairs') && method === 'POST') {
        if (options.repairStatus && options.repairStatus >= 400) {
          return json({ error: { code: 'repair_failed', message: '修复执行失败' } }, options.repairStatus);
        }
        return json(options.repairResult);
      }
      if (url.startsWith('/api/diagnostics')) return json(options.report);
      return json({ error: { code: 'not_found', message: 'x' } }, 404);
    }),
  );
  return { calls };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <DataCenterPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('数据中枢页面', () => {
  it('旧服务缺少完整性证明时明确警告，不把兼容结果宣称全量通过', async () => {
    installFetch({ report: makeReport({ issues: [], summary: { error: 0, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 0, total: 0 } }) });
    renderPage();
    expect(await screen.findByText(/此服务未提供检测完整性声明/)).toBeTruthy();
  });

  it('问题分页可获取首窗口之外的异常，摘要保持完整总数', async () => {
    const first = makeReport({ coverage: { status: 'complete', note: '全部注册检查已完成' },
      issuePage: { offset: 0, limit: 1, total: 2, hasMore: true } });
    const second = makeReport({ ...first,
      issuePage: { offset: 1, limit: 1, total: 2, hasMore: false },
      issues: [{ ...first.issues[0]!, id: 'late-window', title: '旧窗口之外的异常' }] });
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/diagnostics/history')) return json({ entries: [], total: 0, filters: {} });
      return json(url.includes('offset=1') ? second : first);
    });
    vi.stubGlobal('fetch', fetch);
    renderPage();
    await screen.findByText('Series 计数与成员明细不一致');
    fireEvent.click(screen.getByRole('button', { name: '下一页问题' }));
    expect(await screen.findByText('旧窗口之外的异常')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下一页问题' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '上一页问题' }));
    expect(await screen.findByText('Series 计数与成员明细不一致')).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('offset=1'))).toBe(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('历史读取失败明确提示和重试，不伪装没有治理记录', async () => {
    const options = { report: makeReport(), historyStatus: 503 };
    installFetch(options);renderPage();
    await screen.findByText('历史读取失败');
    expect(screen.queryByText('当前筛选下还没有治理记录。')).toBeNull();
    options.historyStatus = 200;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('当前筛选下还没有治理记录。');
    expect(screen.queryByText('历史读取失败')).toBeNull();
  });

  it('历史切换等待时标明保留的是上一结果，响应后展示当前筛选', async () => {
    const previous = { entries: [{ id: 'e1', actor: 'system', summary: '旧筛选的系统记录', at: '2026-10-11T00:00:00Z', entityKind: 'series', entityId: 1 }], total: 1, filters: { entityKind: 'all', actor: 'all', limit: 20 } };
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    let release!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: string) => input.startsWith('/api/diagnostics/history')
      ? input.includes('actor=user') ? new Promise<Response>((resolve) => { release = resolve; }) : Promise.resolve(json(previous))
      : Promise.resolve(json(makeReport()))));
    renderPage();await screen.findByText('旧筛选的系统记录');
    fireEvent.click(screen.getByRole('button', { name: '用户决定' }));
    await screen.findByText(/暂时保留上一结果/);
    expect(screen.getByText('旧筛选的系统记录')).toBeTruthy();
    release(json({ entries: [], total: 0, filters: { entityKind: 'all', actor: 'user', limit: 20 } }));
    await screen.findByText('当前筛选下还没有治理记录。');
    expect(screen.queryByText('旧筛选的系统记录')).toBeNull();
    expect(screen.queryByText(/暂时保留上一结果/)).toBeNull();
  });

  it('展示检测模块、问题证据与影响范围', async () => {
    installFetch({ report: makeReport() });
    renderPage();

    expect(await screen.findByText('数据中枢')).toBeTruthy();
    expect(screen.getByText('存储与数据库')).toBeTruthy();
    expect(screen.getByText('NSFW 可见性')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '确定错误' })).toBeTruthy();
    expect(screen.getByText('Series 计数与成员明细不一致')).toBeTruthy();
    expect(screen.getByText(/计数不一致的 Series/)).toBeTruthy();
    expect(screen.getByText('Series 列表 / 详情')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重建 Series 派生数据/ })).toBeTruthy();
  });

  it('没有问题时展示真实空状态，不伪造建议', async () => {
    installFetch({
      report: makeReport({
        summary: { error: 0, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 0, total: 0 },
        issues: [],
      }),
    });
    renderPage();

    expect(await screen.findByText('当前没有检测到需要处理的数据问题')).toBeTruthy();
    expect(screen.getByText(/暂定标题与等待同步的字段属于正常状态/)).toBeTruthy();
  });

  it('修复流程：预览 → 执行 → 展示验证结果与重新检测后的报告', async () => {
    const after = makeReport({
      summary: { error: 0, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 0, total: 0 },
      issues: [],
    });
    const { calls } = installFetch({
      report: makeReport(),
      repairResult: {
        ok: true,
        repair: { kind: 'recompute-derived', label: '重建 Series 派生数据' },
        verification: {
          verified: true,
          partial: false,
          summary: '修复完成，并已通过重新检测与 API 校验。',
          resolvedIssueIds: ['series.counter-drift'],
          remainingIssueIds: [],
          checks: [
            { label: '派生数据重建结果', ok: true, detail: '1 个 Series · 0 个 Franchise · 2 个正式成员' },
            { label: '重新检测：目标问题', ok: true, detail: '问题「Series 计数与成员明细不一致」已消失' },
          ],
        },
        report: after,
      },
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /重建 Series 派生数据/ }));
    // 预览必须说明当前 / 将修改为 / 不会修改
    expect(await screen.findByText('修复预览')).toBeTruthy();
    expect(screen.getByText('1 个 Series 的计数与成员明细不一致')).toBeTruthy();
    expect(screen.getByText('按当前真实数据重新计算全部派生投影')).toBeTruthy();
    expect(screen.getByText('直接修改')).toBeTruthy();
    expect(screen.getByText('自动派生（系统负责重算）')).toBeTruthy();
    expect(screen.getByText('影响链')).toBeTruthy();
    expect(screen.getByText(/Collection（评分 \/ 进度 \/ 状态）/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /执行修复/ }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/api/diagnostics/repairs'))).toBe(
        true,
      ),
    );
    const repairCall = calls.find((call) => call.method === 'POST');
    expect(repairCall?.body).toEqual({ issueId: 'series.counter-drift', kind: 'recompute-derived' });

    expect((await screen.findAllByText('修复完成并已验证')).length).toBeGreaterThan(0);
    expect(screen.getByText(/问题「Series 计数与成员明细不一致」已消失/)).toBeTruthy();
    // 验证结果按层标注
    expect(screen.getByText('重新检测')).toBeTruthy();
    // 重新检测后的报告：问题消失 → 空状态
    expect(screen.getByText('当前没有检测到需要处理的数据问题')).toBeTruthy();
  });

  it('候选治理：家族候选同时提供确认与否决，否决会带上目标与候选值', async () => {
    const { calls } = installFetch({
      report: makeReport({
        summary: {
          error: 0,
          suspicious: 0,
          'needs-review': 1,
          uncertain: 0,
          external: 0,
          info: 0,
          total: 1,
        },
        issues: [
          {
            id: 'franchise.awaiting-review:fr_1',
            detector: 'franchise.entities',
            category: 'Franchise 待确认',
            severity: 'needs-review',
            title: '家族候选「LoveLive」等待人工确认',
            explanation: '这是 Analyzer 的推断，不是系统事实。',
            evidence: [{ label: '候选家族', value: 'fr_1' }],
            impact: [{ kind: 'franchise', label: 'Franchise 列表 / 详情', href: '/franchises/fr_1' }],
            affected: [{ label: 'LoveLive（fr_1）', href: '/franchises/fr_1' }],
            affectedCount: 1,
            actions: [
              {
                kind: 'repair',
                repairKind: 'confirm-franchise',
                label: '确认该家族',
                target: 'fr_1',
                preview: {
                  current: 'LoveLive 当前状态：candidate（候选）',
                  next: 'confirmed（已确认）',
                  reason: '确认属于同一家族',
                  source: '用户确认',
                  directlyChanges: ['Franchise 治理状态：candidate → confirmed'],
                  derivedChanges: ['Franchise 列表排序与状态徽标'],
                  untouched: ['Series 成员与标题', 'Relation 原始关系'],
                  chain: [
                    { layer: 'governance', label: '治理状态', detail: '写为 confirmed' },
                    { layer: 'api', label: 'API / UI', detail: '列表与详情更新' },
                  ],
                },
              },
              {
                kind: 'repair',
                repairKind: 'reject-franchise-candidate',
                label: '否决该候选',
                target: 'fr_1',
                preview: {
                  current: 'LoveLive 当前状态：candidate（等待人工确认）',
                  next: 'rejected（已否决）',
                  reason: '你认为推断错误',
                  source: '用户否决（写入 candidate_decisions）',
                  directlyChanges: ['Franchise 治理状态：candidate → rejected'],
                  derivedChanges: ['数据中枢不再列为待确认'],
                  untouched: ['Franchise / Series / Subject 数据本身'],
                  chain: [
                    { layer: 'governance', label: '写入否决决定', detail: '保留证据快照' },
                    { layer: 'cache', label: '缓存失效', detail: '诊断重新检测' },
                  ],
                },
              },
            ],
          },
        ],
      }),
      repairResult: {
        ok: true,
        repair: { kind: 'reject-franchise-candidate', label: '否决该候选', target: 'fr_1' },
        verification: {
          verified: true,
          partial: false,
          summary: '修复完成，并已通过重新检测与各受影响层验证。',
          resolvedIssueIds: ['franchise.awaiting-review:fr_1'],
          remainingIssueIds: [],
          checks: [
            { layer: 'governance', label: '否决决定与证据保留', ok: true, detail: 'candidate_decisions #1' },
            { layer: 'detector', label: '重新检测：目标问题', ok: true, detail: '问题已消失' },
          ],
        },
        report: makeReport({
          summary: { error: 0, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 0, total: 0 },
          issues: [],
        }),
      },
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /否决该候选/ }));
    expect(await screen.findByText('修复预览')).toBeTruthy();
    expect(screen.getByText(/candidate（等待人工确认）/)).toBeTruthy();
    expect(screen.getByText('rejected（已否决）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /执行修复/ }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/api/diagnostics/repairs'))).toBe(
        true,
      ),
    );
    const repairCall = calls.find((call) => call.method === 'POST');
    expect(repairCall?.body).toEqual({
      issueId: 'franchise.awaiting-review:fr_1',
      kind: 'reject-franchise-candidate',
      target: 'fr_1',
    });
    expect((await screen.findAllByText(/修复完成并已验证/)).length).toBeGreaterThan(0);
  });

  it('部分成功必须如实展示，不能显示绿灯', async () => {
    installFetch({
      report: makeReport(),
      repairResult: {
        ok: false,
        repair: { kind: 'recompute-derived', label: '重建 Series 派生数据' },
        verification: {
          verified: false,
          partial: true,
          summary: '修复部分成功：重新检测后问题仍存在，或 API 校验未通过。',
          resolvedIssueIds: [],
          remainingIssueIds: ['series.counter-drift'],
          checks: [
            { label: '重新检测：目标问题', ok: false, detail: '问题「Series 计数与成员明细不一致」仍然存在' },
          ],
        },
        report: makeReport(),
      },
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /重建 Series 派生数据/ }));
    fireEvent.click(await screen.findByRole('button', { name: /执行修复/ }));

    expect((await screen.findAllByText('修复部分成功')).length).toBeGreaterThan(0);
    expect(screen.getByText(/问题「Series 计数与成员明细不一致」仍然存在/)).toBeTruthy();
  });

  it('治理历史：只读展示 actor / 决定 / 证据快照，且不提供修改入口', async () => {
    installFetch({
      report: makeReport({
        summary: { error: 0, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 0, total: 0 },
        issues: [],
      }),
      history: {
        total: 2,
        filters: { entityKind: 'all', actor: 'all', limit: 20 },
        entries: [
          {
            id: 'event:42',
            at: '2026-10-02T12:00:00.000Z',
            source: 'entity_event',
            kind: 'candidate_reopened',
            summary: '候选重新进入评估：孤独摇滚（人工）',
            actor: 'user',
            entityKind: 'series',
            entityId: 18,
            entityKey: 'sr_18',
            entityTitle: '孤独摇滚！',
            currentState: 'provisional',
            candidate: { kind: 'title', title: '孤独摇滚' },
            stateChange: 'rejected → superseded（旧否决已失效）',
            reason: '用户手动重新进入评估',
            evidence: '{"title":"孤独摇滚","trigger":"manual"}',
          },
          {
            id: 'decision:3',
            at: '2026-10-02T11:00:00.000Z',
            source: 'candidate_decision',
            kind: 'decision.rejected',
            summary: '候选决定：标题候选「孤独摇滚」→ rejected',
            actor: 'user',
            entityKind: 'series',
            entityId: 18,
            entityKey: 'sr_18',
            entityTitle: '孤独摇滚！',
            currentState: 'provisional',
            candidate: { kind: 'title', title: '孤独摇滚' },
            stateChange: '→ rejected（当前生效）',
            reason: '人工否决',
            evidence: '{"support":2,"coverage":0.5}',
          },
        ],
      },
    });
    renderPage();

    await screen.findByText('治理历史');
    const history = screen.getByTestId('governance-history');
    expect(await screen.findByText('候选重新进入评估：孤独摇滚（人工）')).toBeTruthy();
    expect(screen.getAllByText('本地用户').length).toBeGreaterThan(0);
    expect(screen.getByText(/rejected → superseded/)).toBeTruthy();
    expect(screen.getByText(/原因：用户手动重新进入评估/)).toBeTruthy();
    expect(screen.getAllByText('证据快照').length).toBeGreaterThan(0);
    // 只读：历史区没有确认 / 否决 / 重新进入评估 / 执行修复这类治理动作
    expect(
      Array.from(history.querySelectorAll('button')).some((button) =>
        /确认|否决|重新进入评估|执行修复/.test(button.textContent ?? ''),
      ),
    ).toBe(false);
  });

  it('缓存层边界说明：翻译 / 封面写入不推进数据版本，提示重新检测且不误报', async () => {
    installFetch({ report: makeReport() });
    renderPage();
    expect(
      await screen.findByText(/翻译内容与封面缓存属于缓存层写入，不会推进数据版本/),
    ).toBeTruthy();
    expect(screen.getByText(/不会把暂时状态当成新的数据错误/)).toBeTruthy();
  });

  it('被否决标题候选清单：提供「重新进入评估」且带候选值', async () => {
    const { calls } = installFetch({
      report: makeReport({
        summary: { error: 0, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 1, total: 1 },
        issues: [
          {
            id: 'titles.rejected-candidates',
            detector: 'titles.resolver',
            category: '标题候选',
            severity: 'info',
            title: '1 个标题候选已被人工否决',
            explanation: '候选已退出竞争，但记录与证据保留。',
            evidence: [{ label: '孤独摇滚！ · 候选「孤独摇滚」', value: '否决原因：人工否决' }],
            impact: [{ kind: 'series', label: 'Series 展示标题竞争', href: '/series' }],
            affected: [
              { label: '孤独摇滚！ · 候选「孤独摇滚」', detail: '孤独摇滚', href: '/series/sr_18?review=1' },
            ],
            affectedCount: 1,
            actions: [
              {
                kind: 'repair',
                repairKind: 'reopen-title-candidate',
                label: '重新进入评估「孤独摇滚」',
                target: 'sr_18',
                value: '孤独摇滚',
                preview: {
                  current: '候选「孤独摇滚」已否决',
                  next: '候选重新进入竞争（旧否决保留并标记 superseded）',
                  reason: '你认为当时的否决不正确',
                  source: '用户在数据中枢重新进入评估',
                  directlyChanges: ['标题候选治理状态：rejected → superseded'],
                  derivedChanges: ['Series 展示标题按当前证据重新解析'],
                  untouched: ['Series identity / 成员归属'],
                  chain: [
                    { layer: 'governance', label: '写入治理决定', detail: '旧否决标记 superseded' },
                    { layer: 'cache', label: '缓存失效', detail: '诊断重新检测' },
                  ],
                },
              },
            ],
          },
        ],
      }),
      repairResult: {
        ok: true,
        repair: { kind: 'reopen-title-candidate', label: '重新进入评估「孤独摇滚」', target: 'sr_18', value: '孤独摇滚' },
        verification: {
          verified: true,
          partial: false,
          summary: '修复完成，并已通过重新检测与各受影响层验证。',
          resolvedIssueIds: ['titles.rejected-candidates'],
          remainingIssueIds: [],
          checks: [
            { layer: 'source', label: '候选重新进入竞争', ok: true, detail: 'valid=true' },
            { layer: 'detector', label: '重新检测：目标问题', ok: true, detail: '候选已离开清单' },
          ],
        },
        report: makeReport({
          summary: { error: 0, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 0, total: 0 },
          issues: [],
        }),
      },
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /重新进入评估「孤独摇滚」/ }));
    expect(await screen.findByText('修复预览')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /执行修复/ }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/api/diagnostics/repairs'))).toBe(
        true,
      ),
    );
    const repairCall = calls.find((call) => call.method === 'POST');
    expect(repairCall?.body).toEqual({
      issueId: 'titles.rejected-candidates',
      kind: 'reopen-title-candidate',
      target: 'sr_18',
      value: '孤独摇滚',
    });
  });

  it('显示更多：每次追加 20 条，加载期间保留旧记录，且不会重复', async () => {
    const makeEntries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `event:${index}`,
        at: `2026-10-02T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
        source: 'entity_event' as const,
        kind: 'title_manual',
        summary: `记录 ${index}`,
        actor: 'user' as const,
        entityKind: 'series' as const,
        entityId: 18,
        entityKey: 'sr_18',
        entityTitle: '孤独摇滚！',
        currentState: 'provisional',
        candidate: null,
        stateChange: null,
        reason: null,
        evidence: null,
      }));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/diagnostics/history')) {
          const parsed = new URL(url, 'http://localhost');
          const limit = Number(parsed.searchParams.get('limit') ?? 20);
          if (limit > 20) await new Promise((resolve) => setTimeout(resolve, 80));
          return json({
            entries: makeEntries(limit),
            total: 60,
            filters: { entityKind: 'all', actor: 'all', limit },
          });
        }
        if (url.startsWith('/api/diagnostics')) {
          return json(
            makeReport({
              summary: { error: 0, suspicious: 0, 'needs-review': 0, uncertain: 0, external: 0, info: 0, total: 0 },
              issues: [],
            }),
          );
        }
        return json({ error: { code: 'not_found', message: 'x' } });
      }),
    );
    renderPage();

    await screen.findByText('记录 0');
    expect(screen.getAllByText(/^记录 \d+$/).length).toBe(20);

    // 点击后：加载期间仍然保留旧的 20 条（不会塌陷成空列表）
    fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
    expect(screen.getAllByText(/^记录 \d+$/).length).toBe(20);
    await waitFor(() => expect(screen.getAllByText(/^记录 \d+$/).length).toBe(40));

    // 再次点击：追加到 60，且没有任何重复记录
    fireEvent.click(screen.getByRole('button', { name: /显示更多/ }));
    await waitFor(() => expect(screen.getAllByText(/^记录 \d+$/).length).toBe(60));
    const summaries = screen.getAllByText(/^记录 \d+$/).map((node) => node.textContent);
    expect(new Set(summaries).size).toBe(summaries.length);
  });
});
