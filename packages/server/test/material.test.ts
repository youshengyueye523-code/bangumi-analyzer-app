import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, paths, saveConfig } from '../src/config.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';

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

describe('界面材质配置', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ material: { preset: 'balanced', clarity: 50, frosted: 50 } });
  });

  it('默认是「平衡」，并通过 /api/config 暴露给前端', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/config' });
    const body = response.json();
    expect(body.material).toEqual({ preset: 'balanced', clarity: 50, frosted: 50 });
  });

  it('可以保存预设与自定义值，并与背景板设置互不影响', async () => {
    saveConfig({ wallpaper: { image: '', focusX: 12, focusY: 88, blur: 4, strength: 90 } });
    await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { material: { preset: 'frosted', clarity: 30, frosted: 80 } },
    });
    const config = loadConfig();
    expect(config.material).toEqual({ preset: 'frosted', clarity: 30, frosted: 80 });
    expect(config.wallpaper).toEqual({ image: '', focusX: 12, focusY: 88, blur: 4, strength: 90 });
  });

  it('只提交部分字段时保留其余字段（前端滑块单独调整）', async () => {
    await app.inject({ method: 'PUT', url: '/api/config', payload: { material: { clarity: 20 } } });
    expect(loadConfig().material).toEqual({ preset: 'balanced', clarity: 20, frosted: 50 });
  });

  it('拒绝越界值与非法预设', async () => {
    for (const payload of [
      { material: { clarity: 101 } },
      { material: { frosted: -1 } },
      { material: { preset: 'oily' } },
    ]) {
      const response = await app.inject({ method: 'PUT', url: '/api/config', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(loadConfig().material).toEqual({ preset: 'balanced', clarity: 50, frosted: 50 });
  });

  it('配置文件被手改坏时按默认值兜底，不影响其它设置', async () => {
    saveConfig({ username: 'tester' });
    const raw = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>;
    raw.material = { preset: 42, clarity: 'x', frosted: 999 };
    writeFileSync(paths.configFile, JSON.stringify(raw));

    const config = loadConfig();
    expect(config.material).toEqual({ preset: 'balanced', clarity: 50, frosted: 100 });
    expect(config.username).toBe('tester');
    saveConfig({ username: '' });
  });
});
