import { beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { all, dataVersion, one, run } from '../src/db/index.js';
import { getSeriesDetail, getSubjectDetail, listSeries, listSubjects } from '../src/db/query.js';
import { buildCsv, buildExportPayload } from '../src/data/export.js';
import { invalidateStatsCache } from '../src/stats/cache.js';
import { createSnapshot, currentMembers, getSnapshot } from '../src/db/profileSnapshots.js';
import { applyImport } from '../src/data/import.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import { distributions, habits, overview } from '../src/stats/queries.js';
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase, runSync } from './helpers.js';

describe('第九轮：独立业务事实与跨指标解释', () => {
  beforeEach(() => { resetDatabase(); saveConfig({ hideNsfw: false }); });

  it.each([-2, 'NaN', 1.5, 1e100])('非动画旧总量 %j 不生成负数、非有限或分数话数；合法旧 total 优先级保留', (value) => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [1, 3, 4, 6].map((type) => ({ id: type, type, eps: 12, total_episodes: 15 })),
      collections: [1, 3, 4, 6].map((type) => ({ subject_id: type, subject_type: type, type: 2 })) });
    for (const id of [1, 3, 4, 6]) {
      expect(getSubjectDetail(id)).toMatchObject({ totalEpisodes: 15, watchedEpisodes: 15 });
      run('UPDATE subjects SET total_episodes=:value WHERE id=:id', { id, value });
    }
    invalidateStatsCache();
    const source = all('SELECT * FROM subjects');
    const version = dataVersion();
    expect(overview()).toMatchObject({ totalEpisodes: 0, watchedEpisodes: 0, estimatedMinutes: 0 });
    for (const id of [1, 3, 4, 6]) expect(getSubjectDetail(id)).toMatchObject({ totalEpisodes: 0, watchedEpisodes: 0, progress: 1 });
    expect(buildProfileDataset('real').basics).toMatchObject({ totalEpisodes: 0, watchedEpisodes: 0 });
    expect(listSeries({ includeSingletons: true }).every((series) => series.totalEpisodes === 0)).toBe(true);
    expect(all('SELECT * FROM subjects')).toEqual(source);
    expect(dataVersion()).toBe(version);
  });

  it('公开特别篇和真人事实走各自规则：TV 来源优先于 OVA 标签，真人不套动画 eps 规则', async () => {
    // 2026-10-10 20:32 官方详情 GET；用户收藏状态为模拟，日期/属性均为公开事实。
    const facts = [
      { id: 88473, type: 2, name: '蟲師 特別篇 日蝕む翳', platform: 'TV', eps: 1, total_episodes: 1, date: '2014-01-04', tags: ['OVA', '治愈', '蟲師'], format: 'TV', status: 2, progress: 0, watched: 1 },
      { id: 30619, type: 6, name: '孤独のグルメ', platform: '日剧', eps: 12, total_episodes: 12, date: '2012-01-05', tags: ['日剧', '美食'], format: '其他', status: 3, progress: 5, watched: 5 },
      { id: 160547, type: 6, name: '孤独のグルメ お正月スペシャル! 真冬の北海道・旭川出張編', platform: '日剧', eps: 1, total_episodes: 1, date: '2016-01-01', tags: ['日剧', '美食', 'SP'], format: 'Special', status: 2, progress: 0, watched: 1 },
    ];
    const collections = facts.map((f) => { const item = makeCollectionItem({ subject_id: f.id, subject_type: f.type, type: f.status, ep_status: f.progress });
      Object.assign(item.subject!, { type: f.type, eps: f.eps }); return item; });
    const subjects = Object.fromEntries(facts.map((f) => [f.id, makeSubject({ ...f, tags: f.tags.map((name) => ({ name, count: 1, total_count: 1 })) })]));
    expect((await runSync(new FakeBangumiClient({ collections, subjects }), { depth: 2, config: { subjectTypes: [2, 6] } })).lastRun?.status).toBe('success');
    for (const f of facts) {
      expect(getSubjectDetail(f.id)).toMatchObject({ totalEpisodes: f.eps, watchedEpisodes: f.watched, format: f.format, platform: f.platform });
      expect(JSON.parse(one<{ raw: string }>('SELECT raw FROM subjects WHERE id=:id', { id: f.id })!.raw)).toMatchObject({ id: f.id, type: f.type, eps: f.eps, total_episodes: f.total_episodes });
    }
    expect(overview()).toMatchObject({ totalEpisodes: 14, watchedEpisodes: 7 });
    expect(buildProfileDataset('real').basics).toMatchObject({ totalEpisodes: 14, watchedEpisodes: 7 });
    // 独立合法冲突反例，明确为合成：真人旧总量优先；不借动画正篇裁决改变它。
    run('UPDATE subjects SET total_episodes=13 WHERE id=30619');
    invalidateStatsCache();
    expect(getSubjectDetail(30619)).toMatchObject({ totalEpisodes: 13, watchedEpisodes: 5 });
    expect(overview()).toMatchObject({ totalEpisodes: 15, watchedEpisodes: 7 });
    const dataset = buildProfileDataset('real');
    expect(getSnapshot(createSnapshot({ stageLabel: '特别篇与真人', dataset, members: currentMembers() }).id)!.dataset.basics).toMatchObject({ totalEpisodes: 15, watchedEpisodes: 7 });
  });

  it.each([-3, 'NaN', 'Infinity', 'garbage', 1.5, 1e100])('旧异常进度 %j 不变成负时长、满进度或分数集数，各只读消费者一致', (value) => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 1, eps: 24, format: 'TV' }], collections: [{ subject_id: 1, type: 3, ep_status: 1 }] });
    run('UPDATE collections SET ep_status=:value WHERE subject_id=1', { value });
    invalidateStatsCache();
    const source = all('SELECT * FROM collections');
    const version = dataVersion();
    expect(overview()).toMatchObject({ watchedEpisodes: 0, estimatedMinutes: 0, progressRatio: 0 });
    expect(getSubjectDetail(1)).toMatchObject({ epStatus: 0, watchedEpisodes: 0, progress: 0 });
    expect(listSubjects({ progress: 'not-started' }).total).toBe(1);
    expect(buildProfileDataset('real').basics.watchedEpisodes).toBe(0);
    expect(habits().averageProgress).toBe(0);
    const series = listSeries({ includeSingletons: true })[0]!;
    expect(getSeriesDetail(series.key)!.analysis.consumption.watchedEpisodes).toBe(0);
    const lines = buildCsv().trim().split('\r\n');
    const headers = lines[0]!.replace(/^\uFEFF/, '').split(',');
    expect(lines[1]!.split(',')[headers.indexOf('progress')]).toBe('0.0000');
    const dataset = buildProfileDataset('real');
    const snapshot = createSnapshot({ stageLabel: '旧异常进度', dataset, members: currentMembers() });
    expect(getSnapshot(snapshot.id)!.dataset.basics.watchedEpisodes).toBe(0);
    expect(buildExportPayload().collections[0]).toMatchObject({ ep_status: value });
    expect(all('SELECT * FROM collections')).toEqual(source);
    expect(dataVersion()).toBe(version);
  });

  it('真实未知/将播/ONA/OVA/书籍/音乐/游戏字段经完整同步保留各自单位，不用章节数填动画分母', async () => {
    // 2026-10-10 无凭据公开 GET 核验的元数据；收藏状态和进度全部为模拟。
    // 最后两个是反例，不冒充真实 Special / 真人作品。
    const facts = [
      { id: 18624, type: 2, eps: 24, records: 32, platform: 'TV', status: 2, progress: 0, expected: 24, watched: 24 },
      { id: 18692, type: 2, eps: 0, records: 943, platform: 'TV', status: 2, progress: 0, expected: 0, watched: 0 },
      { id: 514926, type: 2, eps: 0, records: 0, platform: 'TV', status: 1, progress: 0, expected: 0, watched: 0 },
      { id: 13603, type: 2, eps: 28, records: 35, platform: 'WEB', status: 3, progress: 8, expected: 28, watched: 8 },
      { id: 750, type: 2, eps: 1, records: 1, platform: 'OVA', status: 4, progress: 3, expected: 1, watched: 1 },
      { id: 238, type: 2, eps: 1, records: 5, platform: '剧场版', status: 1, progress: 0, expected: 1, watched: 0 },
      { id: 32726, type: 1, eps: 160, records: 0, platform: '漫画', status: 2, progress: 0, expected: 160, watched: 160 },
      { id: 814, type: 3, eps: 0, records: 6, platform: '', status: 2, progress: 0, expected: 6, watched: 6 },
      { id: 401, type: 4, eps: 0, records: 0, platform: '游戏', status: 2, progress: 0, expected: 0, watched: 0 },
      { id: 990901, type: 2, eps: 2, records: 5, platform: 'SP', status: 5, progress: 1, expected: 2, watched: 1 },
      { id: 990902, type: 6, eps: 2, records: 4, platform: '', status: 2, progress: 0, expected: 4, watched: 4 },
    ];
    const collections = facts.map((f) => {
      const item = makeCollectionItem({ subject_id: f.id, subject_type: f.type, type: f.status, ep_status: f.progress });
      Object.assign(item.subject!, { type: f.type, eps: f.eps });
      return item;
    });
    const subjects = Object.fromEntries(facts.map((f) => [f.id, makeSubject({ id: f.id, type: f.type, eps: f.eps, total_episodes: f.records, platform: f.platform })]));
    expect((await runSync(new FakeBangumiClient({ collections, subjects }), { depth: 2, config: { subjectTypes: [1, 2, 3, 4, 6] } })).lastRun?.status).toBe('success');
    for (const f of facts) {
      expect(getSubjectDetail(f.id)).toMatchObject({ totalEpisodes: f.expected, watchedEpisodes: f.watched, epStatus: f.progress });
      const raw = JSON.parse(one<{ raw: string }>('SELECT raw FROM subjects WHERE id=:id', { id: f.id })!.raw);
      expect(raw).toMatchObject({ id: f.id, type: f.type, eps: f.eps, total_episodes: f.records });
      const entity = listSeries({ includeSingletons: true }).find((entry) => getSeriesDetail(entry.key)!.members.some((m) => m.subjectId === f.id))!;
      expect(entity.totalEpisodes).toBe(f.expected);
      expect(getSeriesDetail(entity.key)!.analysis.consumption.watchedEpisodes).toBe(f.watched);
    }
    // 独立手算：库存226；想看Movie的1话不进入progress分母；已看204。
    expect(overview()).toMatchObject({ totalEpisodes: 225, watchedEpisodes: 204 });
    const dataset = buildProfileDataset('real');
    expect(dataset.basics).toMatchObject({ totalEpisodes: 226, watchedEpisodes: 204 });
    const snapshot = createSnapshot({ stageLabel: '各单位兼容', dataset, members: currentMembers() });
    expect(getSnapshot(snapshot.id)!.dataset.basics).toMatchObject({ totalEpisodes: 226, watchedEpisodes: 204 });
  });

  it('评分差采用配对均值；Wish库存/已开始分母、零评分、元数据去重与Real/Visible分别有可解释样本', () => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [
        { id: 1, eps: 24, total_episodes: 32, score: 7, year: 2011, format: 'TV', tag_names: ['共同标签', '共同标签'], studios: ['公司甲', '公司甲'], originals: ['漫画', '漫画'] },
        { id: 2, eps: 26, total_episodes: 27, score: 9, year: 2005, format: 'TV' },
        { id: 3, eps: 1, total_episodes: 5, score: 0, year: null, format: 'Movie', nsfw: true },
      ],
      collections: [{ subject_id: 1, type: 2, rate: 9, ep_status: 0 }, { subject_id: 2, type: 3, rate: 0, ep_status: 12 }, { subject_id: 3, type: 1, rate: 3, ep_status: 0 }] });
    const version = dataVersion();
    const source = all('SELECT * FROM subjects ORDER BY id');
    // mean(my)=6，mean(Bgm)=8，但配对仅第1条，delta=2（不能算 -2）。
    expect(overview()).toMatchObject({ total: 3, averageRate: 6, averageBgmScore: 8, meanDelta: 2, totalEpisodes: 50, watchedEpisodes: 36, completionRate: .3333 });
    expect(buildProfileDataset('real').basics).toMatchObject({ meanDelta: 2, totalEpisodes: 51, watchedEpisodes: 36 });
    expect(distributions().tag.find((tag) => tag.key === '共同标签')!.count).toBe(1);
    expect(distributions().original.find((tag) => tag.key === '漫画')!.count).toBe(1);
    saveConfig({ hideNsfw: true });
    expect(overview()).toMatchObject({ total: 2, averageRate: 9, meanDelta: 2, totalEpisodes: 50, watchedEpisodes: 36, completionRate: .5 });
    expect(buildProfileDataset('visible').basics.totalEpisodes).toBe(50);
    expect(buildProfileDataset('real').basics.totalEpisodes).toBe(51);
    expect(all('SELECT * FROM subjects ORDER BY id')).toEqual(source);
    expect(dataVersion()).toBe(version);
  });
});
