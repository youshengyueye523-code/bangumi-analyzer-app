import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveConfig } from '../src/config.js';
import { run, dataVersion, bumpDataVersion } from '../src/db/index.js';
import { invalidateStatsCache } from '../src/stats/cache.js';
import { timeline } from '../src/stats/queries.js';
import { registerStatsRoutes } from '../src/http/routes/stats.js';
import { registerErrorHandler } from '../src/http/errors.js';
import { resetDatabase } from './helpers.js';

beforeEach(() => {
  resetDatabase();
  invalidateStatsCache();
  saveConfig({ hideNsfw: false });
});
afterEach(() => vi.useRealTimers());
function add(id: number, date: string | null, rate: unknown = 7, nsfw = 0) {
  run(
    `INSERT INTO subjects(id,type,name,nsfw,eps,created_at,updated_at) VALUES(?,2,'context',?,12,'2026-10-25','2026-10-25')`,
    [id, nsfw],
  );
  run(
    `INSERT INTO collections(subject_id,subject_type,type,rate,updated_at,first_seen_at,synced_at) VALUES(?,2,2,?,?,'2026-10-25','2026-10-25')`,
    [id, rate, date],
  );
}
it('provides full-sequence proof and dated/undated coverage without changing old fields', () => {
  add(1, '2024-01-01');
  add(2, '2024-03-01');
  add(3, null);
  add(4, '');
  const result = timeline('month');
  expect(result.points.map((p) => p.period)).toEqual(['2024-01', '2024-02', '2024-03']);
  expect(result.context).toMatchObject({
    contextVersion: 1,
    visibility: 'real',
    dataVersion: dataVersion(),
    calendarZone: 'Asia/Shanghai',
    sequence: { kind: 'full', complete: true, from: '2024-01', to: '2024-03' },
    timeCoverage: { datedCollections: 2, undatedCollections: 2 },
    sourceRefreshedAt: null,
  });
  expect(result.points[1]).toMatchObject({
    added: 0,
    total: 1,
    averageRate: null,
    ratingSample: { ratedCount: 0, ratingSum: 0 },
  });
});
it('distinguishes an empty database from collections without dates', () => {
  expect(timeline('month').context?.timeCoverage).toEqual({
    datedCollections: 0,
    undatedCollections: 0,
  });
  add(1, null);
  bumpDataVersion();
  expect(timeline('month').points).toEqual([]);
  expect(timeline('month').context?.timeCoverage).toEqual({
    datedCollections: 0,
    undatedCollections: 1,
  });
});
it('returns raw canonical rating sums: weighted range average cannot be average of rounded period means', () => {
  add(1, '2026-01-01', 10);
  add(2, '2026-02-01', 1);
  add(3, '2026-02-02', 2);
  add(4, '2026-02-03', 2);
  add(5, '2026-02-04', 11);
  add(6, '2026-02-05', 2.5);
  add(7, '2026-02-06', 'bad');
  add(8, '2026-02-07', 0);
  const p = timeline('month').points;
  expect(p.map((v) => v.averageRate)).toEqual([10, 1.67]);
  expect(p.map((v) => v.ratingSample)).toEqual([
    { ratedCount: 1, ratingSum: 10 },
    { ratedCount: 3, ratingSum: 5 },
  ]);
  expect(
    p.reduce((s, v) => s + v.ratingSample!.ratingSum, 0) /
      p.reduce((s, v) => s + v.ratingSample!.ratedCount, 0),
  ).toBe(3.75);
});
it('refreshes request calendar context across Shanghai month boundary with a warm dataVersion cache', () => {
  add(1, '2020-01-01');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T15:59:59Z'));
  const before = timeline('month'),
    version = dataVersion();
  vi.setSystemTime(new Date('2026-10-31T16:00:01Z'));
  const after = timeline('month');
  expect(before.context?.referenceMonth).toBe('2026-10');
  expect(after.context?.referenceMonth).toBe('2026-11');
  expect(after.context?.viewReferenceAt).not.toBe(before.context?.viewReferenceAt);
  expect(after.points).toBe(before.points);
  expect(dataVersion()).toBe(version);
});
it('binds counts, samples and boundaries to the same visibility/version without source mutation', () => {
  add(1, '1900-01-01', 10, 1);
  add(2, '2026-01-01', 6);
  add(3, null, 8, 1);
  const v = dataVersion();
  expect(timeline('year').context?.timeCoverage).toEqual({
    datedCollections: 2,
    undatedCollections: 1,
  });
  saveConfig({ hideNsfw: true });
  expect(timeline('year')).toMatchObject({
    context: {
      visibility: 'visible',
      dataVersion: v,
      sequence: { from: '2026', to: '2026' },
      timeCoverage: { datedCollections: 1, undatedCollections: 0 },
    },
    points: [{ added: 1, ratingSample: { ratedCount: 1, ratingSum: 6 } }],
  });
  saveConfig({ hideNsfw: false });
  expect(timeline('year').context?.timeCoverage.datedCollections).toBe(2);
  expect(dataVersion()).toBe(v);
});
it('does not freeze the source-sync timestamp when a sync leaves dataVersion unchanged', () => {
  add(1, '2020-01-01');
  const before = timeline('month');
  run("INSERT OR REPLACE INTO meta(key,value) VALUES('last_sync_at','2026-10-25T12:00:00Z')");
  const after = timeline('month');
  expect(after.points).toBe(before.points);
  expect(after.context?.sourceRefreshedAt).toBe('2026-10-25T12:00:00Z');
});
it('preserves old HTTP consumer values, Dashboard and explicit error envelopes', async () => {
  const app = Fastify({ logger: false });
  registerStatsRoutes(app);
  registerErrorHandler(app, false);
  try {
    add(1, '2020-01-01');
    add(2, '2026-10-01', 9);
    const response = await app.inject('/api/stats/timeline?granularity=month');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.points.at(-1)).toMatchObject({
      period: '2026-10',
      added: 1,
      updated: 1,
      total: 2,
      episodes: 12,
      averageRate: 9,
    });
    const legacy = {
      ...body,
      points: body.points.map(({ ratingSample: _sample, ...p }: Record<string, unknown>) => p),
    };
    delete legacy.context;
    expect(Object.keys(legacy).sort()).toEqual(['basis', 'granularity', 'note', 'points']);
    expect(legacy.points.map((p: { total: number }) => p.total).at(-1)).toBe(2);
    const dashboard = (await app.inject('/api/stats/dashboard')).json();
    expect(dashboard.timeline.points.at(-1).total).toBe(dashboard.overview.total);
    add(3, '202A-01-01');
    bumpDataVersion();
    const failure = await app.inject('/api/stats/timeline?granularity=month');
    expect(failure.statusCode).toBe(500);
    expect(failure.json().error.code).toBe('invalid_timeline_period');
    expect(failure.json()).not.toHaveProperty('points');
  } finally {
    await app.close();
  }
});
