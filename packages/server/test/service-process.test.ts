import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { paths } from '../src/config.js';
import { assertIsolatedTestDatabase, makeCollectionItem } from './helpers.js';

const require = createRequire(import.meta.url);
const source = (name: string) => JSON.stringify(new URL(`../src/${name}`, import.meta.url).href);

it('独立服务：任务进行中重复退出，忽略 abort 的晚响应不落库，全部 drain 后才关闭 DB', async () => {
  assertIsolatedTestDatabase();
  const dataDir = join(paths.dataDir, 'signal-child'); mkdirSync(dataDir);
  const script = join(dataDir, 'process.mjs');
  writeFileSync(script, `
    import { buildApp } from ${source('app.ts')};
    import { SyncEngine } from ${source('sync/engine.ts')};
    import { CoverCache } from ${source('images/coverCache.ts')};
    import { createServiceShutdown, stopAppResources } from ${source('lifecycle.ts')};
    import { getDatabase, closeDatabase, dataVersion } from ${source('db/index.ts')};
    import { loadConfig } from ${source('config.ts')};
    import { bindCollectionOwner } from ${source('db/account.ts')};
    const send = (event, extra = {}) => process.send({ event, ...extra });
    const db = getDatabase();
    bindCollectionOwner({ id: 1 });
    db.exec("INSERT INTO subjects(id,name,cover_url,created_at,updated_at) VALUES(777,'unchanged','https://lain.bgm.tv/pic/cover/l/777.jpg','2026-01-01','2026-01-01'); INSERT INTO collections(subject_id,type,rate,first_seen_at,synced_at) VALUES(777,2,8,'2026-01-01','2026-01-01')");
    let releasePage, releaseCover, releaseWorker;
    const client = {
      stats: { requests: 0, retries: 0, throttled: 0, lastRequestMs: 0 }, updateOptions() {},
      async getUser() { return { id: 1, username: 'audit-child', nickname: '', sign: '', avatar: {} }; },
      getCollectionsPage() { send('page-wait'); return new Promise(resolve => { releasePage = () => resolve({ total: 1, limit: 50, offset: 0, data: [${JSON.stringify(makeCollectionItem({ subject_id: 999 }))}] }); }); },
      fetchImage() { send('cover-wait'); return new Promise(resolve => { releaseCover = () => resolve({ data: new Uint8Array([1,2,3]), contentType: 'image/jpeg' }); }); }
    };
    const engine = new SyncEngine({ client, getConfig: () => ({ ...loadConfig(), username: 'audit-child', subjectTypes: [2], cacheCovers: false, requestIntervalMs: 0 }) });
    const coverCache = new CoverCache(client);
    const translationWorker = { stop() { send('worker-stop'); return new Promise(resolve => { releaseWorker = resolve; }); } };
    const deps = { client, engine, coverCache, translationWorker };
    const app = await buildApp({ deps, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const shutdown = createServiceShutdown({ closeServer: () => app.close(), stopResources: () => stopAppResources(deps),
      closeDatabase() { closeDatabase(); send('db-closed'); }, onStart() { send('closing'); },
      onError(error) { send('failure', { message: String(error) }); }, exit(code) { process.exit(code); }, timeoutMs: 10000 });
    process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
    process.on('message', message => {
      if (message === 'signal') { process.emit('SIGINT'); process.emit('SIGTERM'); }
      if (message === 'release-page') releasePage();
      if (message === 'release-cover') releaseCover();
      if (message === 'release-worker') releaseWorker();
      if (message === 'inspect') send('inspection', { version: dataVersion(), count: db.prepare('SELECT COUNT(*) AS n FROM collections').get().n, late: db.prepare('SELECT COUNT(*) AS n FROM subjects WHERE id=999').get().n, cover: db.prepare('SELECT cover_path FROM subjects WHERE id=777').get().cover_path, status: engine.getStatus().progress.phase });
    });
    send('ready', { version: dataVersion() });
    engine.start({ mode: 'incremental', depth: 1 }); void coverCache.start({ limit: 1 });
  `);
  const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, script], {
    env: { ...process.env, BANGUMI_DATA_DIR: dataDir, BANGUMI_USERNAME: '', BANGUMI_ACCESS_TOKEN: '', AI_API_KEY: '', AI_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: Array<Record<string, unknown>> = []; let stderr = '';
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  child.on('message', (message) => messages.push(message as Record<string, unknown>));
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  async function waitFor(event: string) {
    const deadline = Date.now() + 15000;
    while (!messages.some((message) => message.event === event)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`${event} not received: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return messages.find((message) => message.event === event)!;
  }
  try {
    const ready = await waitFor('ready'); await waitFor('page-wait'); await waitFor('cover-wait');
    // Windows child.kill('SIGTERM') 是强制结束，不能冒充优雅退出；通过 IPC 触发子进程实际信号 handlers。
    child.send('signal'); await waitFor('worker-stop');
    expect(messages.some((message) => message.event === 'db-closed')).toBe(false);
    child.send('release-page'); child.send('release-cover');
    await new Promise((resolve) => setTimeout(resolve, 100)); child.send('inspect');
    const state = await waitFor('inspection');
    expect(state).toMatchObject({ version: ready.version, count: 1, late: 0, cover: null, status: 'cancelled' });
    expect(messages.some((message) => message.event === 'db-closed')).toBe(false);
    child.send('release-worker'); await waitFor('db-closed'); expect(await exited, stderr).toBe(0);
    expect(messages.filter((message) => message.event === 'closing')).toHaveLength(1);
    expect(messages.some((message) => message.event === 'failure')).toBe(false);
    const db = new DatabaseSync(join(dataDir, 'bangumi.db'), { readOnly: true });
    try {
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare('SELECT type,rate FROM collections WHERE subject_id=777').get()).toEqual({ type: 2, rate: 8 });
      expect(db.prepare('SELECT status FROM sync_runs ORDER BY rowid DESC LIMIT 1').get()).toEqual({ status: 'cancelled' });
    } finally { db.close(); }
    expect(readdirSync(join(dataDir, 'covers'))).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}, 25000);

it.runIf(process.platform === 'win32')('Windows 独立进程强制终止：未提交来源和版本回滚，不能冒充优雅退出', async () => {
  assertIsolatedTestDatabase();
  const dataDir = join(paths.dataDir, 'forced-child'); mkdirSync(dataDir);
  const script = join(dataDir, 'process.mjs');
  writeFileSync(script, `
    import { getDatabase } from ${source('db/index.ts')};
    const db = getDatabase();
    db.exec("INSERT INTO subjects(id,name,created_at,updated_at) VALUES(777,'preserved','2026-01-01','2026-01-01'); INSERT INTO collections(subject_id,type,rate,first_seen_at,synced_at) VALUES(777,2,8,'2026-01-01','2026-01-01'); INSERT INTO meta(key,value) VALUES('data_version','4') ON CONFLICT(key) DO UPDATE SET value='4'");
    db.exec("BEGIN IMMEDIATE; DELETE FROM collections; UPDATE meta SET value='5' WHERE key='data_version'; UPDATE subjects SET name='uncommitted' WHERE id=777");
    process.send('transaction-open'); setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, script], {
    env: { ...process.env, BANGUMI_DATA_DIR: dataDir, BANGUMI_ACCESS_TOKEN: '', AI_API_KEY: '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  let timer: ReturnType<typeof setTimeout>;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`child not ready: ${stderr}`)), 15000);
      child.once('message', () => resolve());
    });
    // 仅终止本测试自己创建的子进程，绝不查找或向 Local PID 发送信号。
    expect(child.kill('SIGTERM')).toBe(true); await exited;
    const db = new DatabaseSync(join(dataDir, 'bangumi.db'), { readOnly: true });
    try {
      expect(db.prepare('SELECT name FROM subjects WHERE id=777').get()).toEqual({ name: 'preserved' });
      expect(db.prepare('SELECT rate FROM collections WHERE subject_id=777').get()).toEqual({ rate: 8 });
      expect(db.prepare("SELECT value FROM meta WHERE key='data_version'").get()).toEqual({ value: '4' });
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { db.close(); }
  } finally {
    clearTimeout(timer!);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}, 20000);
