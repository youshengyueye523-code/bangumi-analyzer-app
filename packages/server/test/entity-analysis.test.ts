/**
 * v1.8 Phase 2+3：Entity Analysis B–E 层指标（Registry 冻结语义）。
 *
 * 覆盖：coverage / completion / status structure / rating profile /
 * air span & distribution / consumption & estimate、
 * visibility（Real / Visible）、hidden 上下文、relation-only、null / zero、
 * provisional 不影响 metric identity。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { one, run } from '../src/db/index.js';
import { getFranchiseDetail, getSeriesDetail, listFranchises } from '../src/db/query.js';
import { recomputeSeries } from '../src/db/series.js';
import { resetDatabase } from './helpers.js';

const TS = '2026-01-01T00:00:00.000Z';

function hideNsfw(value: boolean): void {
  saveConfig({ hideNsfw: value });
}

interface SubjectSeed {
  id: number;
  rate?: number;
  type?: number;
  score?: number | null;
  year?: number | null;
  format?: string;
  episodes?: number;
  epStatus?: number;
  nsfw?: boolean;
  collected?: boolean;
  local?: boolean;
}

function seedSubject(seed: SubjectSeed): void {
  const {
    id,
    rate = 0,
    type = 2,
    score = 7.5,
    year = 2010,
    format = 'TV',
    episodes = 12,
    epStatus = 0,
    nsfw = false,
    collected = true,
    local = true,
  } = seed;
  if (local) {
    run(
      `INSERT INTO subjects (id, name, name_cn, aliases, year, format, season, score, total_episodes, eps,
         nsfw, tag_names, studios, directors, originals, detail_state, created_at, updated_at)
       VALUES (:id, :name, :name, '[]', :year, :format, 'spring', :score, :episodes, :episodes,
         :nsfw, '[]', '[]', '[]', '[]', 'ok', :ts, :ts)`,
      {
        id,
        name: `分析夹具 ${id}`,
        year,
        format,
        score,
        episodes,
        nsfw: nsfw ? 1 : 0,
        ts: TS,
      },
    );
  }
  if (collected) {
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, ep_status, updated_at, first_seen_at, synced_at)
       VALUES (:id, 2, :type, :rate, :epStatus, :ts, :ts, :ts)`,
      { id, type, rate, epStatus, ts: TS },
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

function seriesKeyOfMember(subjectId: number): string {
  const row = one<{ key: string }>(
    `SELECT e.key FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
     WHERE m.subject_id = :id AND m.role = 'primary' AND e.state <> 'stale' LIMIT 1`,
    { id: subjectId },
  );
  if (!row) throw new Error(`缺少 ${subjectId} 的 Series`);
  return row.key;
}

/**
 * Series 夹具（5 个 primary 成员）：
 * 1 看过 8 / 2010 TV 12 集 · 2 想看 未评分 / 2012 TV · 3 搁置 6 / 2014 Movie 1 集 ·
 * 4 本地未收藏 / 2016 OVA · 5 relation-only。
 */
function seedSeriesFixture(): string {
  seedSubject({ id: 1, rate: 8, type: 2, score: 7.5, year: 2010, format: 'TV', episodes: 12, epStatus: 12 });
  seedSubject({ id: 2, rate: 0, type: 1, score: 8, year: 2012, format: 'TV', episodes: 12, epStatus: 0 });
  seedSubject({ id: 3, rate: 6, type: 4, score: 8.5, year: 2014, format: 'Movie', episodes: 1, epStatus: 0 });
  seedSubject({ id: 4, collected: false, year: 2016, format: 'OVA', episodes: 2 });
  // subject 5 没有本地 subjects 行：只有关系数据
  seedRelation(1, 2, '续集');
  seedRelation(2, 1, '前传');
  seedRelation(2, 3, '续集');
  seedRelation(3, 2, '前传');
  seedRelation(3, 4, '续集');
  seedRelation(4, 3, '前传');
  seedRelation(4, 5, '续集');
  recomputeSeries();
  return seriesKeyOfMember(1);
}

/**
 * Franchise 夹具：A = {1,2}（8 / 6）· B = {3}（2）· C = {4,5}（10 / 4，4 是 NSFW）。
 * Visible：C 整体隐藏 → 3 个成员；Real：5 个成员。
 */
function seedFranchiseFixture(): string {
  seedSubject({ id: 1, rate: 8, type: 2, score: 7.5, year: 2010 });
  seedSubject({ id: 2, rate: 6, type: 2, score: 8.5, year: 2012 });
  seedSubject({ id: 3, rate: 2, type: 1, score: 7, year: 2014 });
  seedSubject({ id: 4, rate: 10, type: 2, score: 7, year: 2016, nsfw: true });
  seedSubject({ id: 5, rate: 4, type: 3, score: 7, year: 2018 });
  seedRelation(1, 2, '续集');
  seedRelation(2, 1, '前传');
  seedRelation(1, 3, '不同演绎');
  seedRelation(3, 1, '不同演绎');
  seedRelation(1, 4, '不同演绎');
  seedRelation(4, 1, '不同演绎');
  seedRelation(4, 5, '续集');
  seedRelation(5, 4, '前传');
  recomputeSeries();
  const franchise = listFranchises()[0];
  if (!franchise) throw new Error('fixture 未生成 Franchise');
  return franchise.key;
}

describe('Entity Analysis：Series B–E 层语义', () => {
  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
  });

  it('Coverage / Completion / Status / Rating / Air / Consumption 使用冻结公式', () => {
    const seriesKey = seedSeriesFixture();
    const detail = getSeriesDetail(seriesKey)!;
    const analysis = detail.analysis;

    // Coverage：collected 3 / known 5（含 1 个 relation-only）
    expect(analysis.coverage).toEqual({
      value: 0.6,
      knownMembers: 5,
      localCollected: 3,
      relationOnly: 1,
    });
    // Completion：看过 1 / 收藏 3（member-level，不是集数）
    expect(analysis.completion).toEqual({ value: 0.3333, watched: 1, collectedCount: 3 });
    // Status structure：想看 1 · 看过 1 · 在看 0 · 搁置 1 · 抛弃 0
    expect(analysis.statusStructure).toEqual({
      counts: { '1': 1, '2': 1, '3': 0, '4': 1, '5': 0 },
      collectedCount: 3,
      available: true,
    });
    // Rating Profile：平均 (8+6)/2 = 7 · 覆盖 2/3 · delta = mean(0.5, -2.5) = -1
    expect(analysis.rating.average).toEqual({ value: 7, ratedCount: 2 });
    expect(analysis.rating.coverage).toEqual({ value: 0.6667, ratedCount: 2, collectedCount: 3 });
    expect(analysis.rating.delta).toEqual({ value: -1, pairedCount: 2 });
    // Air：作品事实（2010–2016，4 个有年份成员 / 5）
    expect(analysis.air.span).toEqual({ firstYear: 2010, lastYear: 2016, datedMembers: 4, totalMembers: 5 });
    expect(analysis.air.distribution.years).toEqual([
      { year: 2010, count: 1 },
      { year: 2012, count: 1 },
      { year: 2014, count: 1 },
      { year: 2016, count: 1 },
    ]);
    expect(analysis.air.distribution.datedMembers).toBe(4);
    // Consumption：看过 1 部 · 12 集（type2=12 + type4 的 0）· 估算 12×24 分钟
    expect(analysis.consumption.watchedMembers).toBe(1);
    expect(analysis.consumption.watchedEpisodes).toBe(12);
    expect(analysis.consumption.estimatedWatchTime).toEqual({
      minutes: 288,
      isEstimate: true,
      contributingMembers: 2,
      excludedNoEpisodeData: 0,
    });
    expect(analysis.hidden).toEqual({ series: 0, members: 0 });
  });

  it('candidate 成员永不进入任何指标', () => {
    const seriesKey = seedSeriesFixture();
    const before = getSeriesDetail(seriesKey)!.analysis;

    seedSubject({ id: 99, rate: 10, type: 2, score: 1, year: 2001 });
    const row = one<{ id: number }>('SELECT id FROM series_entities WHERE key = :key', { key: seriesKey });
    run(
      `INSERT INTO series_entity_members (series_id, subject_id, role, state, position)
       VALUES (:id, 99, 'candidate', 'probable', 99)`,
      { id: row!.id },
    );

    expect(getSeriesDetail(seriesKey)!.analysis).toEqual(before);
  });

  it('无收藏成员：coverage 是真 0，completion / rating / 时长样本是 null', () => {
    /*
     * 该状态当前不会由 engine 产生（每个 Series 至少 1 个收藏成员），
     * Registry 要求实现显式处理 → 直接构造实体验证防御性 null 分支。
     */
    seedSubject({ id: 1, collected: false, year: 2000 });
    seedSubject({ id: 2, collected: false, year: 2002 });
    run(
      `INSERT INTO series_entities (key, title, member_count, collected_count, created_at, updated_at)
       VALUES ('sr_test_zero', '零收藏夹具', 2, 0, :ts, :ts)`,
      { ts: TS },
    );
    const seriesId = Number(
      one<{ id: number }>(`SELECT id FROM series_entities WHERE key = 'sr_test_zero'`)!.id,
    );
    run(
      `INSERT INTO series_entity_members (series_id, subject_id, role, state, position)
       VALUES (:id, 1, 'primary', 'confirmed', 0), (:id, 2, 'primary', 'confirmed', 1)`,
      { id: seriesId },
    );

    const analysis = getSeriesDetail('sr_test_zero')!.analysis;
    expect(analysis.coverage.value).toBe(0);
    expect(analysis.completion).toEqual({ value: null, watched: 0, collectedCount: 0 });
    expect(analysis.statusStructure.available).toBe(false);
    expect(analysis.rating.average.value).toBeNull();
    expect(analysis.rating.coverage.value).toBeNull();
    expect(analysis.rating.delta.value).toBeNull();
    expect(analysis.consumption.estimatedWatchTime.minutes).toBeNull();
  });

  it('provisional 标题不影响 metric identity', () => {
    const seriesKey = seedSeriesFixture();
    const before = getSeriesDetail(seriesKey)!.analysis;
    run(`UPDATE series_entities SET title_state = 'provisional' WHERE key = :key`, { key: seriesKey });
    const after = getSeriesDetail(seriesKey)!;
    expect(after.titleState).toBe('provisional');
    expect(after.analysis).toEqual(before);
  });

  it('hideNsfw 隐藏整个 Series 时 detail 返回 null（HiddenState 语义，不输出 0 / null）', () => {
    seedSubject({ id: 1, rate: 8 });
    seedSubject({ id: 2, rate: 10, nsfw: true });
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();
    const seriesKey = seriesKeyOfMember(1);

    hideNsfw(true);
    expect(getSeriesDetail(seriesKey)).toBeNull();
    // 显式请求 Real 也不改变「整体隐藏 → HiddenState」的既定 IA
    expect(getSeriesDetail(seriesKey, { visibility: 'real' })).toBeNull();
  });
});

describe('Entity Analysis：Franchise 跨 Series 聚合', () => {
  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
  });

  it('Real / Visible 各口径整页一致，且 hidden 上下文描述 hideNsfw 的隐藏范围', () => {
    const key = seedFranchiseFixture();

    const real = getFranchiseDetail(key, { visibility: 'real' })!;
    expect(real.analysis.visibility).toBe('real');
    expect(real.analysis.coverage).toEqual({
      value: 1,
      knownMembers: 5,
      localCollected: 5,
      relationOnly: 0,
    });
    expect(real.analysis.rating.average).toEqual({ value: 6, ratedCount: 5 });
    expect(real.analysis.hidden).toEqual({ series: 1, members: 2 });
    // analysis 与 canonical franchise 平均分同源
    expect(real.averageRate).toBe(6);
    expect(real.analysis.rating.average.value).toBe(real.averageRate);

    const visible = getFranchiseDetail(key, { visibility: 'visible' })!;
    expect(visible.analysis.visibility).toBe('visible');
    expect(visible.analysis.coverage).toEqual({
      value: 1,
      knownMembers: 3,
      localCollected: 3,
      relationOnly: 0,
    });
    expect(visible.analysis.rating.average).toEqual({ value: 5.33, ratedCount: 3 });
    expect(visible.analysis.consumption.watchedMembers).toBe(2);
    expect(visible.analysis.hidden).toEqual({ series: 1, members: 2 });
    expect(visible.averageRate).toBe(5.33);
    expect(visible.analysis.rating.average.value).toBe(visible.averageRate);
  });

  it('默认口径跟随 hideNsfw：关闭 = real，开启 = visible', () => {
    const key = seedFranchiseFixture();
    expect(getFranchiseDetail(key)!.analysis.visibility).toBe('real');

    hideNsfw(true);
    const visible = getFranchiseDetail(key)!;
    expect(visible.analysis.visibility).toBe('visible');
    expect(visible.analysis.coverage.knownMembers).toBe(3);
    expect(visible.analysis.rating.average.ratedCount).toBe(3);

    // 整页 Real 切换：同一个请求口径下所有指标一起变化（不混分子分母）
    const real = getFranchiseDetail(key, { visibility: 'real' })!;
    expect(real.analysis.visibility).toBe('real');
    expect(real.analysis.coverage.knownMembers).toBe(5);
    expect(real.analysis.rating.average.ratedCount).toBe(5);
  });
});
