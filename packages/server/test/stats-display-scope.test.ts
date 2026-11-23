import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { dataVersion, run, setMeta } from '../src/db/index.js';
import { hideWork, hiddenWorks, restoreWork } from '../src/db/userHides.js';
import { registerStatsRoutes } from '../src/http/routes/stats.js';
import { resetDatabase } from './helpers.js';

const app = Fastify();
const timestamp = '2026-02-05T12:00:00+08:00';
const paths = ['overview', 'distributions', 'timeline?granularity=year', 'bias', 'studios', 'directors', 'habits'] as const;
beforeAll(async () => {
  registerStatsRoutes(app);
  resetDatabase();
  saveConfig({ hideNsfw: false });
  for (const [id, nsfw, type, rate, date] of [
    [1, 0, 2, 8, timestamp], [2, 0, 2, 7, timestamp], [3, 1, 2, 10, timestamp],
    [4, 1, 2, 9, timestamp], [5, 0, 1, 10, null],
  ] as const) {
    run(`INSERT INTO subjects (id,name,name_cn,year,format,score,total_episodes,nsfw,tag_names,studios,directors,created_at,updated_at)
      VALUES (:id,:name,:name,2026,'TV',7,12,:nsfw,'["Tag"]','["Studio"]','["Director"]',:ts,:ts)`,
      { id, nsfw, name: 'fixture-' + id, ts: timestamp });
    run(`INSERT INTO collections(subject_id,subject_type,type,rate,ep_status,updated_at,first_seen_at,synced_at)
      VALUES (:id,2,:type,:rate,12,:date,:ts,:ts)`, { id, type, rate, date, ts: timestamp });
  }
  setMeta('last_sync_at', timestamp);
});
afterAll(() => app.close());

async function get(path: string) {
  const response = await app.inject({ method: 'GET', url: '/api/stats/' + path });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function readAnalysis() {
  const [overview, distributions, timeline, bias, studios, directors, habits] = await Promise.all(paths.map(get));
  expect(timeline.context.visibility).toBe('real');
  expect(overview.total).toBe(5);
  expect(overview.ratedCount).toBe(4); // 想看不进入评分样本。
  expect(distributions.format[0].count).toBe(5);
  expect(timeline.context.timeCoverage).toEqual({ datedCollections: 4, undatedCollections: 1 });
  expect(bias.scatter.map((row: { id: number }) => row.id).sort()).toEqual([1, 2, 3, 4]);
  expect(studios.items[0].total).toBe(5);
  expect(directors.items[0].total).toBe(5);
  expect(habits.heatmap[0].count).toBe(4);
  // These are freshness/response timestamps, not statistical inputs or results.
  delete overview.dataVersion;
  delete timeline.context.dataVersion;
  delete timeline.context.viewReferenceAt;
  return { overview, distributions, timeline, bias, studios, directors, habits };
}

it('分析以完整业务集统计；同时存在主动隐藏时 Dashboard 的双向 NSFW 投影也不会串缓存', async () => {
  const baseline = await readAnalysis();
  expect((await get('dashboard')).overview.total).toBe(5);
  hideWork(2);
  hideWork(4);
  const version = dataVersion();
  for (const [hideNsfw, total, rated, ids] of [
    [false, 3, 2, [1, 3, 5]], [true, 2, 1, [1, 5]], [false, 3, 2, [1, 3, 5]], [true, 2, 1, [1, 5]],
  ] as const) {
    saveConfig({ hideNsfw });
    const dashboard = await get('dashboard');
    expect(dashboard.hideNsfw).toBe(hideNsfw);
    expect(dashboard.overview).toMatchObject({ total, ratedCount: rated, lastSyncAt: timestamp, dataVersion: version });
    expect(dashboard.distributions.format[0].count).toBe(total);
    expect(dashboard.timeline.context.timeCoverage).toEqual({ datedCollections: rated, undatedCollections: 1 });
    expect(dashboard.bias.scatter).toHaveLength(rated);
    expect(dashboard.recentlyAdded.map((row: { id: number }) => row.id).sort()).toEqual(ids);
    expect(await readAnalysis()).toEqual(baseline);
  }
  for (const row of hiddenWorks()) restoreWork(row.handle);
  expect(await readAnalysis()).toEqual(baseline);
  expect((await get('dashboard')).overview.total).toBe(3);
});
