import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildApp } from '../src/app.js';
import { SyncEngine } from '../src/sync/engine.js';
import { CoverCache } from '../src/images/coverCache.js';
import { TranslationWorker } from '../src/translate/worker.js';
import { FakeBangumiClient, testConfig } from './helpers.js';
import { createServiceShutdown, stopAppResources } from '../src/lifecycle.js';

function dependencies() {
  const client = new FakeBangumiClient();
  return { client, engine: new SyncEngine({ client, getConfig: () => testConfig() }),
    coverCache: new CoverCache(client), translationWorker: new TranslationWorker({ getConfig: () => testConfig().ai }) };
}

it('同步 drain 抛错时仍尝试停止封面和翻译，不允许只停止部分资源', async () => {
  const deps = dependencies();
  vi.spyOn(deps.engine, 'whenIdle').mockRejectedValue(new Error('injected drain failure'));
  const cover = vi.spyOn(deps.coverCache, 'cancel'); const worker = vi.spyOn(deps.translationWorker, 'stop');
  const app = await buildApp({ deps, logger: false }); await app.ready();
  await expect(app.close()).rejects.toThrow();
  expect(cover).toHaveBeenCalled(); expect(worker).toHaveBeenCalled();
});

it('同步未完成时退出立即取消其他资源，数据库屏障仍等待全部任务', async () => {
  const deps = dependencies(); let release!: () => void;
  vi.spyOn(deps.engine, 'whenIdle').mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const cover = vi.spyOn(deps.coverCache, 'cancel'); const worker = vi.spyOn(deps.translationWorker, 'stop');
  const app = await buildApp({ deps, logger: false }); await app.ready();
  let done = false; const closing = app.close().then(() => { done = true; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false); expect(cover).toHaveBeenCalled(); expect(worker).toHaveBeenCalled();
  } finally { release(); await closing; }
});

it('实际信号入口关闭失败不关闭数据库，也不返回成功退出', async () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const handlers = new Map<string, () => void>(); const exit = vi.fn(); const closeDatabase = vi.fn();
  const block = source.slice(source.indexOf('  const shutdown ='), source.indexOf('  try { await app.listen'));
  // 仅执行实际信号绑定片段，绝不导入主入口或监听真实服务。
  vm.runInNewContext(block.replace(': string', ''), {
    app: { log: { info() {}, error() {} }, close: async () => { throw new Error('injected close failure'); } },
    createServiceShutdown, stopAppResources: async () => {}, deps: {}, shuttingDown: false,
    closeDatabase, process: { on: (event: string, handler: () => void) => handlers.set(event, handler), exit },
  });
  handlers.get('SIGTERM')!(); await new Promise((resolve) => setImmediate(resolve));
  expect(closeDatabase).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalledWith(0);
});

it('实际 listen 失败入口同样等待资源屏障，不直接经 fatal 提前关闭 DB', async () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const shutdown ='); const end = source.indexOf('  console.log(', start);
  let release!: () => void;
  const resource = new Promise<void>((resolve) => { release = resolve; });
  const closeDatabase = vi.fn(); const exit = vi.fn();
  const job = vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    app: { log: { info() {}, error() {} }, listen: async () => { throw new Error('EADDRINUSE'); }, close: async () => {} },
    PORT: 0, HOST: '127.0.0.1', deps: {}, shuttingDown: false, createServiceShutdown,
    stopAppResources: () => resource, closeDatabase, process: { on() {}, exit },
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(closeDatabase).not.toHaveBeenCalled(); release(); await job;
  expect(closeDatabase).toHaveBeenCalledOnce(); expect(exit).toHaveBeenCalledWith(1);
});

function shutdownFixture() {
  const deps = { closeServer: vi.fn(async () => {}), stopResources: vi.fn(async () => {}),
    closeDatabase: vi.fn(), onStart: vi.fn(), onError: vi.fn(), exit: vi.fn(), timeoutMs: 10 };
  return { deps, shutdown: createServiceShutdown(deps) };
}

it('重复信号共用屏障，先完成所有任务，再关闭DB和退出；成功后不重复关闭', async () => {
  const { deps, shutdown } = shutdownFixture(); let release!: () => void;
  deps.stopResources.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const first = shutdown(); const second = shutdown(); expect(second).toBe(first);
  await new Promise((resolve) => setImmediate(resolve));
  expect(deps.closeDatabase).not.toHaveBeenCalled(); expect(deps.exit).not.toHaveBeenCalled();
  release(); expect(await first).toBe(true); expect(await shutdown()).toBe(true);
  expect(deps.closeServer).toHaveBeenCalledTimes(1); expect(deps.closeDatabase).toHaveBeenCalledTimes(1);
  expect(deps.closeDatabase.mock.invocationCallOrder[0]).toBeLessThan(deps.exit.mock.invocationCallOrder[0]!);
});

it.each(['closeServer', 'stopResources'] as const)('%s 失败不关闭DB；故障解除可完整重试', async (field) => {
  const { deps, shutdown } = shutdownFixture(); deps[field].mockRejectedValueOnce(new Error('injected failure'));
  expect(await shutdown()).toBe(false); expect(deps.closeDatabase).not.toHaveBeenCalled();
  expect(deps.exit).not.toHaveBeenCalled(); expect(deps.onError).toHaveBeenCalledOnce();
  expect(await shutdown(1)).toBe(true); expect(deps.exit).toHaveBeenCalledWith(1);
  expect(deps.closeServer).toHaveBeenCalledTimes(2); expect(deps.stopResources).toHaveBeenCalledTimes(2);
});

it('超时保留原屏障和DB；晚完成后显式重试才退出，不重复启动关闭任务', async () => {
  const { deps, shutdown } = shutdownFixture(); let release!: () => void;
  deps.stopResources.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  expect(await shutdown()).toBe(false); expect(deps.closeDatabase).not.toHaveBeenCalled();
  release(); await new Promise((resolve) => setImmediate(resolve));
  expect(deps.closeDatabase).not.toHaveBeenCalled();
  expect(await shutdown()).toBe(true); expect(deps.stopResources).toHaveBeenCalledOnce();
});

it('超时后的晚失败也允许重试，不永久复用失败屏障', async () => {
  const { deps, shutdown } = shutdownFixture(); let fail!: (error: Error) => void;
  deps.stopResources.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
  expect(await shutdown()).toBe(false); fail(new Error('late failure'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(await shutdown()).toBe(true); expect(deps.stopResources).toHaveBeenCalledTimes(2);
});

it('DB关闭抛错不宣称成功，重试DB关闭不再次启动已经完成的资源屏障', async () => {
  const { deps, shutdown } = shutdownFixture(); deps.closeDatabase.mockImplementationOnce(() => { throw new Error('DB close failure'); });
  expect(await shutdown()).toBe(false); expect(deps.exit).not.toHaveBeenCalled();
  expect(await shutdown()).toBe(true); expect(deps.closeDatabase).toHaveBeenCalledTimes(2);
  expect(deps.stopResources).toHaveBeenCalledOnce();
});

it('cancel 本身抛错仍等待该资源drain，并停止所有其它生产者，恢复后可重试', async () => {
  const deps = dependencies(); vi.spyOn(deps.engine, 'cancel').mockImplementationOnce(() => { throw new Error('cancel failure'); });
  const idle = vi.spyOn(deps.engine, 'whenIdle'); const cover = vi.spyOn(deps.coverCache, 'cancel');
  const worker = vi.spyOn(deps.translationWorker, 'stop');
  await expect(stopAppResources(deps)).rejects.toThrow();
  expect(idle).toHaveBeenCalled(); expect(cover).toHaveBeenCalled(); expect(worker).toHaveBeenCalled();
  await expect(stopAppResources(deps)).resolves.toBeUndefined();
});
