import type { TimelinePoint, TimelineStats } from '@bangumi-analyzer/shared';

export type TimelineGrain = TimelineStats['granularity'];
export type RangeMode = 'recent' | 'recorded' | 'all' | 'custom';
export interface TimelineRange {
  grain: TimelineGrain;
  mode: RangeMode;
  from: string;
  to: string;
}
export interface PeriodRange {
  first: number;
  last: number;
}
export const grainSize = (grain: TimelineGrain) =>
  grain === 'year' ? 1 : grain === 'quarter' ? 4 : 12;

export function periodIndex(key: string, grain: TimelineGrain): number | null {
  const pattern =
    grain === 'year'
      ? /^\d{4}$/
      : grain === 'quarter'
        ? /^\d{4}Q[1-4]$/
        : /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!pattern.test(key) || key.includes('\n')) return null;
  return (
    Number(key.slice(0, 4)) * grainSize(grain) + (grain === 'year' ? 0 : Number(key.slice(5)) - 1)
  );
}

export function periodKey(index: number, grain: TimelineGrain): string {
  const size = grainSize(grain),
    year = String(Math.floor(index / size)).padStart(4, '0');
  return grain === 'year'
    ? year
    : grain === 'quarter'
      ? `${year}Q${(index % size) + 1}`
      : `${year}-${String((index % size) + 1).padStart(2, '0')}`;
}

export function periodLabel(key: string, grain: TimelineGrain): string {
  return grain === 'year'
    ? `${key} 年`
    : grain === 'quarter'
      ? `${key.slice(0, 4)} 年 Q${key.slice(5)}`
      : `${key.slice(0, 4)} 年 ${Number(key.slice(5))} 月`;
}

export function periodMonths(index: number, grain: TimelineGrain): { from: string; to: string } {
  const size = grainSize(grain),
    months = 12 / size,
    first = Math.floor(index / size) * 12 + (index % size) * months;
  return { from: periodKey(first, 'month'), to: periodKey(first + months - 1, 'month') };
}

export function readTimelineRange(params: URLSearchParams): TimelineRange {
  const raw = params.get('tg'),
    mode = params.get('tr');
  return {
    grain: raw === 'year' || raw === 'quarter' ? raw : 'month',
    mode: mode === 'all' || mode === 'recorded' || mode === 'custom' ? mode : 'recent',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
}

export function writeTimelineRange(params: URLSearchParams, range: TimelineRange): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const k of ['tg', 'tr', 'from', 'to']) next.delete(k);
  if (range.grain !== 'month') next.set('tg', range.grain);
  if (range.mode !== 'recent') next.set('tr', range.mode);
  if (range.mode === 'custom') {
    next.set('from', range.from);
    next.set('to', range.to);
  }
  return next;
}

/** Metadata is a capability proof, not a heuristic based on a conveniently short response. */
export function timelineCapability(data: TimelineStats): 'complete' | 'unknown' | 'invalid' {
  const ctx = data.context;
  if (
    !ctx ||
    ctx.contextVersion !== 1 ||
    ctx.sequence?.complete !== true ||
    ctx.sequence.kind !== 'full'
  )
    return 'unknown';
  const first = data.points[0]?.period ?? null,
    last = data.points.at(-1)?.period ?? null;
  if (
    ctx.sequence.from !== first ||
    ctx.sequence.to !== last ||
    periodIndex(ctx.referenceMonth, 'month') === null ||
    ctx.calendarZone !== 'Asia/Shanghai' ||
    !['real', 'visible'].includes(ctx.visibility) ||
    !Number.isSafeInteger(ctx.dataVersion) ||
    ctx.dataVersion < 0 ||
    !Number.isSafeInteger(ctx.timeCoverage?.undatedCollections) ||
    ctx.timeCoverage.undatedCollections < 0
  )
    return 'invalid';
  let total = 0,
    previous: number | null = null;
  for (const point of data.points) {
    const index = periodIndex(point.period, data.granularity);
    if (
      index === null ||
      (previous !== null && index !== previous + 1) ||
      !Number.isSafeInteger(point.added) ||
      point.added < 0
    )
      return 'invalid';
    total += point.added;
    if (point.total !== total) return 'invalid';
    previous = index;
  }
  return total === ctx.timeCoverage?.datedCollections ? 'complete' : 'invalid';
}

export function timelineDomain(data: TimelineStats): PeriodRange | null {
  if (data.points.length === 0) return null;
  const grain = data.granularity,
    first = periodIndex(data.points[0]!.period, grain),
    last = periodIndex(data.points.at(-1)!.period, grain);
  if (first === null || last === null) return null;
  if (timelineCapability(data) !== 'complete') return { first, last };
  const month = periodIndex(data.context!.referenceMonth, 'month')!;
  const current = Math.floor(month / (12 / grainSize(grain)));
  return { first: Math.min(first, Math.max(0, current - 11)), last: Math.max(last, current) };
}

export function resolveTimelineRange(
  data: TimelineStats,
  state: TimelineRange,
): PeriodRange | null {
  const domain = timelineDomain(data);
  if (!domain) return null;
  const complete = timelineCapability(data) === 'complete';
  if (state.mode === 'all')
    return complete
      ? { first: periodIndex(data.points[0]!.period, data.granularity)!, last: domain.last }
      : domain;
  if (state.mode === 'custom') {
    const from = periodIndex(state.from, 'month'),
      to = periodIndex(state.to, 'month');
    if (from === null || to === null || from > to) return null;
    const size = 12 / grainSize(state.grain),
      first = Math.floor(from / size),
      last = Math.floor(to / size);
    return first < domain.first || last > domain.last ? null : { first, last };
  }
  // With an old server this is explicitly the last returned range, never calendar padding.
  const last =
    state.mode === 'recorded' || !complete
      ? periodIndex(data.points.at(-1)!.period, state.grain)!
      : Math.floor(
          periodIndex(data.context!.referenceMonth, 'month')! / (12 / grainSize(state.grain)),
        );
  return { first: Math.max(complete ? 0 : domain.first, last - 11), last };
}

export function rangePoints(data: TimelineStats, range: PeriodRange): TimelinePoint[] {
  if (timelineCapability(data) !== 'complete')
    return data.points.filter((p) => {
      const n = periodIndex(p.period, data.granularity);
      return n !== null && n >= range.first && n <= range.last;
    });
  const sourceFirst = periodIndex(data.points[0]!.period, data.granularity)!;
  const last = data.points.at(-1)!;
  return Array.from({ length: range.last - range.first + 1 }, (_, i) => {
    const index = range.first + i,
      existing = data.points[index - sourceFirst];
    if (existing) return existing;
    const period = periodKey(index, data.granularity);
    return {
      period,
      label: periodLabel(period, data.granularity),
      added: 0,
      updated: 0,
      episodes: 0,
      averageRate: null,
      total: index < sourceFirst ? 0 : last.total,
      ratingSample: { ratedCount: 0, ratingSum: 0 },
    };
  });
}

export function summarizeTimeline(points: TimelinePoint[]) {
  let added = 0,
    done = 0,
    episodes = 0,
    ratedCount = 0,
    ratingSum = 0,
    samplesKnown = true;
  for (const p of points) {
    added += p.added;
    done += p.updated;
    episodes += p.episodes;
    const s = p.ratingSample;
    if (
      !s ||
      !Number.isSafeInteger(s.ratedCount) ||
      s.ratedCount < 0 ||
      s.ratedCount > p.added ||
      !Number.isSafeInteger(s.ratingSum) ||
      s.ratingSum < s.ratedCount ||
      s.ratingSum > 10 * s.ratedCount
    )
      samplesKnown = false;
    else {
      ratedCount += s.ratedCount;
      ratingSum += s.ratingSum;
    }
  }
  return {
    added,
    done,
    episodes,
    samplesKnown,
    ratedCount: samplesKnown ? ratedCount : null,
    averageRate: samplesKnown && ratedCount > 0 ? ratingSum / ratedCount : null,
  };
}

/** Display-only grouping keeps every source count. Exact focus and rows retain their original grain. */
export function overviewBuckets(points: TimelinePoint[], limit = 160) {
  const step = Math.max(1, Math.ceil(points.length / limit));
  const buckets: Array<{ first: string; last: string; added: number; recorded: number }> = [];
  for (let i = 0; i < points.length; i += step) {
    const group = points.slice(i, i + step);
    buckets.push({
      first: group[0]!.period,
      last: group.at(-1)!.period,
      added: group.reduce((s, p) => s + p.added, 0),
      recorded: group.filter((p) => p.added > 0).length,
    });
  }
  return { step, buckets };
}
