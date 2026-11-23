import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getFilterFacets, getSubjectDetail, listSubjects } from '../src/db/query.js';
import { dataVersion, one, run } from '../src/db/index.js';
import { FakeBangumiClient, resetDatabase, runSync } from './helpers.js';
import { libraryCollectionItems, librarySubjects } from './fixtures.js';

function ids(query: Parameters<typeof listSubjects>[0]): number[] {
  return listSubjects(query).items.map((item) => item.id).sort((a, b) => a - b);
}

describe('收藏库查询与筛选', () => {
  it.each(['null', '[]', '"legacy"', '{"1":-1,"2":"5","3":null,"4":1e309}'])('异常旧计数对象 %s 不进入详情展示，源证据不变', async (raw) => {
    await seed();
    const version = dataVersion();
    run('UPDATE subjects SET rating_dist=:raw, collection_stats=:raw WHERE id=1', { raw });
    const detail = getSubjectDetail(1)!;
    expect(detail.ratingDistribution).toEqual({});
    expect(detail.collectionBreakdown).toEqual({});
    expect(one('SELECT rating_dist, collection_stats FROM subjects WHERE id=1')).toEqual({ rating_dist: raw, collection_stats: raw });
    expect(dataVersion()).toBe(version);
  });

  it('旧计数对象只投影有效桶与非负整数，合法零计数保留', async () => {
    await seed();
    run('UPDATE subjects SET rating_dist=:rating, collection_stats=:collection WHERE id=1', {
      rating: '{"1":0,"10":8,"11":2,"2":-1,"3":1.5,"4":"4"}',
      collection: '{"wish":0,"collect":8,"doing":-1,"on_hold":2.5,"dropped":"3","unknown":9}',
    });
    expect(getSubjectDetail(1)!.ratingDistribution).toEqual({ '1': 0, '10': 8 });
    expect(getSubjectDetail(1)!.collectionBreakdown).toEqual({ wish: 0, collect: 8 });
  });
  beforeEach(() => {
    resetDatabase();
  });

  beforeAll(() => {
    // 保持默认超时，仅提示该文件依赖真实同步流程
  });

  async function seed(): Promise<void> {
    const client = new FakeBangumiClient({
      collections: libraryCollectionItems(),
      subjects: librarySubjects(),
    });
    const status = await runSync(client, { depth: 2 });
    if (status.lastRun?.status !== 'success') {
      throw new Error(`同步失败：${status.lastRun?.error}`);
    }
  }

  it('返回全部收藏并正确映射派生字段', async () => {
    await seed();
    const page = listSubjects({ pageSize: 50 });
    expect(page.total).toBe(10);
    const hyouka = page.items.find((item) => item.id === 2)!;
    expect(hyouka.nameCn).toBe('冰菓');
    expect(hyouka.year).toBe(2012);
    expect(hyouka.season).toBe('春');
    expect(hyouka.format).toBe('TV');
    expect(hyouka.totalEpisodes).toBe(22);
    expect(hyouka.watchedEpisodes).toBe(22);
    expect(hyouka.progress).toBe(1);
    expect(hyouka.delta).toBe(2.1);
    expect(hyouka.studios).toContain('京都动画');
    expect(hyouka.directors).toContain('武本康弘');
  });

  it.each(['{}', '[null,123,"科幻"]', 'not-json'])('历史异常数组在列表/搜索/筛选/分面中不崩溃、不产生数字标签：%s', async (invalid) => {
    await seed();
    run('UPDATE subjects SET tag_names=:invalid, studios=:invalid, directors=:invalid WHERE id=1', { invalid });
    run('UPDATE collections SET tags=:invalid WHERE subject_id=1', { invalid });
    const before = one('SELECT tag_names, studios, directors FROM subjects WHERE id=1');
    const version = dataVersion();
    expect(() => listSubjects({ q: '科幻' })).not.toThrow();
    expect(() => getFilterFacets()).not.toThrow();
    expect(listSubjects({ q: '123' }).items).toEqual([]);
    expect(listSubjects({ tags: ['123'] }).items).toEqual([]);
    const item = listSubjects({ q: '1' }).items.find((entry) => entry.id === 1)!;
    expect(item.tags.every((tag) => typeof tag === 'string')).toBe(true);
    expect(item.userTags.every((tag) => typeof tag === 'string')).toBe(true);
    if (invalid.startsWith('[')) expect(listSubjects({ tags: ['科幻'] }).items.some((entry) => entry.id === 1)).toBe(true);
    expect(one('SELECT tag_names, studios, directors FROM subjects WHERE id=1')).toEqual(before);
    expect(dataVersion()).toBe(version);
  });

  it.each(['{}', '[null,123,{"key":"导演","value":"夹具导演"}]', 'not-json'])('旧库异常 infobox 不令详情读取崩溃且保留合法证据：%s', async (infobox) => {
    await seed();
    run('UPDATE subjects SET infobox=:infobox WHERE id=1', { infobox });
    const before = one('SELECT infobox, raw FROM subjects WHERE id=1');
    const version = dataVersion();
    expect(() => getSubjectDetail(1)).not.toThrow();
    const detail = getSubjectDetail(1)!;
    expect(detail.infobox).toEqual(infobox.startsWith('[') ? [{ key: '导演', values: [{ key: null, value: '夹具导演' }] }] : []);
    expect(one('SELECT infobox, raw FROM subjects WHERE id=1')).toEqual(before);
    expect(dataVersion()).toBe(version);
  });

  it.each([
    { totalEpisodes: 0, eps: 22, expected: 22 },
    { totalEpisodes: 12, eps: 22, expected: 22 },
    { totalEpisodes: 0, eps: 0, expected: 0 },
  ])('集数映射遵循 canonical 优先级：%j', async ({ totalEpisodes, eps, expected }) => {
    await seed();
    run('UPDATE subjects SET total_episodes = :episodes, eps = :eps WHERE id = 2', { episodes: totalEpisodes, eps });
    const subject = listSubjects({ q: '冰菓' }).items[0]!;
    expect(subject.totalEpisodes).toBe(expected);
    expect(subject.watchedEpisodes).toBe(expected);
    expect(subject.progress).toBe(1);
  });

  it('按收藏状态筛选', async () => {
    await seed();
    expect(ids({ status: [2] })).toEqual([1, 2, 3, 8, 9]);
    expect(ids({ status: [3] })).toEqual([4, 5]);
    expect(ids({ status: [1] })).toEqual([10]);
    expect(ids({ status: [4] })).toEqual([6]);
    expect(ids({ status: [5] })).toEqual([7]);
  });

  it('按年份区间筛选', async () => {
    await seed();
    expect(ids({ yearFrom: 2015, yearTo: 2018 })).toEqual([1, 3, 6]);
  });

  it('按我的评分与 Bangumi 评分筛选', async () => {
    await seed();
    expect(ids({ rateMin: 8 })).toEqual([1, 2, 3, 6, 8]);
    expect(ids({ rateMax: 6 })).toEqual([7, 9]);
    expect(ids({ bgmScoreMin: 8.3 })).toEqual([6, 8, 10]);
  });

  it('支持组合条件：2015-2020 + TV + 看过 + 评分≥8', async () => {
    await seed();
    expect(
      ids({
        yearFrom: 2015,
        yearTo: 2020,
        format: ['TV'],
        status: [2],
        rateMin: 8,
      }),
    ).toEqual([3]);
  });

  it('按放送形态 / 季度 / 标签 / 制作公司 / 导演筛选', async () => {
    await seed();
    expect(ids({ format: ['Movie'] })).toEqual([1]);
    expect(ids({ format: ['ONA'] })).toEqual([10]);
    expect(ids({ format: ['OVA'] })).toEqual([9]);
    expect(ids({ season: ['秋'] })).toEqual([8]);
    expect(ids({ season: ['春'] })).toEqual([2, 3, 4, 5, 9]);
    expect(ids({ tags: ['科幻'] })).toEqual([4, 7, 9, 10]);
    expect(ids({ tags: ['科幻', '音乐'], tagMode: 'all' })).toEqual([4]);
    expect(ids({ studios: ['京都动画'] })).toEqual([2, 3]);
    expect(ids({ directors: ['新海诚'] })).toEqual([1]);
  });

  it('按观看进度筛选', async () => {
    await seed();
    expect(ids({ progress: 'in-progress' })).toEqual([4, 5]);
    expect(ids({ progress: 'completed' })).toEqual([1, 2, 3, 8, 9]);
    expect(ids({ progress: 'unfinished' })).toEqual([4, 5, 6, 7]);
    expect(ids({ progress: 'not-started' })).toEqual([10]);
  });

  it('按是否评分与评分偏差筛选', async () => {
    await seed();
    expect(ids({ rated: 'unrated' })).toEqual([5, 10]);
    expect(ids({ rated: 'rated' })).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
    expect(ids({ bias: 'over' })).toEqual([1, 2, 3, 8]);
    expect(ids({ bias: 'under' })).toEqual([4, 6, 7, 9]);
  });

  it('支持中文名、原名、罗马字别名与 ID 搜索', async () => {
    await seed();
    expect(ids({ q: '冰菓' })).toEqual([2]);
    expect(ids({ q: 'Hyouka' })).toEqual([2]);
    expect(ids({ q: 'English Alias' })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 全局搜索：标签名同样可以被主搜索栏搜到（以前这里返回空）
    expect(ids({ q: '科幻' })).toEqual([4, 7, 9, 10]);
    expect(ids({ q: '5' })).toEqual([5]);
  });

  it('支持排序与稳定的分页', async () => {
    await seed();
    const byRate = listSubjects({ sort: 'rate', order: 'desc', pageSize: 50 }).items.map((i) => i.id);
    expect(byRate[0]).toBe(2); // 10 分

    const byYear = listSubjects({ sort: 'year', order: 'asc', pageSize: 50 }).items.map((i) => i.id);
    expect(byYear[0]).toBe(9); // 2000 年

    const firstPage = listSubjects({ pageSize: 4, page: 1, sort: 'updated' });
    const secondPage = listSubjects({ pageSize: 4, page: 2, sort: 'updated' });
    const thirdPage = listSubjects({ pageSize: 4, page: 3, sort: 'updated' });
    const allIds = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map((i) => i.id);
    expect(new Set(allIds).size).toBe(10);
    expect(firstPage.pageCount).toBe(3);
  });

  it('超出范围的页码会被收敛到最后一页', async () => {
    await seed();
    const page = listSubjects({ pageSize: 4, page: 99 });
    expect(page.page).toBe(3);
    expect(page.items.length).toBe(2);
  });

  it('提供筛选面板所需的聚合数据', async () => {
    await seed();
    const facets = getFilterFacets();
    expect(facets.total).toBe(10);
    expect(facets.years.map((y) => y.value)).toContain(2015);
    expect(facets.formats.find((f) => f.value === 'TV')?.count).toBe(7);
    expect(facets.tags.find((t) => t.value === '科幻')?.count).toBe(4);
    expect(facets.studios.find((s) => s.value === '京都动画')?.count).toBe(2);
    expect(facets.directors.find((d) => d.value === '新海诚')?.count).toBe(1);
    expect(facets.statuses.find((s) => s.value === 2)?.count).toBe(5);
    expect(facets.ratedCount).toBe(8);
    expect(facets.formats.find((f) => f.value === 'Movie')?.count).toBe(1);
  });
});
