/**
 * v1.8 Phase 4：Entity Ranking（Coverage / Completion / Rating）。
 *
 * 语义：display ≠ rankable —— 所有实体仍展示；sample ≥ 3 才进入该指标的排名域；
 * 列表 ranking 值必须与 Detail analysis 同源；Visible / Real 不串口径；
 * Series 与 Franchise 各自独立榜单。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { one, run } from '../src/db/index.js';
import { getFranchiseDetail, getSeriesDetail, listFranchises, listSeries } from '../src/db/query.js';
import { recomputeSeries } from '../src/db/series.js';
import { resetDatabase } from './helpers.js';

const TS = '2026-01-01T00:00:00.000Z';

function hideNsfw(value: boolean): void {
  saveConfig({ hideNsfw: value });
}

interface MemberSeed {
  id: number;
  rate?: number;
  type?: number;
  score?: number;
  collected?: boolean;
  local?: boolean;
}

function seedMember(seed: MemberSeed): void {
  const { id, rate = 0, type = 2, score = 7.5, collected = true, local = true } = seed;
  if (local) {
    run(
      `INSERT INTO subjects (id, name, name_cn, aliases, year, format, score, total_episodes, eps,
         nsfw, tag_names, detail_state, created_at, updated_at)
       VALUES (:id, :name, :name, '[]', 2010, 'TV', :score, 12, 12, 0, '[]', 'ok', :ts, :ts)`,
      { id, name: `排名夹具 ${id}`, score, ts: TS },
    );
  }
  if (collected) {
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, ep_status, updated_at, first_seen_at, synced_at)
       VALUES (:id, 2, :type, :rate, 0, :ts, :ts, :ts)`,
      { id, type, rate, ts: TS },
    );
  }
}

function link(from: number, to: number): void {
  linkOneWay(from, to);
  linkOneWay(to, from, '前传');
}

/** related_id 没有 FK：relation-only 成员只以「被引用」的形式存在。 */
function linkOneWay(subjectId: number, relatedId: number, relation = '续集'): void {
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:subjectId, :relatedId, :relation, 2, '', '', :ts)`,
    { subjectId, relatedId, relation, ts: TS },
  );
}

function franchiseLink(from: number, to: number): void {
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:from, :to, '不同演绎', 2, '', '', :ts)`,
    { from, to, ts: TS },
  );
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:from, :to, '不同演绎', 2, '', '', :ts)`,
    { from: to, to: from, ts: TS },
  );
}

function titleSeries(subjectId: number, title: string): void {
  run(
    `UPDATE series_entities SET title = :title
     WHERE id = (SELECT series_id FROM series_entity_members WHERE subject_id = :id AND role = 'primary' LIMIT 1)`,
    { title, id: subjectId },
  );
}

function franchiseKeyOfSubject(subjectId: number): string {
  const row = one<{ key: string }>(
    `SELECT f.key FROM franchise_entities f
     JOIN franchise_series fs ON fs.franchise_id = f.id
     JOIN series_entity_members m ON m.series_id = fs.series_id
     WHERE m.subject_id = :id AND m.role = 'primary' AND f.state <> 'stale' LIMIT 1`,
    { id: subjectId },
  );
  if (!row) throw new Error(`缺少 ${subjectId} 的 Franchise`);
  return row.key;
}

/**
 * Series 排名夹具：
 * A：known 4（3 收藏 type2 8/7/6 + 1 relation-only）→ coverage 0.75 / completion 1 / rate 7
 * B：known 2（2 收藏 9/9）→ 三指标样本都 < 3（低样本仍展示）
 * C：known 3（1 收藏 10）→ coverage 可排名；completion/rate 样本 < 3
 * D：known 3（看过 1 / 想看 1 / 在看 1）→ completion 1/3；无评分
 * E：known 5（5 收藏 type2 rate 5）
 */
function seedSeriesFixture(): void {
  seedMember({ id: 1, rate: 8 });
  seedMember({ id: 2, rate: 7 });
  seedMember({ id: 3, rate: 6 });
  link(1, 2);
  link(2, 3);
  linkOneWay(3, 99); // 99 无本地 subjects 行 → relation-only（只以被引用形式存在）

  seedMember({ id: 4, rate: 9 });
  seedMember({ id: 5, rate: 9 });
  link(4, 5);

  seedMember({ id: 6, rate: 10 });
  seedMember({ id: 7, collected: false });
  seedMember({ id: 8, collected: false });
  link(6, 7);
  link(7, 8);

  seedMember({ id: 10, rate: 0, type: 2 });
  seedMember({ id: 11, rate: 0, type: 1 });
  seedMember({ id: 12, rate: 0, type: 3 });
  link(10, 11);
  link(11, 12);

  for (const id of [20, 21, 22, 23, 24]) seedMember({ id, rate: 5 });
  link(20, 21);
  link(21, 22);
  link(22, 23);
  link(23, 24);

  recomputeSeries();
  titleSeries(1, '系列 A');
  titleSeries(4, '系列 B');
  titleSeries(6, '系列 C');
  titleSeries(10, '系列 D');
  titleSeries(20, '系列 E');
}

/**
 * Franchise 排名夹具：
 * fr1 = P{1,2,3 全收藏 rate 8} + Q{4,5,6 全收藏 rate 2}；fr2 = {10} + {11}（各 rate 9）。
 * Visible（隐藏 Q）时 fr1 只剩 P。
 */
function seedFranchiseFixture(): void {
  for (const id of [1, 2, 3]) seedMember({ id, rate: 8 });
  link(1, 2);
  link(2, 3);
  for (const id of [4, 5, 6]) seedMember({ id, rate: 2 });
  link(4, 5);
  link(5, 6);
  franchiseLink(1, 4);

  seedMember({ id: 10, rate: 9 });
  seedMember({ id: 11, rate: 9 });
  franchiseLink(10, 11);

  recomputeSeries();
}

function titles(rows: Array<{ title: string }>): string[] {
  return rows.map((row) => row.title);
}

describe('Series Ranking（v1.8）', () => {
  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
    seedSeriesFixture();
  });

  it('Coverage：sample ≥ 3 先排，低样本仍展示但排在排名域之后', () => {
    const rows = listSeries({ sort: 'coverage', includeSingletons: true });
    expect(titles(rows)).toEqual(['系列 D', '系列 E', '系列 A', '系列 C', '系列 B']);

    const byTitle = new Map(rows.map((row) => [row.title, row.ranking!]));
    expect(byTitle.get('系列 D')).toEqual({
      metric: 'coverage',
      value: 1,
      sample: 3,
      rankable: true,
    });
    // relation-only 进入 Coverage 分母
    expect(byTitle.get('系列 A')).toEqual({
      metric: 'coverage',
      value: 0.75,
      sample: 4,
      rankable: true,
    });
    expect(byTitle.get('系列 C')).toEqual({
      metric: 'coverage',
      value: 0.3333,
      sample: 3,
      rankable: true,
    });
    // 低样本仍展示，只是不进入排名域
    expect(byTitle.get('系列 B')).toEqual({
      metric: 'coverage',
      value: 1,
      sample: 2,
      rankable: false,
    });
  });

  it('Completion：member-level，想看不作为 progress；低样本不参与排名', () => {
    const rows = listSeries({ sort: 'completion', includeSingletons: true });
    expect(titles(rows)).toEqual(['系列 A', '系列 E', '系列 D', '系列 B', '系列 C']);

    const byTitle = new Map(rows.map((row) => [row.title, row.ranking!]));
    expect(byTitle.get('系列 A')).toEqual({
      metric: 'completion',
      value: 1,
      sample: 3,
      rankable: true,
    });
    // 看过 1 / 收藏 3：想看与在看不算 progress
    expect(byTitle.get('系列 D')).toEqual({
      metric: 'completion',
      value: 0.3333,
      sample: 3,
      rankable: true,
    });
    // 完成度 100% 但分母只有 2 → 展示但不排名
    expect(byTitle.get('系列 B')).toEqual({
      metric: 'completion',
      value: 1,
      sample: 2,
      rankable: false,
    });
    expect(byTitle.get('系列 C')?.rankable).toBe(false);
  });

  it('Rating：ratedCount ≥ 3 才进入排名域；无评分不是 0', () => {
    const rows = listSeries({ sort: 'rate', includeSingletons: true });
    expect(titles(rows)).toEqual(['系列 A', '系列 E', '系列 C', '系列 B', '系列 D']);

    const byTitle = new Map(rows.map((row) => [row.title, row.ranking!]));
    expect(byTitle.get('系列 A')).toEqual({
      metric: 'rate',
      value: 7,
      sample: 3,
      rankable: true,
    });
    // n=1 的高分不参与排名，但仍展示自己的评分
    expect(byTitle.get('系列 C')).toEqual({
      metric: 'rate',
      value: 10,
      sample: 1,
      rankable: false,
    });
    // 无评分 → value = null（不是 0）
    expect(byTitle.get('系列 D')).toEqual({
      metric: 'rate',
      value: null,
      sample: 0,
      rankable: false,
    });
  });

  it('列表 ranking 值与 Series Detail analysis 同源（同口径）', () => {
    for (const sort of ['coverage', 'completion', 'rate'] as const) {
      for (const row of listSeries({ sort, includeSingletons: true })) {
        const detail = getSeriesDetail(row.key)!;
        const meta = row.ranking!;
        const expected =
          sort === 'coverage'
            ? {
                value: detail.analysis.coverage.value,
                sample: detail.analysis.coverage.knownMembers,
              }
            : sort === 'completion'
              ? {
                  value: detail.analysis.completion.value,
                  sample: detail.analysis.completion.collectedCount,
                }
              : {
                  value: detail.analysis.rating.average.value,
                  sample: detail.analysis.rating.average.ratedCount,
                };
        expect(meta.value).toBe(expected.value);
        expect(meta.sample).toBe(expected.sample);
      }
    }
  });

  it('非排名排序保持原有语义（size/title 不受影响，且不带 ranking 元数据）', () => {
    const rows = listSeries({ sort: 'size', includeSingletons: true });
    expect(rows.every((row) => row.ranking === undefined)).toBe(true);
    expect(rows[0]?.title).toBe('系列 E'); // member_count 5 最大
  });
});

describe('Franchise Ranking（v1.8）', () => {
  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
    seedFranchiseFixture();
  });

  it('Rating：canonical caliber-aware 值；sample < 3 不参与排名', () => {
    const fr1 = franchiseKeyOfSubject(1);
    const fr2 = franchiseKeyOfSubject(10);

    const real = listFranchises({ sort: 'rate' });
    expect(titles(real)).toEqual([
      listFranchises().find((row) => row.key === fr1)!.title,
      listFranchises().find((row) => row.key === fr2)!.title,
    ]);
    const realByKey = new Map(real.map((row) => [row.key, row]));
    expect(realByKey.get(fr1)?.ranking).toEqual({
      metric: 'rate',
      value: 5,
      sample: 6,
      rankable: true,
    });
    expect(realByKey.get(fr2)?.ranking).toEqual({
      metric: 'rate',
      value: 9,
      sample: 2,
      rankable: false,
    });
    // 与 Detail analysis / canonical 平均分同源
    expect(realByKey.get(fr1)?.ranking?.value).toBe(
      getFranchiseDetail(fr1, { visibility: 'real' })!.analysis.rating.average.value,
    );
    expect(realByKey.get(fr1)?.ranking?.value).toBe(
      getFranchiseDetail(fr1, { visibility: 'real' })!.averageRate,
    );
  });

  it('部分隐藏：Visible ranking 使用可见成员值，不串 Real materialization', () => {
    const fr1 = franchiseKeyOfSubject(1);
    // 隐藏 Q（4）→ fr1 只剩 P
    run(`UPDATE subjects SET nsfw = 1 WHERE id = 4`);
    hideNsfw(true);

    const rows = listFranchises({ sort: 'rate' });
    const row = rows.find((entry) => entry.key === fr1)!;
    expect(row.ranking).toEqual({ metric: 'rate', value: 8, sample: 3, rankable: true });
    const detail = getFranchiseDetail(fr1)!;
    expect(detail.analysis.visibility).toBe('visible');
    expect(detail.analysis.rating.average.value).toBe(8);
    expect(row.ranking?.value).toBe(detail.averageRate);

    // 关闭隐藏 → 口径回到 Real，值与 materialization 一致
    hideNsfw(false);
    const real = listFranchises({ sort: 'rate' }).find((entry) => entry.key === fr1)!;
    expect(real.ranking).toEqual({ metric: 'rate', value: 5, sample: 6, rankable: true });
    expect(real.ranking?.value).toBe(
      getFranchiseDetail(fr1, { visibility: 'real' })!.averageRate,
    );
  });

  it('Coverage / Completion：跨 Series 聚合 + 样本门槛；Series / Franchise 不混榜', () => {
    const coverage = listFranchises({ sort: 'coverage' });
    expect(coverage).toHaveLength(2);
    expect(coverage.every((row) => row.ranking?.metric === 'coverage')).toBe(true);
    expect(coverage[0]?.ranking?.rankable).toBe(true);
    expect(coverage[1]?.ranking?.rankable).toBe(false);
    expect(coverage.every((row) => 'seriesCount' in row && !('memberCount' in row))).toBe(true);

    const completion = listFranchises({ sort: 'completion' });
    expect(completion.every((row) => row.ranking?.metric === 'completion')).toBe(true);
    const rows = listSeries({ sort: 'coverage', includeSingletons: true });
    expect(rows.every((row) => 'memberCount' in row && !('seriesCount' in row))).toBe(true);
  });
});
