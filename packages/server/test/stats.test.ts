import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { run } from '../src/db/index.js';
import { listSeries } from '../src/db/query.js';
import { recomputeSeries } from '../src/db/series.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import {
  directors,
  distributions,
  habits,
  highRatedTagShare,
  overview,
  ratingBias,
  studios,
  timeline,
} from '../src/stats/queries.js';
import { FakeBangumiClient, resetDatabase, runSync } from './helpers.js';
import { libraryCollectionItems, librarySubjects } from './fixtures.js';

async function seed(): Promise<void> {
  const client = new FakeBangumiClient({
    collections: libraryCollectionItems(),
    subjects: librarySubjects(),
  });
  await runSync(client, { depth: 2 });
}

describe('统计与分析', () => {
  beforeEach(() => {
    resetDatabase();
  });

  it('首页概览数字与数据一致', async () => {
    await seed();
    const stats = overview();
    expect(stats.total).toBe(10);
    expect(stats.statusCounts['2']).toBe(5);
    expect(stats.statusCounts['1']).toBe(1);
    expect(stats.statusCounts['3']).toBe(2);
    expect(stats.statusCounts['4']).toBe(1);
    expect(stats.statusCounts['5']).toBe(1);
    expect(stats.ratedCount).toBe(8);
    expect(stats.unratedCount).toBe(2);
    expect(stats.completionRate).toBe(0.5);
    expect(stats.averageRate).toBeCloseTo(7.75, 2);
    expect(stats.highRatedCount).toBe(5);
    // 未完成 = 收藏总量 − 看过（想看 1 + 在看 2 + 搁置 1 + 抛弃 1），不是「搁置」数量
    expect(stats.unfinishedCount).toBe(5);
    expect(stats.yearRange.min).toBe(2000);
    expect(stats.yearRange.max).toBe(2022);
    expect(stats.detailCoverage.ratio).toBe(1);
    expect(stats.relationsCoverage.ratio).toBe(1);
    expect(stats.watchedEpisodes).toBeGreaterThan(0);
    expect(stats.estimatedMinutes).toBeGreaterThan(0);
  });

  it('旧元数据数组内重复项不重复计算作品、评分样本、占比或画像熵；不改写源记录', async () => {
    await seed();
    saveConfig({ hideNsfw: false });
    const { all, dataVersion } = await import('../src/db/index.js');
    const { invalidateStatsCache } = await import('../src/stats/cache.js');
    const { generatedAt: _beforeTime, ...beforeProfile } = buildProfileDataset('real');
    const beforeStats = [studios(), directors(), distributions(), highRatedTagShare()];
    const columns = ['tag_names', 'studios', 'directors', 'originals', 'meta_tags'];
    for (const row of all<Record<string, string | number>>('SELECT id,tag_names,studios,directors,originals,meta_tags FROM subjects')) {
      for (const column of columns) {
        const values = JSON.parse(String(row[column]));
        run(`UPDATE subjects SET ${column}=:value WHERE id=:id`, { value: JSON.stringify([...values, ...values, ...values]), id: Number(row.id) });
      }
    }
    invalidateStatsCache();
    const source = all('SELECT * FROM subjects ORDER BY id');
    const version = dataVersion();
    const { generatedAt: _afterTime, ...afterProfile } = buildProfileDataset('real');
    expect(afterProfile).toEqual(beforeProfile);
    expect([studios(), directors(), distributions(), highRatedTagShare()]).toEqual(beforeStats);
    expect(all('SELECT * FROM subjects ORDER BY id')).toEqual(source);
    expect(dataVersion()).toBe(version);
  });

  it.each([JSON.stringify([123, null, 'valid fixture studio']), JSON.stringify({ broken: 1 }), 'not-json'])('旧库异常 JSON 元数据不应令画像崩溃，且只读构建不改源数据：%s', async (invalid) => {
    await seed();
    run('UPDATE subjects SET studios=:invalid, directors=:invalid, originals=:invalid, tag_names=:invalid, meta_tags=:invalid WHERE id=1', { invalid });
    const { one, dataVersion } = await import('../src/db/index.js');
    const version = dataVersion();
    const before = one('SELECT * FROM subjects WHERE id=1');
    expect(() => buildProfileDataset()).not.toThrow();
    const profile = buildProfileDataset();
    expect(profile.studios.every((entry) => typeof entry.name === 'string')).toBe(true);
    for (const read of [studios, directors, distributions, habits, highRatedTagShare]) {
      expect(() => read()).not.toThrow();
    }
    expect(studios().items.every((entry) => typeof entry.name === 'string')).toBe(true);
    expect(directors().items.every((entry) => typeof entry.name === 'string')).toBe(true);
    if (Array.isArray(JSON.parse(invalid === 'not-json' ? 'null' : invalid))) {
      expect(profile.studios.some((entry) => entry.name === 'valid fixture studio')).toBe(true);
      expect(studios().items.some((entry) => entry.name === 'valid fixture studio')).toBe(true);
    }
    expect(one('SELECT * FROM subjects WHERE id=1')).toEqual(before);
    expect(dataVersion()).toBe(version);
  });

  it('画像已看集数继承 canonical：未知集数不贡献，想看不贡献，已知进度封顶', async () => {
    await seed();
    run('UPDATE subjects SET total_episodes=0, eps=0');
    run('UPDATE collections SET type=3, ep_status=7');
    run('UPDATE subjects SET total_episodes=12 WHERE id IN (1,2)');
    run('UPDATE collections SET type=1 WHERE subject_id=1');
    run('UPDATE collections SET ep_status=99 WHERE subject_id=2');
    const { recordMutation } = await import('../src/db/mutation.js');
    recordMutation('import', 'isolated episode boundary fixture');
    expect(overview().watchedEpisodes).toBe(12);
    expect(buildProfileDataset().basics.watchedEpisodes).toBe(12);
  });

  describe('完成率与集数进度的语义边界（v1.4.2.1）', () => {
    it('完成率 = 看过 / 收藏总量，且与非看过的数量互补', async () => {
      await seed();
      const stats = overview();
      const done = stats.statusCounts['2'] ?? 0;
      expect(stats.total).toBe(10);
      expect(done).toBe(5);
      expect(stats.completionRate).toBeCloseTo(done / stats.total, 4);
      // 未完成 = 全部非「看过」，不能被「搁置」之类的单一状态代指
      expect(stats.unfinishedCount).toBe(stats.total - done);
      expect(stats.unfinishedCount).not.toBe(stats.statusCounts['4']);
    });

    it('五种收藏状态之和 = 收藏总量', async () => {
      await seed();
      const stats = overview();
      const sum = ['1', '2', '3', '4', '5'].reduce(
        (total, key) => total + (stats.statusCounts[key] ?? 0),
        0,
      );
      expect(sum).toBe(stats.total);
    });

    it('集数进度是独立口径，不影响完成率', async () => {
      await seed();
      const before = overview();
      // 把「在看」条目的观看集数清零：集数进度会变，完成率不能变
      const { run, bumpDataVersion } = await import('../src/db/index.js');
      const { invalidateStatsCache } = await import('../src/stats/cache.js');
      run(`UPDATE collections SET ep_status = 0 WHERE type = 3`);
      // 统计层按「数据版本号」缓存，测试里需要显式失效
      bumpDataVersion();
      invalidateStatsCache();
      const after = overview();

      expect(after.completionRate).toBe(before.completionRate);
      expect(after.unfinishedCount).toBe(before.unfinishedCount);
      expect(after.statusCounts['3']).toBe(before.statusCounts['3']);
      expect(after.watchedEpisodes).toBeLessThan(before.watchedEpisodes);
      expect(after.progressRatio).toBeLessThan(before.progressRatio);
    });

    it('集数进度只统计集数已知的条目，且不含「想看」', async () => {
      await seed();
      const stats = overview();
      // 想看条目不应出现在集数分母里
      const { one } = await import('../src/db/index.js');
      const wish = one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM collections c JOIN subjects s ON s.id = c.subject_id
          WHERE c.type = 1 AND COALESCE(NULLIF(s.total_episodes, 0), s.eps, 0) > 0`,
      );
      expect(Number(wish?.count ?? 0)).toBeGreaterThan(0);
      const countedAll = one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM collections c JOIN subjects s ON s.id = c.subject_id
          WHERE c.type IN (2,3,4,5) AND COALESCE(NULLIF(s.total_episodes, 0), s.eps, 0) > 0`,
      );
      expect(stats.progressCountedSubjects).toBe(Number(countedAll?.count ?? 0));
      expect(stats.progressCountedSubjects).toBeLessThan(stats.total);
    });
  });

  it('分布统计覆盖状态 / 评分 / 年份 / 类型 / 标签', async () => {
    await seed();
    const dist = distributions();
    expect(dist.status.map((item) => item.label)).toContain('看过');
    expect(dist.rate.reduce((sum, item) => sum + item.count, 0)).toBe(10);
    expect(dist.year.map((item) => item.key)).toEqual(
      expect.arrayContaining(['2000', '2012', '2015', '2022']),
    );
    expect(dist.format.find((item) => item.key === 'TV')?.count).toBe(7);
    expect(dist.tag[0]?.count).toBeGreaterThanOrEqual(1);
    expect(dist.original.find((item) => item.key === '漫画改')?.count).toBeGreaterThan(0);
  });

  it('标记高分作品在各类别中的占比', async () => {
    await seed();
    const dist = distributions();
    const tv = dist.format.find((item) => item.key === 'TV')!;
    expect(tv.highRatedShare).not.toBeNull();
    expect(tv.highRatedShare!).toBeGreaterThan(0);
  });

  it('时间线按年 / 季度 / 月聚合，并补齐空档', async () => {
    await seed();
    const yearly = timeline('year');
    expect(yearly.points.map((point) => point.period)).toEqual([
      '2023',
      '2024',
      '2025',
      '2026',
    ]);
    expect(yearly.points.at(-1)?.total).toBe(10);
    expect(yearly.note).toContain('最后更新时间');

    const quarterly = timeline('quarter');
    expect(quarterly.points.some((point) => point.period.includes('Q'))).toBe(true);
    const monthly = timeline('month');
    expect(monthly.points[0]?.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('评分偏差区分「我更喜欢」和「我更不喜欢」', async () => {
    await seed();
    const bias = ratingBias(5);
    expect(bias.count).toBe(8);
    expect(bias.scatter).toHaveLength(8);
    expect(bias.over[0]?.delta).toBeGreaterThan(0);
    expect(bias.under.at(-1)?.delta).toBeLessThan(0);
    // 冰菓：我的 10 分 vs 大众 7.9 分
    expect(bias.over.some((item) => item.id === 2)).toBe(true);
  });

  it('制作公司与导演统计包含平均评分与高分比例', async () => {
    await seed();
    const studioStats = studios(20);
    const kyoto = studioStats.items.find((item) => item.name === '京都动画')!;
    expect(kyoto.total).toBe(2);
    expect(kyoto.averageRate).toBe(9);
    expect(kyoto.highRatedShare).toBe(1);

    const directorStats = directors(20);
    expect(directorStats.items.map((item) => item.name)).toContain('新海诚');
  });

  it('观看习惯包含季度热力图与年份平均', async () => {
    await seed();
    const stats = habits();
    expect(stats.heatmap.length).toBeGreaterThan(0);
    expect(stats.activeYears).toBe(4);
    expect(stats.busiestYear?.count).toBeGreaterThan(0);
    expect(stats.weekdayDistribution.reduce((sum, day) => sum + day.count, 0)).toBe(10);
    expect(stats.averagePerYear).toBeCloseTo(2.5, 1);
  });

  it('画像明确区分数据结论与推测', async () => {
    await seed();
    const dataset = buildProfileDataset();
    expect(dataset.sample.total).toBe(10);
    expect(dataset.sample.rated).toBe(8);
    expect(dataset.claims.length).toBeGreaterThan(3);
    // 每条结论都必须带证据与置信度，并且明确区分数据结论 / 推测
    for (const claim of dataset.claims) {
      expect(claim.statement.length).toBeGreaterThan(0);
      expect(['data', 'inference']).toContain(claim.kind);
      expect(['high', 'medium', 'low']).toContain(claim.confidence);
      expect(Array.isArray(claim.evidence)).toBe(true);
    }
    expect(dataset.claims.some((claim) => claim.kind === 'data')).toBe(true);
    expect(dataset.claims.some((claim) => claim.id === 'breadth')).toBe(true);
    // 数据不足时必须显式标注，而不是编造结论
    const insufficient = dataset.claims.filter((claim) => claim.insufficient);
    expect(insufficient.every((claim) => claim.confidence === 'low')).toBe(true);
  });

  it('统计结果按数据版本缓存，数据变化后自动刷新', async () => {
    await seed();
    const first = overview();
    expect(first.total).toBe(10);
    // 再次调用命中缓存（对象相同）
    expect(overview()).toBe(first);

    const smaller = new FakeBangumiClient({
      collections: libraryCollectionItems().slice(0, 3),
    });
    await runSync(smaller);
    expect(overview().total).toBe(3);
  });
});

/* ------------------------------------------------------------------ v1.8 P0-A */

const VIS_TS = '2024-01-01T02:00:00+08:00';

/**
 * 口径夹具：Series A = {1,2}（8 / 6）· 独立 3（10）· NSFW 独立 4（2）。
 * hideNsfw 关闭（Real）：4 部 / 平均 6.5 / meanDelta -1；
 * hideNsfw 开启（Visible）：3 部 / 平均 8 / meanDelta 0.5。
 */
function seedVisibilityFixture(): void {
  const rows = [
    { id: 1, rate: 8, nsfw: 0, year: 2010 },
    { id: 2, rate: 6, nsfw: 0, year: 2012 },
    { id: 3, rate: 10, nsfw: 0, year: 2014 },
    { id: 4, rate: 2, nsfw: 1, year: 2016 },
  ];
  for (const row of rows) {
    run(
      `INSERT INTO subjects (id, name, name_cn, aliases, year, format, season, score, total_episodes, eps,
         nsfw, tag_names, studios, directors, originals, detail_state, created_at, updated_at)
       VALUES (:id, :name, :name, '[]', :year, 'TV', 'spring', 7.5, 12, 12,
         :nsfw, '["科幻"]', '["Studio"]', '["Dir"]', '["漫画"]', 'ok', :ts, :ts)`,
      { id: row.id, name: `口径测试 ${row.id}`, year: row.year, nsfw: row.nsfw, ts: VIS_TS },
    );
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, ep_status, updated_at, first_seen_at, synced_at)
       VALUES (:id, 2, 2, :rate, 12, :ts, :ts, :ts)`,
      { id: row.id, rate: row.rate, ts: VIS_TS },
    );
  }
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (1, 2, '续集', 2, '', '', :ts)`,
    { ts: VIS_TS },
  );
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (2, 1, '前传', 2, '', '', :ts)`,
    { ts: VIS_TS },
  );
  recomputeSeries();
}

describe('v1.8 可见性口径：Real = canonical / Visible = 默认投影', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    seedVisibilityFixture();
  });

  afterEach(() => {
    saveConfig({ hideNsfw: false });
  });

  it('hideNsfw 关闭 = Real：全量收藏进入统计', () => {
    const stats = overview();
    expect(stats.total).toBe(4);
    expect(stats.ratedCount).toBe(4);
    expect(stats.averageRate).toBeCloseTo(6.5, 2);
    expect(stats.meanDelta).toBeCloseTo(-1, 2);
    expect(stats.detailCoverage).toEqual({ synced: 4, total: 4, ratio: 1 });
  });

  it('hideNsfw 开启 = Visible：Statistics 全页同一口径', () => {
    saveConfig({ hideNsfw: true });
    const stats = overview();
    expect(stats.total).toBe(3);
    expect(stats.ratedCount).toBe(3);
    expect(stats.averageRate).toBeCloseTo(8, 2);
    expect(stats.meanDelta).toBeCloseTo(0.5, 2);
    expect(stats.detailCoverage).toEqual({ synced: 3, total: 3, ratio: 1 });

    const dist = distributions();
    expect(dist.status.reduce((sum, item) => sum + item.count, 0)).toBe(stats.total);
    expect(dist.rate.reduce((sum, item) => sum + item.count, 0)).toBe(stats.total);
    expect(dist.year.reduce((sum, item) => sum + item.count, 0)).toBe(stats.total);
    expect(dist.tag.reduce((sum, item) => sum + item.count, 0)).toBe(stats.total);

    const tl = timeline('year');
    expect(tl.points.reduce((sum, point) => sum + point.added, 0)).toBe(stats.total);

    const habit = habits();
    expect(habit.heatmap.reduce((sum, entry) => sum + entry.count, 0)).toBe(stats.total);

    // 与 overview 同源：样本量一致、meanDelta 相等、scatter 不含隐藏条目
    const bias = ratingBias(10);
    expect(bias.count).toBe(stats.ratedCount);
    expect(bias.meanDelta).toBeCloseTo(stats.meanDelta ?? 0, 2);
    expect(bias.scatter.some((item) => item.id === 4)).toBe(false);

    expect(studios(20).items.reduce((sum, item) => sum + item.total, 0)).toBe(stats.total);
    expect(directors(20).items.reduce((sum, item) => sum + item.total, 0)).toBe(stats.total);
  });

  it('缓存按口径隔离：切换 hideNsfw 不跨口径复用', () => {
    const real = overview();
    expect(real.total).toBe(4);

    saveConfig({ hideNsfw: true });
    const visible = overview();
    expect(visible.total).toBe(3);
    expect(visible).not.toBe(real);

    // 切回后命中 Real 缓存（对象同一），再切回命中 Visible 缓存
    saveConfig({ hideNsfw: false });
    expect(overview()).toBe(real);
    saveConfig({ hideNsfw: true });
    expect(overview()).toBe(visible);
  });

  it('Profile 全页同口径：样本、维度、series 都使用可见集合', () => {
    saveConfig({ hideNsfw: true });
    const dataset = buildProfileDataset();

    expect(dataset.sample.total).toBe(3);
    expect(dataset.sample.rated).toBe(3);
    expect(dataset.sample.yearFrom).toBe(2010);
    expect(dataset.sample.yearTo).toBe(2014);
    expect(dataset.basics.averageRate).toBeCloseTo(8, 2);
    expect(dataset.basics.meanDelta).toBeCloseTo(0.5, 2);

    expect(dataset.tags.reduce((sum, item) => sum + item.count, 0)).toBe(3);
    expect(dataset.formats.reduce((sum, item) => sum + item.count, 0)).toBe(3);
    expect(dataset.tags[0]?.share).toBeCloseTo(1, 4);
    expect(dataset.formats[0]?.share).toBeCloseTo(1, 4);
    expect(dataset.studios[0]?.count).toBe(3);
    expect(dataset.directors[0]?.count).toBe(3);
    expect(dataset.originals[0]?.count).toBe(3);

    expect(dataset.series.groupedWorks).toBe(2);
    expect(dataset.series.standaloneWorks).toBe(1);
    expect(dataset.series.groupCount).toBe(1);
    expect(dataset.series.averageGroupSize).toBe(2);
  });

  it('Entity 聚合与全局统计在同一口径下可对齐', () => {
    expect(
      listSeries({ includeSingletons: true }).reduce((sum, entry) => sum + entry.collectedCount, 0),
    ).toBe(overview().total);

    saveConfig({ hideNsfw: true });
    expect(
      listSeries({ includeSingletons: true }).reduce((sum, entry) => sum + entry.collectedCount, 0),
    ).toBe(overview().total);
  });
});

/* ------------------------------------------------------------------ v1.8 P0-C */

describe('P0-C 时间语义：first_seen_at = 本地首次入库', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
  });

  it('UTC 与 +08:00 表示同一时刻；分桶使用 updated_at 的本地字符串年份', () => {
    const utc = '2023-12-31T18:00:00.000Z';
    const local = '2024-01-01T02:00:00+08:00';
    expect(new Date(utc).getTime()).toBe(new Date(local).getTime());

    run(
      `INSERT INTO subjects (id, name, nsfw, detail_state, created_at, updated_at)
       VALUES (1, '时间语义', 0, 'ok', :ts, :ts)`,
      { ts: utc },
    );
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, ep_status, updated_at, first_seen_at, synced_at)
       VALUES (1, 2, 2, 0, 0, :local, :utc, :utc)`,
      { local, utc },
    );

    const tl = timeline('year');
    expect(tl.basis).toBe('collection-updated-at');
    // 按 updated_at 的本地（+08:00）年份分桶 → 2024；first_seen_at（UTC）不是分桶依据
    expect(tl.points.map((point) => point.period)).toEqual(['2024']);
    expect(tl.note).toContain('最后更新时间');
    expect(tl.note).toContain('不是严格的收藏时间');

    expect(habits().heatmap).toEqual([{ year: 2024, quarter: 1, count: 1 }]);
  });
});
