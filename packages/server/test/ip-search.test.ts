import { beforeEach, describe, expect, it } from 'vitest';
import { all, dataVersion, run } from '../src/db/index.js';
import { searchFranchiseEntities, searchSeriesEntities } from '../src/db/ipSearch.js';
import {
  applySeriesTitleOverride,
  recomputeSeries,
  resetSeriesTitleOverride,
} from '../src/db/series.js';
import { listFranchises, listSeries } from '../src/db/query.js';
import { resetDatabase } from './helpers.js';

function seedSubject(
  id: number,
  nameCn: string,
  options: { year?: number; aliases?: string[]; collected?: boolean } = {},
): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, aliases, year, format, tag_names, created_at, updated_at)
     VALUES (:id, :name, :nameCn, :aliases, :year, 'TV', '[]', :ts, :ts)`,
    {
      id,
      name: nameCn,
      nameCn,
      aliases: JSON.stringify(options.aliases ?? []),
      year: options.year ?? 2000 + (id % 20),
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

function seriesKeyByTitle(title: string): string {
  const hit = listSeries({ includeSingletons: true }).find((entry) => entry.title === title);
  if (!hit) throw new Error(`series not found: ${title}`);
  return hit.key;
}

describe('Series / IP 域内搜索', () => {
  beforeEach(() => resetDatabase());

  it.each([
    { field: 'title_candidates', raw: '{}' },
    { field: 'title_candidates', raw: '[null,{"valid":true,"title":123},{"valid":true,"title":"有效候选"}]' },
    { field: 'aliases', raw: '[null,123,"有效别名"]' },
  ])('异常历史 $field 不阻断实体搜索或改写原始证据', ({ field, raw }) => {
    seedSubject(1, '测试家族');
    seedSubject(2, '测试家族 第二季');
    seedSubject(3, '测试家族 新作');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    seedRelation(1, 3, '不同演绎');
    seedRelation(3, 1, '不同演绎');
    recomputeSeries();
    if (field === 'aliases') {
      run('UPDATE subjects SET aliases=:raw', { raw });
    } else {
      run('UPDATE series_entities SET title_candidates=:raw', { raw });
      run('UPDATE franchise_entities SET title_candidates=:raw', { raw });
    }
    const before = [all('SELECT * FROM subjects'), all('SELECT * FROM series_entities'), all('SELECT * FROM franchise_entities')];
    const version = dataVersion();
    expect(() => searchSeriesEntities('测试家族')).not.toThrow();
    expect(() => searchFranchiseEntities('测试家族')).not.toThrow();
    expect(searchSeriesEntities('测试家族').total).toBe(2);
    expect(searchFranchiseEntities('测试家族').total).toBe(1);
    expect(searchSeriesEntities('123').total).toBe(0);
    if (raw.includes('有效')) {
      const query = field === 'aliases' ? '有效别名' : '有效候选';
      expect(searchSeriesEntities(query).total).toBe(2);
      expect(searchFranchiseEntities(query).total).toBe(1);
    }
    expect([all('SELECT * FROM subjects'), all('SELECT * FROM series_entities'), all('SELECT * FROM franchise_entities')]).toEqual(before);
    expect(dataVersion()).toBe(version);
  });

  it('部分匹配 + 标题命中原因', () => {
    seedSubject(1, '孤独摇滚！');
    seedSubject(2, '孤独摇滚！ 第二季');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();

    const result = searchSeriesEntities('孤独');
    expect(result.total).toBe(1);
    expect(result.items[0]!.title).toBe('孤独摇滚！');
    expect(result.items[0]!.matchReasons.some((reason) => reason.type === 'title')).toBe(true);
  });

  it('搜索域覆盖单成员 Series（即使列表默认隐藏）', () => {
    seedSubject(1, '独自一人的作品');
    recomputeSeries();
    // 默认列表不显示单成员
    expect(listSeries({}).some((entry) => entry.title === '独自一人的作品')).toBe(false);
    const result = searchSeriesEntities('独自一人');
    expect(result.total).toBe(1);
    expect(result.items[0]!.memberCount).toBe(1);
  });

  it('同一 Series 的多个成员命中只返回一个结果（聚合 + 去重）', () => {
    seedSubject(1, '物语系列');
    seedSubject(2, '物语系列 第二季');
    seedSubject(3, '猫物语（黑）');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    seedRelation(2, 3, '续集');
    seedRelation(3, 2, '前传');
    recomputeSeries();

    const result = searchSeriesEntities('物语');
    expect(result.total).toBe(1);
    const hit = result.items[0]!;
    expect(hit.title).toBe('物语系列');
    // 命中来源可以有多条，但实体只出现一次
    expect(hit.matchReasons.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hit.matchReasons.map((reason) => reason.text)).size).toBe(
      hit.matchReasons.length,
    );
  });

  it('成员别名可召回 Series（来自 subjects.aliases，而不是 tag）', () => {
    seedSubject(1, 'CLANNAD', { aliases: ['小镇家族'] });
    seedSubject(2, 'CLANNAD ～AFTER STORY～');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();

    const result = searchSeriesEntities('小镇家族');
    expect(result.total).toBe(1);
    expect(result.items[0]!.title).toBe('CLANNAD');
    const reason = result.items[0]!.matchReasons.find((entry) => entry.type === 'member-alias');
    expect(reason?.text).toBe('小镇家族');
  });

  it('排序：标题完全匹配优先于成员命中', () => {
    seedSubject(1, '孤独');
    recomputeSeries();
    seedSubject(2, '孤独摇滚！');
    seedSubject(3, '孤独摇滚！ 第二季');
    seedRelation(2, 3, '续集');
    seedRelation(3, 2, '前传');
    recomputeSeries();

    const result = searchSeriesEntities('孤独');
    expect(result.items[0]!.title).toBe('孤独');
    expect(result.items[1]!.title).toBe('孤独摇滚！');
  });

  it('归一化匹配：忽略空格与标点', () => {
    seedSubject(1, '孤独摇滚！');
    recomputeSeries();
    expect(searchSeriesEntities('孤独 摇滚').total).toBe(1);
    expect(searchSeriesEntities('孤独、摇滚').total).toBe(1);
  });

  it('Title Review 生命周期：manual 改名立即生效，reset 后回到自动标题', () => {
    seedSubject(1, '自动标题');
    seedSubject(2, '自动标题 第二季');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();
    const key = seriesKeyByTitle('自动标题');
    expect(searchSeriesEntities('自动标题').total).toBe(1);

    const overridden = applySeriesTitleOverride(key, { mode: 'custom', title: '人工新标题' });
    expect(overridden.ok).toBe(true);
    const afterOverride = searchSeriesEntities('人工新标题');
    expect(afterOverride.total).toBe(1);
    expect(afterOverride.items[0]!.key).toBe(key);
    expect(afterOverride.items[0]!.matchReasons.some((reason) => reason.type === 'title')).toBe(true);
    // 旧标题仍是 resolver 的有效候选 → 作为成员/别名合法召回，但不再作为当前标题；
    // 由于同一文本的 alias 与 member 会合并展示，这里只断言「不是 title 命中」且能召回
    const legacy = searchSeriesEntities('自动标题');
    expect(legacy.items[0]!.matchReasons.every((reason) => reason.type !== 'title')).toBe(true);
    expect(legacy.items[0]!.matchReasons.some((reason) => reason.text === '自动标题')).toBe(true);

    resetSeriesTitleOverride(key);
    expect(searchSeriesEntities('自动标题').total).toBe(1);
    // 人工标题不是成员标题 → reset 后不应再召回
    expect(searchSeriesEntities('人工新标题').total).toBe(0);
  });

  it('被否决的候选不进入有效搜索词', () => {
    seedSubject(1, '正常系列');
    seedSubject(2, '正常系列 第二季');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();
    const key = seriesKeyByTitle('正常系列');

    // 模拟 resolver 写入的「结构异常候选」：只存在于候选列表，且被标记 invalid
    run(
      `UPDATE series_entities
          SET title_candidates = json_insert(title_candidates, '$[#]',
                json_object('title', '不该被搜到的截断候选(', 'source', 'brand:members',
                            'state', 'provisional', 'evidence', 'synthetic',
                            'valid', json('false'), 'rejectReason', '括号未闭合',
                            'support', 1, 'coverage', 0.1))
        WHERE key = :key`,
      { key },
    );
    expect(searchSeriesEntities('不该被搜到的截断候选').total).toBe(0);

    // valid 缺失（旧数据 / 未知来源）同样不进入搜索索引：只有明确 valid=true 才作为 alias
    run(
      `UPDATE series_entities
          SET title_candidates = json_insert(title_candidates, '$[#]',
                json_object('title', '未知有效性的候选词', 'source', 'brand:members',
                            'state', 'provisional', 'evidence', 'legacy row',
                            'support', 1, 'coverage', 0.1))
        WHERE key = :key`,
      { key },
    );
    expect(searchSeriesEntities('未知有效性的候选词').total).toBe(0);
  });

  it('Franchise 搜索：成员作品命中后聚合到家族', () => {
    seedSubject(1, '家族作品');
    seedSubject(2, '家族作品 第二季');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    seedSubject(3, '家族作品 新作');
    seedRelation(1, 3, '不同演绎');
    seedRelation(3, 1, '不同演绎');
    recomputeSeries();

    const franchise = listFranchises()[0]!;
    const result = searchFranchiseEntities('新作');
    expect(result.total).toBe(1);
    expect(result.items[0]!.key).toBe(franchise.key);
    expect(
      result.items[0]!.matchReasons.some(
        (reason) => reason.type === 'member' || reason.type === 'series',
      ),
    ).toBe(true);
  });

  it('空查询返回空结果，不返回全部实体', () => {
    seedSubject(1, '任意作品');
    recomputeSeries();
    expect(searchSeriesEntities('   ').total).toBe(0);
    expect(searchFranchiseEntities('').total).toBe(0);
  });

  it('成员作品标题命中会回到所属 Series（Fine 场景）', () => {
    seedSubject(1, '路人女主的养成方法');
    seedSubject(2, '路人女主的养成方法 Fine');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();

    const result = searchSeriesEntities('Fine');
    expect(result.total).toBe(1);
    expect(result.items[0]!.title).toBe('路人女主的养成方法');
    expect(result.items[0]!.matchReasons.some((reason) => reason.type === 'member')).toBe(true);
  });

  it('同一 Subject 同时作为 alias 与 member 命中时，用户可见原因只保留一条', () => {
    // 化物语场景：series 标题由标签推出，化物语同时是有效候选（alias）与成员
    seedSubject(1, '化物语', { aliases: ['化物语'] });
    seedSubject(2, '伪物语');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    run(`UPDATE subjects SET tag_names = '["物语系列"]' WHERE id IN (1, 2)`);
    recomputeSeries();

    const result = searchSeriesEntities('化物语');
    expect(result.total).toBe(1);
    expect(result.items[0]!.title).toBe('物语系列');

    const reasons = result.items[0]!.matchReasons;
    const normalized = reasons.map((reason) =>
      reason.text.trim().toLowerCase().replace(/[\s\p{P}]+/gu, ''),
    );
    // 不再出现「命中别名：化物语 + 命中成员：化物语」这类同文本重复
    expect(new Set(normalized).size).toBe(normalized.length);
    const matched = reasons.filter((reason) => reason.text === '化物语');
    expect(matched).toHaveLength(1);
    // 具体证据优先：保留成员命中而不是抽象的 alias 命中
    expect(matched[0]!.type).toBe('member');
  });

  it('不同文本的命中原因不会被误合并，且排名不变', () => {
    seedSubject(1, '化物语', { aliases: ['化物语'] });
    seedSubject(2, '伪物语');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    run(`UPDATE subjects SET tag_names = '["物语系列"]' WHERE id IN (1, 2)`);
    recomputeSeries();

    const result = searchSeriesEntities('物语');
    expect(result.total).toBe(1);
    const reasons = result.items[0]!.matchReasons;
    // 标题（物语系列）与两个不同成员文本都要保留
    expect(reasons.some((reason) => reason.type === 'title')).toBe(true);
    expect(reasons.some((reason) => reason.text === '化物语')).toBe(true);
    expect(reasons.some((reason) => reason.text === '伪物语')).toBe(true);
    // 排序语义不变：标题仍排在最前
    expect(reasons[0]!.type).toBe('title');
  });

  it('去重后的原因数量仍然受上限约束（≤ 5）', () => {
    for (let id = 1; id <= 8; id += 1) {
      seedSubject(id, `测试系列 作品${id}`);
      if (id > 1) {
        seedRelation(id - 1, id, '续集');
        seedRelation(id, id - 1, '前传');
      }
    }
    recomputeSeries();

    const result = searchSeriesEntities('测试系列');
    expect(result.total).toBe(1);
    expect(result.items[0]!.matchReasons.length).toBeLessThanOrEqual(5);
  });
});
