import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoverCache } from '../src/images/coverCache.js';
import { paths } from '../src/config.js';
import { dataVersion, one, run } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase, runSync, testConfig } from './helpers.js';
import { subjectFromDetail, subjectFromSlim } from '../src/bangumi/normalize.js';
import { upsertSubjectDetail, upsertSubjectSlim } from '../src/db/subjects.js';
import { libraryCollectionItems, librarySubjects } from './fixtures.js';

const image = { data: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' };
let client: FakeBangumiClient;
let cache: CoverCache;

beforeEach(async () => {
  resetDatabase();
  client = new FakeBangumiClient({ collections: libraryCollectionItems(), subjects: librarySubjects() });
  await runSync(client, { depth: 2 });
  cache = new CoverCache(client);
  cache.removeAll();
  run("UPDATE subjects SET cover_url = CASE WHEN id = 1 THEN 'https://lain.bgm.tv/old.jpg' ELSE NULL END");
});
afterEach(() => vi.restoreAllMocks());

function delayedDownload() {
  let release!: (value: typeof image) => void;
  const response = new Promise<typeof image>((resolve) => { release = resolve; });
  // Deliberately finish despite abort: the body may already have arrived when cancellation happens.
  const fetch = vi.spyOn(client, 'fetchImage').mockReturnValue(response);
  const job = cache.start({ concurrency: 1 });
  expect(fetch).toHaveBeenCalledTimes(1);
  return { job, release };
}

describe('封面下载并发与缓存边界', () => {
  it('关闭服务等待封面任务取消完成，不能在 DB 关闭后写回', async () => {
    const app = await buildApp({ deps: { client, coverCache: cache,
      engine: new SyncEngine({ client, getConfig: () => testConfig() }) }, logger: false });
    await app.ready();
    const { job, release } = delayedDownload();
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(closed).toBe(false);
    } finally { release(image); await job; await closing; }
    expect(closed).toBe(true);
    expect(cache.localFile(1)).toBeNull();
  });
  it.each(['slim', 'detail'] as const)('%s 写入新封面地址时只失效缓存，同地址保留缓存', async (kind) => {
    await cache.start({ concurrency: 1 });
    const version = dataVersion();
    const update = (url: string | null) => {
      const images = { large: url ?? '', common: '', medium: '', small: '', grid: '' };
      if (kind === 'slim') {
        const item = makeCollectionItem({ subject_id: 1 });
        item.subject.images = images;
        upsertSubjectSlim(subjectFromSlim(item), '2026-10-10T06:25:00Z');
      } else upsertSubjectDetail(subjectFromDetail(makeSubject({ id: 1, images }), null), '2026-10-10T06:25:00Z');
    };
    update('https://lain.bgm.tv/old.jpg');
    expect(cache.localFile(1)).toBeTruthy();
    update('https://lain.bgm.tv/new.png');
    expect(cache.localFile(1)).toBeNull();
    expect(one('SELECT cover_path, cover_cached_at FROM subjects WHERE id=1')).toEqual({ cover_path: null, cover_cached_at: null });
    await cache.start({ concurrency: 1 });
    expect(cache.localFile(1)).toBe('1.png');
    update(null);
    // Slim missing image keeps the known URL; complete detail can remove it.
    expect(cache.localFile(1)).toBe(kind === 'slim' ? '1.png' : null);
    expect(dataVersion()).toBe(version);
  });

  it('同一条目 URL 的封面可以变化，HTTP 不得宣称 immutable', async () => {
    await cache.start({ concurrency: 1 });
    const app = await buildApp({ deps: { client, coverCache: cache,
      engine: new SyncEngine({ client, getConfig: () => testConfig() }) }, logger: false });
    try {
      const first = await app.inject({ method: 'GET', url: '/api/covers/1' });
      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('no-cache');
      cache.removeAll();
      vi.spyOn(client, 'fetchImage').mockResolvedValue({ ...image, data: new Uint8Array([4, 5, 6]) });
      await cache.start({ concurrency: 1 });
      const second = await app.inject({ method: 'GET', url: '/api/covers/1' });
      expect(second.rawPayload).toEqual(Buffer.from([4, 5, 6]));
      expect(second.headers['cache-control']).toBe('no-cache');
    } finally { await app.close(); }
  });
  it.each(['cancel', 'clear'] as const)('%s 后到达的响应不能重新写回文件或 DB', async (operation) => {
    const version = dataVersion();
    const { job, release } = delayedDownload();
    try {
      if (operation === 'cancel') expect(cache.cancel()).toBe(true);
      else expect(cache.removeAll()).toBe(0);
    } finally { release(image); await job; }
    expect(cache.localFile(1)).toBeNull();
    expect(readdirSync(paths.coverDir)).toEqual([]);
    expect(cache.status()).toMatchObject({ running: false, processed: 0, failed: 0 });
    expect(dataVersion()).toBe(version);
    await cache.start({ concurrency: 1 });
    expect(cache.localFile(1)).toBeTruthy();
    expect(dataVersion()).toBe(version);
  });

  it.each(['changed', 'deleted'] as const)('等待下载时条目 %s，不能提交过时封面', async (operation) => {
    const version = dataVersion();
    const { job, release } = delayedDownload();
    try {
      if (operation === 'changed') run("UPDATE subjects SET cover_url = 'https://lain.bgm.tv/new.png' WHERE id=1");
      else { run('DELETE FROM collections WHERE subject_id=1'); run('DELETE FROM subjects WHERE id=1'); }
    } finally { release(image); await job; }
    expect(cache.localFile(1)).toBeNull();
    expect(readdirSync(paths.coverDir)).toEqual([]);
    expect(cache.status().processed).toBe(0);
    expect(dataVersion()).toBe(version);
  });

  it('清空接口在下载中取消旧任务，阻止重入，结束后可正常重试', async () => {
    const app = await buildApp({ deps: { client, coverCache: cache,
      engine: new SyncEngine({ client, getConfig: () => testConfig() }) }, logger: false });
    const { job, release } = delayedDownload();
    try {
      expect((await app.inject({ method: 'DELETE', url: '/api/covers' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/covers/cache' })).statusCode).toBe(409);
    } finally { release(image); await job; await app.close(); }
    expect(cache.localFile(1)).toBeNull();
    await cache.start({ concurrency: 1 });
    const file = cache.localFile(1)!;
    expect(existsSync(join(paths.coverDir, file))).toBe(true);
    expect(readFileSync(join(paths.coverDir, file))).toEqual(Buffer.from(image.data));
    expect(one('SELECT cover_cached_at FROM subjects WHERE id=1')).toBeTruthy();
  });
});
