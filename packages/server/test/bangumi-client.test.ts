import { MockAgent, fetch as undiciFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BangumiApiError, BangumiClient } from '../src/bangumi/client.js';

const BASE = 'https://api.bgm.tv';

function createClient(options: Partial<ConstructorParameters<typeof BangumiClient>[0]> = {}) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const client = new BangumiClient({
    token: 'secret-token-value',
    userAgent: 'bangumi-analyzer/1.0.0 (test)',
    requestIntervalMs: 0,
    httpProxy: '',
    maxRetries: 3,
    retryBaseDelayMs: 1,
    rateLimitCooldownMs: 5,
    timeoutMs: 2000,
    fetchImpl: undiciFetch,
    dispatcher: mockAgent,
    ...options,
  });
  return { client, mockAgent, pool: mockAgent.get(BASE) };
}

describe('Bangumi HTTP 客户端', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });

  afterEach(async () => {
    await agent.close();
  });

  it('发送正确的 User-Agent 与 Authorization 头', async () => {
    const { client, pool, mockAgent } = createClient();
    let capturedHeaders: Record<string, unknown> = {};
    pool
      .intercept({ path: '/v0/me', method: 'GET' })
      .reply((options) => {
        capturedHeaders = (options.headers ?? {}) as Record<string, unknown>;
        return {
          statusCode: 200,
          data: { id: 1, username: 'tester', nickname: '测试', sign: '' },
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });

    const me = await client.getMe();
    expect(me.username).toBe('tester');
    const headerText = JSON.stringify(capturedHeaders).toLowerCase();
    expect(headerText).toContain('bangumi-analyzer/1.0.0');
    expect(headerText).toContain('bearer secret-token-value');
    await mockAgent.close();
  });

  it('5xx 会自动重试并在成功后返回数据', async () => {
    const { client, pool, mockAgent } = createClient();
    pool.intercept({ path: '/v0/me', method: 'GET' }).reply(500, { title: 'boom' });
    pool
      .intercept({ path: '/v0/me', method: 'GET' })
      .reply(200, { id: 1, username: 'tester', nickname: '', sign: '' });

    const me = await client.getMe();
    expect(me.id).toBe(1);
    expect(client.stats.retries).toBe(1);
    await mockAgent.close();
  });

  it('公开身份查询编码路径并拒绝异常 UID', async () => {
    const { client, pool, mockAgent } = createClient({ token: '' });
    pool.intercept({ path: '/v0/users/a%2Fb', method: 'GET' }).reply(200, { id: 1, username: 'a/b', sign: '' });
    expect((await client.getUser('a/b')).id).toBe(1);
    pool.intercept({ path: '/v0/users/broken', method: 'GET' }).reply(200, { id: 0, username: 'broken', sign: '' });
    await expect(client.getUser('broken')).rejects.toMatchObject({ kind: 'parse' });
    await mockAgent.close();
  });

  it.each([{}, [{ id: 'bad', relation: '续集' }], [{ id: 1 }], [{ id: 0, relation: '续集' }]])('异常关系响应不能冒充完整空集合：%j', async (payload) => {
    const { client, pool, mockAgent } = createClient();
    pool.intercept({ path: '/v0/subjects/1/subjects', method: 'GET' }).reply(200, payload);
    await expect(client.getSubjectRelations(1)).rejects.toMatchObject({ kind: 'parse' });
    await mockAgent.close();
  });

  it.each([{}, [{ id: 1, name: 'valid', relation: '导演' }, { id: 'bad', name: 'bad', relation: '导演' }]])('异常人员响应不能被标记为完整成功：%j', async (payload) => {
    const { client, pool, mockAgent } = createClient();
    pool.intercept({ path: '/v0/subjects/1/persons', method: 'GET' }).reply(200, payload);
    await expect(client.getSubjectPersons(1)).rejects.toMatchObject({ kind: 'parse' });
    await mockAgent.close();
  });

  it('图床请求不能携带 Bangumi API Token，合法空关系仍保持正常', async () => {
    const { client, pool, mockAgent } = createClient();
    let headers: Record<string, unknown> = {};
    mockAgent.get('https://lain.bgm.tv').intercept({ path: '/fixture.png', method: 'GET' }).reply((options) => {
      headers = options.headers as Record<string, unknown>;
      return { statusCode: 200, data: 'fixture image', responseOptions: { headers: { 'content-type': 'image/png' } } };
    });
    const image = await client.fetchImage('https://lain.bgm.tv/fixture.png');
    expect(image.data.byteLength).toBeGreaterThan(0);
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('authorization');
    pool.intercept({ path: '/v0/subjects/1/subjects', method: 'GET' }).reply(200, []);
    expect(await client.getSubjectRelations(1)).toEqual([]);
    await mockAgent.close();
  });

  it('429 限流会被识别并最终重试成功', async () => {
    const { client, pool, mockAgent } = createClient();
    pool
      .intercept({ path: '/v0/me', method: 'GET' })
      .reply(429, { title: 'Too Many Requests' }, { headers: { 'retry-after': '0' } });
    pool
      .intercept({ path: '/v0/me', method: 'GET' })
      .reply(200, { id: 1, username: 'tester', nickname: '', sign: '' });

    const me = await client.getMe();
    expect(me.id).toBe(1);
    expect(client.stats.throttled).toBe(1);
    await mockAgent.close();
  });

  it('401 归类为认证失败且不重试、不回显 Token', async () => {
    const { client, pool, mockAgent } = createClient();
    pool.intercept({ path: '/v0/me', method: 'GET' }).reply(401, {
      title: 'Unauthorized',
      description: 'need Login',
    });

    const error = (await client.getMe().catch((caught) => caught)) as BangumiApiError;
    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(client.stats.retries).toBe(0);
    expect(error.message).not.toContain('secret-token-value');
    expect(error.hint).toContain('access-token');
    await mockAgent.close();
  });

  it('404 归类为资源不存在', async () => {
    const { client, pool, mockAgent } = createClient();
    pool.intercept({ path: /\/v0\/users\/.+\/collections.*/, method: 'GET' }).reply(404, {
      title: 'Not Found',
      description: "user doesn't exist",
    });

    await expect(
      client.getCollectionsPage('nobody', { limit: 50, offset: 0 }),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await mockAgent.close();
  });

  it('返回非法 JSON 时归类为解析错误', async () => {
    const { client, pool, mockAgent } = createClient();
    pool.intercept({ path: '/v0/me', method: 'GET' }).reply(200, '<html>oops</html>', {
      headers: { 'content-type': 'text/html' },
    });

    await expect(client.getMe()).rejects.toMatchObject({ kind: 'parse' });
    await mockAgent.close();
  });

  it.each([
    { total: 0, data: null },
    { data: [] },
    { total: -1, data: [] },
  ])('异常分页响应不能被容错成空收藏：%j', async (body) => {
    const { client, pool, mockAgent } = createClient();
    pool.intercept({ path: /\/v0\/users\/.+\/collections.*/, method: 'GET' }).reply(200, body);
    await expect(client.getCollectionsPage('tester', { limit: 50, offset: 0 })).rejects.toMatchObject({ kind: 'parse' });
    await mockAgent.close();
  });

  it('超时会归类为 timeout 并可重试', async () => {
    const { client, pool, mockAgent } = createClient({ timeoutMs: 30, maxRetries: 2 });
    pool
      .intercept({ path: '/v0/me', method: 'GET' })
      .reply(200, { id: 1, username: 't', nickname: '', sign: '' })
      .delay(200);
    pool
      .intercept({ path: '/v0/me', method: 'GET' })
      .reply(200, { id: 1, username: 't', nickname: '', sign: '' })
      .delay(200);

    await expect(client.getMe()).rejects.toMatchObject({ kind: 'timeout' });
    await mockAgent.close();
  });

  it('分页参数会被正确拼接到查询字符串', async () => {
    const { client, pool, mockAgent } = createClient();
    let capturedPath = '';
    pool
      .intercept({ path: /\/v0\/users\/tester\/collections.*/, method: 'GET' })
      .reply((options) => {
        capturedPath = options.path;
        return {
          statusCode: 200,
          data: { total: 1, limit: 50, offset: 100, data: [] },
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });

    await client.getCollectionsPage('tester', { subjectType: 2, limit: 50, offset: 100 });
    expect(capturedPath).toContain('subject_type=2');
    expect(capturedPath).toContain('limit=50');
    expect(capturedPath).toContain('offset=100');
    await mockAgent.close();
  });

  it('网络错误会重试后抛出 network 错误', async () => {
    const failingFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof undiciFetch;
    const { client, mockAgent } = createClient({ fetchImpl: failingFetch, maxRetries: 2 });

    await expect(client.getMe()).rejects.toMatchObject({ kind: 'network' });
    await mockAgent.close();
  });
});
