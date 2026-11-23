import { MockAgent } from 'undici';
import { beforeEach, expect, it } from 'vitest';
import { bgmSubjectSchema } from '@bangumi-analyzer/shared';
import { BangumiClient } from '../src/bangumi/client.js';
import { subjectFromDetail } from '../src/bangumi/normalize.js';
import { all, dataVersion, getMeta, one, run } from '../src/db/index.js';
import { applyImport } from '../src/data/import.js';
import { buildExportPayload } from '../src/data/export.js';
import { subjectFromExportRow } from '../src/data/mappers.js';
import { getSubjectDetail, listSubjects } from '../src/db/query.js';
import { enrichDetails } from '../src/sync/enrich.js';
import { ProgressTracker } from '../src/sync/progress.js';
import { SyncEngine } from '../src/sync/engine.js';
import { overview } from '../src/stats/queries.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import { saveConfig } from '../src/config.js';
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase, runSync, testConfig } from './helpers.js';

const id = 137;
const zero = { wish: 0, collect: 0, doing: 0, on_hold: 0, dropped: 0 };
const valid = () => ({ ...makeSubject({ id, name: 'trusted source', eps: 12 }), collection: { ...zero, collect: 400 }, nsfw: true });
const sources = () => ({ subjects: all('SELECT id,name,eps,score,collection_total,collection_stats,nsfw,raw FROM subjects'),
  staff: all('SELECT * FROM subject_staff'), jobs: all('SELECT * FROM translation_jobs'), version: dataVersion(), pending: getMeta('sync_projection_pending') });

beforeEach(async () => {
  resetDatabase(); saveConfig({ hideNsfw: false });
  await runSync(new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: id })], subjects: { [id]: valid() } }));
});

async function response(payload: unknown, inspect: (client: BangumiClient) => Promise<void>) {
  const agent = new MockAgent(); agent.disableNetConnect();
  agent.get('https://api.bgm.tv').intercept({ path: `/v0/subjects/${id}`, method: 'GET' }).reply(200, payload);
  const client = new BangumiClient({ token: '', userAgent: 'source-regression', requestIntervalMs: 0, httpProxy: '', dispatcher: agent });
  try { await inspect(client); } finally { await agent.close(); }
}
const enrich = (client: Parameters<typeof enrichDetails>[1]['client']) => enrichDetails([id], {
  client, signal: new AbortController().signal, progress: new ProgressTracker(0, 'enrich', 1, () => {}),
});

it('AUD-086：实际client拒绝合法但身份不同的详情，失败保留来源/版本，可正确重试', async () => {
  const before = sources();
  await response({ ...valid(), id: 421, name: 'other subject', eps: 24, rating: { ...valid().rating, score: 10 } }, async (client) => {
    expect(await enrich(client)).toMatchObject({ synced: 0, failed: 1 });
  });
  expect(sources()).toEqual(before);
  expect(one('SELECT detail_state,detail_attempts,detail_error FROM subjects WHERE id=137')).toMatchObject({ detail_state: 'failed', detail_attempts: 1, detail_error: expect.stringMatching(/身份/) });
  await response(valid(), async (client) => { expect(await enrich(client)).toMatchObject({ synced: 1, failed: 0 }); });
  expect(one('SELECT detail_state,detail_attempts FROM subjects WHERE id=137')).toEqual({ detail_state: 'ok', detail_attempts: 0 });
  expect(dataVersion()).toBe(before.version);
});

it('AUD-086：自定义来源不能绕过目标绑定，normalize也拒绝existing与detail不同身份', async () => {
  const wrong = makeSubject({ id: 421 }); const before = sources();
  await expect(enrich(new FakeBangumiClient({ subjects: { [id]: wrong } }))).resolves.toMatchObject({ synced: 0, failed: 1 });
  expect(sources()).toEqual(before);
  const existing = one<any>('SELECT * FROM subjects WHERE id=137');
  expect(() => subjectFromDetail(wrong, existing)).toThrow(/身份/);
});

it('AUD-086：完整同步只使用正确slim事实，不把错配详情送进Dashboard/Profile', async () => {
  await response({ ...valid(), id: 421, eps: 24, rating: { ...valid().rating, score: 10 } }, async (httpClient) => {
    const client = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: id, subject: { ...makeCollectionItem({ subject_id: id }).subject, eps: 12, score: 7 } })] });
    client.getSubject = httpClient.getSubject.bind(httpClient);
    const engine = new SyncEngine({ client, getConfig: () => testConfig() });
    engine.start({ mode: 'full', depth: 1 }); await engine.whenIdle();
    expect(engine.getStatus().lastRun?.counters.detailsFetched).toBe(0);
    expect(one('SELECT detail_state FROM subjects WHERE id=137')).toEqual({ detail_state: 'failed' });
    expect(getSubjectDetail(id)).toMatchObject({ id, totalEpisodes: 12, bgmScore: 7, rawSubject: { id } });
    expect(overview()).toMatchObject({ watchedEpisodes: 12, averageBgmScore: 7 });
    expect(buildProfileDataset('real').basics).toMatchObject({ watchedEpisodes: 12, averageBgmScore: 7 });
  });
});

it.each([undefined, null, {}, { ...zero, collect: -1 }, { ...zero, collect: 1.5 }, { ...zero, collect: '0' }, { ...zero, collect: Number.MAX_SAFE_INTEGER, wish: 1 }])(
  'AUD-087：缺失或非法收藏分类 %j 不制造0或丢失旧证据', async (collection) => {
    const payload: Record<string, unknown> = { ...valid(), collection }; if (collection === undefined) delete payload.collection;
    const before = sources();
    await response(payload, async (client) => { expect(await enrich(client)).toMatchObject({ synced: 0, failed: 1 }); });
    expect(sources()).toEqual(before); expect(getSubjectDetail(id)?.collectionTotal).toBe(400);
  },
);

it('AUD-087：完整合法零保留0，raw保留未知源字段及真正缺失的可选字段', async () => {
  const payload: Record<string, unknown> = { id, type: 2, name: 'explicit zero', eps: 12, nsfw: false, collection: zero, future_source_evidence: { nested: ['retained'] } };
  await response(payload, async (client) => { expect(await enrich(client)).toMatchObject({ synced: 1, failed: 0 }); });
  expect(getSubjectDetail(id)?.collectionTotal).toBe(0);
  expect(JSON.parse(one<{ raw: string }>('SELECT raw FROM subjects WHERE id=137')!.raw)).toEqual(payload);
});

it.each([undefined, null, 0, 'false'])('AUD-088：缺失/非法nsfw %j 不撤销可信隐藏标记', async (nsfw) => {
  saveConfig({ hideNsfw: true }); expect(getSubjectDetail(id)).toBeNull();
  const payload: Record<string, unknown> = { ...valid(), nsfw }; if (nsfw === undefined) delete payload.nsfw;
  const before = sources();
    await response(payload, async (client) => { expect(await enrich(client)).toMatchObject({ synced: 1, failed: 0 }); });
    expect(one('SELECT nsfw FROM subjects WHERE id=137')).toEqual({ nsfw: 1 });
    expect(dataVersion()).toBe(before.version); expect(getSubjectDetail(id)).toBeNull();
    expect(JSON.parse(one<{ raw: string }>('SELECT raw FROM subjects WHERE id=137')!.raw)).toEqual(payload);
});

it('AUD-088：明确false可撤销上游true，明确true再次隐藏；用户开关只改可见性', async () => {
  saveConfig({ hideNsfw: true });
  await response({ ...valid(), nsfw: false }, async (client) => { expect(await enrich(client)).toMatchObject({ synced: 1 }); });
  expect(getSubjectDetail(id)?.nsfw).toBe(false);
  await response(valid(), async (client) => { expect(await enrich(client)).toMatchObject({ synced: 1 }); });
  expect(getSubjectDetail(id)).toBeNull(); expect(listSubjects({ page: 1, pageSize: 20 }).total).toBe(0);
  saveConfig({ hideNsfw: false }); expect(getSubjectDetail(id)?.nsfw).toBe(true);
});

it('AUD-087/088：直接Schema不补造缺失的关键来源，普通可选字段兼容仍保留', () => {
  const missing: Record<string, unknown> = { ...valid() }; delete missing.collection; delete missing.nsfw;
  expect(bgmSubjectSchema.safeParse(missing).success).toBe(false);
  expect(bgmSubjectSchema.parse({ ...valid(), nsfw: undefined }).nsfw).toBeUndefined();
});

it('AUD-087同根因：新slim缺失人数不能显示确定0，原始收藏保留字段缺失', async () => {
  resetDatabase();
  const item = makeCollectionItem({ subject_id: 421 });
  const source: Record<string, unknown> = { ...item, subject: { ...item.subject, collection_total: undefined } };
  await runSync(new FakeBangumiClient({ collections: [source as unknown as typeof item] }));
  expect(getSubjectDetail(421)?.collectionTotal).toBeNull();
  const raw = JSON.parse(one<{ raw: string }>('SELECT raw FROM collections WHERE subject_id=421')!.raw);
  expect(Object.hasOwn(raw.subject, 'collection_total')).toBe(false);
  expect(listSubjects({ page: 1, pageSize: 20, sort: 'collectionTotal' }).items[0]?.collectionTotal).toBeNull();
  const payload = buildExportPayload(); resetDatabase(); applyImport(payload);
  expect(getSubjectDetail(421)?.collectionTotal).toBeNull();
});

it.each([undefined, null, -1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1])('AUD-087：slim未知/非法人数 %j 保留已知值，明确0仍可更新', async (count) => {
  const item = makeCollectionItem({ subject_id: id });
  const update = (collection_total: unknown) => new FakeBangumiClient({ collections: [{ ...item, subject: { ...item.subject, collection_total } } as unknown as typeof item] });
  await runSync(update(count)); expect(getSubjectDetail(id)?.collectionTotal).toBe(400);
  await runSync(update(0)); expect(getSubjectDetail(id)?.collectionTotal).toBe(0);
  await runSync(update(count)); expect(getSubjectDetail(id)?.collectionTotal).toBe(0);
});

it('AUD-087：旧零值兼容保留，异常来源状态不能通过导入成为合法事实', () => {
  run('UPDATE subjects SET collection_total=0,collection_total_known=NULL WHERE id=137');
  expect(getSubjectDetail(id)?.collectionTotal).toBe(0);
  expect(subjectFromExportRow({ id: 421, collection_total: 0 })?.collection_total_known).toBeNull();
  for (const flag of [-1, 2, true, '1', {}]) expect(subjectFromExportRow({ id: 421, collection_total: 0, collection_total_known: flag })).toBeNull();
  expect(subjectFromExportRow({ id: 421, collection_total_known: 1 })).toBeNull();
});

it.each(['tester', '41'])('AUD-086同根因：账号 %s 的明确请求目标也必须与响应身份一致', async (target) => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const client = new BangumiClient({ token: '', userAgent: 'source-regression', requestIntervalMs: 0, httpProxy: '', dispatcher: agent });
  agent.get('https://api.bgm.tv').intercept({ path: `/v0/users/${target}`, method: 'GET' }).reply(200, { id: 42, username: 'another-user', nickname: '', sign: '' });
  try { await expect(client.getUser(target)).rejects.toMatchObject({ kind: 'parse' }); } finally { await agent.close(); }
});

it('账号规范化：用户名大小写和数字UID可匹配同一身份；关系/person ID不是请求subject ID', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); const pool = agent.get('https://api.bgm.tv');
  const client = new BangumiClient({ token: '', userAgent: 'source-regression', requestIntervalMs: 0, httpProxy: '', dispatcher: agent });
  pool.intercept({ path: '/v0/users/TESTER', method: 'GET' }).reply(200, { id: 42, username: 'tester' });
  pool.intercept({ path: '/v0/users/42', method: 'GET' }).reply(200, { id: 42, username: 'tester' });
  pool.intercept({ path: `/v0/subjects/${id}/subjects`, method: 'GET' }).reply(200, [{ id: 421, type: 2, relation: '续集' }]);
  pool.intercept({ path: `/v0/subjects/${id}/persons`, method: 'GET' }).reply(200, [{ id: 421, name: 'director', relation: '导演' }]);
  try {
    expect((await client.getUser('TESTER')).id).toBe(42); expect((await client.getUser('42')).id).toBe(42);
    expect((await client.getSubjectRelations(id))[0]?.id).toBe(421);
    expect((await client.getSubjectPersons(id))[0]?.id).toBe(421);
  } finally { await agent.close(); }
});
