import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { saveConfig } from '../src/config.js';
import { CoverCache } from '../src/images/coverCache.js';
import { run } from '../src/db/index.js';
import { listReports, saveReport } from '../src/db/profileReports.js';
import { hideWork, hiddenWorks, restoreWork } from '../src/db/userHides.js';
import { SyncEngine } from '../src/sync/engine.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';
import { libraryCollectionItems, librarySubjects } from './fixtures.js';

let app: FastifyInstance;
let client: FakeBangumiClient;
let engine: SyncEngine;

function aiResponse(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 1234, completion_tokens: 567 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const VALID_AI_OUTPUT = {
  sections: [
    {
      id: 'what-you-like',
      title: '你到底喜欢什么',
      statement: '你的高分作品集中在少数几个标签组合上。',
      evidence: ['高分作品 5 部，其中 3 部同时具备「科幻」与「日常」'],
      kind: 'data',
      confidence: 'medium',
    },
    {
      id: 'avoidance',
      title: '你会主动避开什么',
      statement: '当前数据不足，无法判断稳定的回避模式。',
      evidence: ['同类作品样本均少于 5 部'],
      kind: 'inference',
      confidence: 'low',
    },
    {
      id: 'changes',
      title: '你的审美变化',
      statement: '当前只有一次同步，无法比较阶段变化。',
      evidence: ['阶段快照数量 0'],
      kind: 'data',
      confidence: 'low',
    },
  ],
  verdict: '整体来看，你的评分集中在几类稳定标签上，但样本量还不足以得出更强结论。',
  uncertainties: ['缺少跨阶段数据'],
  surprises: [],
};

beforeAll(async () => {
  client = new FakeBangumiClient({
    collections: libraryCollectionItems(),
    subjects: librarySubjects(),
  });
  engine = new SyncEngine({ client, getConfig: () => testConfig() });
  app = await buildApp({
    deps: { client, engine, coverCache: new CoverCache(client) },
    logger: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function syncOnce(): Promise<void> {
  engine.start({ mode: 'incremental', depth: 2 });
  await engine.whenIdle();
}

describe('画像数据集（不依赖 AI）', () => {
  beforeEach(async () => {
    resetDatabase();
    saveConfig({ ai: { enabled: false, apiKey: '' } });
    await syncOnce();
  });

  it('返回完整结构化数据与结论', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/profile/dataset' });
    expect(response.statusCode).toBe(200);
    const dataset = response.json();

    expect(dataset.sample.total).toBe(10);
    expect(dataset.claims.length).toBeGreaterThan(3);
    expect(Array.isArray(dataset.tagPairs)).toBe(true);
    expect(dataset.breadth.distinctTags).toBeGreaterThan(0);
    expect(dataset.periods.length).toBeGreaterThan(0);
    expect(dataset.samples.highRated.length).toBeGreaterThan(0);
  });

  it('每条结论都能追溯到统计数字', () => {
    const dataset = buildProfileDataset();
    for (const claim of dataset.claims) {
      expect(claim.evidence.length).toBeGreaterThan(0);
    }
    const breadth = dataset.claims.find((claim) => claim.id === 'breadth');
    expect(breadth?.evidence.join(' ')).toContain(String(dataset.breadth.distinctTags));
    const bias = dataset.claims.find((claim) => claim.id === 'rating-bias');
    expect(bias?.evidence.join(' ')).toContain(String(dataset.sample.rated));
  });

  it('数据不足时明确标注，而不是给出结论', async () => {
    // 只有 2 部作品的极小样本：所有需要样本量的结论都必须标注「数据不足」
    resetDatabase();
    const tiny = new FakeBangumiClient({
      collections: libraryCollectionItems().slice(0, 2),
      subjects: librarySubjects(),
    });
    const tinyEngine = new SyncEngine({ client: tiny, getConfig: () => testConfig() });
    tinyEngine.start({ mode: 'incremental', depth: 1 });
    await tinyEngine.whenIdle();

    const dataset = buildProfileDataset();
    expect(dataset.sample.total).toBe(2);
    const drift = dataset.claims.find((claim) => claim.id === 'period-drift');
    expect(drift?.insufficient).toBeTruthy();
    expect(drift?.confidence).toBe('low');
    const template = dataset.claims.find((claim) => claim.id === 'core-template');
    expect(template?.insufficient).toBeTruthy();
    for (const claim of dataset.claims.filter((item) => item.insufficient)) {
      expect(claim.confidence).toBe('low');
    }

    // 空数据库不会报错
    resetDatabase();
    expect(buildProfileDataset().sample.total).toBe(0);
    const response = await app.inject({ method: 'GET', url: '/api/profile/dataset' });
    expect(response.statusCode).toBe(200);
  });

  it('没有 AI 时也能正常返回 AI 状态', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/profile/ai' });
    const body = response.json();
    expect(body.configured).toBe(false);
    expect(body.reason).toContain('未启用');
    expect(body.report).toBeNull();
  });
});

describe('画像 AI 总结', () => {
  beforeEach(async () => {
    resetDatabase();
    saveConfig({ hideNsfw: false, ai: { enabled: false, apiKey: '' } });
    for (const name of ['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy']) vi.stubEnv(name, undefined);
    await syncOnce();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('未配置时拒绝生成，但基础画像不受影响', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/profile/ai', payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('ai_not_configured');
    expect(response.json().error.hint).toBeTruthy();

    const dataset = await app.inject({ method: 'GET', url: '/api/profile/dataset' });
    expect(dataset.statusCode).toBe(200);
  });

  it('配置后可以生成并缓存报告（同一份数据不重复调用）', async () => {
    saveConfig({ ai: { enabled: true, apiKey: 'test-key', model: 'test-model' } });
    const fetchMock = vi.fn(async () => aiResponse(VALID_AI_OUTPUT));
    vi.stubGlobal('fetch', fetchMock);

    const first = await app.inject({ method: 'POST', url: '/api/profile/ai', payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json().reused).toBe(false);
    expect(first.json().report.output.verdict).toContain('整体来看');
    expect(first.json().report.usage.promptTokens).toBe(1234);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await app.inject({ method: 'POST', url: '/api/profile/ai', payload: {} });
    expect(second.json().reused).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const status = await app.inject({ method: 'GET', url: '/api/profile/ai' });
    expect(status.json().configured).toBe(true);
    expect(status.json().report.upToDate).toBe(true);
    vi.unstubAllGlobals();
  });

  it('强制重新生成会再次调用 AI', async () => {
    saveConfig({ ai: { enabled: true, apiKey: 'test-key', model: 'test-model' } });
    const fetchMock = vi.fn(async () => aiResponse(VALID_AI_OUTPUT));
    vi.stubGlobal('fetch', fetchMock);

    await app.inject({ method: 'POST', url: '/api/profile/ai', payload: {} });
    await app.inject({ method: 'POST', url: '/api/profile/ai', payload: { force: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('隐藏只影响展示：Real 画像含隐藏样本及 Series/Franchise，历史可读且缓存只随业务输入变化', async () => {
    saveConfig({ ai: { enabled: true, apiKey: 'test-key', model: 'test-model' } });
    const hidden = buildProfileDataset().samples.highRated[0]!;
    const another = buildProfileDataset().samples.highRated[1]!;
    const hiddenMarker = 'FixtureHiddenWorkTitle';
    const seriesKey = 'fixture-analysis-series';
    run('UPDATE subjects SET name_cn=? WHERE id=?', [hiddenMarker, hidden.id]);
    const sid = run("INSERT INTO series_entities(key,title,member_count,created_at,updated_at) VALUES(?,'analysis-series',2,'fixture','fixture')", [seriesKey]).lastInsertRowid;
    for (const id of [hidden.id, another.id]) {
      run('UPDATE subjects SET series_key=? WHERE id=?', [seriesKey, id]);
      run('INSERT INTO series_entity_members(series_id,subject_id) VALUES(?,?)', [sid, id]);
    }
    for (const [title, state] of [['FamilyIncluded', 'confirmed'], ['FamilyConflict', 'conflict']] as const) {
      const fid = run("INSERT INTO franchise_entities(key,title,created_at,updated_at) VALUES(?,?,'fixture','fixture')", [title,title]).lastInsertRowid;
      run('INSERT INTO franchise_series(franchise_id,series_id,state) VALUES(?,?,?)', [fid,sid,state]);
    }
    const seedReport = (hash: string) => saveReport({ snapshotId: null, provider: 'test', model: 'test-model', datasetHash: hash,
      output: { ...VALID_AI_OUTPUT, verdict: hiddenMarker } as Parameters<typeof saveReport>[0]['output'], promptTokens: 10, completionTokens: 10 });
    const oldIds = ['legacy-1', 'visible-v1:old', 'legacy-3'].map(seedReport);
    const fetchMock = vi.fn(async (_url: unknown, _init: RequestInit) => aiResponse(VALID_AI_OUTPUT));
    vi.stubGlobal('fetch', fetchMock);
    const get = (id?: number) => app.inject({ method: 'GET', url: '/api/profile/ai' + (id ? `?reportId=${id}` : '') });
    const generate = () => app.inject({ method: 'POST', url: '/api/profile/ai', payload: {} });

    hideWork(hidden.id);
    const status = (await get()).json();
    expect(status).toMatchObject({ enabled: true, configured: true, reason: '', report: { id: oldIds.at(-1), upToDate: false } });
    expect(status.reports.map((r: { id: number }) => r.id)).toEqual([...oldIds].reverse());
    for (const id of oldIds) expect((await get(id)).json().report).toMatchObject({ id, upToDate: false, output: { verdict: hiddenMarker } });
    expect((await app.inject({ method: 'GET', url: `/api/subjects/${hidden.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/profile/dataset' })).body).not.toContain(hiddenMarker);
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await generate();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ reused: false, report: { upToDate: true } });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1].body));
    const prompt = body.messages.find((message: { role: string }) => message.role === 'user').content as string;
    expect(prompt).toContain(hiddenMarker);
    expect(prompt).toContain(seriesKey);
    expect(prompt).toContain('"id": "structure"');
    expect(prompt).toContain('FamilyIncluded');
    expect(prompt).not.toContain('FamilyConflict');
    expect(prompt).toContain(another.title);
    const generated = result.json().report;
    const handle = hiddenWorks()[0]!.handle;
    restoreWork(handle);
    hideWork(another.id);
    saveConfig({ hideNsfw: true });
    seedReport('legacy-newer');
    expect((await get()).json().report).toMatchObject({ id: generated.id, upToDate: true });
    expect((await generate()).json()).toMatchObject({ reused: true, report: { id: generated.id } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    run('UPDATE collections SET rate=1 WHERE subject_id=?', [hidden.id]);
    expect((await get(generated.id)).json().report.upToDate).toBe(false);
    expect(listReports()).toHaveLength(5);
  });

  it('生成期间避免重复发送，隐藏变化不废弃已返回的结果', async () => {
    saveConfig({ ai: { enabled: true, apiKey: 'test-key', model: 'test-model' } });
    const [first, second] = buildProfileDataset().samples.highRated;
    hideWork(first!.id);
    const status = await app.inject({ method: 'GET', url: '/api/profile/ai' });
    expect(status.json()).toMatchObject({ configured: true, reports: [], report: null });
    let resolve!: (r: Response) => void;
    const hold = new Promise<Response>(done => { resolve = done; });
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const fetchMock = vi.fn(() => { entered(); return hold; });
    vi.stubGlobal('fetch', fetchMock);
    const post = () => app.inject({ method: 'POST', url: '/api/profile/ai', payload: { force: true } });
    const firstRequest = post().then(value => value);
    await started;
    const duplicate = await post();
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('profile_ai_in_progress');
    hideWork(second!.id);
    resolve(aiResponse(VALID_AI_OUTPUT));
    expect((await firstRequest).json().report.upToDate).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listReports()).toHaveLength(1);
  });

  it('AI 失败时返回可读错误，且不影响其他画像功能', async () => {
    saveConfig({ ai: { enabled: true, apiKey: 'test-key', model: 'test-model' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })),
    );
    const failed = await app.inject({ method: 'POST', url: '/api/profile/ai', payload: {} });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.message).toContain('AI');
    expect(failed.json().error.hint).toBeTruthy();

    // 统计部分仍然可用
    const dataset = await app.inject({ method: 'GET', url: '/api/profile/dataset' });
    expect(dataset.statusCode).toBe(200);
    const status = await app.inject({ method: 'GET', url: '/api/profile/ai' });
    expect(status.json().report).toBeNull();
    vi.unstubAllGlobals();
  });

  it('AI 返回结构不合法时拒绝保存', async () => {
    saveConfig({ ai: { enabled: true, apiKey: 'test-key', model: 'test-model' } });
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse({ hello: 'world' })));
    const response = await app.inject({ method: 'POST', url: '/api/profile/ai', payload: {} });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('ai_invalid_response');
    vi.unstubAllGlobals();
  });

  it('本地 HTTP 请求取消会中止上游等待，之后可以恢复生成', async () => {
    saveConfig({ ai: { enabled: true, apiKey: 'test-key', model: 'test-model' } });
    let entered!: () => void;
    let cancelled!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const closed = new Promise<void>(resolve => { cancelled = resolve; });
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => { reject(options.signal!.reason); cancelled(); }, { once: true });
      entered();
    })));
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const clientRequest = httpRequest(base + '/api/profile/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    clientRequest.on('error', () => {});
    clientRequest.end('{}');
    await started;
    clientRequest.destroy();
    await closed;
    expect(listReports()).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/profile/ai' })).json().generating).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse(VALID_AI_OUTPUT)));
    expect((await app.inject({ method: 'POST', url: '/api/profile/ai', payload: {} })).statusCode).toBe(200);
  });
});

describe('画像阶段快照与复盘', () => {
  beforeEach(async () => {
    resetDatabase();
    saveConfig({ ai: { enabled: false, apiKey: '' } });
    await syncOnce();
  });

  it('可以创建、列出与删除快照', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/profile/snapshots',
      payload: { stageLabel: '第 1 阶段', note: '首次复盘' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().snapshot.stageLabel).toBe('第 1 阶段');
    expect(created.json().snapshot.collectionCount).toBe(10);

    const list = await app.inject({ method: 'GET', url: '/api/profile/snapshots' });
    expect(list.json().snapshots).toHaveLength(1);

    const id = list.json().snapshots[0].id;
    const removed = await app.inject({ method: 'DELETE', url: `/api/profile/snapshots/${id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().snapshots).toHaveLength(0);
  });

  it('新快照固定 Real；隐藏切换不污染成员和阶段计数，旧未知口径不参与对比', async () => {
    const { all, one, run } = await import('../src/db/index.js');
    run('UPDATE subjects SET nsfw=1 WHERE id=1');
    saveConfig({ hideNsfw: true });
    expect(buildProfileDataset().sample.total).toBe(9);
    const first = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'real first' } });
    expect(first.json().snapshot.collectionCount).toBe(10);
    expect(first.json().snapshot.visibility).toBe('real');
    const stored = one<{ dataset: string; members: string }>('SELECT dataset,members FROM profile_snapshots WHERE id=:id', { id: first.json().snapshot.id })!;
    expect(JSON.parse(stored.dataset).sample.total).toBe(10);
    expect(Object.keys(JSON.parse(stored.members))).toHaveLength(10);
    saveConfig({ hideNsfw: false });
    const second = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'real second' } });
    const url = `/api/profile/compare?from=${first.json().snapshot.id}&to=${second.json().snapshot.id}`;
    expect((await app.inject({ method: 'GET', url })).json().comparison.stageWorks).toMatchObject({ newWorks: 0, removedWorks: 0 });
    const oldId = first.json().snapshot.id;
    run("UPDATE profile_snapshots SET dataset=json_remove(dataset,'$.visibility') WHERE id=:id", { id: oldId });
    const before = all('SELECT * FROM profile_snapshots ORDER BY id');
    const compared = await app.inject({ method: 'GET', url });
    expect(compared.statusCode).toBe(200);
    expect(compared.json()).toMatchObject({ available: false, comparison: null });
    expect(compared.json().reason).toContain('口径');
    const list = await app.inject({ method: 'GET', url: '/api/profile/snapshots' });
    expect(list.json().snapshots).toHaveLength(2);
    expect(list.json().snapshots.find((item: { id: number }) => item.id === oldId).visibility).toBeNull();
    expect(all('SELECT * FROM profile_snapshots ORDER BY id')).toEqual(before);
    // 明确为 Visible 的快照也不能与 Real 混算；只读检查不能反向修订历史。
    run("UPDATE profile_snapshots SET dataset=json_set(dataset,'$.visibility','visible') WHERE id=:id", { id: oldId });
    expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({ available: false, comparison: null });
    expect((await app.inject({ method: 'DELETE', url: `/api/profile/snapshots/${oldId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/profile/snapshots' })).json().snapshots).toHaveLength(1);
  });

  it.each([{ stageLabel: 123 }, { stageLabel: 'fixture', note: 123 }, { stageLabel: 'fixture', source: [] }])('异常快照字段返回 400，不能崩溃或写入快照：%j', async (payload) => {
    const response = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload });
    expect(response.statusCode).toBe(400);
    const list = await app.inject({ method: 'GET', url: '/api/profile/snapshots' });
    expect(list.json().snapshots).toEqual([]);
  });

  it('重复候选 ID 按不同作品计数，旧快照读取也不重复计算命中率', async () => {
    const { run, one, dataVersion } = await import('../src/db/index.js');
    const first = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'fixture first' } });
    const second = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'fixture second', candidateIds: [1, 1, 998] } });
    expect(second.statusCode).toBe(201);
    expect(second.json().snapshot.candidateCount).toBe(2);
    const id = second.json().snapshot.id;
    // 旧版本已保存的重复清单也只能读时投影，不能改写历史快照。
    run('UPDATE profile_snapshots SET candidate_ids=:candidates WHERE id=:id', { candidates: '[1,1,998]', id });
    const before = one('SELECT candidate_ids FROM profile_snapshots WHERE id=:id', { id });
    const version = dataVersion();
    const list = await app.inject({ method: 'GET', url: '/api/profile/snapshots' });
    expect(list.json().snapshots.find((entry: { id: number }) => entry.id === id).candidateCount).toBe(2);
    const compared = await app.inject({ method: 'GET', url: `/api/profile/compare?from=${first.json().snapshot.id}&to=${id}` });
    expect(compared.json().comparison.rankReview).toMatchObject({ candidateCount: 2, collectedCount: 1, hitRate: 0.5, byStatus: { '看过': 1 } });
    expect(one('SELECT candidate_ids FROM profile_snapshots WHERE id=:id', { id })).toEqual(before);
    expect(dataVersion()).toBe(version);
  });

  it.each([
    { column: 'members', value: 'null' },
    { column: 'members', value: '{}' },
    { column: 'members', value: '{"1": [0, 0]}' },
    { column: 'members', value: '{"1": [2, 11]}' },
    { column: 'members', value: '{"1": {"type": 2}}' },
    { column: 'members', value: '{"1": [2, "9"]}' },
    { column: 'dataset', value: '{"visibility":"real", "tags":[null]}' },
  ])('损坏的 Real 快照 %j 拒绝对比；记录与数据版本保持不变', async ({ column, value }) => {
    const { all, run, dataVersion } = await import('../src/db/index.js');
    const first = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'before' } });
    const second = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'after' } });
    run(`UPDATE profile_snapshots SET ${column}=:value WHERE id=:id`, { value, id: second.json().snapshot.id });
    const before = all('SELECT * FROM profile_snapshots ORDER BY id');
    const version = dataVersion();
    const result = await app.inject({ method: 'GET', url: `/api/profile/compare?from=${first.json().snapshot.id}&to=${second.json().snapshot.id}` });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ available: false, comparison: null });
    expect(result.json().reason).toContain('结构异常');
    expect((await app.inject({ method: 'GET', url: '/api/profile/snapshots' })).json().snapshots).toHaveLength(2);
    expect(all('SELECT * FROM profile_snapshots ORDER BY id')).toEqual(before);
    expect(dataVersion()).toBe(version);
  });

  it.each([
    { beforeShare: 0.3, afterShare: 0.345, expected: 'strengthened' },
    { beforeShare: 0.3, afterShare: 0.255, expected: 'weakened' },
    { beforeShare: 0.4, afterShare: 0.34, expected: 'weakened' },
    { beforeShare: 0.4, afterShare: 0.46, expected: 'strengthened' },
    { beforeShare: 0.4, afterShare: 0.3401, expected: 'continued' },
    { beforeShare: 0.4, afterShare: 0.4599, expected: 'continued' },
  ])('阶段维度相对 15% 门槛包含边界：%j', async ({ beforeShare, afterShare, expected }) => {
    const { run } = await import('../src/db/index.js');
    const { getSnapshot } = await import('../src/db/profileSnapshots.js');
    const first = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'before' } });
    const second = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'after' } });
    // 10000 部使 0.0001 边界具有真实整数分子，避免不自洽的 count=5 / share 夹具。
    const members = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i + 1), [2, 8]]));
    for (const [id, share] of [[first.json().snapshot.id, beforeShare], [second.json().snapshot.id, afterShare]]) {
      const dataset = getSnapshot(id!)!.dataset;
      dataset.sample = { ...dataset.sample, total: 10000, rated: 10000, highRated: 10000 };
      dataset.basics.averageRate = 8;
      dataset.tags = [{ name: '边界标签', count: Math.round(share! * 10000), share: share!, averageRate: 8 }];
      dataset.formats = []; dataset.studios = []; dataset.directors = []; dataset.tagPairs = [];
      run('UPDATE profile_snapshots SET dataset=:dataset,members=:members,collection_count=10000,rated_count=10000,average_rate=8 WHERE id=:id', {
        id, dataset: JSON.stringify(dataset), members: JSON.stringify(members),
      });
    }
    const response = await app.inject({ method: 'GET', url: `/api/profile/compare?from=${first.json().snapshot.id}&to=${second.json().snapshot.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().comparison.changes.find((change: { id: string }) => change.id === 'dimension-tags').verdict).toBe(expected);
  });

  it.each([
    { path: '$.tags[0].share', value: 1.1 },
    { path: '$.tags[0].count', value: 999 },
    { path: '$.tags[0].share', value: 0.9876 },
    { path: '$.tags[0].count', value: '5' },
    { path: '$.breadth.recentPeriodEntropy', value: 'broken' },
    { path: '$.tagPairs', value: [{}] },
    { path: '$.sample.total', value: 0 },
    { path: '$.sample.highRated', value: 999 },
    { path: '$.basics.averageRate', value: 1 },
    { path: '$.tagPairs', value: [{ a: 'A', b: 'B', count: 999, share: 0.5 }] },
  ])('Real 快照的异常统计字段 %j 不生成阶段结论', async ({ path, value }) => {
    const { all, run } = await import('../src/db/index.js');
    const first = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'before' } });
    const second = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'after' } });
    run('UPDATE profile_snapshots SET dataset=json_set(dataset,:path,json(:value)) WHERE id=:id', { path, value: JSON.stringify(value), id: second.json().snapshot.id });
    const before = all('SELECT * FROM profile_snapshots ORDER BY id');
    const result = await app.inject({ method: 'GET', url: `/api/profile/compare?from=${first.json().snapshot.id}&to=${second.json().snapshot.id}` });
    expect(result.statusCode).toBe(200);
    expect(result.json().available).toBe(false);
    expect(all('SELECT * FROM profile_snapshots ORDER BY id')).toEqual(before);
  });

  it('成员评分小数和矛盾摘要均不能借合法 JSON 生成比较结论', async () => {
    const { run, all } = await import('../src/db/index.js');
    const first = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'before' } });
    const second = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'after' } });
    const id = second.json().snapshot.id;
    for (const sql of ["UPDATE profile_snapshots SET members=json_set(members,'$.1[1]',8.5) WHERE id=:id", 'UPDATE profile_snapshots SET average_rate=1 WHERE id=:id']) {
      run(sql, { id });
      const before = all('SELECT * FROM profile_snapshots');
      const response = await app.inject({ method: 'GET', url: `/api/profile/compare?from=${first.json().snapshot.id}&to=${id}` });
      expect(response.json()).toMatchObject({ available: false, comparison: null });
      expect(all('SELECT * FROM profile_snapshots')).toEqual(before);
      // 恢复本测试拥有的快照，分别验证两个独立拒绝原因。
      run('UPDATE profile_snapshots SET members=(SELECT members FROM profile_snapshots WHERE id=:first) WHERE id=:id', { first: first.json().snapshot.id, id });
    }
  });

  it('合法空维度、零评分和低样本快照仍允许比较，缺少证据明确为 insufficient', async () => {
    const { run } = await import('../src/db/index.js');
    run("UPDATE subjects SET tag_names='[]', studios='[]', directors='[]'");
    run('UPDATE collections SET rate=0');
    const first = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'before' } });
    const second = await app.inject({ method: 'POST', url: '/api/profile/snapshots', payload: { stageLabel: 'after' } });
    const result = await app.inject({ method: 'GET', url: `/api/profile/compare?from=${first.json().snapshot.id}&to=${second.json().snapshot.id}` });
    expect(result.statusCode).toBe(200);
    expect(result.json().available).toBe(true);
    expect(result.json().comparison.stageWorks).toMatchObject({ newWorks: 0, removedWorks: 0, newWorksAverageRate: null });
    for (const id of ['dimension-tags', 'dimension-studios', 'dimension-directors', 'core-template', 'breadth']) {
      expect(result.json().comparison.changes.find((change: { id: string }) => change.id === id).verdict).toBe('insufficient');
    }
  });

  it('只有 1 个快照时明确说明无法对比', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/profile/snapshots',
      payload: { stageLabel: '第 1 阶段' },
    });
    const compare = await app.inject({ method: 'GET', url: '/api/profile/compare' });
    const body = compare.json();
    expect(body.available).toBe(false);
    expect(body.reason).toContain('只有 1 个阶段快照');
  });

  it('两个快照之间可以给出延续 / 强化 / 削弱 / 推翻 / 证据不足的判断', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/profile/snapshots',
      payload: { stageLabel: '第 1 阶段' },
    });

    // 第二阶段：新增一部作品并调整评分，模拟阶段变化
    const original = libraryCollectionItems()[0]!;
    const extra = { ...original, subject_id: 99, subject: { ...original.subject!, id: 99 }, rate: 9 };
    await runSyncWithExtra(extra);
    await app.inject({
      method: 'POST',
      url: '/api/profile/snapshots',
      payload: { stageLabel: '第 2 阶段' },
    });

    const compare = await app.inject({
      method: 'GET',
      url: `/api/profile/compare?from=${first.json().snapshot.id}`,
    });
    const body = compare.json();
    expect(body.available).toBe(true);
    expect(body.comparison.stageWorks.newWorks).toBe(1);
    expect(body.comparison.changes.length).toBeGreaterThan(3);
    for (const change of body.comparison.changes) {
      expect(['continued', 'strengthened', 'weakened', 'overturned', 'insufficient']).toContain(
        change.verdict,
      );
      expect(change.evidence.length).toBeGreaterThan(0);
    }
    // 没有候选清单时必须明确说明无法计算 Rank 复盘
    expect(body.comparison.rankReview.available).toBe(false);
    expect(body.comparison.rankReview.reason).toContain('候选清单');
  });

  it('记录了候选清单时，可以计算 Rank 复盘的命中率', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/profile/snapshots',
      payload: { stageLabel: '第 1 阶段' },
    });
    // 候选 5 部：其中 3 部确实在收藏里（1、2、3）
    const second = await app.inject({
      method: 'POST',
      url: '/api/profile/snapshots',
      payload: {
        stageLabel: '第 2 阶段',
        source: 'Bangumi Rank',
        rankFrom: 1,
        rankTo: 5,
        candidateIds: [1, 2, 3, 998, 999],
      },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().snapshot.hasCandidateList).toBe(true);
    expect(second.json().snapshot.candidateCount).toBe(5);

    const compare = await app.inject({ method: 'GET', url: '/api/profile/compare' });
    const review = compare.json().comparison.rankReview;
    expect(review.available).toBe(true);
    expect(review.candidateCount).toBe(5);
    expect(review.collectedCount).toBe(3);
    expect(review.hitRate).toBeCloseTo(0.6, 3);
  });

  it('空数据库时不允许创建快照', async () => {
    resetDatabase();
    const response = await app.inject({
      method: 'POST',
      url: '/api/profile/snapshots',
      payload: { stageLabel: '空阶段' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('empty_dataset');
  });
});

/** 在当前数据基础上追加一部作品再同步一次（用于模拟阶段变化）。 */
async function runSyncWithExtra(extra: Record<string, unknown>): Promise<void> {
  const next = new FakeBangumiClient({
    collections: [...libraryCollectionItems(), extra as never],
    subjects: { ...librarySubjects(), 99: librarySubjects()[1]! },
  });
  const extraEngine = new SyncEngine({ client: next, getConfig: () => testConfig() });
  extraEngine.start({ mode: 'incremental', depth: 1 });
  await extraEngine.whenIdle();
}
