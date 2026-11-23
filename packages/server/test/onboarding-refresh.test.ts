import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { saveConfig, loadConfig } from '../src/config.js';
import { all, dataVersion, run } from '../src/db/index.js';
import { createSyncRun, updateSyncRun } from '../src/db/syncRuns.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase } from './helpers.js';

let app: FastifyInstance;
let engine: SyncEngine;
let client: FakeBangumiClient;
beforeAll(async () => {
  client = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 })], subjects: { 1: makeSubject(1) } });
  engine = new SyncEngine({ client, getConfig: loadConfig });
  app = await buildApp({ deps: { client, engine, coverCache: new CoverCache(client) }, logger: false });
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(() => {
  resetDatabase();
  saveConfig({ nickname: '隔离资料', avatar: '', username: 'tester', token: '', onboardingSeen: false, cacheCovers: false, summaryAutoTranslate: false });
});
const profile = async () => (await app.inject({ method: 'GET', url: '/api/profile/local' })).json();
const step = (body: Awaited<ReturnType<typeof profile>>, id: string) => body.steps.find((s: { id: string }) => s.id === id).done;
function syntheticCollection() {
  run("INSERT INTO subjects(id,type,name,name_cn,created_at,updated_at) VALUES(1,2,'fixture','fixture','2026-11-04','2026-11-04')");
  run("INSERT INTO collections(subject_id,subject_type,type,rate,ep_status,updated_at,first_seen_at,synced_at) VALUES(1,2,2,8,12,'2026-11-04','2026-11-04','2026-11-04')");
}
async function fakeSync() {
  engine.start({ mode: 'incremental', depth: 1 }); await engine.whenIdle();
  expect(engine.getStatus().lastRun?.status).toBe('success');
}

describe('迁移前本地引导与详情读取', () => {
  it('空库不能凭配置通过首次同步；公开用户名不要求可选Token', async () => {
    const body = await profile();
    expect(step(body, 'profile')).toBe(true);
    expect(step(body, 'bangumi')).toBe(true);
    expect(step(body, 'sync')).toBe(false);
    expect(body.completed).toBe(false);
  });
  it('合成/导入收藏和synced_at均不能伪装为成功同步', async () => {
    syntheticCollection();
    expect(step(await profile(), 'sync')).toBe(false);
    expect(all('SELECT * FROM sync_runs')).toEqual([]);
  });
  it.each(['running', 'failed', 'cancelled', 'interrupted'] as const)('%s同步记录不是完成证据', async status => {
    syntheticCollection();
    const id = createSyncRun('incremental', 1);
    updateSyncRun(id, { status, finishedAt: status === 'running' ? null : '2026-11-04T00:00:00Z' });
    expect(step(await profile(), 'sync')).toBe(false);
  });
  it('enrich成功只代表补全详情，不代表完成收藏同步', async () => {
    syntheticCollection();
    const id = createSyncRun('enrich', 1);
    updateSyncRun(id, { status: 'success', finishedAt: '2026-11-04T00:00:00Z' });
    expect(step(await profile(), 'sync')).toBe(false);
  });
  it('没有结束时间的success字段不作为完整成功证据', async () => {
    const id = createSyncRun('full', 1);
    updateSyncRun(id, { status: 'success' });
    expect(step(await profile(), 'sync')).toBe(false);
  });
  it('由实际引擎和Fake数据源执行成功后才通过；读取状态不会调用远端', async () => {
    await fakeSync();
    const calls = client.calls.length;
    const body = await profile();
    expect(step(body, 'sync')).toBe(true);
    expect(body.completed).toBe(true);
    expect(body.seen).toBe(false);
    expect(client.calls).toHaveLength(calls);
  });
  it('成功的空收藏同步也可以完成初始化，不要求收藏数量', async () => {
    const empty = new SyncEngine({ client: new FakeBangumiClient({ collections: [] }), getConfig: loadConfig });
    empty.start({ mode: 'incremental', depth: 1 }); await empty.whenIdle();
    expect(empty.getStatus().lastRun?.status).toBe('success');
    const body = await profile();
    expect(body.collections).toBe(0);
    expect(step(body, 'sync')).toBe(true);
    expect(body.completed).toBe(true);
  });
  it('昵称或头像满足本地资料；空用户名即使有Token也未完成账号步骤', async () => {
    saveConfig({ nickname: '  ', avatar: '', username: '', token: 'fixture-only' });
    let body = await profile();
    expect(step(body, 'profile')).toBe(false); expect(step(body, 'bangumi')).toBe(false);
    saveConfig({ avatar: 'fixture-avatar' });
    body = await profile(); expect(step(body, 'profile')).toBe(true);
  });
  it('跳过只改变展示状态，保留未完成步骤及离线访问且不启动同步', async () => {
    syntheticCollection();
    const calls = client.calls.length;
    const before = all('SELECT * FROM collections');
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { onboardingSeen: true } })).statusCode).toBe(200);
    const body = await profile();
    expect(body.completed).toBe(true); expect(body.seen).toBe(true); expect(step(body, 'sync')).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/subjects/1' })).statusCode).toBe(200);
    expect(all('SELECT * FROM collections')).toEqual(before); expect(all('SELECT * FROM sync_runs')).toEqual([]);
    expect(client.calls).toHaveLength(calls);
  });
  it('重复读取条目只读本地，反映本地变更；不改收藏/同步/翻译队列及dataVersion', async () => {
    await fakeSync();
    const tables = ['subjects', 'collections', 'sync_runs', 'translation_jobs', 'meta'];
    const snapshot = () => tables.map(t => all(`SELECT * FROM ${t}`));
    const before = snapshot(), version = dataVersion(), calls = client.calls.length;
    const start = vi.spyOn(engine, 'start');
    const a = await app.inject({ method: 'GET', url: '/api/subjects/1' });
    const b = await app.inject({ method: 'GET', url: '/api/subjects/1' });
    expect(a.statusCode).toBe(200); expect(b.json()).toEqual(a.json());
    expect(snapshot()).toEqual(before); expect(dataVersion()).toBe(version);
    run("UPDATE subjects SET name_cn='本地更新' WHERE id=1");
    expect((await app.inject({ method: 'GET', url: '/api/subjects/1' })).json().nameCn).toBe('本地更新');
    expect(client.calls).toHaveLength(calls); expect(start).not.toHaveBeenCalled(); start.mockRestore();
    expect((await app.inject({ method: 'GET', url: '/api/subjects/99999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/subjects/1.5' })).statusCode).toBe(400);
  });
});
