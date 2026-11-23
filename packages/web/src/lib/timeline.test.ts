import { expect, it } from 'vitest';
import type { TimelineStats } from '@bangumi-analyzer/shared';
import {
  overviewBuckets,
  periodIndex,
  periodKey,
  periodMonths,
  rangePoints,
  readTimelineRange,
  resolveTimelineRange,
  summarizeTimeline,
  timelineCapability,
  writeTimelineRange,
} from './timeline.js';

export function fixture(length = 24, first = '2024-11', referenceMonth = '2026-10'): TimelineStats {
  const start = periodIndex(first, 'month')!;
  const points = Array.from({ length }, (_, i) => ({
    period: periodKey(start + i, 'month'),
    label: periodKey(start + i, 'month'),
    added: i === 0 || i === length - 1 ? 1 : 0,
    updated: i === 0 ? 1 : 0,
    total: i === length - 1 ? 2 : 1,
    episodes: i === 0 ? 12 : 0,
    averageRate: i === 0 ? 10 : i === length - 1 ? 2 : null,
    ratingSample: {
      ratedCount: i === 0 || i === length - 1 ? 1 : 0,
      ratingSum: i === 0 ? 10 : i === length - 1 ? 2 : 0,
    },
  }));
  if (length === 1) {
    points[0]!.added = 2;
    points[0]!.ratingSample = { ratedCount: 2, ratingSum: 12 };
  }
  return {
    granularity: 'month',
    basis: 'collection-updated-at',
    note: '最后更新时间',
    points,
    context: {
      contextVersion: 1,
      visibility: 'real',
      dataVersion: 1,
      referenceMonth,
      viewReferenceAt: referenceMonth + '-25T00:00:00Z',
      calendarZone: 'Asia/Shanghai',
      sourceRefreshedAt: null,
      sequence: {
        kind: 'full',
        complete: true,
        from: points[0]!.period,
        to: points.at(-1)!.period,
      },
      timeCoverage: { datedCollections: 2, undatedCollections: 1 },
    },
  };
}
it('defaults to current-calendar 12 months, never the last recorded window', () => {
  const data = fixture(12, '2000-01'),
    state = readTimelineRange(new URLSearchParams());
  const range = resolveTimelineRange(data, state)!;
  expect(periodKey(range.first, 'month')).toBe('2025-11');
  expect(periodKey(range.last, 'month')).toBe('2026-10');
  const projected = rangePoints(data, range);
  expect(projected).toHaveLength(12);
  expect(projected.every((p) => p.added === 0 && p.total === 2 && p.averageRate === null)).toBe(
    true,
  );
  const recorded = resolveTimelineRange(data, { ...state, mode: 'recorded' })!;
  expect(periodKey(recorded.last, 'month')).toBe('2000-12');
});
it('legacy 601 points are unknown, never padded or certified as latest or complete', () => {
  const data = fixture(601, '1900-01');
  delete data.context;
  data.points.forEach((p) => delete p.ratingSample);
  expect(timelineCapability(data)).toBe('unknown');
  const range = resolveTimelineRange(data, readTimelineRange(new URLSearchParams()))!;
  expect(rangePoints(data, range)).toHaveLength(12);
  expect(periodKey(range.last, 'month')).toBe(data.points.at(-1)!.period);
  expect(summarizeTimeline(data.points).samplesKnown).toBe(false);
});
it('rejects false completeness: missing interior/tail, bad coverage and mismatched boundaries', () => {
  for (const mutate of [
    (d: TimelineStats) => d.points.splice(3, 1),
    (d: TimelineStats) => d.points.pop(),
    (d: TimelineStats) => d.context!.timeCoverage.datedCollections++,
    (d: TimelineStats) => d.points[4]!.total++,
  ]) {
    const d = fixture();
    mutate(d);
    expect(timelineCapability(d)).toBe('invalid');
  }
});
it('weighted mean uses exact sum/sample; zero sample differs from unavailable metadata', () => {
  const d = fixture(2);
  d.points[0]!.added = 3;
  d.points[0]!.ratingSample = { ratedCount: 3, ratingSum: 5 };
  d.points[0]!.averageRate = 1.67;
  d.points[1]!.ratingSample = { ratedCount: 1, ratingSum: 10 };
  expect(summarizeTimeline(d.points)).toMatchObject({ ratedCount: 4, averageRate: 3.75 });
  d.points.forEach((p) => {
    p.ratingSample = { ratedCount: 0, ratingSum: 0 };
    p.averageRate = null;
  });
  expect(summarizeTimeline(d.points)).toMatchObject({
    samplesKnown: true,
    ratedCount: 0,
    averageRate: null,
  });
  delete d.points[0]!.ratingSample;
  expect(summarizeTimeline(d.points)).toMatchObject({
    samplesKnown: false,
    ratedCount: null,
    averageRate: null,
  });
});
it('URL round trip preserves other tabs/filters; invalid fixed ranges retain their intent', () => {
  const initial = new URLSearchParams('tab=timeline&keep=yes');
  const state = {
    grain: 'quarter' as const,
    mode: 'custom' as const,
    from: '1999-12',
    to: '2000-03',
  };
  const next = writeTimelineRange(initial, state);
  expect(readTimelineRange(next)).toEqual(state);
  expect(next.get('keep')).toBe('yes');
  const d = fixture();
  expect(resolveTimelineRange(d, { ...state, grain: 'month' })).toBeNull();
  expect(next.get('from')).toBe('1999-12');
  expect(
    resolveTimelineRange(d, { ...state, grain: 'month', from: '2026-10', to: '2025-01' }),
  ).toBeNull();
});
it('quarter and year projection preserve civil endpoints and low years', () => {
  expect(periodMonths(periodIndex('0099Q4', 'quarter')!, 'quarter')).toEqual({
    from: '0099-10',
    to: '0099-12',
  });
  expect(periodMonths(periodIndex('0100', 'year')!, 'year')).toEqual({
    from: '0100-01',
    to: '0100-12',
  });
  expect(periodIndex('2026-13', 'month')).toBeNull();
  expect(periodIndex('2026\n', 'year')).toBeNull();
  expect(periodIndex('2026\r', 'year')).toBeNull();
  expect(periodIndex('2026-01\r', 'month')).toBeNull();
  expect(periodIndex('2026-01\u2028', 'month')).toBeNull();
});
it.each([602, 720, 2400, 120000])(
  'all %i periods remain reachable with bounded overview buckets',
  (n) => {
    const data = fixture(n, n === 120000 ? '0000-01' : '1000-01');
    const r = resolveTimelineRange(data, { grain: 'month', mode: 'all', from: '', to: '' })!;
    const all = rangePoints(data, r);
    expect(all.some((p) => p.period === data.points[0]!.period)).toBe(true);
    expect(all.some((p) => p.period === data.points.at(-1)!.period)).toBe(true);
    expect(all.at(-1)?.total).toBe(2);
    const overview = overviewBuckets(data.points);
    expect(overview.buckets.length).toBeLessThanOrEqual(160);
    expect(overview.buckets.reduce((s, b) => s + b.added, 0)).toBe(2);
    expect(overview.buckets.at(-1)?.last).toBe(data.points.at(-1)!.period);
  },
);
