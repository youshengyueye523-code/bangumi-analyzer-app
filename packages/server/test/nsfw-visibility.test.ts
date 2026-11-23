/**
 * v1.5.3：NSFW 可见性策略。
 *
 * 唯一判定依据是 `subjects.nsfw`（Bangumi subject.nsfw）；tag / 标题关键词不参与判定。
 * 隐藏只改变「当前可见投影」，任何开关切换都不得改动数据。
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { saveConfig } from '../src/config.js';
import { one, run } from '../src/db/index.js';
import { searchFranchiseEntities, searchSeriesEntities } from '../src/db/ipSearch.js';
import {
  getFilterFacets,
  getFranchiseDetail,
  getSubjectDetail,
  isFranchiseHidden,
  isSeriesHidden,
  isSubjectHidden,
  listFranchises,
  listSeries,
  listSubjects,
} from '../src/db/query.js';
import { recomputeSeries } from '../src/db/series.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { TranslationWorker } from '../src/translate/worker.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';

const TS = '2026-01-01T00:00:00.000Z';

function hideNsfw(value: boolean): void {
  saveConfig({ hideNsfw: value });
}

function seedSubject(
  id: number,
  nameCn: string,
  options: { nsfw?: boolean; aliases?: string[]; collected?: boolean; format?: string } = {},
): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, aliases, year, format, nsfw, tag_names, created_at, updated_at)
     VALUES (:id, :name, :nameCn, :aliases, :year, :format, :nsfw, '[]', :ts, :ts)`,
    {
      id,
      name: nameCn,
      nameCn,
      aliases: JSON.stringify(options.aliases ?? []),
      year: 2000 + (id % 20),
      format: options.format ?? 'TV',
      nsfw: options.nsfw ? 1 : 0,
      ts: TS,
    },
  );
  if (options.collected !== false) {
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, first_seen_at, synced_at)
       VALUES (:id, 2, 2, 0, :ts, :ts)`,
      { id, ts: TS },
    );
  }
}

function seedRelation(from: number, to: number, relation: string): void {
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:from, :to, :relation, 2, '', '', :ts)`,
    { from, to, relation, ts: TS },
  );
}

/** 双成员系列：1 普通 + 2 NSFW。 */
function seedMixedSeries(): void {
  seedSubject(1, '测试系列');
  seedSubject(2, '测试系列 NSFW 篇', { nsfw: true, aliases: ['隐藏俗称'] });
  seedRelation(1, 2, '续集');
  seedRelation(2, 1, '前传');
  recomputeSeries();
}

function dataCounts(): Record<string, number> {
  const tables = [
    'subjects',
    'collections',
    'subject_relations',
    'series_entities',
    'franchise_entities',
  ];
  const result: Record<string, number> = {};
  for (const table of tables) {
    result[table] = Number(one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
  }
  return result;
}

describe('NSFW 可见性策略（数据层）', () => {
  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
  });

  it('关闭隐藏时与完整数据一致，真实统计与可见统计相同', () => {
    seedSubject(1, '普通作品');
    seedSubject(2, 'NSFW 作品', { nsfw: true });
    const facets = getFilterFacets();
    expect(facets.total).toBe(2);
    expect(facets.realTotal).toBe(2);
    expect(facets.hiddenCount).toBe(0);
    expect(listSubjects({}).items.map((item) => item.id).sort()).toEqual([1, 2]);
  });

  it('开启隐藏后 Subject 列表 / 搜索 / facets 排除 NSFW，真实总数保留', () => {
    seedSubject(1, '普通作品');
    seedSubject(2, 'NSFW 作品', { nsfw: true, aliases: ['隐藏俗称'] });
    hideNsfw(true);

    expect(listSubjects({}).items.map((item) => item.id)).toEqual([1]);
    expect(listSubjects({ q: 'NSFW' }).items).toHaveLength(0);
    expect(listSubjects({ q: '隐藏俗称' }).items).toHaveLength(0);
    expect(isSubjectHidden(2)).toBe(true);
    expect(isSubjectHidden(1)).toBe(false);

    const facets = getFilterFacets();
    expect(facets.total).toBe(1);
    expect(facets.realTotal).toBe(2);
    expect(facets.hiddenCount).toBe(1);
  });

  it('只有 subject.nsfw 参与判定：普通 tag 不影响可见性', () => {
    seedSubject(1, '卖肉但未标记');
    run(`UPDATE subjects SET tag_names = '["R18","工口"]' WHERE id = 1`);
    seedSubject(2, '外表普通的 NSFW', { nsfw: true });
    hideNsfw(true);
    // tag 命中 R18/工口 的作品仍然可见；nsfw=1 的普通标题仍然隐藏
    expect(listSubjects({}).items.map((item) => item.id)).toEqual([1]);
  });

  it('Series：任一 primary 成员 NSFW → 整体隐藏；关闭后完整恢复', () => {
    seedMixedSeries();
    const series = listSeries({ includeSingletons: true })[0]!;
    expect(series.memberCount).toBe(2);

    hideNsfw(true);
    expect(listSeries({ includeSingletons: true })).toHaveLength(0);
    expect(isSeriesHidden(series.key)).toBe(true);
    // 搜索不能通过隐藏成员 / 隐藏 alias 反查到该 Series
    expect(searchSeriesEntities('NSFW 篇').total).toBe(0);
    expect(searchSeriesEntities('隐藏俗称').total).toBe(0);
    expect(searchSeriesEntities('测试系列').total).toBe(0);
    // 系列链接在隐藏时不下发，避免指向被隐藏系列的死链
    expect(getSubjectDetail(1)!.series).toBeNull();

    hideNsfw(false);
    expect(listSeries({ includeSingletons: true })).toHaveLength(1);
    expect(isSeriesHidden(series.key)).toBe(false);
    expect(searchSeriesEntities('NSFW 篇').total).toBe(1);
    expect(getSubjectDetail(1)!.series?.key).toBe(series.key);
  });

  it('单成员 NSFW Series 同样整体隐藏并恢复', () => {
    seedSubject(1, '单人 NSFW 作品', { nsfw: true });
    recomputeSeries();
    const key = listSeries({ includeSingletons: true })[0]!.key;

    hideNsfw(true);
    expect(listSeries({ includeSingletons: true })).toHaveLength(0);
    expect(isSeriesHidden(key)).toBe(true);

    hideNsfw(false);
    expect(listSeries({ includeSingletons: true })).toHaveLength(1);
  });

  it('隐藏状态下 Subject 详情的关联条目与封面不泄露隐藏内容', () => {
    seedSubject(1, '普通作品');
    seedSubject(2, 'NSFW 关联条目', { nsfw: true });
    seedRelation(1, 2, '关联');
    recomputeSeries();

    expect(getSubjectDetail(1)!.relations.map((entry) => entry.id)).toEqual([2]);

    hideNsfw(true);
    expect(getSubjectDetail(1)!.relations).toHaveLength(0);
    hideNsfw(false);
    expect(getSubjectDetail(1)!.relations.map((entry) => entry.id)).toEqual([2]);
  });

  it('Franchise：部分可见 → 保留且不含隐藏 Series；全部隐藏 → 家族隐藏', () => {
    // 家族 A：series1（1+2）与 series2（3）通过「不同演绎」组成家族
    seedSubject(1, '家族作品');
    seedSubject(2, '家族作品 第二季');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    seedSubject(3, '家族作品 新作');
    seedRelation(1, 3, '不同演绎');
    seedRelation(3, 1, '不同演绎');
    // 家族 B：两个 Series 都含 NSFW 成员
    seedSubject(20, '独占家族 甲');
    seedSubject(21, '独占家族 甲 NSFW', { nsfw: true });
    seedRelation(20, 21, '续集');
    seedRelation(21, 20, '前传');
    seedSubject(22, '独占家族 乙');
    seedSubject(23, '独占家族 乙 NSFW', { nsfw: true });
    seedRelation(22, 23, '续集');
    seedRelation(23, 22, '前传');
    seedRelation(20, 22, '不同演绎');
    seedRelation(22, 20, '不同演绎');
    recomputeSeries();

    const franchiseA = getSubjectDetail(1)!.franchise!;
    const franchiseB = getSubjectDetail(20)!.franchise!;
    const seriesA2 = getSubjectDetail(3)!.series!;
    expect(franchiseA.key).not.toBe(franchiseB.key);

    // 给 series A1 增加 NSFW 成员
    seedSubject(4, '家族作品 第二季 NSFW', { nsfw: true });
    seedRelation(2, 4, '续集');
    seedRelation(4, 2, '前传');
    recomputeSeries();

    hideNsfw(true);
    // 家族 A：仍有可见 Series（seriesA2），整体保留；隐藏 Series 不出现在详情里
    const keptA = listFranchises().find((entry) => entry.key === franchiseA.key);
    expect(keptA).toBeTruthy();
    // 家族代表图不会使用隐藏的 NSFW 成员
    expect(keptA!.coverSubjects.every((entry) => entry.id !== 4)).toBe(true);
    const detailA = getFranchiseDetail(franchiseA.key)!;
    expect(detailA.series.map((entry) => entry.key)).toEqual([seriesA2.key]);
    expect(isFranchiseHidden(franchiseA.key)).toBe(false);
    // 家族 B：所有 Series 都隐藏 → 家族整体隐藏
    expect(listFranchises().some((entry) => entry.key === franchiseB.key)).toBe(false);
    expect(isFranchiseHidden(franchiseB.key)).toBe(true);

    hideNsfw(false);
    expect(listFranchises().some((entry) => entry.key === franchiseB.key)).toBe(true);
    expect(getFranchiseDetail(franchiseA.key)!.series).toHaveLength(2);
  });

  it('Franchise 搜索不会通过隐藏成员泄露', () => {
    seedSubject(1, '家族作品');
    seedSubject(2, '家族作品 第二季');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    seedSubject(3, '家族作品 新作');
    seedRelation(1, 3, '不同演绎');
    seedRelation(3, 1, '不同演绎');
    seedSubject(4, '家族作品 新作 NSFW', { nsfw: true });
    seedRelation(3, 4, '续集');
    seedRelation(4, 3, '前传');
    recomputeSeries();

    hideNsfw(true);
    expect(searchFranchiseEntities('NSFW').total).toBe(0);
    expect(searchFranchiseEntities('家族作品 新作 NSFW').total).toBe(0);
    expect(searchFranchiseEntities('家族作品').total).toBe(1);

    hideNsfw(false);
    expect(searchFranchiseEntities('NSFW').total).toBe(1);
  });

  it('开关切换不修改数据：行数在 ON / OFF 前后完全一致', () => {
    seedMixedSeries();
    seedSubject(3, '单人 NSFW', { nsfw: true });
    recomputeSeries();

    const before = dataCounts();
    hideNsfw(true);
    const during = dataCounts();
    hideNsfw(false);
    const after = dataCounts();
    expect(during).toEqual(before);
    expect(after).toEqual(before);
    // 恢复后完整可见
    expect(listSubjects({}).items).toHaveLength(3);
  });
});

describe('NSFW 可见性策略（HTTP 层）', () => {
  let app: FastifyInstance;
  let worker: TranslationWorker;

  beforeAll(async () => {
    const client = new FakeBangumiClient({});
    const engine = new SyncEngine({ client, getConfig: () => testConfig() });
    // worker 不启动，只注册路由让简介接口可用
    worker = new TranslationWorker({
      getConfig: () => ({ ...testConfig().ai, enabled: false, apiKey: '' }),
      concurrency: () => 1,
    });
    app = await buildApp({
      deps: { client, engine, coverCache: new CoverCache(client), translationWorker: worker },
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await worker.stop();
  });

  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
  });

  it('直接访问隐藏 Subject / Series / 简介 / 封面：返回 hidden 而不是内容', async () => {
    seedMixedSeries();
    const seriesKey = listSeries({ includeSingletons: true })[0]!.key;
    hideNsfw(true);

    const subject = await app.inject({ method: 'GET', url: '/api/subjects/2' });
    expect(subject.statusCode).toBe(404);
    expect(subject.json().error.code).toBe('subject_hidden');
    expect(JSON.stringify(subject.json())).not.toContain('NSFW 篇');

    const series = await app.inject({
      method: 'GET',
      url: `/api/series/${encodeURIComponent(seriesKey)}`,
    });
    expect(series.statusCode).toBe(404);
    expect(series.json().error.code).toBe('series_hidden');

    const translate = await app.inject({ method: 'GET', url: '/api/translate/subjects/2' });
    expect(translate.statusCode).toBe(404);
    expect(translate.json().error.code).toBe('subject_hidden');

    const cover = await app.inject({ method: 'GET', url: '/api/covers/2' });
    expect(cover.statusCode).toBe(404);
    expect(cover.json().error.code).toBe('cover_hidden');

    // 关闭隐藏后全部恢复
    hideNsfw(false);
    const subjectAfter = await app.inject({ method: 'GET', url: '/api/subjects/2' });
    expect(subjectAfter.statusCode).toBe(200);
    expect(subjectAfter.json().nameCn).toContain('NSFW');
  });

  it('全局搜索与 Series / IP 搜索接口都不返回隐藏结果', async () => {
    seedMixedSeries();
    hideNsfw(true);

    const global = await app.inject({ method: 'GET', url: '/api/search/entities?q=NSFW' });
    expect(global.json().workTotal).toBe(0);
    expect(global.json().works).toHaveLength(0);

    const series = await app.inject({ method: 'GET', url: '/api/series/search?q=NSFW' });
    expect(series.json().total).toBe(0);

    const franchise = await app.inject({ method: 'GET', url: '/api/franchises/search?q=NSFW' });
    expect(franchise.json().total).toBe(0);
  });

  it('配置接口保存 hideNsfw 并立即可读', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { hideNsfw: true },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().hideNsfw).toBe(true);
    const loaded = await app.inject({ method: 'GET', url: '/api/config' });
    expect(loaded.json().hideNsfw).toBe(true);
    await app.inject({ method: 'PUT', url: '/api/config', payload: { hideNsfw: false } });
  });
});
