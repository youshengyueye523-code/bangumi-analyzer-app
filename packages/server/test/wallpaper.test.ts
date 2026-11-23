import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, readFileSync, writeFileSync, linkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, paths, saveConfig } from '../src/config.js';
import { CoverCache } from '../src/images/coverCache.js';
import { pruneWallpapers } from '../src/images/wallpaper.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';

/** 最小合法 PNG（1×1） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'ascii'),
  Buffer.alloc(32, 7),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'ascii'),
  Buffer.alloc(32, 3),
]);
const GIF = Buffer.from('GIF89a', 'ascii');

function dataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function wallpaperFiles(): string[] {
  return existsSync(paths.wallpaperDir) ? readdirSync(paths.wallpaperDir) : [];
}

let app: FastifyInstance;
let client: FakeBangumiClient;

beforeAll(async () => {
  client = new FakeBangumiClient({ collections: [], subjects: [] });
  const engine = new SyncEngine({ client, getConfig: () => testConfig() });
  app = await buildApp({
    deps: { client, engine, coverCache: new CoverCache(client) },
    logger: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('背景图上传与读取', () => {
  beforeEach(() => {
    resetDatabase();
    pruneWallpapers([]);
    saveConfig({
      wallpaper: { image: '', focusX: 50, focusY: 50, blur: 10, strength: 60 },
    });
    expect(wallpaperFiles()).toHaveLength(0);
  });

  it('默认配置是「无背景」，且不影响其它配置项', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/config' });
    const body = response.json();
    expect(body.wallpaper).toEqual({ image: '', focusX: 50, focusY: 50, blur: 10, strength: 60 });
    expect(body.username).toBe(loadConfig().username);
  });

  it('合法文件名的硬链接也不能读取背景目录外的资产', async () => {
    const outside = join(paths.dataDir, 'outside-wallpaper-fixture.txt');
    writeFileSync(outside, 'private fixture outside wallpaper directory');
    const file = 'wp-aaaaaaaaaaaaaaaa.png';
    linkSync(outside, join(paths.wallpaperDir, file));
    const result = await app.inject({ method: 'GET', url: `/api/wallpaper/${file}` });
    expect(result.statusCode).toBe(404);
    expect(result.body).not.toContain('private fixture outside wallpaper directory');
  });

  it('PNG / JPEG / WebP 都能上传并落盘，文件名按内容寻址', async () => {
    for (const [mime, buffer, extension] of [
      ['image/png', PNG, 'png'],
      ['image/jpeg', JPEG, 'jpg'],
      ['image/webp', WEBP, 'webp'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/wallpaper',
        payload: { dataUrl: dataUrl(mime, buffer) },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.image).toMatch(new RegExp(`^wp-[0-9a-f]{16}\\.${extension}$`));
      expect(existsSync(join(paths.wallpaperDir, body.image))).toBe(true);
    }
  });

  it('同一张图重复上传不会产生新文件（内容寻址）', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/wallpaper',
      payload: { dataUrl: dataUrl('image/png', PNG) },
    });
    const count = wallpaperFiles().length;
    const second = await app.inject({
      method: 'POST',
      url: '/api/wallpaper',
      payload: { dataUrl: dataUrl('image/png', PNG) },
    });
    expect(second.json().image).toBe(first.json().image);
    expect(wallpaperFiles().length).toBe(count);
  });

  it('过期上传被清理后，不能成功应用不存在的背景，原配置保留', async () => {
    const first = (await app.inject({ method: 'POST', url: '/api/wallpaper', payload: { dataUrl: dataUrl('image/png', PNG) } })).json().image;
    const expired = new Date(Date.now() - 11 * 60_000);
    utimesSync(join(paths.wallpaperDir, first), expired, expired);
    const second = (await app.inject({ method: 'POST', url: '/api/wallpaper', payload: { dataUrl: dataUrl('image/jpeg', JPEG) } })).json().image;
    expect(existsSync(join(paths.wallpaperDir, first))).toBe(false);
    const before = loadConfig();
    const result = await app.inject({ method: 'PUT', url: '/api/config', payload: { wallpaper: { image: first } } });
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe('wallpaper_not_found');
    expect(loadConfig()).toEqual(before);
    const retry = await app.inject({ method: 'PUT', url: '/api/config', payload: { wallpaper: { image: second } } });
    expect(retry.statusCode).toBe(200);
    expect(loadConfig().wallpaper.image).toBe(second);
  });

  it('重新上传同内容会刷新交接窗口，过期的当前生效图片仍受保护', async () => {
    const upload = () => app.inject({ method: 'POST', url: '/api/wallpaper', payload: { dataUrl: dataUrl('image/png', PNG) } });
    const first = (await upload()).json().image;
    const expired = new Date(Date.now() - 11 * 60_000);
    utimesSync(join(paths.wallpaperDir, first), expired, expired);
    expect((await upload()).json().image).toBe(first);
    await app.inject({ method: 'POST', url: '/api/wallpaper', payload: { dataUrl: dataUrl('image/jpeg', JPEG) } });
    expect(existsSync(join(paths.wallpaperDir, first))).toBe(true);
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: { wallpaper: { image: first } } })).statusCode).toBe(200);
    utimesSync(join(paths.wallpaperDir, first), expired, expired);
    await app.inject({ method: 'POST', url: '/api/wallpaper', payload: { dataUrl: dataUrl('image/webp', WEBP) } });
    expect(existsSync(join(paths.wallpaperDir, first))).toBe(true);
  });

  it('拒绝 GIF / 非图片 / 内容与声明不一致 / 超大文件', async () => {
    const cases: Array<{ label: string; dataUrl: string }> = [
      { label: 'GIF', dataUrl: dataUrl('image/gif', GIF) },
      { label: '文本', dataUrl: 'data:text/plain;base64,aGVsbG8=' },
      { label: '内容与声明不一致', dataUrl: dataUrl('image/png', JPEG) },
      {
        label: '超过 12MB',
        dataUrl: dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(12 * 1024 * 1024)])),
      },
    ];
    for (const testCase of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/wallpaper',
        payload: { dataUrl: testCase.dataUrl },
      });
      expect(response.statusCode, testCase.label).toBe(400);
      expect(response.json().error.code).toBe('invalid_wallpaper');
    }
    expect(wallpaperFiles()).toHaveLength(0);
  });

  it('按文件名读取，拒绝路径穿越与不存在的文件', async () => {
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/wallpaper',
      payload: { dataUrl: dataUrl('image/png', PNG) },
    });
    const image = uploaded.json().image as string;

    const ok = await app.inject({ method: 'GET', url: `/api/wallpaper/${image}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('image/png');
    expect(ok.headers['cache-control']).toContain('immutable');

    for (const bad of ['wp-0000000000000000.png', 'config.json', '..%2Fconfig.json']) {
      const response = await app.inject({ method: 'GET', url: `/api/wallpaper/${bad}` });
      expect(response.statusCode, bad).toBe(404);
      expect(response.json().error.code).toBe('wallpaper_not_found');
    }
  });

  it('应用 / 清除背景：写入配置、删除被替换的文件', async () => {
    const first = (
      await app.inject({
        method: 'POST',
        url: '/api/wallpaper',
        payload: { dataUrl: dataUrl('image/png', PNG) },
      })
    ).json().image as string;
    const second = (
      await app.inject({
        method: 'POST',
        url: '/api/wallpaper',
        payload: { dataUrl: dataUrl('image/jpeg', JPEG) },
      })
    ).json().image as string;

    const applied = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { wallpaper: { image: first, focusX: 32, focusY: 68, blur: 20, strength: 80 } },
    });
    expect(applied.statusCode).toBe(200);
    expect(loadConfig().wallpaper).toEqual({
      image: first,
      focusX: 32,
      focusY: 68,
      blur: 20,
      strength: 80,
    });

    await app.inject({ method: 'PUT', url: '/api/config', payload: { wallpaper: { image: second } } });
    expect(loadConfig().wallpaper.image).toBe(second);
    expect(existsSync(join(paths.wallpaperDir, first))).toBe(false);
    expect(existsSync(join(paths.wallpaperDir, second))).toBe(true);

    await app.inject({ method: 'PUT', url: '/api/config', payload: { wallpaper: { image: '' } } });
    expect(loadConfig().wallpaper.image).toBe('');
    expect(wallpaperFiles()).toHaveLength(0);
  });

  it('配置接口拒绝 data URL / 路径穿越等非法文件名', async () => {
    for (const image of ['data:image/png;base64,AAAA', '../../config.json', 'wp-zzz.png']) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { wallpaper: { image } },
      });
      expect(response.statusCode, image).toBe(400);
    }
    expect(loadConfig().wallpaper.image).toBe('');
  });

  it('配置里的背景被手动破坏（文件不存在 / 非法值）时按无背景处理，不影响其余配置', async () => {
    saveConfig({ username: 'tester' });
    const configFile = paths.configFile;
    const raw = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    raw.wallpaper = { image: '../../etc/passwd', focusX: 999, blur: -5, strength: 'abc' };
    writeFileSync(configFile, JSON.stringify(raw));

    const config = loadConfig();
    expect(config.wallpaper.image).toBe('');
    expect(config.wallpaper.focusX).toBe(100);
    expect(config.wallpaper.blur).toBe(0);
    expect(config.wallpaper.strength).toBe(60);
    expect(config.username).toBe('tester');
    saveConfig({ username: '' });
  });
});
