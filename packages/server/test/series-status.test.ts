import { beforeEach, describe, expect, it } from 'vitest';
import { recomputeSeries } from '../src/db/series.js';
import { getSeriesDetail, listSeries, summarizeSeriesWatch } from '../src/db/query.js';
import { all, one, run } from '../src/db/index.js';
import {
  FakeBangumiClient,
  makeCollectionItem,
  makeSubject,
  resetDatabase,
  runSync,
} from './helpers.js';

/**
 * 系列 / IP 观看状态统计专项测试。
 *
 * 核心不变量：
 * - 统计口径只能是「我的收藏条目」的收藏状态；
 * - 未收藏的系列条目不得进入任何状态统计；
 * - 只有全部收藏条目都是「看过」时才允许标记 allWatched。
 */

interface WorkSpec {
  id: number;
  nameCn: string;
  status: number;
  rate?: number;
  epStatus?: number;
  eps?: number;
}

/**
 * 构建一组作品 + 官方系列关系。
 * `links` 用 "id:relation" 形式描述关系（例如 100:续集）。
 */
function buildClient(works: WorkSpec[], links: Array<[number, number, string]> = []): FakeBangumiClient {
  return new FakeBangumiClient({
    collections: works.map((work) =>
      makeCollectionItem({
        subject_id: work.id,
        type: work.status,
        rate: work.rate ?? 8,
        ep_status: work.epStatus ?? (work.status === 2 ? 12 : 0),
        subject: {
          id: work.id,
          type: 2,
          name: `Series ${work.id}`,
          name_cn: work.nameCn,
          short_summary: '',
          date: '2020-04-01',
          images: {},
          volumes: 0,
          eps: work.eps ?? 12,
          collection_total: 100,
          score: 7.5,
          rank: 100,
          tags: [],
        },
      }),
    ),
    subjects: Object.fromEntries(
      works.map((work) => [
        work.id,
        makeSubject({
          id: work.id,
          name: `Series ${work.id}`,
          name_cn: work.nameCn,
          infobox: [{ key: '中文名', value: work.nameCn }],
          eps: work.eps ?? 12,
          total_episodes: work.eps ?? 12,
        }),
      ]),
    ),
    relations: Object.fromEntries(
      works.map((work) => [
        work.id,
        links
          .filter(([from]) => from === work.id)
          .map(([, to, relation]) => ({
            id: to,
            type: 2,
            name: `Series ${to}`,
            name_cn: `系列作品 ${to}`,
            relation,
          })),
      ]),
    ),
  });
}

async function seed(works: WorkSpec[], links: Array<[number, number, string]> = []): Promise<void> {
  await runSync(buildClient(works, links), { depth: 2 });
}

function onlySeries() {
  const series = listSeries({ sort: 'size' });
  expect(series.length).toBe(1);
  const detail = getSeriesDetail(series[0]!.key);
  expect(detail).toBeTruthy();
  return detail!;
}

describe('系列观看状态聚合', () => {
  beforeEach(() => {
    resetDatabase();
  });

  it('案例 A：全部看过 → allWatched 为 true', async () => {
    await seed(
      [
        { id: 1, nameCn: '第一季', status: 2 },
        { id: 2, nameCn: '第二季', status: 2 },
      ],
      [
        [1, 2, '续集'],
        [2, 1, '前传'],
      ],
    );
    const detail = onlySeries();
    expect(detail.watch).toMatchObject({
      collectedCount: 2,
      watched: 2,
      wish: 0,
      watching: 0,
      onHold: 0,
      dropped: 0,
      allWatched: true,
    });
    expect(detail.statusCounts).toEqual({ '2': 2 });
  });

  it('案例 B/D：部分看过 + 部分想看 → 不得标记全部看完', async () => {
    await seed(
      [
        { id: 1, nameCn: '第一季', status: 2 },
        { id: 2, nameCn: '第二季', status: 2 },
        { id: 3, nameCn: '第三季', status: 2 },
        { id: 4, nameCn: '剧场版', status: 1 },
        { id: 5, nameCn: '特别篇', status: 1 },
      ],
      [
        [1, 2, '续集'],
        [2, 3, '续集'],
        // 剧场版 / 特别篇通过「同系列」关系并入同一 IP
        [3, 4, '同系列'],
        [4, 5, '同系列'],
      ],
    );
    const detail = onlySeries();
    expect(detail.watch.watched).toBe(3);
    expect(detail.watch.wish).toBe(2);
    expect(detail.watch.allWatched).toBe(false);
    expect(detail.statusCounts).toEqual({ '2': 3, '1': 2 });
    // 统计对象只能是我的收藏条目
    expect(detail.watch.collectedCount).toBe(
      detail.members.filter((member) => member.collected).length,
    );
  });

  it('案例 C：全部想看 → 看过为 0，且不是「已看完」', async () => {
    await seed(
      [
        { id: 1, nameCn: '第一季', status: 1 },
        { id: 2, nameCn: '第二季', status: 1 },
      ],
      [
        [1, 2, '续集'],
        [2, 1, '前传'],
      ],
    );
    const detail = onlySeries();
    expect(detail.watch.watched).toBe(0);
    expect(detail.watch.wish).toBe(2);
    expect(detail.watch.allWatched).toBe(false);
    expect(detail.watch.anyStarted).toBe(false);
  });

  it('案例 E：包含在看 / 搁置 / 抛弃时分别统计', async () => {
    await seed(
      [
        { id: 1, nameCn: '第一季', status: 2 },
        { id: 2, nameCn: '第二季', status: 3, epStatus: 5 },
        { id: 3, nameCn: 'OVA', status: 4 },
        { id: 4, nameCn: '特别篇', status: 5 },
      ],
      [
        [1, 2, '续集'],
        [2, 3, '外传'],
        [3, 4, '同系列'],
      ],
    );
    const detail = onlySeries();
    expect(detail.watch).toMatchObject({
      collectedCount: 4,
      watched: 1,
      wish: 0,
      watching: 1,
      onHold: 1,
      dropped: 1,
      allWatched: false,
      anyStarted: true,
    });
    expect(
      detail.members
        .filter((member) => member.item)
        .map((member) => member.item!.collectionType)
        .sort(),
    ).toEqual([2, 3, 4, 5]);
  });

  it('案例 F：只有一个收藏条目时，数据层存在单成员 Series，统计等于该条目状态', async () => {
    await seed([
      { id: 1, nameCn: '剧场版', status: 4 },
      { id: 2, nameCn: '第二季', status: 2 },
    ], []);
    // 没有关系时每部作品仍是单成员 Series（数据层必须存在），只是默认列表隐藏
    const all = listSeries({ includeSingletons: true });
    expect(all.length).toBeGreaterThanOrEqual(2);
    const singleton = all.find((entry) => entry.memberCount === 1 && entry.title.includes('剧场版'));
    expect(singleton).toBeTruthy();
    const detail = getSeriesDetail(singleton!.key)!;
    const watch = detail.watch;
    expect(watch).toMatchObject({
      collectedCount: 1,
      watched: 0,
      wish: 0,
      watching: 0,
      onHold: 1,
      dropped: 0,
      allWatched: false,
    });
  });

  it('案例 G：系列含未收藏条目时，只有我的收藏参与统计', async () => {
    // 作品 1、2 收藏；作品 3、4 只在官方关系里出现（未收藏）
    const client = buildClient(
      [
        { id: 1, nameCn: '第一季', status: 2 },
        { id: 2, nameCn: '第二季', status: 1 },
      ],
      [
        [1, 2, '续集'],
        [2, 1, '前传'],
      ],
    );
    // 手工补上「未收藏但存在于关系中」的条目
    await runSync(client, { depth: 2 });
    const key = listSeries()[0]!.key;
    run(
      `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
       VALUES (1, 3, '续集', 2, 'Unaired 3', '未收藏第三季', '2026-01-01'),
              (1, 4, '外传', 2, 'Unaired 4', '未收藏外传', '2026-01-01')`,
    );
    recomputeSeries();

    const detail = getSeriesDetail(key)!;
    expect(detail.watch.collectedCount).toBe(2);
    expect(detail.watch.knownMembers).toBe(4);
    expect(detail.watch.watched).toBe(1);
    expect(detail.watch.wish).toBe(1);
    // 未收藏成员只出现在 members（collected=false），不进入状态统计
    expect(
      detail.members
        .filter((member) => !member.collected)
        .map((member) => member.subjectId)
        .sort(),
    ).toEqual([3, 4]);
    expect(detail.members.filter((member) => !member.collected).every((member) => member.title.length > 0)).toBe(true);
    expect(detail.watch.watched + detail.watch.wish).toBe(detail.watch.collectedCount);
  });

  it('回归：收藏状态必须来自 collections.type，而不是 subjects.type', async () => {
    await seed(
      [
        { id: 1, nameCn: '第一季', status: 1 },
        { id: 2, nameCn: '第二季', status: 3 },
        { id: 3, nameCn: '第三季', status: 4 },
      ],
      [
        [1, 2, '续集'],
        [2, 3, '续集'],
      ],
    );
    const series = listSeries()[0]!;
    // 旧实现会把每种状态都记成 {"2": N}（subjects.type 恒为 2）
    expect(series.statusCounts).toEqual({ '1': 1, '3': 1, '4': 1 });
    expect(series.statusCounts['2']).toBeUndefined();

    const stored = one<{ status_counts: string }>(
      'SELECT status_counts FROM series_entities WHERE key = :key',
      { key: series.key },
    );
    expect(JSON.parse(stored!.status_counts)).toEqual({ '1': 1, '3': 1, '4': 1 });
  });

  it('空收藏 / 缺失状态不会伪造「已看完」', () => {
    const watch = summarizeSeriesWatch([]);
    expect(watch).toMatchObject({
      collectedCount: 0,
      watched: 0,
      allWatched: false,
      anyStarted: false,
    });
    expect(watch.insufficient).toBeTruthy();
  });

  it('重建系列分组后统计与数据库一致（幂等）', async () => {
    await seed(
      [
        { id: 1, nameCn: '第一季', status: 2 },
        { id: 2, nameCn: '第二季', status: 1 },
        { id: 3, nameCn: 'OVA', status: 4 },
      ],
      [
        [1, 2, '续集'],
        [2, 1, '前传'],
      ],
    );
    const before = listSeries()[0]!.statusCounts;
    recomputeSeries();
    recomputeSeries();
    const after = listSeries()[0]!.statusCounts;
    expect(after).toEqual(before);

    // 与直接从 collections 聚合的结果一致
    const groundTruth = all<{ type: number; n: number }>(
      `SELECT c.type AS type, COUNT(*) AS n FROM series_entity_members m
       JOIN collections c ON c.subject_id = m.subject_id
       JOIN series_entities e ON e.id = m.series_id
       WHERE m.role = 'primary' AND e.key = :key
       GROUP BY c.type`,
      { key: listSeries()[0]!.key },
    );
    const expected: Record<string, number> = {};
    for (const row of groundTruth) expected[String(row.type)] = Number(row.n);
    expect(after).toEqual(expected);
  });
});
