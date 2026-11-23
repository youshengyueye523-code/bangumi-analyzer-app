import { beforeEach, describe, expect, it } from 'vitest';
import { bgmSubjectSchema } from '@bangumi-analyzer/shared';
import { subjectFromDetail, subjectFromSlim } from '../src/bangumi/normalize.js';
import { saveConfig } from '../src/config.js';
import { dataVersion, one, run } from '../src/db/index.js';
import { episodeCount, episodeCountSql } from '../src/db/episodeCount.js';
import { currentMembers, createSnapshot, getSnapshot } from '../src/db/profileSnapshots.js';
import { getSeriesDetail, getSubjectDetail, listSeries, listSubjects } from '../src/db/query.js';
import { recomputeSeries } from '../src/db/series.js';
import { upsertSubjectDetail, upsertSubjectSlim } from '../src/db/subjects.js';
import { applyImport } from '../src/data/import.js';
import { buildCsv, buildExportPayload } from '../src/data/export.js';
import { habits, overview } from '../src/stats/queries.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase, runSync } from './helpers.js';

describe('公开真实样本：正篇与数据库章节记录数', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
  });

  it('18624：收藏→详情→存储→列表/详情/统计/实体/Real 快照采用24话，保留32条原始章节', async () => {
    // 公开语义事实：24 正篇 + 2 OP + 6 ED；收藏状态为纯模拟，不复制用户记录。
    const item = makeCollectionItem({ subject_id: 18624, ep_status: 0 });
    item.subject!.eps = 24;
    const client = new FakeBangumiClient({ collections: [item], subjects: {
      18624: makeSubject({ id: 18624, name_cn: '回转企鹅罐', eps: 24, total_episodes: 32 }),
    } });
    const status = await runSync(client, { depth: 2 });
    expect(status.running).toBe(false);
    expect(status.lastRun?.status).toBe('success');
    expect(one('SELECT eps,total_episodes FROM subjects WHERE id=18624')).toEqual({ eps: 24, total_episodes: 24 });
    expect(getSubjectDetail(18624)).toMatchObject({ totalEpisodes: 24, epStatus: 0, watchedEpisodes: 24, progress: 1 });
    expect(listSubjects({}).items[0]).toMatchObject({ totalEpisodes: 24, watchedEpisodes: 24 });
    expect(overview()).toMatchObject({ totalEpisodes: 24, watchedEpisodes: 24, estimatedMinutes: 24 * 24 });
    const dataset = buildProfileDataset('real');
    expect(dataset.basics).toMatchObject({ totalEpisodes: 24, watchedEpisodes: 24 });
    const snapshot = createSnapshot({ stageLabel: '隔离正篇语义', dataset, members: currentMembers() });
    expect(getSnapshot(snapshot.id)!.dataset.basics.totalEpisodes).toBe(24);
    const series = listSeries({ includeSingletons: true })[0]!;
    expect(series.totalEpisodes).toBe(24);
    // 模拟修复部署前的旧投影；只读接口不能要求用户先重算真实库才能解释正确。
    run('UPDATE series_entities SET total_episodes=32 WHERE key=:key', { key: series.key });
    expect(listSeries({ includeSingletons: true })[0]!.totalEpisodes).toBe(24);
    expect(getSeriesDetail(series.key, { visibility: 'real' })!.analysis.consumption.watchedEpisodes).toBe(24);
    expect(one<{ raw: string }>('SELECT raw FROM subjects WHERE id=18624')!.raw).toContain('"total_episodes":32');
  });

  it.each([
    { id: 3428, platform: 'TV', eps: 25, records: 25 }, // 公开普通 TV
    { id: 18624, platform: 'TV', eps: 24, records: 32 }, // OP / ED
    { id: 340, platform: 'TV', eps: 26, records: 27 }, // 特别篇
    { id: 238, platform: '剧场版', eps: 1, records: 5 }, // 电影附加章节
    { id: 18882, platform: 'OVA', eps: 12, records: 13 }, // 公开 OVA + SP
    { id: 13603, platform: 'WEB', eps: 28, records: 35 }, // 公开 ONA
    { id: 90007, platform: 'TV', eps: 0, records: 8 },
    { id: 90008, platform: 'TV', eps: undefined, records: 8 },
  ])('各形态及明确未知经完整同步与跨模块读取：%j', async ({ id, platform, eps, records }) => {
    const input = bgmSubjectSchema.parse(makeSubject({ id, platform, eps, total_episodes: records }));
    const row = subjectFromDetail(input, null);
    expect(row.total_episodes).toBe(eps ?? 0);
    expect(episodeCount(row)).toBe(eps ?? 0);
    expect(JSON.parse(row.raw!).total_episodes).toBe(records);
    const item = makeCollectionItem({ subject_id: id, ep_status: 0 });
    item.subject!.eps = eps;
    expect((await runSync(new FakeBangumiClient({ collections: [item], subjects: { [id]: input } }), { depth: 2 })).lastRun?.status).toBe('success');
    expect(getSubjectDetail(id)).toMatchObject({ totalEpisodes: eps ?? 0, progress: 1, watchedEpisodes: eps ?? 0 });
    expect(overview()).toMatchObject({ totalEpisodes: eps ?? 0, watchedEpisodes: eps ?? 0 });
    expect(buildProfileDataset('real').basics.totalEpisodes).toBe(eps ?? 0);
    expect(listSeries({ includeSingletons: true })[0]!.totalEpisodes).toBe(eps ?? 0);
  });

  it.each([
    { eps: 24, total: 32, raw: null, expected: 24 },
    { eps: 0, total: 8, raw: JSON.stringify({ id: 99, type: 2, eps: 0, total_episodes: 8 }), expected: 0 },
    { eps: 0, total: 8, raw: JSON.stringify({ id: 99, type: 2, total_episodes: 8 }), expected: 0 },
    { eps: 0, total: 8, raw: null, expected: 8 }, // 无来源的合法旧总量
    { eps: 0, total: 8, raw: 'not-json', expected: 8 },
    { eps: 0, total: 8, raw: 'null', expected: 8 },
    { eps: 0, total: 8, raw: '{"id":100,"type":2,"eps":0,"total_episodes":8}', expected: 8 },
    { eps: 0, total: 8, raw: '{"id":"99","type":2,"eps":0,"total_episodes":8}', expected: 8 },
    { eps: 0, total: 8, raw: '{"id":99,"type":"2","eps":0,"total_episodes":8}', expected: 8 },
    { eps: 0, total: 8, raw: '{"id":99,"type":2,"eps":0,"total_episodes":true}', expected: 8 },
    { eps: 0, total: 8, raw: '{"id":99,"type":2,"eps":null,"total_episodes":8}', expected: 8 },
    { eps: -1, total: -2, raw: null, expected: 0 },
    { eps: 2.5, total: 3.5, raw: null, expected: 0 },
  ])('旧数据 SQL 与 JS 一致且只读：%j', ({ eps, total, raw, expected }) => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1, subjects: [{ id: 99, eps: 1 }], collections: [] });
    run('UPDATE subjects SET eps=:eps,total_episodes=:total,raw=:raw WHERE id=99', { eps, total, raw });
    const source = one<any>('SELECT * FROM subjects WHERE id=99')!;
    const version = dataVersion();
    expect(episodeCount(source)).toBe(expected);
    expect(one<any>(`SELECT ${episodeCountSql()} AS count FROM subjects s WHERE id=99`)!.count).toBe(expected);
    expect(one('SELECT * FROM subjects WHERE id=99')).toEqual(source);
    expect(dataVersion()).toBe(version);
  });

  it('非有限数值与 nullable 旧读取输入不会制造话数；SQLite 非有限值只读处理', () => {
    for (const value of [Infinity, -Infinity, NaN, null]) {
      expect(episodeCount({ id: 99, type: 2, eps: 0, total_episodes: value, raw: null })).toBe(0);
    }
    for (const total of ['1e999', '-1e999', 'NULL']) {
      expect(one<{ count: number }>(`WITH s AS (SELECT 99 AS id, 2 AS type, 0 AS eps, ${total} AS total_episodes, NULL AS raw)
        SELECT ${episodeCountSql()} AS count FROM s`)!.count).toBe(0);
    }
  });

  it('旧导出32/24→导入→实体重算→CSV/画像一致；源字段和历史快照不改写', () => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 18624, eps: 24, total_episodes: 32, format: 'TV', raw: { id: 18624, type: 2, eps: 24, total_episodes: 32 } }],
      collections: [{ subject_id: 18624, type: 3, rate: 7, ep_status: 12 }] });
    const source = one('SELECT eps,total_episodes,raw FROM subjects WHERE id=18624');
    expect(getSubjectDetail(18624)).toMatchObject({ totalEpisodes: 24, epStatus: 12, watchedEpisodes: 12, progress: .5 });
    expect(overview()).toMatchObject({ totalEpisodes: 24, watchedEpisodes: 12 });
    const series = listSeries({ includeSingletons: true })[0]!;
    expect(series.totalEpisodes).toBe(24);
    const legacy = buildProfileDataset('real');
    legacy.basics.totalEpisodes = 32;
    const saved = createSnapshot({ stageLabel: '历史隔离样本', dataset: legacy, members: currentMembers() });
    recomputeSeries();
    recomputeSeries();
    expect(listSeries({ includeSingletons: true })[0]!.key).toBe(series.key);
    expect(getSeriesDetail(series.key, { visibility: 'real' })!.analysis.consumption.watchedEpisodes).toBe(12);
    expect(buildProfileDataset('real').basics.totalEpisodes).toBe(24);
    expect(getSnapshot(saved.id)!.dataset.basics.totalEpisodes).toBe(32);
    const csv = buildCsv().split('\n');
    const columns = csv[0]!.split(',');
    expect(csv[1]!.split(',')[columns.indexOf('total_episodes')]).toBe('24');
    expect(one('SELECT eps,total_episodes,raw FROM subjects WHERE id=18624')).toEqual(source);
    expect(buildExportPayload().subjects.find((row) => row.id === 18624)).toMatchObject({ eps: 24, total_episodes: 32 });
  });

  it('官方收藏 JSON 导入、连载进度与超量进度不借章节数量补分母', () => {
    const item = makeCollectionItem({ subject_id: 99, type: 3, ep_status: 30 });
    item.subject!.eps = 24;
    applyImport({ data: [item] });
    expect(getSubjectDetail(99)).toMatchObject({ totalEpisodes: 24, watchedEpisodes: 24, epStatus: 30, progress: 1 });
  });

  it('习惯统计平均进度遵守看过完成，而不是把 ep_status=0 算成0%', () => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 1, eps: 24, total_episodes: 32 }, { id: 2, eps: 26, total_episodes: 27 }],
      collections: [{ subject_id: 1, type: 2, ep_status: 0 }, { subject_id: 2, type: 3, ep_status: 12 }] });
    expect(getSubjectDetail(1)!.progress).toBe(1);
    expect(habits().averageProgress).toBe(.731); // mean(1,12/26)，保留逐作品平均公式
  });

  it('缺失 slim 不清除话数；显式零值保留；详情话数不被后续 slim 冲突覆盖', () => {
    const timestamp = '2026-10-10T00:00:00Z';
    const item = makeCollectionItem({ subject_id: 99 });
    item.subject!.eps = 24;
    upsertSubjectSlim(subjectFromSlim(item), timestamp);
    item.subject!.eps = undefined;
    upsertSubjectSlim(subjectFromSlim(item), timestamp);
    expect(one<any>('SELECT eps FROM subjects WHERE id=99')!.eps).toBe(24);
    item.subject!.eps = 0;
    upsertSubjectSlim(subjectFromSlim(item), timestamp);
    expect(one<any>('SELECT eps,total_episodes FROM subjects WHERE id=99')).toEqual({ eps: 0, total_episodes: 0 });
    const detail = subjectFromDetail(makeSubject({ id: 99, eps: 24, total_episodes: 32 }), null);
    upsertSubjectDetail(detail, timestamp);
    item.subject!.eps = 32;
    upsertSubjectSlim(subjectFromSlim(item), timestamp);
    expect(one<any>('SELECT eps,total_episodes FROM subjects WHERE id=99')).toEqual({ eps: 24, total_episodes: 24 });
    upsertSubjectDetail(subjectFromDetail(makeSubject({ id: 99, eps: 0, total_episodes: 8 }), detail), timestamp);
    upsertSubjectSlim(subjectFromSlim(item), timestamp);
    expect(one<any>('SELECT eps,total_episodes FROM subjects WHERE id=99')).toEqual({ eps: 0, total_episodes: 0 });
  });

  it('详情缺失 eps 保留已有 slim 话数，后续有话数的 slim 可补齐；上游非法话数不当作0', () => {
    const ts = '2026-10-10T00:00:00Z';
    const item = makeCollectionItem({ subject_id: 99 });
    item.subject!.eps = 24;
    const slim = subjectFromSlim(item);
    upsertSubjectSlim(slim, ts);
    const detail = subjectFromDetail(bgmSubjectSchema.parse(makeSubject({ id: 99, eps: undefined, total_episodes: 32 })), slim);
    upsertSubjectDetail(detail, ts);
    expect(episodeCount(detail)).toBe(24);
    item.subject!.eps = 26;
    upsertSubjectSlim(subjectFromSlim(item), ts);
    expect(one<any>('SELECT eps FROM subjects WHERE id=99')!.eps).toBe(26);
    for (const eps of [null, -1, '24', {}, 1.5, Infinity]) {
      expect(bgmSubjectSchema.parse({ ...makeSubject({ id: 99 }), eps }).eps).toBeUndefined();
    }
  });

  it.each([1, 2, 3, 4, 5])('未知话数与收藏状态 %s：完成语义和未知分母分离', (type) => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 99, eps: 0, total_episodes: 8, raw: { id: 99, type: 2, eps: 0, total_episodes: 8 } }],
      collections: [{ subject_id: 99, type, ep_status: 12 }] });
    const detail = getSubjectDetail(99)!;
    expect(detail.totalEpisodes).toBe(0);
    expect(detail.progress).toBe(type === 2 ? 1 : 0);
    expect(detail.epStatus).toBe(12);
    expect(detail.watchedEpisodes).toBe(type === 2 ? 0 : 12);
    // 统计没有可靠分母的条目不制造已看总量或时长。
    expect(overview().watchedEpisodes).toBe(0);
  });

  it.each([1, 3, 4, 6])('非动画类型 %s 保留原 total_episodes 优先规则', (type) => {
    const row = subjectFromDetail(makeSubject({ id: 99, type, eps: 2, total_episodes: 4 }), null);
    expect(row.total_episodes).toBe(4);
    expect(episodeCount(row)).toBe(4);
    // shared 解析现在区分动画缺字段；非动画保持此前缺失 eps 的默认零规则。
    const missing = subjectFromDetail(makeSubject({ id: 99, type, eps: undefined, total_episodes: 0 }), row);
    expect(missing.eps).toBe(0);
    expect(missing.total_episodes).toBe(0);
  });

  it.each(['official', 'export'] as const)('重复 %s 导入必须更新 pending 话数，区分缺失与零并保护完整详情', (format) => {
    const payload = (eps: number | undefined) => {
      if (format === 'official') {
        const item = makeCollectionItem({ subject_id: 99 });
        item.subject!.eps = eps;
        return { data: [item] };
      }
      return { format: 'bangumi-analyzer-export', version: 1,
        subjects: [{ id: 99, eps, total_episodes: 32,
          raw: { id: 99, type: 2, eps, total_episodes: 32 } }],
        collections: [{ subject_id: 99, type: 2, ep_status: 0 }] };
    };
    applyImport(payload(12));
    applyImport(payload(24));
    expect(getSubjectDetail(99)).toMatchObject({ totalEpisodes: 24, watchedEpisodes: 24 });
    expect(overview().totalEpisodes).toBe(24);
    expect(buildProfileDataset('real').basics.totalEpisodes).toBe(24);
    expect(listSeries({ includeSingletons: true })[0]!.totalEpisodes).toBe(24);
    if (format === 'export') expect(JSON.parse(one<any>('SELECT raw FROM subjects WHERE id=99')!.raw).eps).toBe(24);
    applyImport(payload(undefined));
    expect(getSubjectDetail(99)!.totalEpisodes).toBe(24);
    applyImport(payload(0));
    expect(getSubjectDetail(99)).toMatchObject({ totalEpisodes: 0, watchedEpisodes: 0, progress: 1 });
    upsertSubjectDetail(subjectFromDetail(makeSubject({ id: 99, eps: 26, total_episodes: 27 }), null), '2026-10-10T00:00:00Z');
    const source = one('SELECT eps,total_episodes,raw FROM subjects WHERE id=99');
    applyImport(payload(32));
    expect(getSubjectDetail(99)!.totalEpisodes).toBe(26);
    expect(one('SELECT eps,total_episodes,raw FROM subjects WHERE id=99')).toEqual(source);
  });

  it.each([
    { id: 100, type: 2, eps: 0 },
    { id: '99', type: 2, eps: 0 },
    { id: 99, type: 1, eps: 0 },
    { id: 99, type: 2, eps: 1.5 },
    { id: 99, type: 2, eps: 9007199254740992 },
  ])('不可信详情 raw %j 不能阻止 slim 补齐合法话数', (raw) => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 99, eps: 0, total_episodes: 32, raw }],
      collections: [{ subject_id: 99, type: 2, ep_status: 0 }] });
    run("UPDATE subjects SET detail_state='ok' WHERE id=99");
    const item = makeCollectionItem({ subject_id: 99 });
    item.subject!.eps = 24;
    upsertSubjectSlim(subjectFromSlim(item), '2026-10-10T00:00:00Z');
    expect(getSubjectDetail(99)).toMatchObject({ totalEpisodes: 24, watchedEpisodes: 24 });
    expect(JSON.parse(one<any>('SELECT raw FROM subjects WHERE id=99')!.raw)).toEqual(raw);
  });
});
