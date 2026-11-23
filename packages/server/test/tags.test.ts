import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/schema.js';
import { migrate } from '../src/db/index.js';
import { aggregateTags, getFilterFacets, listSubjects } from '../src/db/query.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import {
  FakeBangumiClient,
  makeCollectionItem,
  makeSubject,
  resetDatabase,
  runSync,
} from './helpers.js';

/** 第 25 个之后的标签：早期版本会被截断，必须仍然可筛选 */
const LONG_TAIL_TAGS = Array.from({ length: 12 }, (_, index) => `长尾标签${index + 1}`);

function tagObjects(names: string[]) {
  return names.map((name, index) => ({
    name,
    count: 100 - index,
    total_count: 1000 + index,
  }));
}

const TAG_FIXTURE = [
  {
    id: 1,
    tags: ['共同标签', '恋爱', '奇幻', '战斗', ...LONG_TAIL_TAGS],
    rate: 9,
    type: 2,
  },
  { id: 2, tags: ['共同标签', '奇幻', '日常'], rate: 8, type: 2 },
  { id: 3, tags: ['共同标签', '战斗', '日常'], rate: 5, type: 2 },
  { id: 4, tags: ['日常'], rate: 0, type: 1 },
];

function buildClient(): FakeBangumiClient {
  return new FakeBangumiClient({
    collections: TAG_FIXTURE.map((entry) =>
      makeCollectionItem({
        subject_id: entry.id,
        type: entry.type,
        rate: entry.rate,
        subject: {
          id: entry.id,
          type: 2,
          name: `Tag Test ${entry.id}`,
          name_cn: `标签测试 ${entry.id}`,
          short_summary: '',
          date: '2020-04-01',
          images: {},
          volumes: 0,
          eps: 12,
          collection_total: 100,
          score: 7.5,
          rank: 100,
          // 收藏列表里的标签由详情接口覆盖，这里给最少信息即可
          tags: tagObjects(entry.tags.slice(0, 3)),
        },
      }),
    ),
    subjects: Object.fromEntries(
      TAG_FIXTURE.map((entry) => [
        entry.id,
        makeSubject({
          id: entry.id,
          name_cn: `标签测试 ${entry.id}`,
          tags: tagObjects(entry.tags),
          infobox: [
            { key: '中文名', value: `标签测试 ${entry.id}` },
            { key: '动画制作', value: '测试公司' },
          ],
        }),
      ]),
    ),
    // 制作人员：一个人参与 2 部作品（覆盖「脚本」这类没有专用筛选器的关系）
    persons: {
      1: [
        { id: 101, name: '脚本甲', relation: '脚本', career: ['脚本'], type: 1 },
        { id: 102, name: '导演乙', relation: '导演', career: ['导演'], type: 1 },
      ],
      2: [{ id: 101, name: '脚本甲', relation: '脚本', career: ['脚本'], type: 1 }],
      3: [{ id: 103, name: '脚本丙', relation: '脚本', career: ['脚本'], type: 1 }],
      4: [],
    },
  });
}

async function seed(): Promise<void> {
  await runSync(buildClient(), { depth: 2 });
}

describe('标签数据完整性', () => {
  beforeEach(() => {
    resetDatabase();
  });

  it('同步后保留接口返回的全部标签（不再截断到 24 个）', async () => {
    await seed();
    const dataset = buildProfileDataset();
    expect(dataset.sample.total).toBe(4);

    const facets = getFilterFacets();
    // 长尾标签（第 25 个之后）必须存在
    for (const tag of LONG_TAIL_TAGS) {
      expect(facets.tags.some((item) => item.value === tag)).toBe(true);
    }
  });

  it('筛选器返回的标签总数与数据库实际去重标签数一致', async () => {
    await seed();
    const facets = getFilterFacets();
    const expected = new Set(TAG_FIXTURE.flatMap((entry) => entry.tags));
    expect(facets.tagTotal).toBe(expected.size);
    expect(facets.tags.length).toBe(expected.size);
    for (const tag of expected) {
      expect(facets.tags.some((item) => item.value === tag)).toBe(true);
    }
  });

  it('按标签筛选只会返回真正带有该标签的作品', async () => {
    await seed();
    for (const tag of ['共同标签', '日常', '战斗', LONG_TAIL_TAGS[5]!]) {
      const page = listSubjects({ tags: [tag], pageSize: 50 });
      const expectedIds = TAG_FIXTURE.filter((entry) => entry.tags.includes(tag))
        .map((entry) => entry.id)
        .sort((a, b) => a - b);
      expect(page.items.map((item) => item.id).sort((a, b) => a - b)).toEqual(expectedIds);
    }
  });

  it('多标签组合筛选支持「任意命中」与「同时具备」', async () => {
    await seed();
    const any = listSubjects({ tags: ['恋爱', '日常'], tagMode: 'any', pageSize: 50 });
    expect(any.items.map((item) => item.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    const all = listSubjects({ tags: ['共同标签', '日常'], tagMode: 'all', pageSize: 50 });
    expect(all.items.map((item) => item.id).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('作品详情里的标签与数据库保存的标签完全一致', async () => {
    await seed();
    const detail = listSubjects({ q: '标签测试 1', pageSize: 1 }).items[0]!;
    expect(detail.tags).toEqual(TAG_FIXTURE[0]!.tags);
  });
});

describe('制作人员 → 作品 → 标签 反向追溯', () => {
  beforeEach(() => {
    resetDatabase();
  });

  it('可以用任意关系的人员姓名筛出作品', async () => {
    await seed();
    // 脚本甲参与了 1、2 两部作品（「脚本」没有专用筛选器，走 staff）
    const page = listSubjects({ staff: ['脚本甲'], pageSize: 50 });
    expect(page.items.map((item) => item.id).sort((a, b) => a - b)).toEqual([1, 2]);

    const director = listSubjects({ staff: ['导演乙'], pageSize: 50 });
    expect(director.items.map((item) => item.id)).toEqual([1]);
  });

  it('在人员筛选结果内聚合标签（反向追溯核心 SQL）', async () => {
    await seed();
    const scope = aggregateTags({ staff: ['脚本甲'] });
    expect(scope.matchedSubjects).toBe(2);
    // 脚本甲的作品标签 = 作品 1 ∪ 作品 2
    expect(scope.tags.map((item) => item.value).sort()).toEqual(
      [...new Set([...TAG_FIXTURE[0]!.tags, ...TAG_FIXTURE[1]!.tags])].sort(),
    );
    // 计数与作品数一致
    const shared = scope.tags.find((item) => item.value === '共同标签');
    expect(shared?.count).toBe(2);
    const onlyFirst = scope.tags.find((item) => item.value === '恋爱');
    expect(onlyFirst?.count).toBe(1);
  });

  it('人员作品较少 / 较多时都能正确聚合', async () => {
    await seed();
    const few = aggregateTags({ staff: ['脚本丙'] });
    expect(few.matchedSubjects).toBe(1);
    expect(few.tags.length).toBeGreaterThan(0);

    const all = aggregateTags({});
    expect(all.matchedSubjects).toBe(4);
    expect(all.tags.length).toBeGreaterThan(few.tags.length);
  });

  it('人员 + 标签组合筛选（先筛人再筛标签）', async () => {
    await seed();
    const page = listSubjects({ staff: ['脚本甲'], tags: ['日常'], pageSize: 50 });
    expect(page.items.map((item) => item.id)).toEqual([2]);
  });
});

describe('迁移与重启后的一致性', () => {
  beforeEach(() => {
    resetDatabase();
  });

  it('v4 迁移会从原始 tags 重建被截断的 tag_names', () => {
    // 构造一个停留在 v3 的库：tag_names 只有前 3 个标签，tags 保存完整数据
    const legacy = new DatabaseSync(':memory:');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 3)) {
      legacy.exec(migration.sql);
      legacy.exec(`PRAGMA user_version = ${migration.version}`);
    }
    legacy
      .prepare(
        `INSERT INTO subjects (id, type, name, name_cn, tag_names, tags, created_at, updated_at)
         VALUES (1, 2, 'Legacy', '旧数据', :tagNames, :tags, '2024-01-01', '2024-01-01')`,
      )
      .run({
        tagNames: JSON.stringify(['甲', '乙', '丙']),
        tags: JSON.stringify([
          { name: '甲', count: 1, total_count: 1 },
          { name: '乙', count: 1, total_count: 1 },
          { name: '丙', count: 1, total_count: 1 },
          { name: '丁', count: 1, total_count: 1 },
          { name: '戊', count: 1, total_count: 1 },
        ]),
      });

    migrate(legacy);

    const row = legacy.prepare('SELECT tag_names FROM subjects WHERE id = 1').get() as {
      tag_names: string;
    };
    expect(JSON.parse(row.tag_names)).toEqual(['甲', '乙', '丙', '丁', '戊']);
    expect(Number(legacy.prepare('PRAGMA user_version').get()?.user_version)).toBeGreaterThanOrEqual(4);
    legacy.close();
  });

  it('数据重新打开后标签统计保持一致', async () => {
    await seed();
    const before = getFilterFacets();
    const scopeBefore = aggregateTags({ staff: ['脚本甲'] });

    // 关闭并重新打开数据库，模拟重启项目
    const { closeDatabase, openDatabase } = await import('../src/db/index.js');
    closeDatabase();
    openDatabase();

    const after = getFilterFacets();
    const scopeAfter = aggregateTags({ staff: ['脚本甲'] });
    expect(after.tagTotal).toBe(before.tagTotal);
    expect(after.tags.map((item) => item.value).sort()).toEqual(
      before.tags.map((item) => item.value).sort(),
    );
    expect(scopeAfter.tags).toEqual(scopeBefore.tags);
    expect(scopeAfter.matchedSubjects).toBe(scopeBefore.matchedSubjects);
  });
});
