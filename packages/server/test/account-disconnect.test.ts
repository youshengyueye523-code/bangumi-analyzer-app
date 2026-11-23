import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { loadConfig, paths, saveConfig } from '../src/config.js';
import { all } from '../src/db/index.js';
import { collectionOwnerUid } from '../src/db/account.js';
import { getDatabase, run } from '../src/db/index.js';
import { createBackup } from '../src/data/backup.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase } from './helpers.js';
import { join } from 'node:path';

let app: FastifyInstance, client: FakeBangumiClient, engine: SyncEngine;
const user = { id: 1, username: 'tester', nickname: 'fixture', sign: '', avatar: {} };
function domainSnapshot() {
  return Object.fromEntries(all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").map(({ name }) => [name, all(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)]));
}
async function createApp() {
  client = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 })], subjects: { 1: makeSubject(1) }, me: user, users: { tester: user, '1': user, other: { ...user, id: 2, username: 'other' } } });
  engine = new SyncEngine({ client, getConfig: loadConfig });
  app = await buildApp({ deps: { client, engine, coverCache: new CoverCache(client) }, logger: false });
  await app.ready();
}
async function sync() { engine.start({ mode: 'full', depth: 1 }); await engine.whenIdle(); expect(engine.getStatus().lastRun?.status).toBe('success'); }
const disconnect = () => app.inject({ method: 'POST', url: '/api/config/disconnect', payload: {} });
const bind = (username: string) => app.inject({ method: 'PUT', url: '/api/config', payload: { username, token: 'fixture-account-token' } });

beforeEach(async () => {
  vi.stubEnv('BANGUMI_DISTRIBUTION', '1');
  vi.stubEnv('BANGUMI_USERNAME', ''); vi.stubEnv('BANGUMI_ACCESS_TOKEN', '');
  resetDatabase();
  saveConfig({ username: 'tester', token: 'fixture-account-token', nickname: 'local profile', avatar: '', cacheCovers: false, summaryAutoTranslate: false,
    ai: { enabled: false, apiKey: 'fixture-independent-ai-key', model: 'fixture-model' } });
  await createApp();
});
afterEach(async () => { await app.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('portable-only Bangumi disconnect', () => {
  it('ordinary Local exposes no capability or disconnect endpoint', async () => {
    await app.close(); vi.stubEnv('BANGUMI_DISTRIBUTION', ''); await createApp();
    expect((await app.inject('/api/config')).json()).not.toHaveProperty('canDisconnectBangumi');
    expect((await disconnect()).statusCode).toBe(404);
    expect(loadConfig().username).toBe('tester');
  });
  it('clears only account credentials; keeps every DB table, owner, backup, local profile and AI config', async () => {
    await sync();
    const backup = createBackup();
    const bytes = readFileSync(join(paths.backupDir, backup.fileName));
    const before = domainSnapshot(), previous = loadConfig();
    const update = vi.spyOn(client, 'updateOptions');
    const response = await disconnect();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ canDisconnectBangumi: true, username: '', hasToken: false, tokenHint: null });
    expect(loadConfig()).toEqual({ ...previous, username: '', token: '' });
    expect(JSON.parse(readFileSync(paths.configFile, 'utf8'))).toEqual(loadConfig());
    expect(update).toHaveBeenLastCalledWith({ token: '' });
    expect(domainSnapshot()).toEqual(before);
    expect(readFileSync(join(paths.backupDir, backup.fileName))).toEqual(bytes);
    expect((await app.inject('/api/profile/local')).json().profile).toMatchObject({ username: '', hasToken: false, nickname: 'local profile' });
    expect((await app.inject({ method: 'POST', url: '/api/sync', payload: { mode: 'full' } })).json().error.code).toBe('missing_username');
    expect((await disconnect()).statusCode).toBe(200);
  });
  it('rebinds original account by username or UID and resumes sync', async () => {
    await sync(); await disconnect();
    expect((await bind('1')).statusCode).toBe(200); await sync();
    await disconnect(); expect((await bind('tester')).statusCode).toBe(200); await sync();
    expect(collectionOwnerUid()).toBe(1);
  });
  it('rejects a different UID at both configuration and sync boundaries without mixing data', async () => {
    await sync(); await disconnect();
    const before = domainSnapshot(), config = loadConfig();
    const response = await bind('other');
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('account_switch_forbidden');
    expect(loadConfig()).toEqual(config); expect(domainSnapshot()).toEqual(before);
    // Even a direct file configuration bypass cannot bypass the engine's UID check.
    saveConfig({ username: 'other' }); engine.start({ mode: 'full' }); await engine.whenIdle();
    expect(engine.getStatus().lastRun?.status).toBe('error'); expect(collectionOwnerUid()).toBe(1);
    expect(all('SELECT * FROM collections')).toEqual(before.collections);
  });
  it('retains UID protection even if current collections become empty', async () => {
    await sync(); run('DELETE FROM collections'); await disconnect();
    expect(collectionOwnerUid()).toBe(1);
    expect((await bind('other')).statusCode).toBe(409);
    saveConfig({ username: 'other' }); engine.start({ mode: 'full' }); await engine.whenIdle();
    expect(engine.getStatus().lastRun?.status).toBe('error'); expect(collectionOwnerUid()).toBe(1);
    expect((await bind('tester')).statusCode).toBe(200);
  });
  it('unknown-owner legacy data can disconnect but cannot claim an arbitrary new owner', async () => {
    await sync(); run("DELETE FROM meta WHERE key='collection_owner_uid'");
    expect((await disconnect()).statusCode).toBe(200);
    expect((await app.inject('/api/subjects')).statusCode).toBe(200);
    expect((await bind('tester')).json().error.code).toBe('account_owner_unconfirmed');
    expect(collectionOwnerUid()).toBeNull();
  });
  it('cancels and drains a late sync, blocks concurrent starts/config/verify, and ignores late data', async () => {
    await sync(); const before = all('SELECT * FROM collections');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    client.getCollectionsPage = async () => { entered(); await gate; return { total: 1, limit: 50, offset: 0, data: [makeCollectionItem({ subject_id: 1, rate: 1 })] }; };
    engine.start({ mode: 'full' }); await started;
    const pending = disconnect().then(r => r);
    while (!engine.accountChangeInProgress) await new Promise(r => setTimeout(r, 0));
    try {
      expect(engine.running).toBe(true);
      expect(() => engine.start({ mode: 'full' })).toThrow('正在断开');
      for (const request of [app.inject({ method: 'POST', url: '/api/sync', payload: { mode: 'full' } }), bind('tester'), app.inject({ method: 'POST', url: '/api/config/verify' }), disconnect()]) expect((await request).statusCode).toBe(409);
    } finally { release(); }
    expect((await pending).statusCode).toBe(200); expect(engine.running).toBe(false);
    expect(engine.getStatus().lastRun?.status).toBe('cancelled');
    expect(all('SELECT * FROM collections')).toEqual(before); expect(loadConfig().token).toBe('');
  });
  it('late identity save and token verification cannot resurrect credentials or report a stale identity', async () => {
    await sync();
    let release!: () => void, entered = 0;
    const gate = new Promise<void>(r => { release = r; });
    client.getUser = async () => { entered++; await gate; return user; };
    client.getMe = async () => { entered++; await gate; return user; };
    const saving = bind('1').then(r => r);
    const verifying = app.inject({ method: 'POST', url: '/api/config/verify' }).then(r => r);
    while (entered < 2) await new Promise(r => setTimeout(r, 0));
    try { expect((await disconnect()).statusCode).toBe(200); } finally { release(); }
    expect((await saving).statusCode).toBe(409); expect((await verifying).statusCode).toBe(409);
    expect(loadConfig().username).toBe(''); expect(loadConfig().token).toBe('');
  });
  it('does not pretend to clear environment-owned credentials', async () => {
    vi.stubEnv('BANGUMI_ACCESS_TOKEN', 'fixture-env-override');
    const response = await disconnect(); expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('account_credentials_from_environment');
    expect(loadConfig().username).toBe('tester');
  });
});
