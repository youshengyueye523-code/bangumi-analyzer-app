import { render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TimelineMetricChart, TimelineOverview } from './TimelineCharts.js';
import type { TimelinePoint } from '@bangumi-analyzer/shared';

vi.mock('echarts/core', async (original) => {
  const actual = await original<typeof import('echarts/core')>();
  return { ...actual, format: { ...actual.format, getTextRect: (text: string) => ({ width: text.length * 6 }) } };
});
const { chart } = vi.hoisted(() => ({ chart: vi.fn() }));
vi.mock('./chart.js', () => ({
  CHART_FONT: { axis: 11 },
  Chart: (props: unknown) => {
    chart(props);
    return null;
  },
  useChartTheme: () => ({
    palette: ['blue', 'green', 'gold', '', '', '', 'teal'],
    accent: 'blue',
    subtle: 'gray',
  }),
  axisStyle: () => ({ axisLabel: {} }),
  baseChartOption: () => ({ tooltip: {} }),
}));
beforeEach(() => chart.mockClear());
const points: TimelinePoint[] = [
  {
    period: '2026-01',
    label: '一月',
    added: 616,
    updated: 1,
    total: 616,
    episodes: 120,
    averageRate: 8,
    ratingSample: { ratedCount: 1, ratingSum: 8 },
  },
  {
    period: '2026-02',
    label: '二月',
    added: 1,
    updated: 0,
    total: 617,
    episodes: 2,
    averageRate: null,
    ratingSample: { ratedCount: 0, ratingSum: 0 },
  },
];
it('uses explicit rating scale and keeps null gaps with no interpolation', () => {
  render(<TimelineMetricChart points={points} metric="averageRate" />);
  const option = chart.mock.lastCall![0].option;
  expect(option.yAxis).toMatchObject({ min: 0, max: 10, name: '分 · 0–10' });
  expect(option.series[0].data).toEqual([8, null]);
  expect(option.series[0].connectNulls).toBe(false);
});
it('quantity and episode charts keep exact values on separate linear scales', () => {
  const view = render(<TimelineMetricChart points={points} metric="added" />);
  expect(chart.mock.lastCall![0].option.series[0].data).toEqual([616, 1]);
  view.rerender(<TimelineMetricChart points={points} metric="episodes" />);
  expect(chart.mock.lastCall![0].option.series[0].data).toEqual([120, 2]);
  expect(chart.mock.lastCall![0].option.yAxis.name).toBe('集');
});
it('overview preserves the final true endpoint and points; tick sampling only affects labels', () => {
  const p = Array.from({ length: 2400 }, (_, i) => ({
    ...points[0]!,
    period: String(i).padStart(4, '0'),
    label: String(i),
    added: i === 2399 ? 616 : 1,
  }));
  const view = render(
    <TimelineOverview points={p} selectedFrom="0000" selectedTo="2399" onLocate={vi.fn()} />,
  );
  const overview = chart.mock.lastCall![0].option;
  expect(overview.xAxis.data.at(-1)).toBe('2385 → 2399');
  expect(overview.xAxis.axisLabel.formatter(overview.xAxis.data.at(-1),overview.xAxis.data.length-1)).toContain('2399');
  expect(overview.xAxis.axisLabel.alignMaxLabel).toBe('center');
  expect(overview.series[0].data.reduce((s: number, v: { value: number }) => s + v.value, 0)).toBe(
    3015,
  );
  view.rerender(<TimelineMetricChart points={p} metric="total" />);
  expect(chart.mock.lastCall![0].option.series[0].data).toHaveLength(2400);
  expect(chart.mock.lastCall![0].option.xAxis.axisLabel.interval(0)).toBe(true);
  expect(chart.mock.lastCall![0].option.xAxis.axisLabel.interval(2399)).toBe(true);
});

it('current-range chart rebuilds axes from only displayed points, keeps exact magnitudes and has no history highlighting', () => {
  const view = render(<TimelineOverview points={points} selectedFrom="" selectedTo="" currentRange />);
  let option = chart.mock.lastCall![0].option;
  expect(option.xAxis.data).toEqual(['2026-01', '2026-02']);
  expect(option.series[0].data.map((d: {value: number}) => d.value)).toEqual([616, 1]);
  view.rerender(<TimelineOverview points={[points[1]!]} selectedFrom="" selectedTo="" currentRange />);
  option = chart.mock.lastCall![0].option;
  expect(option.xAxis.data).toEqual(['2026-02']);
  expect(option.series[0].data).toEqual([{value: 1, itemStyle: {color: 'blue', opacity: 1}}]);
  expect(option.yAxis).toMatchObject({ min: 0, minInterval: 1 });
  expect(option.yAxis.max).toBeUndefined(); // ECharts derives scale from this range, not the old 616 peak.
  expect(chart.mock.lastCall![0].onEvents).toBeUndefined();
});

it('current range never buckets away periods, even at 2400, and leaves cumulative input untouched', () => {
  const p = Array.from({length: 2400}, (_, i) => ({...points[1]!, period: String(i), added: i, total: 10000 + i}));
  render(<TimelineOverview points={p} selectedFrom="" selectedTo="" currentRange />);
  const option = chart.mock.lastCall![0].option;
  expect(option.xAxis.data).toHaveLength(2400);
  expect(option.series[0].data.map((d: {value: number}) => d.value)).toEqual(p.map(x => x.added));
  expect(p[0]!.total).toBe(10000);
  expect(option.series[0].large).toBe(true);
});

it.each(['added', 'episodes', 'averageRate', 'total'] as const)('all metric %s axes use the original period index with centered compact labels', metric => {
  render(<TimelineMetricChart points={points} metric={metric} />);
  const o=chart.mock.lastCall![0].option;
  expect(o.xAxis.data).toEqual(points.map(p=>p.period));
  expect(o.xAxis.axisLabel).toMatchObject({align:'center',alignMinLabel:'center',alignMaxLabel:'center',hideOverlap:false});
  expect(o.xAxis.axisLabel.formatter(o.xAxis.data[0],0)).toBe('2026-01');
  expect(o.xAxis.axisLabel.interval(0)&&o.xAxis.axisLabel.interval(1)).toBe(true);
  expect(o.xAxis.axisTick.alignWithLabel).toBe(true);
  expect(o.grid.containLabel).toBe(false);
  expect(o.xAxis.boundaryGap).toBe(metric==='added'||metric==='episodes');
});
it('quarter formatting cannot shift category identity, series index or Tooltip',()=>{
  const p=points.map((v,i)=>({...v,period:i?'2025Q1':'2024Q4',label:i?'2025 年 Q1':'2024 年 Q4'}));
  render(<TimelineMetricChart points={p} metric="added"/>);
  const o=chart.mock.lastCall![0].option;
  expect(o.xAxis.data).toEqual(['2024Q4','2025Q1']);
  expect(o.xAxis.axisLabel.formatter('2024Q4',0)).toBe('2024 Q4');
  expect(o.xAxis.axisLabel.formatter('2025Q1',1)).toBe('2025 Q1');
  expect(o.tooltip.formatter([{dataIndex:1}])).toContain('2025 年 Q1');
  expect(o.tooltip.formatter([{dataIndex:1}])).toContain('1 部');
});
