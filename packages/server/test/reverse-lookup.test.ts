import { beforeEach, describe, expect, it } from 'vitest';
import { getFilterFacets, listSubjects, searchStaff } from '../src/db/query.js';
import { all } from '../src/db/index.js';
import {
  FakeBangumiClient,
  makeCollectionItem,
  makeSubject,
  resetDatabase,
  runSync,
} from './helpers.js';

/**
 * 反向检索专项测试：
 * 单次出现的公司 / 人员必须可检索；「作品 → 人员 → 标签」必须保留来源上下文；
 * 查询语义必须与点击元素一致（不做假结果，也不隐式扩大范围）。
 */
const WORKS = [
  { id: 1, tags: ['甲标签', '乙标签', '丙标签'], studio: '独家公司', director: '独导', rate: 9 },
  { id: 2, tags: ['乙标签'], studio: '常见公司', director: '常见导演', rate: 8 },
  { id: 3, tags: ['丙标签'], studio: '常见公司', director: '第二导演', rate: 7 },
  { id: 4, tags: ['甲标签'], studio: '常见公司', director: '第三导演', rate: 6 },
];

/** 人员数据：Cygames 参与 1/2/3，金﨑貴臣（罕见字形）参与 1/2，獨家配角只在 1 */
const PERSONS: Record<number, Array<{ id: number; name: string; relation: string }>> = {
  1: [
    { id: 901, name: 'Cygames', relation: '原作' },
    { id: 902, name: 'Cygames', relation: '制作' },
    { id: 903, name: '金﨑貴臣', relation: '音响监督' },
    { id: 904, name: '山田脚本', relation: '脚本' },
  ],
  2: [
    { id: 901, name: 'Cygames', relation: '原作' },
    { id: 903, name: '金﨑貴臣', relation: '音响监督' },
  ],
  3: [{ id: 901, name: 'Cygames', relation: '企画' }],
  4: [{ id: 905, name: '山田脚本', relation: '脚本' }],
};

function buildClient(): FakeBangumiClient {
  return new FakeBangumiClient({
    collections: WORKS.map((work) =>
      makeCollectionItem({
        subject_id: work.id,
        rate: work.rate,
        subject: {
          id: work.id,
          type: 2,
          name: `Reverse ${work.id}`,
          name_cn: `反向检索 ${work.id}`,
          short_summary: '',
          date: '2023-04-01',
          images: {},
          volumes: 0,
          eps: 12,
          collection_total: 100,
          score: 7.5,
          rank: 100,
          tags: work.tags.map((name, index) => ({ name, count: 10 - index, total_count: 100 })),
        },
      }),
    ),
    subjects: Object.fromEntries(
      WORKS.map((work) => [
        work.id,
        makeSubject({
          id: work.id,
          name_cn: `反向检索 ${work.id}`,
          tags: work.tags.map((name, index) => ({ name, count: 10 - index, total_count: 100 })),
          infobox: [
            { key: '中文名', value: `反向检索 ${work.id}` },
            { key: '动画制作', value: work.studio },
            { key: '导演', value: work.director },
          ],
        }),
      ]),
    ),
    persons: Object.fromEntries(
      Object.entries(PERSONS).map(([id, list]) => [
        Number(id),
        list.map((person) => ({
          id: person.id,
          name: person.name,
          relation: person.relation,
          career: [],
          type: 1,
        })),
      ]),
    ),
  });
}

async function seed(): Promise<void> {
  await runSync(buildClient(), { depth: 2 });
}

describe('单次出现的条目也必须可检索', () => {
  beforeEach(() => {
    resetDatabase();
  });

  it('facet 不做截断：只出现一次的公司 / 导演 / 人员都在列表里', async () => {
    await seed();
    const facets = getFilterFacets();

    const soloStudio = facets.studios.find((item) => item.value === '独家公司');
    expect(soloStudio?.count).toBe(1);
    const soloDirector = facets.directors.find((item) => item.value === '独导');
    expect(soloDirector?.count).toBe(1);

    // 列表长度与实际去重数量一致（没有 LIMIT / HAVING 截断）
    const studioCount = Number(
      all<{ n: number }>(
        `SELECT COUNT(DISTINCT je.value) AS n
         FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(s.studios) je`,
      )[0]?.n ?? 0,
    );
    expect(facets.studios.length).toBe(studioCount);

    const directorCount = Number(
      all<{ n: number }>(
        `SELECT COUNT(DISTINCT je.value) AS n
         FROM collections c JOIN subjects s ON s.id = c.subject_id, json_each(s.directors) je`,
      )[0]?.n ?? 0,
    );
    expect(facets.directors.length).toBe(directorCount);

    // 人员总数（含只出现一次的）也要报出来
    expect(facets.staffTotal).toBeGreaterThan(0);
  });

  it('只出现一次的公司 / 导演可以直接筛选出作品', async () => {
    await seed();
    expect(listSubjects({ studios: ['独家公司'] }).items.map((item) => item.id)).toEqual([1]);
    expect(listSubjects({ directors: ['独导'] }).items.map((item) => item.id)).toEqual([1]);
    // 公司同样存在于 subject_staff 中，staff= 查询也应命中
    expect(listSubjects({ staff: ['独家公司'] }).items.map((item) => item.id)).toEqual([1]);
  });

  it('只出现一次的人员（含罕见字形）可以被搜到', async () => {
    await seed();
    const solo = searchStaff({ q: '独家公司' });
    expect(solo.matched).toBe(1);
    expect(solo.items[0]).toMatchObject({ name: '独家公司', works: 1 });

    const rareGlyph = searchStaff({ q: '金﨑貴臣' });
    expect(rareGlyph.matched).toBe(1);
    expect(rareGlyph.items[0]?.name).toBe('金﨑貴臣');
    expect(rareGlyph.items[0]?.works).toBe(2);

    // 参与多部作品的人员同样可检索，并按作品数排序
    const common = searchStaff({ q: 'Cygames' });
    expect(common.items[0]).toMatchObject({ name: 'Cygames', works: 3 });
    expect(common.items[0]?.relations).toEqual(expect.arrayContaining(['原作']));
  });

  it('人员检索支持大小写与部分匹配，并给出总数', async () => {
    await seed();
    const lower = searchStaff({ q: 'cygames' });
    expect(lower.matched).toBe(1);
    const partial = searchStaff({ q: '脚本' });
    expect(partial.items.some((item) => item.name === '山田脚本')).toBe(true);

    const all = searchStaff({});
    expect(all.total).toBeGreaterThanOrEqual(5);
    expect(all.items.length).toBeGreaterThan(0);
  });
});

describe('反向追溯的来源上下文', () => {
  beforeEach(() => {
    resetDatabase();
  });

  it('作品 → 人员：结果包含来源作品，并回报上下文命中情况', async () => {
    await seed();
    const page = listSubjects({
      staff: ['金﨑貴臣'],
      fromSubject: 1,
      sourceRelation: '音响监督',
    });
    expect(page.items.map((item) => item.id).sort()).toEqual([1, 2]);
    expect(page.context).toMatchObject({
      subjectId: 1,
      present: true,
      relation: '音响监督',
    });
    expect(page.context?.title).toBe('反向检索 1');
  });

  it('作品 → 标签 → 人员：多级上下文同时生效且不会扩大范围', async () => {
    await seed();
    // 先按标签「乙标签」（作品 1、2），再叠加人员 Cygames（作品 1、2、3）
    const page = listSubjects({
      tags: ['乙标签'],
      staff: ['Cygames'],
      fromSubject: 2,
    });
    expect(page.items.map((item) => item.id).sort()).toEqual([1, 2]);
    expect(page.context?.present).toBe(true);

    // 来源作品 3 没有「乙标签」→ 必须如实回报「不在结果中」，而不是把它硬塞进来
    const mismatch = listSubjects({
      tags: ['乙标签'],
      staff: ['Cygames'],
      fromSubject: 3,
    });
    expect(mismatch.items.map((item) => item.id).sort()).toEqual([1, 2]);
    expect(mismatch.context?.present).toBe(false);
  });

  it('人员参与的其它作品仍然可以被检索到（不局限于来源作品）', async () => {
    await seed();
    const page = listSubjects({ staff: ['Cygames'], fromSubject: 1 });
    expect(page.items.map((item) => item.id).sort()).toEqual([1, 2, 3]);
  });

  it('不同关系类型的人员都能被正确回溯', async () => {
    await seed();
    const cases: Array<[string, number[]]> = [
      ['独导', [1]], // 导演
      ['金﨑貴臣', [1, 2]], // 音响监督
      ['山田脚本', [1, 4]], // 脚本
      ['独家公司', [1]], // 制作公司（infobox 动画制作）
      ['Cygames', [1, 2, 3]], // 原作 / 制作 / 企画
    ];
    for (const [name, expected] of cases) {
      const page = listSubjects({ staff: [name] });
      expect(page.items.map((item) => item.id).sort((a, b) => a - b)).toEqual(expected);
    }
  });
});
