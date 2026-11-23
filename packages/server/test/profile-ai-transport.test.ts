import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiCompletionUrl, generateProfileSummary } from '../src/ai/provider.js';
import type { AiConfig } from '../src/config.js';

const config: AiConfig = { provider: 'openai-compatible', enabled: true, apiKey: 'synthetic-only', model: 'fixture', baseUrl: 'http://127.0.0.1/v1' };
const body = { model: 'fixture', stream: false, messages: [], temperature: 0.4, response_format: { type: 'json_object' } };
const output = { sections: [1, 2, 3].map(id => ({ id: String(id), title: 'fixture', statement: 'fixture',
  evidence: [], confidence: 'high', kind: 'data' })), verdict: 'fixture', uncertainties: [], surprises: [] };
const result = JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] });
const servers: Server[] = [];

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test listener');
  return 'http://127.0.0.1:' + address.port;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

const generate = (baseUrl: string, options: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch } = {}) =>
  generateProfileSummary({ config: { ...config, baseUrl }, body, ...options });

describe('AI 单请求传输与响应边界', () => {
  it('非流式 JSON 正常解析；429 保留退避提示、5xx 不自动重放，SSE 不当作普通 JSON', async () => {
    for (const [response, kind, hint] of [
      [new Response('reflection synthetic-only', { status: 429, headers: { 'retry-after': '12' } }), 'rate_limit', /12 秒/],
      [new Response('reflection synthetic-only', { status: 503 }), 'server', /^$/],
      [new Response('data: ignored\n\n', { headers: { 'content-type': 'text/event-stream' } }), 'invalid_response', /非流式/],
      [new Response('null'), 'invalid_response', /^$/],
    ] as const) {
      const fetchImpl = vi.fn(async () => response);
      await expect(generate(config.baseUrl, { fetchImpl })).rejects.toMatchObject({ kind, hint, message: expect.not.stringContaining('synthetic-only') });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const fetchImpl = vi.fn(async () => new Response(result));
    await expect(generate(config.baseUrl, { fetchImpl })).resolves.toMatchObject({ output });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(aiCompletionUrl('http://127.0.0.1/v1/chat/completions')).toBe('http://127.0.0.1/v1/chat/completions');
  });

  it('真实本机 HTTP：读取响应超时、响应中断、取消和下一次成功各只发一次', async () => {
    let calls = 0;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const base = await listen(createServer((req, res) => {
      calls++;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      if (req.url?.startsWith('/timeout')) return;
      if (req.url?.startsWith('/partial')) {
        res.write('{"choices":');
        setTimeout(() => res.destroy(), 35);
        return;
      }
      if (req.url?.startsWith('/cancel')) { started(); return; }
      res.end(result);
    }));
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    vi.stubEnv('no_proxy', '127.0.0.1');
    await expect(generate(base + '/timeout', { timeoutMs: 250, fetchImpl: fetch })).rejects.toMatchObject({ kind: 'timeout', message: expect.stringContaining('读取响应') });
    await expect(generate(base + '/partial', { fetchImpl: fetch })).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('读取响应') });
    const controller = new AbortController();
    const pending = generate(base + '/cancel', { signal: controller.signal, fetchImpl: fetch });
    const check = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await reading;
    controller.abort();
    await check;
    await expect(generate(base + '/ok', { fetchImpl: fetch })).resolves.toMatchObject({ output });
    expect(calls).toBe(4);
  });

  it('标准进程代理复现：默认 Fetch 直连失败；AI 请求使用环境代理，同时保留 NO_PROXY', async () => {
    let hits = 0;
    const target = await listen(createServer((_req, res) => res.end(result)));
    // Reserve then close a local port. The test proxy can route this address to the fake API.
    const closed = createServer();
    const unreachable = await listen(closed);
    await new Promise<void>(resolve => closed.close(() => resolve()));
    const proxy = createServer((request, response) => {
      hits++;
      request.resume();
      if (request.url !== unreachable + '/chat/completions') { response.writeHead(400); response.end(); return; }
      response.end(result);
    });
    const proxyUrl = await listen(proxy);
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    vi.stubEnv('http_proxy', proxyUrl);
    vi.stubEnv('NO_PROXY', 'localhost');
    vi.stubEnv('no_proxy', 'localhost');
    await expect(fetch(unreachable, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    await expect(generate(unreachable, { timeoutMs: 2000 })).resolves.toMatchObject({ output });
    await expect(generate(target.replace('127.0.0.1', 'localhost'), { timeoutMs: 2000 })).resolves.toMatchObject({ output });
    expect(hits).toBe(1);
  });
});
