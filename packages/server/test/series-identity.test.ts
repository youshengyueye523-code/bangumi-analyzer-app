import { beforeEach, describe, expect, it } from 'vitest';
import { all, run } from '../src/db/index.js';
import { recomputeSeries, confirmFranchise, resolveEntityKey } from '../src/db/series.js';
import {
  getFranchiseDetail,
  getRelationAudit,
  getSeriesDetail,
  listFranchises,
  listSeries,
} from '../src/db/query.js';
import { resetDatabase } from './helpers.js';

function seedSubject(
  id: number,
  nameCn: string,
  options: { year?: number; format?: string; collected?: boolean; tags?: string[] } = {},
): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, year, format, tag_names, created_at, updated_at)
     VALUES (:id, :name, :nameCn, :year, :format, :tags, :ts, :ts)`,
    {
      id,
      name: nameCn,
      nameCn,
      year: options.year ?? 2000 + (id % 20),
      format: options.format ?? 'TV',
      tags: JSON.stringify(options.tags ?? []),
      ts: '2026-01-01T00:00:00.000Z',
    },
  );
  if (options.collected !== false) {
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, first_seen_at, synced_at)
       VALUES (:id, 2, 2, 0, :ts, :ts)`,
      { id, ts: '2026-01-01T00:00:00.000Z' },
    );
  }
}

function seedRelation(from: number, to: number, relation: string): void {
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:from, :to, :relation, 2, '', '', :ts)`,
    { from, to, relation, ts: '2026-01-01T00:00:00.000Z' },
  );
}

describe('entity identity stability', () => {
  beforeEach(() => resetDatabase());

  it('重建幂等：成员不变时 key / 名称 / 数量都不变', () => {
    seedSubject(1, '测试系列', { year: 2019 });
    seedSubject(2, '测试系列 第二季', { year: 2020 });
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');

    recomputeSeries();
    const first = listSeries({ includeSingletons: true });
    recomputeSeries();
    recomputeSeries();
    const second = listSeries({ includeSingletons: true });

    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
  });

  it.each(['{}', '[null,123,"科幻"]'])('异常历史元数据不能阻断实体重算或改写原始证据：%s', (invalid) => {
    seedSubject(1, '旧数据系列');
    seedSubject(2, '旧数据系列 第二季');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();
    const first = listSeries({ includeSingletons: true });
    run('UPDATE subjects SET tag_names=:invalid, originals=:invalid, studios=:invalid, directors=:invalid WHERE id=1', { invalid });
    const before = all('SELECT * FROM subjects ORDER BY id');
    expect(() => recomputeSeries()).not.toThrow();
    expect(() => recomputeSeries()).not.toThrow();
    const after = listSeries({ includeSingletons: true });
    expect(after.map((entry) => [entry.key, entry.title])).toEqual(first.map((entry) => [entry.key, entry.title]));
    expect(getSeriesDetail(after[0]!.key)?.members.map((member) => member.subjectId).sort()).toEqual([1, 2]);
    expect(all('SELECT * FROM subjects ORDER BY id')).toEqual(before);
  });

  it('新成员加入已有系列时，实体 key 与名称保持不变', () => {
    seedSubject(1, '测试系列', { year: 2019 });
    seedSubject(2, '测试系列 第二季', { year: 2020 });
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();
    const before = listSeries({ includeSingletons: true })[0]!;

    // 新增第三季（增量同步场景）
    seedSubject(3, '测试系列 第三季', { year: 2021 });
    seedRelation(2, 3, '续集');
    seedRelation(3, 2, '前传');
    recomputeSeries();

    const after = listSeries({ includeSingletons: true })[0]!;
    expect(after.key).toBe(before.key);
    expect(after.title).toBe(before.title);
    expect(after.memberCount).toBe(3);
  });

  it('弱关系（相同世界观）加入后不改变任何实体的 key / 名称', () => {
    seedSubject(1, '作品 A', { year: 2019 });
    seedSubject(2, '作品 A 第二季', { year: 2020 });
    seedSubject(3, '作品 B', { year: 2021 });
    seedSubject(4, '作品 B 第二季', { year: 2022 });
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    seedRelation(3, 4, '续集');
    seedRelation(4, 3, '前传');
    recomputeSeries();
    const before = listSeries({ includeSingletons: true }).map((entry) => [entry.key, entry.title]);

    seedRelation(3, 1, '相同世界观');
    seedRelation(1, 3, '相同世界观');
    recomputeSeries();
    const after = listSeries({ includeSingletons: true }).map((entry) => [entry.key, entry.title]);

    expect(after).toEqual(before);
    expect(listSeries({ includeSingletons: true })).toHaveLength(2);
  });
});

describe('legacy key alias', () => {
  beforeEach(() => resetDatabase());

  it('旧 bgm:<id> key 通过 alias 解析到新实体，并给出 canonical key', () => {
    seedSubject(1, '测试系列', { year: 2019 });
    seedSubject(2, '测试系列 第二季', { year: 2020 });
    seedRelation(1, 2, '续集');
    run(
      `INSERT INTO series_legacy_snapshot (old_key, title, source, member_ids, captured_at)
       VALUES ('bgm:1', '测试系列', 'bgm-relation', '[1,2]', '2026-01-01T00:00:00.000Z')`,
    );

    recomputeSeries();

    const resolved = resolveEntityKey('series', 'bgm:1');
    expect(resolved).toBeTruthy();
    expect(resolved!.key.startsWith('sr_')).toBe(true);
    const detail = getSeriesDetail('bgm:1');
    expect(detail).toBeTruthy();
    expect(detail!.aliasedFrom).toBe('bgm:1');
    expect(detail!.canonicalKey).toBe(resolved!.key);
    // 别名指向真实实体
    const aliases = all<{ alias_key: string; entity_id: number }>(
      'SELECT alias_key, entity_id FROM entity_aliases',
    );
    expect(aliases.map((row) => row.alias_key)).toContain('bgm:1');
  });
});

describe('franchise confirmation is never silently overwritten', () => {
  beforeEach(() => resetDatabase());

  it('确认后的家族保持 confirmed，新证据只产生候选成员', () => {
    seedSubject(1, 'Franchise 作品 2003', { year: 2003 });
    seedSubject(2, 'Franchise 作品 第二季', { year: 2004 });
    seedSubject(3, 'Franchise 作品 2009', { year: 2009 });
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    seedRelation(1, 3, '不同演绎');
    seedRelation(3, 1, '不同演绎');
    recomputeSeries();

    const candidate = listFranchises()[0]!;
    expect(candidate.state).toBe('candidate');
    expect(confirmFranchise(candidate.key)).toBe(true);

    const confirmed = getFranchiseDetail(candidate.key)!;
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.confirmedSeriesCount).toBe(2);

    // 新的不同演绎作品加入：允许作为候选成员出现，但不得改变 confirmed 状态与名称
    seedSubject(4, 'Franchise 作品 2024', { year: 2024 });
    seedRelation(4, 3, '不同演绎');
    seedRelation(3, 4, '不同演绎');
    recomputeSeries();

    const after = getFranchiseDetail(candidate.key)!;
    expect(after.state).toBe('confirmed');
    expect(after.title).toBe(confirmed.title);
    const linkStates = after.series.map((entry) => entry.linkState);
    expect(linkStates).toContain('confirmed');
    if (after.series.length > confirmed.series.length) {
      expect(linkStates).toContain('candidate');
    }
  });
});

describe('unknown relation safety', () => {
  beforeEach(() => resetDatabase());

  it('未知关系不会合并实体，并出现在关系审计中', () => {
    seedSubject(1, '作品 A');
    seedSubject(2, '作品 B');
    seedRelation(1, 2, '其他');
    recomputeSeries();

    const series = listSeries({ includeSingletons: true });
    expect(series).toHaveLength(2);
    const audit = getRelationAudit();
    expect(audit.unknownCount).toBe(1);
    expect(audit.entries.find((entry) => entry.relation === '其他')?.klass).toBe('unknown');
  });
});

describe('未确认展示名的可改善性', () => {
  beforeEach(() => resetDatabase());

  it('新增强证据成员后，display title 自动改善且 identity 不变', () => {
    // 初始：只有一个核心作品（标题本身不完整）+ 一个衍生广播成员 → 只能给出暂定名
    seedSubject(1, '测试系列 A');
    seedSubject(2, '测试系列 广播剧');
    seedRelation(1, 2, '番外篇');
    seedRelation(2, 1, '衍生');
    recomputeSeries();
    const before = listSeries({ includeSingletons: true })[0]!;
    expect(before.titleState).toBe('provisional');
    expect(before.title).toBe('测试系列 A');

    // 新增连续性续集：核心成员增加，品牌证据增强
    seedSubject(3, '测试系列 第二季');
    seedRelation(1, 3, '续集');
    seedRelation(3, 1, '前传');
    recomputeSeries();
    const after = listSeries({ includeSingletons: true })[0]!;

    expect(after.key).toBe(before.key);
    expect(after.title).toBe('测试系列');
    expect(after.titleState).toBe('resolved');
  });
});
