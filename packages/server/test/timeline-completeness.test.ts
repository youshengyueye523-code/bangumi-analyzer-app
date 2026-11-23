import { ApiError } from '@bangumi-analyzer/shared';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { all, dataVersion, run } from '../src/db/index.js';
import { registerErrorHandler } from '../src/http/errors.js';
import { registerStatsRoutes } from '../src/http/routes/stats.js';
import { invalidateStatsCache } from '../src/stats/cache.js';
import { timeline } from '../src/stats/queries.js';
import { assertIsolatedTestDatabase, resetDatabase } from './helpers.js';

const app = Fastify({ logger: false });

beforeAll(async () => {
  assertIsolatedTestDatabase();
  registerErrorHandler(app, false);
  registerStatsRoutes(app);
  await app.ready();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  resetDatabase();
  invalidateStatsCache();
  saveConfig({ hideNsfw: false });
});

function insert(id: number, updatedAt: string | null, type = 2, rate = 8, progress = 0) {
  const ts = '2026-10-25T00:00:00Z';
  run(`INSERT INTO subjects (id,type,name,nsfw,eps,total_episodes,created_at,updated_at)
       VALUES (:id,2,'timeline fixture',0,12,12,:ts,:ts)`, { id, ts });
  run(`INSERT INTO collections (subject_id,subject_type,type,rate,ep_status,updated_at,first_seen_at,synced_at)
       VALUES (:id,2,:type,:rate,:progress,:updatedAt,:ts,:ts)`,
    { id, type, rate, progress, updatedAt, ts });
}

// Independent calendar oracle: Date month arithmetic, rather than the production period generator.
function calendar(length: number): string[] {
  const cursor = new Date('2026-10-01T00:00:00Z');
  cursor.setUTCMonth(cursor.getUTCMonth() - length + 1);
  return Array.from({ length }, () => {
    const key = cursor.toISOString().slice(0, 7);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    return key;
  });
}

function sparseFixture(keys: string[]) {
  const first = keys[0]!, middle = keys[Math.floor(keys.length / 2)]!, last = keys.at(-1)!;
  insert(1, `${first}-01T00:00:00+08:00`);                 // done, 12 episodes, rated 8
  insert(2, `${first}-02T00:00:00+08:00`, 1, 0);           // wish, no episodes or rating
  insert(3, `${middle}-03T00:00:00+08:00`, 4, 0, 3);        // on hold, 3 episodes, unrated
  insert(4, `${last}-04T00:00:00+08:00`, 3, 6, 5);          // doing, 5 episodes, rated 6
  insert(5, `${last}-05T00:00:00+08:00`, 2, 10);            // done, 12 episodes, rated 10
  return [
    { key: first, count: 2, done: 1, episodes: 12, rates: [8] },
    { key: middle, count: 1, done: 0, episodes: 3, rates: [] as number[] },
    { key: last, count: 2, done: 1, episodes: 17, rates: [6, 10] },
  ];
}

describe('P0-A timeline completeness', () => {
  it.each([1, 12, 600, 601, 602, 720, 2400])('returns all %i months with exact zero gaps and prefixes', (length) => {
    const keys = calendar(length), fixtures = sparseFixture(keys);
    const result = timeline('month');
    expect(result.points.map(point => point.period)).toEqual(keys);
    expect(result.points).toHaveLength(length);
    expect(result.basis).toBe('collection-updated-at');
    expect(result.note).toContain('最后更新时间');
    const { context: _context, ...legacyResult } = result;
    expect(Object.keys(legacyResult).sort()).toEqual(['basis', 'granularity', 'note', 'points']);
    let cumulative = 0;
    for (const point of result.points) {
      const rows = fixtures.filter(row => row.key === point.period);
      const added = rows.reduce((sum, row) => sum + row.count, 0);
      const rates = rows.flatMap(row => row.rates);
      cumulative += added;
      const { ratingSample: _ratingSample, ...legacyPoint } = point;
      expect(legacyPoint).toEqual({
        period: point.period,
        label: `${point.period.slice(0, 4)} 年 ${Number(point.period.slice(5))} 月`,
        added,
        updated: rows.reduce((sum, row) => sum + row.done, 0),
        total: cumulative,
        episodes: rows.reduce((sum, row) => sum + row.episodes, 0),
        averageRate: rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null,
      });
    }
    expect(result.points.reduce((sum, point) => sum + point.added, 0)).toBe(5);
    expect(result.points.reduce((sum, point) => sum + point.updated, 0)).toBe(2);
    expect(result.points.reduce((sum, point) => sum + point.episodes, 0)).toBe(32);
    expect(result.points[0]!.added).toBe(length === 1 ? 5 : 2);
    expect(result.points.at(-1)!.added).toBe(length === 1 ? 5 : 2);
    expect(result.points.at(-1)!.total).toBe(5);
  });

  it('preserves year/quarter boundaries, empty years and upstream string timezone semantics', () => {
    insert(1, '2023-12-31T23:59:59+08:00');
    insert(2, '2024-01-01T00:00:00+08:00');
    insert(3, '2024-04-01T00:00:00+08:00');
    insert(4, '2026-01-01T00:00:00+08:00');
    const years = timeline('year').points;
    expect(years.map(point => point.period)).toEqual(['2023', '2024', '2025', '2026']);
    expect(years.map(point => point.added)).toEqual([1, 2, 0, 1]);
    expect(years.map(point => point.total)).toEqual([1, 3, 3, 4]);
    const quarters = timeline('quarter').points;
    expect(quarters.map(point => point.period)).toEqual([
      '2023Q4', '2024Q1', '2024Q2', '2024Q3', '2024Q4',
      '2025Q1', '2025Q2', '2025Q3', '2025Q4', '2026Q1',
    ]);
    expect(quarters.map(point => point.total)).toEqual([1, 2, 3, 3, 3, 3, 3, 3, 3, 4]);
    expect(quarters[3]).toMatchObject({ added: 0, updated: 0, episodes: 0, averageRate: null });
  });

  it('crosses century and leap-year month boundaries without Date year coercion', () => {
    insert(1, '1999-12-31T23:00:00+08:00');
    insert(2, '2000-03-01T01:00:00+08:00');
    expect(timeline('month').points.map(point => point.period)).toEqual([
      '1999-12', '2000-01', '2000-02', '2000-03',
    ]);
  });

  it('bounds resources by the complete four-digit year domain, without another hidden cap', () => {
    insert(1, '0000-01-01T00:00:00+08:00');
    insert(2, '9999-12-31T00:00:00+08:00');
    for (const [grain, count, first, last] of [
      ['year', 10000, '0000', '9999'],
      ['quarter', 40000, '0000Q1', '9999Q4'],
      ['month', 120000, '0000-01', '9999-12'],
    ] as const) {
      const points = timeline(grain).points;
      expect(points).toHaveLength(count);
      expect(points[0]).toMatchObject({ period: first, added: 1, total: 1 });
      expect(points.at(-1)).toMatchObject({ period: last, added: 1, total: 2 });
      expect(points.reduce((sum, point) => sum + point.added, 0)).toBe(2);
    }
  });

  it.each([
    ['month', '2026-00-01'], ['month', '2026-13-01'], ['month', '2026-1x-01'],
    ['month', '10000-01-01'], ['quarter', '2026-99-01'], ['year', 'not-a-date'],
  ] as const)('rejects invalid %s buckets explicitly: %s', (grain, badDate) => {
    insert(1, '2020-01-01');
    insert(2, badDate);
    insert(3, '2030-01-01');
    expect(() => timeline(grain)).toThrow(ApiError);
    expect(() => timeline(grain)).toThrow(expect.objectContaining({
      code: 'invalid_timeline_period', status: 500, dataIntact: true,
    }));
  });

  it('validates invalid interior buckets rather than dropping them between valid endpoints', () => {
    insert(1, '2020-01-01');
    insert(2, '202A-02-01');
    insert(3, '2030-01-01');
    expect(() => timeline('month')).toThrow(expect.objectContaining({ code: 'invalid_timeline_period' }));
  });

  it('keeps missing-date exclusion and the empty response unchanged', () => {
    insert(1, null);
    insert(2, '');
    for (const grain of ['year', 'quarter', 'month'] as const) expect(timeline(grain).points).toEqual([]);
  });

  it('preserves visibility and does not mutate source rows or dataVersion', () => {
    sparseFixture(calendar(720));
    run('UPDATE subjects SET nsfw=1 WHERE id=5');
    const before = { collections: all('SELECT * FROM collections ORDER BY subject_id'), version: dataVersion() };
    expect(timeline('month').points.at(-1)!.total).toBe(5);
    saveConfig({ hideNsfw: true });
    expect(timeline('month').points.at(-1)!.total).toBe(4);
    saveConfig({ hideNsfw: false });
    expect(timeline('month').points.at(-1)!.total).toBe(5);
    expect(all('SELECT * FROM collections ORDER BY subject_id')).toEqual(before.collections);
    expect(dataVersion()).toBe(before.version);
  });

  it('serves the full monthly API and existing dashboard consumer without schema changes', async () => {
    sparseFixture(calendar(720));
    const monthly = await app.inject({ method: 'GET', url: '/api/stats/timeline?granularity=month' });
    expect(monthly.statusCode).toBe(200);
    const body = monthly.json();
    expect(body.points).toHaveLength(720);
    expect(body.points.at(-1)).toMatchObject({ period: '2026-10', added: 2, total: 5, episodes: 17 });
    const dashboard = await app.inject({ method: 'GET', url: '/api/stats/dashboard' });
    expect(dashboard.statusCode).toBe(200);
    const dash = dashboard.json();
    expect(dash.timeline.granularity).toBe('year');
    expect(dash.timeline.points).toHaveLength(61);
    expect(dash.timeline.points.at(-1)).toMatchObject({ period: '2026', total: 5 });
    expect(dash.timeline.points.reduce((sum: number, point: { added: number }) => sum + point.added, 0)).toBe(dash.overview.total);
  });

  it('returns an explicit existing error envelope, never a successful partial series', async () => {
    insert(1, '2020-01-01');
    insert(2, '2026-13-01');
    const response = await app.inject({ method: 'GET', url: '/api/stats/timeline?granularity=month' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_timeline_period', dataIntact: true } });
    expect(response.json()).not.toHaveProperty('points');
  });
});
