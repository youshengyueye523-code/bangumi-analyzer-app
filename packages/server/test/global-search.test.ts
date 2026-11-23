import { beforeEach, describe, expect, it } from 'vitest';
import { listSubjects, searchEntities } from '../src/db/query.js';
import {
  FakeBangumiClient,
  makeCollectionItem,
  makeSubject,
  resetDatabase,
  runSync,
} from './helpers.js';

/**
 * 全局搜索专项测试：主搜索栏必须覆盖标题 / 别名 / ID / 标签 / 人员 / 公司 / 导演，
 * 并且每个结果都要能说明命中原因。
 */
const WORKS = [
  {
    id: 1,
    nameCn: '妄想学生会',
    name: 'Seitokai Yakuindomo',
    aliases: ['黄段子学生会', 'Student Council'],
    tags: ['黄段子', '搞笑', '校园'],
    studio: 'GoHands',
    director: '金澤洪充',
    staff: [{ name: '金澤洪充', relation: '导演' }],
  },
  {
    id: 2,
    nameCn: '妄想学生会＊OVA',
    name: 'Seitokai Yakuindomo * OVA',
    aliases: [],
    tags: ['黄段子', '搞笑'],
    studio: 'GoHands',
    director: '金澤洪充',
    staff: [{ name: '金澤洪充', relation: '导演' }],
  },
  {
    id: 3,
    nameCn: '孤独的独家公司作品',
    name: 'Solo Studio Work',
    aliases: ['Solo Alias Only'],
    tags: ['冷门标签唯一'],
    studio: '独家公司XYZ',
    director: '独导ABC',
    staff: [{ name: '独家公司XYZ', relation: '动画制作' }],
  },
];

function buildClient(): FakeBangumiClient {
  return new FakeBangumiClient({
    collections: WORKS.map((work) =>
      makeCollectionItem({
        subject_id: work.id,
        rate: 8,
        subject: {
          id: work.id,
          type: 2,
          name: work.name,
          name_cn: work.nameCn,
          short_summary: '',
          date: '2010-07-01',
          images: {},
          volumes: 0,
          eps: 13,
          collection_total: 100,
          score: 7.5,
          rank: 100,
          tags: work.tags.map((name, index) => ({
            name,
            count: 10 - index,
            total_count: 100,
          })),
        },
      }),
    ),
    subjects: Object.fromEntries(
      WORKS.map((work) => [
        work.id,
        makeSubject({
          id: work.id,
          name: work.name,
          name_cn: work.nameCn,
          tags: work.tags.map((name, index) => ({ name, count: 10 - index, total_count: 100 })),
          infobox: [
            { key: '中文名', value: work.nameCn },
            ...(work.aliases.length > 0
              ? [{ key: '别名', value: work.aliases.map((value) => ({ v: value })) }]
              : []),
            { key: '动画制作', value: work.studio },
            { key: '导演', value: work.director },
          ],
        }),
      ]),
    ),
    persons: Object.fromEntries(
      WORKS.map((work) => [
        work.id,
        work.staff.map((person, index) => ({
          id: work.id * 100 + index,
          name: person.name,
          relation: person.relation,
          career: [],
          type: 1,
        })),
      ]),
    ),
  });
}

const ids = (query: Parameters<typeof listSubjects>[0]) =>
  listSubjects({ ...query, pageSize: 100 }).items.map((item) => item.id).sort((a, b) => a - b);

describe('主搜索栏的全局搜索', () => {
  beforeEach(async () => {
    resetDatabase();
    await runSync(buildClient(), { depth: 2 });
  });

  it('关键词同时覆盖标题与别名', async () => {
    expect(ids({ q: '妄想学生会' })).toEqual([1, 2]);
    expect(ids({ q: 'Seitokai' })).toEqual([1, 2]);
    // 别名（非主标题）
    expect(ids({ q: '黄段子学生会' })).toEqual([1]);
    expect(ids({ q: 'Student Council' })).toEqual([1]);
    expect(ids({ q: 'Solo Alias Only' })).toEqual([3]);
  });

  it('关键词覆盖标签、制作人员与公司', async () => {
    expect(ids({ q: '黄段子' })).toEqual([1, 2]);
    expect(ids({ q: '冷门标签唯一' })).toEqual([3]);
    expect(ids({ q: '金澤洪充' })).toEqual([1, 2]);
    expect(ids({ q: 'GoHands' })).toEqual([1, 2]);
    expect(ids({ q: '独家公司XYZ' })).toEqual([3]);
  });

  it('Bangumi ID 仍然可以直接搜索', async () => {
    expect(ids({ q: '2' })).toEqual([2]);
  });

  it('每条结果都会说明命中原因', async () => {
    const page = listSubjects({ q: '黄段子', pageSize: 10 });
    for (const item of page.items) {
      expect(item.matchReasons).toContain('tag');
    }
    const aliasPage = listSubjects({ q: '黄段子学生会', pageSize: 10 });
    expect(aliasPage.items[0]?.matchReasons).toContain('alias');

    const staffPage = listSubjects({ q: '金澤洪充', pageSize: 10 });
    expect(staffPage.items[0]?.matchReasons).toEqual(
      expect.arrayContaining(['staff', 'director']),
    );

    // 没有关键词时不返回命中原因（避免无意义标注）
    expect(listSubjects({ pageSize: 3 }).items[0]?.matchReasons).toBeUndefined();
  });

  it('实体检索返回分类结果与作品数量', () => {
    const result = searchEntities('黄段子', 5);
    // workTotal 是「全局命中数」（含标签命中），与回车后的收藏库结果一致
    expect(result.workTotal).toBe(2);
    expect(result.tags[0]).toMatchObject({ value: '黄段子', count: 2 });
    // 作品分组只列出「标题 / 别名 / ID」直接命中的作品（标签命中的作品通过标签分组进入）
    expect(result.works.map((work) => work.id)).toEqual([1]);
    expect(result.works[0]?.reasons).toContain('alias');

    const staff = searchEntities('金澤', 5);
    expect(staff.staff.map((person) => person.name)).toContain('金澤洪充');

    const studio = searchEntities('GoHands', 5);
    expect(studio.studios[0]).toMatchObject({ value: 'GoHands', count: 2 });
  });

  it('只出现一次的标签 / 人员 / 公司都能被搜索到', () => {
    const tag = searchEntities('冷门标签唯一', 5);
    expect(tag.tags[0]).toMatchObject({ value: '冷门标签唯一', count: 1 });
    expect(tag.workTotal).toBe(1);

    const studio = searchEntities('独家公司XYZ', 5);
    expect(studio.studios[0]).toMatchObject({ value: '独家公司XYZ', count: 1 });
    expect(studio.staff[0]).toMatchObject({ name: '独家公司XYZ', works: 1 });
    expect(ids({ q: '独家公司XYZ' })).toEqual([3]);
  });

  it('关键词可以与其它条件叠加（显式「在当前结果中继续筛选」）', async () => {
    // 关键词命中标签，再叠加状态条件——语义明确：两个条件都满足
    const page = listSubjects({ q: '黄段子', status: [2], pageSize: 10 });
    expect(page.items.map((item) => item.id).sort()).toEqual([1, 2]);
  });

  it('连续不同的关键词彼此独立，不会互相污染', () => {
    const first = listSubjects({ q: '黄段子', pageSize: 10 });
    expect(first.items.map((item) => item.id).sort()).toEqual([1, 2]);

    // 第二次搜索是全新的关键词：不应该被上一次的结果限制
    const second = listSubjects({ q: '独家公司XYZ', pageSize: 10 });
    expect(second.items.map((item) => item.id)).toEqual([3]);

    const third = listSubjects({ q: 'Seitokai', pageSize: 10 });
    expect(third.items.map((item) => item.id).sort()).toEqual([1, 2]);
  });
});
