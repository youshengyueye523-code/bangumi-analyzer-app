import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import type { TimelineStats } from '@bangumi-analyzer/shared';
import { TimelineView } from './TimelineSection.js';
import { periodKey } from '../../lib/timeline.js';
const { metricRender } = vi.hoisted(() => ({ metricRender: vi.fn() }));
vi.mock('../charts/TimelineCharts.js', () => ({
  TimelineOverview: ({ onLocate, currentRange, points }: { onLocate?: (a: string, b: string) => void; currentRange?: boolean; points: Array<{period: string; added: number}> }) => currentRange
    ? <div data-testid="main-values">{points.map(p => `${p.period}:${p.added}`).join(',')}</div>
    : <button onClick={() => onLocate?.('2026-01', '2026-01')}>概览定位一月</button>,
  TimelineMetricChart: ({
    points,
    metric,
  }: {
    points: Array<{
      period: string;
    }>;
    metric: string;
  }) => { metricRender(metric); return (
    <div data-testid={`chart-${metric}`} data-length={points.length}>
      {points[0]?.period}/{points.at(-1)?.period}
    </div>
  ); },
}));
function data(n = 24): TimelineStats {
  const start = 2026 * 12 + 9 - n + 1;
  const points = Array.from({ length: n }, (_, i) => ({
    period: periodKey(start + i, 'month'),
    label: periodKey(start + i, 'month'),
    added: i === n - 1 ? 2 : 0,
    updated: 0,
    total: i === n - 1 ? 2 : 0,
    episodes: i === n - 1 ? 5 : 0,
    averageRate: i === n - 1 ? 7 : null,
    ratingSample: { ratedCount: i === n - 1 ? 2 : 0, ratingSum: i === n - 1 ? 14 : 0 },
  }));
  return {
    granularity: 'month',
    basis: 'collection-updated-at',
    note: '',
    points,
    context: {
      contextVersion: 1,
      dataVersion: 1,
      visibility: 'real',
      calendarZone: 'Asia/Shanghai',
      viewReferenceAt: '2026-10-25T00:00:00Z',
      referenceMonth: '2026-10',
      sourceRefreshedAt: null,
      sequence: {
        complete: true,
        kind: 'full',
        from: points[0]?.period ?? null,
        to: points.at(-1)?.period ?? null,
      },
      timeCoverage: { datedCollections: 2, undatedCollections: 0 },
    },
  };
}
function RouteState() {
  const location = useLocation(),
    navigate = useNavigate();
  return (
    <>
      <output data-testid="url">{location.search}</output>
      <button onClick={() => navigate(-1)}>返回上个范围</button>
    </>
  );
}
function show(d = data(), initial = '/analysis') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <TimelineView data={d} />
      <RouteState />
    </MemoryRouter>,
  );
}
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
function flushFrames() { act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(0)); }); }
beforeEach(() => {
  vi.clearAllMocks();
  frames.clear();
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());
it('starts with calendar recent12, separates scales and leaves cumulative collapsed', () => {
  show();
  expect(screen.getByTestId('timeline-main').getAttribute('data-periods')).toBe('12');
  expect(screen.queryByText('概览定位一月')).toBeNull();
  expect(screen.getByRole('button', { name: '展开全历史概览' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByTestId('chart-added').getAttribute('data-length')).toBe('12');
  expect(screen.getByTestId('chart-averageRate').textContent).toContain('2025-11/2026-10');
  expect(screen.getByText('深入查看 · 累计归集曲线').closest('details')?.hasAttribute('open')).toBe(
    false,
  );
  expect(screen.getByRole('table').getAttribute('aria-label')).toBe('时间趋势精确明细');
});
it('custom range is draft until apply; cancel restores committed URL/chart/summary', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: /更改范围/ }));
  fireEvent.change(screen.getByLabelText('起始月份'), { target: { value: '2026-01' } });
  fireEvent.change(screen.getByLabelText('结束月份'), { target: { value: '2026-02' } });
  expect(screen.getByTestId('chart-added').getAttribute('data-length')).toBe('12');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.getByTestId('url').textContent).toContain('');
  fireEvent.click(screen.getByRole('button', { name: /更改范围/ }));
  expect((screen.getByLabelText('起始月份') as HTMLInputElement).value).toBe('2025-11');
  fireEvent.change(screen.getByLabelText('起始月份'), { target: { value: '2026-01' } });
  fireEvent.change(screen.getByLabelText('结束月份'), { target: { value: '2026-02' } });
  fireEvent.click(screen.getByRole('button', { name: '应用范围' }));
  expect(screen.getByTestId('url').textContent).toContain('tr=custom&from=2026-01&to=2026-02');
  expect(screen.getByTestId('chart-added').getAttribute('data-length')).toBe('2');
  expect(screen.getByTestId('chart-episodes').textContent).toContain('2026-01/2026-02');
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
});
it('browser back restores the same committed range', () => {
  show();
  fireEvent.click(screen.getAllByRole('button', { name: '全部历史' })[0]!);
  expect(screen.getByTestId('chart-added').getAttribute('data-length')).toBe('24');
  fireEvent.click(screen.getByRole('button', { name: '返回上个范围' }));
  expect(screen.getByTestId('chart-added').getAttribute('data-length')).toBe('12');
});
it('invalid URL dates remain visible as invalid, rather than silently clamping', () => {
  show(data(), '/analysis?tr=custom&from=1900-01&to=1900-02');
  expect(screen.queryByTestId('chart-added')).toBeNull();
  expect(screen.getByText(/图表不会静默/)).toBeTruthy();
  expect(screen.getByTestId('url').textContent).toContain('1900-01');
});
it('legacy data is explicitly unknown and samples are not invented', () => {
  const d = data(601);
  delete d.context;
  d.points.forEach((p) => delete p.ratingSample);
  show(d);
  expect(screen.getByText(/兼容视图/).textContent).toContain('不补齐未知月份');
  expect(screen.queryByRole('button', { name: '最近有记录' })).toBeNull();
  expect(screen.queryByRole('button', { name: '展开全历史概览' })).toBeNull();
  expect(screen.getByRole('button', { name: '展开已返回记录概览' })).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: '统一精读范围' })).getByRole('button', {
      name: '全部已返回',
    }),
  ).toBeTruthy();
  expect(screen.getAllByText('未提供').length).toBeGreaterThan(0);
});
it('long-history detail DOM is bounded while page jump reaches the first source period', () => {
  const d = data(2400);
  show(d, '/analysis?tr=all');
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(51);
  fireEvent.change(screen.getByRole('spinbutton', { name: '明细页码' }), {
    target: { value: '48' },
  });
  expect(within(screen.getByRole('table')).getByText(d.points[0]!.period)).toBeTruthy();
});
it('endpoint keyboard preview commits on release; custom invalid reversal still blocks apply', () => {
  show();
  const start = screen.getByRole('slider', { name: '范围起点' });
  fireEvent.keyDown(start, { key: 'ArrowLeft' });
  fireEvent.change(screen.getByRole('slider', { name: '范围起点' }), {
    target: { value: 2026 * 12 },
  });
  expect(screen.getByRole('slider', { name: '范围起点' }).getAttribute('aria-valuetext')).toBe(
    '2026 年 1 月',
  );
  expect(screen.getByTestId('chart-added').getAttribute('data-length')).toBe('12');
  fireEvent.keyUp(start, { key: 'ArrowLeft' });
  expect(screen.getByTestId('chart-added').getAttribute('data-length')).toBe('10');
  expect(screen.getByTestId('url').textContent).toContain('from=2026-01');
  fireEvent.click(screen.getByRole('button', { name: /更改范围/ }));
  fireEvent.change(screen.getByLabelText('结束月份'), { target: { value: '2025-01' } });
  expect((screen.getByRole('button', { name: '应用范围' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
it('no dated data distinguishes known missing dates from legacy uncertainty', () => {
  const d = data();
  d.points = [];
  d.context!.sequence.from = null;
  d.context!.sequence.to = null;
  d.context!.timeCoverage = { datedCollections: 0, undatedCollections: 2 };
  show(d);
  expect(screen.getByText('收藏尚无可归期日期')).toBeTruthy();
  expect(screen.queryByRole('slider')).toBeNull();
});
it('single-period full-history view omits ineffective range navigation', () => {
  show(data(1), '/analysis?tr=all');
  expect(screen.queryByRole('button', { name: '前一段范围' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /更改范围/ }));
  expect(screen.queryByRole('slider')).toBeNull();
  expect(screen.getByText('当前仅一期，无需范围导航。')).toBeTruthy();
});
it('grain switch keeps absolute month intent in URL instead of replacing it with twelve years', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: '按年' }));
  expect(screen.getByTestId('url').textContent).toContain(
    'tg=year&tr=custom&from=2025-11&to=2026-10',
  );
});
it('small-value comparison excludes the peak even when there are fewer than twelve records', () => {
  const d = data(3);
  d.points[0]!.added = 1;
  d.points[0]!.total = 1;
  d.points[1]!.total = 1;
  d.points[2]!.added = 616;
  d.points[2]!.total = 617;
  d.context!.timeCoverage.datedCollections = 617;
  const view = show(d);
  fireEvent.click(screen.getByText('深入查看 · 极值与小值比较'));
  const local = view.container.querySelectorAll('.timeline-small-row');
  expect(local.length).toBe(1);
  expect(local[0]!.textContent).toContain('1 部');
  expect(local[0]!.textContent).not.toContain('616');
  expect(screen.getByRole('button', { name: /616 部 · 定位此期/ })).toBeTruthy();
});
it('exact month entry preserves the complete four-digit period domain including year zero', () => {
  const d = data(1);
  d.points[0]!.period = '0000-01';
  d.points[0]!.label = '0000 年 1 月';
  d.context!.sequence.from = '0000-01';
  d.context!.sequence.to = '0000-01';
  show(d, '/analysis?tr=custom&from=0000-01&to=0000-01');
  fireEvent.click(screen.getByRole('button', { name: /更改范围/ }));
  expect((screen.getByLabelText('起始月份') as HTMLInputElement).value).toBe('0000-01');
  expect((screen.getByRole('button', { name: '应用范围' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it.each([35, 720, 2400])('main chart really slices %i periods to four; overview toggle and all-history shortcut are independent', n => {
  show(data(n), '/analysis?tr=custom&from=2025-03&to=2025-06');
  const main = () => screen.getByTestId('timeline-main');
  expect(main().getAttribute('data-periods')).toBe('4');
  expect(screen.getByTestId('main-values').textContent).toBe('2025-03:0,2025-04:0,2025-05:0,2025-06:0');
  const url = screen.getByTestId('url').textContent;
  fireEvent.click(screen.getByRole('button', { name: '展开全历史概览' }));
  expect(screen.getByText('概览定位一月')).toBeTruthy();
  expect(screen.getByTestId('url').textContent).toBe(url);
  fireEvent.click(screen.getByRole('button', { name: '收起全历史概览' }));
  expect(screen.queryByText('概览定位一月')).toBeNull();
  expect(main().getAttribute('data-periods')).toBe('4');
  fireEvent.click(screen.getByRole('button', { name: '全部历史' }));
  expect(main().getAttribute('data-periods')).toBe(String(n));
  expect(screen.queryByText('概览定位一月')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '展开全历史概览' }));
  fireEvent.click(screen.getByText('概览定位一月'));
  expect(main().getAttribute('data-from')).toBe('2026-01');
  expect(main().getAttribute('data-periods')).toBe('1');
});

it.each([35, 720, 2400])('draft pan updates only the main chart once per frame at %i; Esc restores and release commits once', n => {
  show(data(n));
  const main = screen.getByTestId('timeline-main');
  const pan = screen.getByRole('slider', { name: '整体平移范围' });
  vi.spyOn(pan, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);
  const original = main.getAttribute('data-from'), url = screen.getByTestId('url').textContent;
  const table = screen.getByRole('table').textContent, renders = metricRender.mock.calls.length;
  fireEvent.pointerDown(pan, { button: 0, clientX: 200 });
  fireEvent.pointerMove(pan, { clientX: 175 });
  fireEvent.pointerMove(pan, { clientX: 150 });
  expect(main.getAttribute('data-preview')).toBe('false');
  flushFrames();
  expect(main.getAttribute('data-preview')).toBe('true');
  expect(main.getAttribute('data-from')).not.toBe(original);
  expect(main.getAttribute('data-periods')).toBe('12');
  expect(screen.getByTestId('url').textContent).toBe(url);
  expect(screen.getByRole('table').textContent).toBe(table);
  expect(metricRender.mock.calls.length).toBe(renders);
  fireEvent.keyDown(pan, { key: 'Escape' });
  fireEvent.pointerMove(pan, { clientX: 100 });
  fireEvent.pointerUp(pan); flushFrames();
  expect(main.getAttribute('data-preview')).toBe('false');
  expect(main.getAttribute('data-from')).toBe(original);
  expect(screen.getByTestId('url').textContent).toBe(url);
  fireEvent.pointerDown(pan, { button: 0, clientX: 200 });
  fireEvent.pointerMove(pan, { clientX: 150 }); flushFrames();
  const target = main.getAttribute('data-from');
  fireEvent.pointerUp(pan); fireEvent.lostPointerCapture(pan); flushFrames();
  expect(main.getAttribute('data-from')).toBe(target);
  expect(main.getAttribute('data-preview')).toBe('false');
  expect(screen.getByTestId('url').textContent).toContain(`from=${target}`);
  fireEvent.click(screen.getByRole('button', { name: '返回上个范围' }));
  expect(screen.getByTestId('url').textContent).toBe(url);
});

it('endpoint live draft and pending-frame cancellation preserve committed cumulative prefix', () => {
  const d = data(35);
  d.points.forEach((p, i) => { p.added = 1; p.total = i + 1; });
  d.context!.timeCoverage.datedCollections = 35;
  show(d, '/analysis?tr=custom&from=2025-03&to=2025-06');
  const first = screen.getByRole('slider', { name: '范围起点' });
  const main = screen.getByTestId('timeline-main');
  fireEvent.pointerDown(first, { button: 0 });
  fireEvent.change(first, { target: { value: 2025 * 12 + 3 } }); flushFrames();
  expect(main.getAttribute('data-from')).toBe('2025-04');
  expect(main.getAttribute('data-periods')).toBe('3');
  expect(screen.getByTestId('chart-total').textContent).toBe('2025-03/2025-06');
  const row = within(screen.getByRole('table')).getByRole('rowheader', { name: '2025-03' }).closest('tr')!;
  expect(within(row).getAllByRole('cell').at(-1)?.textContent).toBe('16');
  fireEvent.change(first, { target: { value: 2025 * 12 + 4 } });
  fireEvent.keyDown(first, { key: 'Escape' }); flushFrames();
  expect(main.getAttribute('data-from')).toBe('2025-03');
  fireEvent.pointerUp(first);
  expect(screen.getByTestId('url').textContent).toContain('from=2025-03');
});
