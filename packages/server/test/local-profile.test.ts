import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeAvatarDataUrl, validateAvatarDataUrl } from '@bangumi-analyzer/shared';
import { buildApp } from '../src/app.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase, testConfig } from './helpers.js';

/** 1×1 PNG（合法文件头，用于验证魔数检查）。 */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** 声明为 PNG 但内容其实是文本：必须被拒绝。 */
const FAKE_PNG_DATA_URL = `data:image/png;base64,${Buffer.from('this is not an image').toString('base64')}`;

let app: FastifyInstance;

beforeAll(async () => {
  const client = new FakeBangumiClient({
    collections: [makeCollectionItem({ subject_id: 1, type: 2, rate: 8, subject: makeSubject({ id: 1 }) })],
    subjects: { 1: makeSubject({ id: 1 }) },
  });
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

describe('头像 data URL 校验', () => {
  it('接受合法图片，拒绝错误格式与超大文件', () => {
    expect(validateAvatarDataUrl(PNG_DATA_URL)).toBeNull();
    expect(validateAvatarDataUrl('data:text/plain;base64,aGVsbG8=')).toContain('不支持');
    expect(validateAvatarDataUrl('https://example.com/a.png')).toContain('data URL');
    const huge = `data:image/png;base64,${'A'.repeat(3_000_000)}`;
    expect(validateAvatarDataUrl(huge)).toContain('过大');
  });

  it('校验文件头，声明与内容不一致时拒绝解码', () => {
    expect(decodeAvatarDataUrl(PNG_DATA_URL).ok).toBe(true);
    const decoded = decodeAvatarDataUrl(FAKE_PNG_DATA_URL);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toContain('内容与声明的图片格式不一致');
  });
});

describe('本地资料与首次使用引导', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ nickname: '', avatar: '', onboardingSeen: false });
  });

  it('资料与引导状态只保存在本机配置里，接口不返回任何凭据', async () => {
    saveConfig({ token: 'super-secret-token-123456', username: 'tester' });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { nickname: '深夜补番的人' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nickname).toBe('深夜补番的人');
    expect(JSON.stringify(body)).not.toContain('super-secret-token-123456');
    expect(loadConfig().nickname).toBe('深夜补番的人');
    saveConfig({ token: '' });
  });

  it('拒绝把非图片内容伪装成头像保存', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { avatar: FAKE_PNG_DATA_URL },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_avatar');
    expect(loadConfig().avatar).toBe('');
  });

  it('保存合法头像后可以读回，并可以清空', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { avatar: PNG_DATA_URL },
    });
    expect(saved.statusCode).toBe(200);
    expect(loadConfig().avatar.startsWith('data:image/png;base64,')).toBe(true);

    await app.inject({ method: 'PUT', url: '/api/config', payload: { avatar: '' } });
    expect(loadConfig().avatar).toBe('');
  });

  it('引导状态按资料 / Bangumi 配置 / 同步数据三条件判断', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/profile/local' });
    const emptyBody = empty.json();
    expect(emptyBody.completed).toBe(false);
    expect(emptyBody.steps.map((step: { id: string; done: boolean }) => [step.id, step.done])).toEqual([
      ['profile', false],
      ['bangumi', false],
      ['sync', false],
    ]);

    saveConfig({ username: 'tester', token: 'token-value' });
    const configured = await app.inject({ method: 'GET', url: '/api/profile/local' });
    const configuredBody = configured.json();
    // 还没有同步数据 → 仍然未完成，但前两步已完成
    expect(configuredBody.completed).toBe(false);
    expect(configuredBody.steps[1].done).toBe(true);
    saveConfig({ token: '' });
  });

  it('跳过引导后不再自动出现，重置后又会出现', async () => {
    await app.inject({ method: 'PUT', url: '/api/config', payload: { onboardingSeen: true } });
    const skipped = await app.inject({ method: 'GET', url: '/api/profile/local' });
    expect(skipped.json().completed).toBe(true);
    expect(skipped.json().seen).toBe(true);

    await app.inject({ method: 'PUT', url: '/api/config', payload: { onboardingSeen: false } });
    const reset = await app.inject({ method: 'GET', url: '/api/profile/local' });
    expect(reset.json().completed).toBe(false);
  });
});
