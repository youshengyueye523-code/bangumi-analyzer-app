import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { paths } from '../src/config.js';
import { join } from 'node:path';
import { linkSync, writeFileSync } from 'node:fs';
import { dataVersion, one, run } from '../src/db/index.js';
import { listFranchises, listSeries } from '../src/db/query.js';
import { FakeBangumiClient, resetDatabase, testConfig, makeCollectionItem } from './helpers.js';
import { libraryCollectionItems, librarySubjects } from './fixtures.js';

let app: FastifyInstance;
let client: FakeBangumiClient;
let engine: SyncEngine;

beforeAll(async () => {
  client = new FakeBangumiClient({
    collections: libraryCollectionItems(),
    subjects: librarySubjects(),
  });
  engine = new SyncEngine({ client, getConfig: () => testConfig() });
  app = await buildApp({
    deps: { client, engine, coverCache: new CoverCache(client) },
    logger: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function syncOnce(): Promise<void> {
  engine.start({ mode: 'incremental', depth: 2 });
  await engine.whenIdle();
}

describe('本地 HTTP API', () => {
  beforeEach(() => {
    resetDatabase();
  });

  it('健康检查返回数据库与版本信息', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBeTruthy();
    expect(body.dbPath).toContain('bangumi.db');
  });

  it('未确认 UID 的旧库拒绝用户名/Token 变更，保留本地读取和非身份设置', async () => {
    await syncOnce();
    run("DELETE FROM meta WHERE key='collection_owner_uid'");
    const before = loadConfig();
    for (const payload of [{ username: '1' }, { token: 'fixture-replacement-token' }]) {
      const response = await app.inject({ method: 'PUT', url: '/api/config', payload });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('account_owner_unconfirmed');
      expect(loadConfig()).toEqual(before);
    }
    expect((await app.inject({ method: 'GET', url: '/api/subjects' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { nickname: 'fixture local profile' } })).statusCode).toBe(200);
    expect(loadConfig().username).toBe(before.username);
    expect(one("SELECT value FROM meta WHERE key='collection_owner_uid'")).toBeUndefined();
  });

  it('导入派生重建失败时原始写入与数据版本全部回滚', async () => {
    const version = dataVersion();
    run(`CREATE TRIGGER audit_import_failure BEFORE INSERT ON series_entities
         BEGIN SELECT RAISE(ABORT, 'injected import rebuild failure'); END`);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/data/import', payload: {
        format: 'bangumi-analyzer-export', version: 1,
        subjects: [{ id: 990001, name: 'atomic import fixture', eps: 12 }],
        collections: [{ subject_id: 990001, type: 2, rate: 8 }],
      } });
      expect(response.statusCode).toBe(500);
      expect(one('SELECT id FROM subjects WHERE id = 990001')).toBeUndefined();
      expect(one('SELECT subject_id FROM collections WHERE subject_id = 990001')).toBeUndefined();
      expect(dataVersion()).toBe(version);
      expect(one('SELECT key FROM series_entities')).toBeUndefined();
    } finally { run('DROP TRIGGER audit_import_failure'); }
  });

  it('来自其他网站的无 body POST 在副作用之前拒绝；正常本地调用仍可用', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sync/cancel', headers: { origin: 'https://untrusted.example' } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('cross_origin_request');
    for (const headers of [{}, { origin: 'http://localhost', host: 'localhost:80' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/sync/cancel', headers })).statusCode).toBe(200);
    }
  });

  it('不透明来源与跨站 Fetch Metadata 同样不能执行 mutation', async () => {
    for (const headers of [{ origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/data/backups', headers });
      expect(response.statusCode).toBe(403);
    }
  });

  it('不接受伪造非本机 Host 的同源读写，阻止 DNS rebinding 绕过 Origin', async () => {
    for (const [method, url] of [['GET', '/api/data/export/json'], ['POST', '/api/sync/cancel']] as const) {
      const result = await app.inject({ method, url, headers: { host: 'untrusted.example:8787', origin: 'http://untrusted.example:8787', 'sec-fetch-site': 'same-origin' } });
      expect(result.statusCode).toBe(403);
      expect(result.json().error.code).toBe('invalid_local_host');
    }
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
      expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('配置接口不会返回 Token 明文', async () => {
    saveConfig({ username: 'tester', token: 'super-secret-token-123456' });
    const response = await app.inject({ method: 'GET', url: '/api/config' });
    const body = response.json();
    expect(body.hasToken).toBe(true);
    expect(body.tokenHint).not.toContain('super-secret-token-123456');
    expect(body.tokenHint).toContain('…');
    expect(JSON.stringify(body)).not.toContain('super-secret-token-123456');
    expect(loadConfig().token).toBe('super-secret-token-123456');
    saveConfig({ token: '' });
  });

  it('非空数据库拒绝配置跨账号切换，允许同账号用户名与 UID，并原样保留拒绝前的配置', async () => {
    saveConfig({ username: 'tester' });
    await syncOnce();
    const other = { id: 999, username: 'other-account', nickname: '', sign: '', avatar: {} };
    const getUser = client.getUser.bind(client);
    client.getUser = async (name) => name === 'other-account' ? other : getUser(name);
    try {
      for (const username of ['other-account', '']) {
        const before = loadConfig();
        const result = await app.inject({ method: 'PUT', url: '/api/config', payload: { username, nickname: 'must not save' } });
        expect(result.statusCode).toBe(409);
        expect(result.json().error.code).toBe('account_switch_forbidden');
        expect(loadConfig()).toEqual(before);
      }
      expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { username: '1' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { username: 'tester' } })).statusCode).toBe(200);
      // 第四轮用户裁决：未绑定 UID 的旧库不凭当前配置推断归属，任何身份变更都先拒绝。
      run("DELETE FROM meta WHERE key = 'collection_owner_uid'");
      expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { username: 'other-account' } })).statusCode).toBe(409);
      const unconfirmed = await app.inject({ method: 'PUT', url: '/api/config', payload: { username: '1' } });
      expect(unconfirmed.statusCode).toBe(409);
      expect(unconfirmed.json().error.code).toBe('account_owner_unconfirmed');
    } finally { client.getUser = getUser; }
  });

  it('非法配置会被拒绝并给出说明', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { username: 'bad user name' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('invalid_username');
    expect(body.error.hint).toBeTruthy();
  });

  it('同步分页期间不能更换身份配置，其他本地资料仍可保存', async () => {
    saveConfig({ username: 'tester', token: 'fixture-own-token' });
    const isolatedClient = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 })] });
    const isolatedEngine = new SyncEngine({ client: isolatedClient, getConfig: () => testConfig({ token: 'fixture-own-token' }) });
    const isolatedApp = await buildApp({ deps: { client: isolatedClient, engine: isolatedEngine, coverCache: new CoverCache(isolatedClient) }, logger: false });
    const getPage = isolatedClient.getCollectionsPage.bind(isolatedClient);
    let observed = 0;
    isolatedClient.getCollectionsPage = async (...args) => {
      const result = await isolatedApp.inject({ method: 'PUT', url: '/api/config', payload: { token: 'fixture-other-token' } });
      observed = result.statusCode;
      expect(result.json().error?.code).toBe('sync_in_progress');
      expect(loadConfig().token).toBe('fixture-own-token');
      expect((await isolatedApp.inject({ method: 'PUT', url: '/api/config', payload: { nickname: 'local profile allowed' } })).statusCode).toBe(200);
      return getPage(...args);
    };
    try {
      await isolatedApp.ready();
      isolatedEngine.start({ mode: 'incremental' });
      await isolatedEngine.whenIdle();
      expect(observed).toBe(409);
      expect(isolatedEngine.getStatus().lastRun?.status).toBe('success');
      expect((await isolatedApp.inject({ method: 'PUT', url: '/api/config', payload: { token: 'fixture-other-token' } })).statusCode).toBe(200);
    } finally { await isolatedApp.close(); }
  });

  it('账号身份查询等待期间启动同步也不能绕过配置锁', async () => {
    saveConfig({ username: 'tester', token: 'fixture-own-token' });
    await syncOnce();
    let releaseLookup!: () => void;
    let lookupEntered!: () => void;
    let releasePage!: () => void;
    let pageEntered!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookupStarted = new Promise<void>((resolve) => { lookupEntered = resolve; });
    const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
    const pageStarted = new Promise<void>((resolve) => { pageEntered = resolve; });
    const isolatedClient = new FakeBangumiClient();
    const getUser = isolatedClient.getUser.bind(isolatedClient);
    isolatedClient.getUser = async (name, options) => {
      if (name === '1') { lookupEntered(); await lookupGate; }
      return getUser(name, options);
    };
    const getPage = isolatedClient.getCollectionsPage.bind(isolatedClient);
    isolatedClient.getCollectionsPage = async (...args) => { pageEntered(); await pageGate; return getPage(...args); };
    const isolatedEngine = new SyncEngine({ client: isolatedClient, getConfig: () => testConfig({ token: 'fixture-own-token' }) });
    const isolatedApp = await buildApp({ deps: { client: isolatedClient, engine: isolatedEngine, coverCache: new CoverCache(isolatedClient) }, logger: false });
    try {
      await isolatedApp.ready();
      const saving = isolatedApp.inject({ method: 'PUT', url: '/api/config', payload: { username: '1', token: 'fixture-new-token' } }).then((result) => result);
      await lookupStarted;
      isolatedEngine.start({ mode: 'incremental' });
      await pageStarted;
      releaseLookup();
      expect((await saving).statusCode).toBe(409);
      expect(loadConfig().token).toBe('fixture-own-token');
      releasePage();
      await isolatedEngine.whenIdle();
    } finally { releaseLookup(); releasePage(); await isolatedEngine.whenIdle(); await isolatedApp.close(); }
  });

  it('隐藏口径下 dashboard payload 内部一致，且不跨口径复用缓存（v1.8）', async () => {
    await syncOnce();
    const before = (await app.inject({ method: 'GET', url: '/api/stats/dashboard' })).json();
    const totalBefore = Number(before.overview.total);
    const ratedBefore = Number(before.overview.ratedCount);

    const target = one<{ subject_id: number }>(
      'SELECT subject_id FROM collections WHERE rate > 0 ORDER BY subject_id LIMIT 1',
    );
    expect(target).toBeTruthy();
    const hiddenId = Number(target!.subject_id);
    run('UPDATE subjects SET nsfw = 1 WHERE id = :id', { id: hiddenId });
    saveConfig({ hideNsfw: true });

    const dashboard = (await app.inject({ method: 'GET', url: '/api/stats/dashboard' })).json();
    expect(dashboard.overview.total).toBe(totalBefore - 1);
    expect(dashboard.overview.ratedCount).toBe(ratedBefore - 1);
    const statusSum = Object.values(
      dashboard.overview.statusCounts as Record<string, number>,
    ).reduce((sum, count) => sum + count, 0);
    expect(statusSum).toBe(dashboard.overview.total);
    expect(
      dashboard.distributions.status.reduce(
        (sum: number, item: { count: number }) => sum + item.count,
        0,
      ),
    ).toBe(dashboard.overview.total);
    expect(
      dashboard.timeline.points.reduce(
        (sum: number, point: { added: number }) => sum + point.added,
        0,
      ),
    ).toBe(dashboard.overview.total);
    expect(dashboard.bias.count).toBe(dashboard.overview.ratedCount);
    expect(dashboard.bias.meanDelta).toBeCloseTo(dashboard.overview.meanDelta ?? 0, 2);
    for (const list of [dashboard.recentlyUpdated, dashboard.recentlyAdded, dashboard.inProgress]) {
      expect(list.some((item: { id: number }) => item.id === hiddenId)).toBe(false);
    }

    saveConfig({ hideNsfw: false });
  });

  it('Series / Franchise detail 返回 analysis 块并支持整页口径参数（v1.8）', async () => {
    await syncOnce();

    const seriesKey = listSeries({ includeSingletons: true })[0]?.key;
    expect(seriesKey).toBeTruthy();
    const seriesResponse = await app.inject({
      method: 'GET',
      url: `/api/series/${encodeURIComponent(seriesKey!)}?visibility=visible`,
    });
    expect(seriesResponse.statusCode).toBe(200);
    const series = seriesResponse.json();
    expect(series.analysis.visibility).toBe('visible');
    expect(series.analysis.coverage.localCollected).toBe(series.collectedCount);
    expect(series.analysis.statusStructure.collectedCount).toBe(series.collectedCount);
    expect(series.analysis.consumption.estimatedWatchTime.isEstimate).toBe(true);

    const franchise = listFranchises()[0];
    if (franchise) {
      const franchiseResponse = await app.inject({
        method: 'GET',
        url: `/api/franchises/${encodeURIComponent(franchise.key)}?visibility=real`,
      });
      expect(franchiseResponse.statusCode).toBe(200);
      const detail = franchiseResponse.json();
      expect(detail.analysis.visibility).toBe('real');
      // analysis 与 canonical franchise 平均分同源（Real materialization）
      expect(detail.analysis.rating.average.value).toBe(detail.averageRate);
    }
  });

  it('Entity 列表支持 Ranking 排序，并返回 sample / rankable 元数据（v1.8 Phase 4）', async () => {
    await syncOnce();

    const seriesResponse = await app.inject({
      method: 'GET',
      url: '/api/series?sort=coverage&includeSingletons=1&limit=1000',
    });
    expect(seriesResponse.statusCode).toBe(200);
    const series = seriesResponse.json().series as Array<{
      ranking?: { metric: string; value: number | null; sample: number; rankable: boolean };
    }>;
    expect(series.length).toBeGreaterThan(0);
    expect(series.every((row) => row.ranking?.metric === 'coverage')).toBe(true);
    // 排名域（sample ≥ 3）必须整体排在低样本之前
    const firstNonRankable = series.findIndex((row) => row.ranking && !row.ranking.rankable);
    const lastRankable = series.map((row) => row.ranking?.rankable === true).lastIndexOf(true);
    if (firstNonRankable >= 0 && lastRankable >= 0) {
      expect(lastRankable).toBeLessThan(firstNonRankable);
    }
    const rankableValues = series
      .filter((row) => row.ranking?.rankable)
      .map((row) => row.ranking!.value ?? 0);
    expect([...rankableValues].sort((a, b) => b - a)).toEqual(rankableValues);

    // 非排名排序保持向后兼容（不注入 ranking 元数据）
    const bySize = await (
      await app.inject({
        method: 'GET',
        url: '/api/series?sort=size&includeSingletons=1&limit=20',
      })
    ).json();
    expect(bySize.series.every((row: { ranking?: unknown }) => row.ranking === undefined)).toBe(true);

    // 未知 sort 回退 size，不报错
    const bogus = await app.inject({
      method: 'GET',
      url: '/api/series?sort=bogus&includeSingletons=1&limit=5',
    });
    expect(bogus.statusCode).toBe(200);

    // Franchise：rate 排序新增且必须携带 ratedCount
    const franchiseResponse = await app.inject({
      method: 'GET',
      url: '/api/franchises?sort=rate&limit=500',
    });
    expect(franchiseResponse.statusCode).toBe(200);
    const franchises = franchiseResponse.json().franchises as Array<{
      ranking?: { metric: string; sample: number; rankable: boolean };
    }>;
    expect(franchises.every((row) => row.ranking?.metric === 'rate')).toBe(true);
    expect(
      franchises.every((row) => (row.ranking?.sample ?? 0) >= 0 && typeof row.ranking?.rankable === 'boolean'),
    ).toBe(true);

    const coverageFranchises = await (
      await app.inject({ method: 'GET', url: '/api/franchises?sort=completion&limit=500' })
    ).json();
    expect(
      coverageFranchises.franchises.every(
        (row: { ranking?: { metric: string } }) => row.ranking?.metric === 'completion',
      ),
    ).toBe(true);
  });

  it('同步接口返回状态、进度与历史记录', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/sync', payload: { mode: 'incremental' } });
    expect([202, 409]).toContain(start.statusCode);
    await engine.whenIdle();

    const status = await app.inject({ method: 'GET', url: '/api/sync/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json().lastRun.status).toBe('success');

    const history = await app.inject({ method: 'GET', url: '/api/sync/history?limit=5' });
    expect(history.json().runs.length).toBeGreaterThan(0);
  });

  it('收藏库接口支持筛选、排序与分页', async () => {
    await syncOnce();
    const response = await app.inject({
      method: 'GET',
      url: '/api/subjects?status=2&format=TV&sort=rate&order=desc&pageSize=2&page=1',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // 看过 + TV：冰菓 / 吹响 / 虫师
    expect(body.total).toBe(3);
    expect(body.pageSize).toBe(2);
    expect(body.items[0].id).toBe(2);
  });

  it('非法查询参数返回 400 而不是 500', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/subjects?pageSize=-5&sort=unknown',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_request');
  });

  it('条目详情包含人员、关系与原始数据', async () => {
    await syncOnce();
    const response = await app.inject({ method: 'GET', url: '/api/subjects/2' });
    expect(response.statusCode).toBe(200);
    const detail = response.json();
    expect(detail.nameCn).toBe('冰菓');
    expect(detail.staff.some((item: { name: string }) => item.name === '武本康弘')).toBe(true);
    expect(detail.ratingDistribution['10']).toBeGreaterThan(0);
    expect(detail.infobox.length).toBeGreaterThan(0);
    expect(detail.rawSubject).toBeTruthy();
  });

  it('不存在的条目返回带建议的 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/subjects/999999' });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe('subject_not_found');
    expect(body.error.hint).toBeTruthy();
  });

  it('聚合面板接口一次返回 Dashboard 所需全部数据', async () => {
    await syncOnce();
    const response = await app.inject({ method: 'GET', url: '/api/stats/dashboard' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.overview.total).toBe(10);
    expect(body.distributions.status.length).toBeGreaterThan(0);
    expect(body.timeline.points.length).toBeGreaterThan(0);
    expect(body.recentlyUpdated.length).toBeGreaterThan(0);
  });

  it('画像接口返回结构化数据集与 AI 状态', async () => {
    await syncOnce();
    const response = await app.inject({ method: 'GET', url: '/api/profile/dataset' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sample.total).toBe(10);
    expect(Array.isArray(body.claims)).toBe(true);
    expect(body.claims.some((claim: { kind: string }) => claim.kind === 'data')).toBe(true);

    const ai = await app.inject({ method: 'GET', url: '/api/profile/ai' });
    expect(ai.statusCode).toBe(200);
    expect(ai.json().configured).toBe(false);
  });

  it('旧库异常 JSON 不令画像和统计 HTTP 读取崩溃，也不改写源数据', async () => {
    await syncOnce();
    run(`UPDATE subjects SET studios='not-json', directors='[123,null,"有效夹具导演"]',
         originals='{"broken":1}', tag_names='not-json', meta_tags='[null,42]' WHERE id=1`);
    const before = one('SELECT * FROM subjects WHERE id=1');
    const version = dataVersion();
    for (const url of ['/api/profile/dataset', '/api/stats/dashboard', '/api/stats/studios',
      '/api/stats/directors', '/api/stats/distributions', '/api/stats/habits']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }
    const directors = (await app.inject({ method: 'GET', url: '/api/stats/directors' })).json();
    expect(directors.items.some((item: { name: string }) => item.name === '有效夹具导演')).toBe(true);
    expect(one('SELECT * FROM subjects WHERE id=1')).toEqual(before);
    expect(dataVersion()).toBe(version);
  });

  it('旧库异常 infobox 的详情 HTTP 返回合法条目，保留原始证据', async () => {
    await syncOnce();
    const infobox = '[null,{"key":"导演","value":"夹具导演"}]';
    run('UPDATE subjects SET infobox=:infobox WHERE id=1', { infobox });
    const version = dataVersion();
    const response = await app.inject({ method: 'GET', url: '/api/subjects/1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().infobox).toEqual([{ key: '导演', values: [{ key: null, value: '夹具导演' }] }]);
    expect(one('SELECT infobox FROM subjects WHERE id=1')).toEqual({ infobox });
    expect(dataVersion()).toBe(version);
  });

  it('导出格式异常收藏在预检和执行接口均跳过，不覆盖既有收藏', async () => {
    await syncOnce();
    const before = one('SELECT * FROM collections WHERE subject_id=1');
    const payload = { format: 'bangumi-analyzer-export', version: 1, subjects: [],
      collections: [{ subject_id: 1, type: 0, rate: 11, private: 'false' }] };
    for (const url of ['/api/data/import?dryRun=true', '/api/data/import']) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ updatedCollections: 0, skipped: 1 });
      expect(one('SELECT * FROM collections WHERE subject_id=1')).toEqual(before);
    }
  });

  it('系列分组接口可用', async () => {
    await syncOnce();
    const list = await app.inject({ method: 'GET', url: '/api/series' });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().series)).toBe(true);
  });

  it('导出接口返回可下载的 JSON 与 CSV', async () => {
    await syncOnce();
    const json = await app.inject({ method: 'GET', url: '/api/data/export/json' });
    expect(json.headers['content-disposition']).toContain('attachment');
    expect(json.json().format).toBe('bangumi-analyzer-export');

    const csv = await app.inject({ method: 'GET', url: '/api/data/export/csv' });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('冰菓');
  });

  it('导入接口支持预检与应用', async () => {
    const payload = { collections: libraryCollectionItems(), subjects: librarySubjects() };
    void payload;
    const raw = await import('./fixtures.js');
    const dryRun = await app.inject({
      method: 'POST',
      url: '/api/data/import?dryRun=true',
      payload: raw.libraryCollectionItems(),
    });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json().applicable ?? true).toBeTruthy();
    expect(dryRun.json().newCollections).toBe(10);

    const applied = await app.inject({
      method: 'POST',
      url: '/api/data/import',
      payload: raw.libraryCollectionItems(),
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().applied).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/subjects' });
    expect(list.json().total).toBe(10);
    // 导出文件不携带可靠账号证据；导入非空库不能因此自动认领当前配置账号。
    const before = (await app.inject({ method: 'GET', url: '/api/data/export/json' })).json();
    const version = dataVersion();
    client.calls.length = 0;
    expect((await app.inject({ method: 'POST', url: '/api/sync', payload: { mode: 'incremental' } })).statusCode).toBe(202);
    await engine.whenIdle();
    expect(engine.getStatus().lastRun).toMatchObject({ status: 'error' });
    expect(engine.getStatus().lastRun?.error).toContain('归属');
    expect(client.calls).toEqual([]);
    expect(one("SELECT value FROM meta WHERE key='collection_owner_uid'")).toBeUndefined();
    expect(dataVersion()).toBe(version);
    expect((await app.inject({ method: 'GET', url: '/api/data/export/json' })).json()).toMatchObject({ collections: before.collections, subjects: before.subjects });
    for (const url of ['/api/profile/dataset', '/api/stats/dashboard', '/api/series']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }
  });

  it('未缓存的封面会跳转到 Bangumi 图床', async () => {
    await syncOnce();
    const response = await app.inject({ method: 'GET', url: '/api/covers/2' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('lain.bgm.tv');
  });

  it('损坏的封面路径和链接不能把缓存读取导向目录外的文件', async () => {
    await syncOnce();
    const outside = join(paths.dataDir, 'outside-cover-fixture.txt');
    writeFileSync(outside, 'private fixture outside cover directory');
    linkSync(outside, join(paths.coverDir, 'linked-fixture.jpg'));
    for (const path of ['../outside-cover-fixture.txt', 'linked-fixture.jpg']) {
      run('UPDATE subjects SET cover_path=:path, cover_cached_at=:ts WHERE id=2', { path, ts: '2026-01-01' });
      const result = await app.inject({ method: 'GET', url: '/api/covers/2' });
      expect(result.statusCode).toBe(302);
      expect(result.body).not.toContain('private fixture outside cover directory');
    }
  });

  it('未知接口返回结构化 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/not-exists' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });

  it('网页端主题配置可经由服务端持久化并通过 /api/theme.js 首屏下发', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/config' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().theme).toBe('system');

    const initialScript = await app.inject({ method: 'GET', url: '/api/theme.js' });
    expect(initialScript.statusCode).toBe(200);
    expect(initialScript.headers['content-type']).toContain('application/javascript');
    expect(initialScript.headers['cache-control']).toBe('no-store');
    expect(initialScript.body).toBe('window.__BANGUMI_INITIAL_THEME__="system";');

    for (const nextTheme of ['dark', 'light', 'system'] as const) {
      const updated = await app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { theme: nextTheme },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().theme).toBe(nextTheme);

      const loaded = await app.inject({ method: 'GET', url: '/api/config' });
      expect(loaded.statusCode).toBe(200);
      expect(loaded.json().theme).toBe(nextTheme);

      const themeScript = await app.inject({ method: 'GET', url: '/api/theme.js' });
      expect(themeScript.statusCode).toBe(200);
      expect(themeScript.body).toBe(`window.__BANGUMI_INITIAL_THEME__=${JSON.stringify(nextTheme)};`);
    }

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { theme: 'sepia' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
