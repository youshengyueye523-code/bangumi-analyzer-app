import { describe, expect, it } from 'vitest';
import { classifyRelation } from '../src/series/taxonomy.js';
import {
  resolveGraph,
  type EngineEdge,
  type EngineNode,
  type ResolverOptions,
} from '../src/series/resolver.js';
import { resolveTitle, validateCandidateStructure } from '../src/series/title.js';

function node(
  id: number,
  nameCn: string,
  options: { year?: number; format?: string; collected?: boolean; tags?: string[] } = {},
): EngineNode {
  return {
    id,
    name: nameCn,
    nameCn,
    year: options.year ?? 2000 + (id % 20),
    totalEpisodes: 12,
    format: options.format ?? 'TV',
    collected: options.collected ?? true,
    collectionType: options.collected === false ? null : 2,
    rate: 8,
    hasDetail: options.collected !== false,
    tags: options.tags ?? [],
    originals: [],
    studios: [],
    directors: [],
  };
}

function edge(from: number, to: number, relation: string): EngineEdge {
  const kind = classifyRelation(relation);
  return { from, to, relation, klass: kind.klass, polarity: kind.polarity };
}

function options(patch: Partial<ResolverOptions> = {}): ResolverOptions {
  return {
    tagFrequency: new Map(),
    rareTagLimit: 10,
    isExcludedTag: (tag) => tag === 'TV',
    ...patch,
  };
}

describe('series resolver — adversarial cases', () => {
  it('连续性关系形成同一个 Series，并给出结构化理由', () => {
    const nodes = new Map([
      [1, node(1, '第一季', { year: 2019 })],
      [2, node(2, '第二季', { year: 2020 })],
      [3, node(3, 'OVA', { year: 2021, format: 'OVA' })],
    ]);
    const edges = [edge(1, 2, '续集'), edge(2, 1, '前传'), edge(2, 3, '番外篇'), edge(3, 2, '主线故事')];
    const out = resolveGraph(nodes, edges, options());
    expect(out.series).toHaveLength(1);
    const series = out.series[0]!;
    expect(series.primaryIds).toEqual([1, 2, 3]);
    // 锚点选择非 OVA 的最早作品
    expect(series.anchorId).toBe(1);
    const reasons = new Map(series.members.map((member) => [member.subjectId, member.reasonCode]));
    expect(reasons.get(1)).toBe('anchor');
    expect(reasons.get(2)).toBe('continuity:续集');
    expect(reasons.get(3)).toBe('continuity:主线故事');
  });

  it('相同世界观不会合并成 Series（辉夜 / 我推 场景）', () => {
    const nodes = new Map([
      [1, node(1, '辉夜大小姐想让我告白', { year: 2019 })],
      [2, node(2, '辉夜大小姐想让我告白 第二季', { year: 2020 })],
      [3, node(3, '【我推的孩子】', { year: 2023 })],
      [4, node(4, '【我推的孩子】 第二季', { year: 2024 })],
    ]);
    const edges = [
      edge(1, 2, '续集'),
      edge(3, 4, '续集'),
      edge(3, 1, '相同世界观'),
      edge(1, 3, '相同世界观'),
    ];
    const out = resolveGraph(nodes, edges, options());
    expect(out.series).toHaveLength(2);
    const sizes = out.series.map((series) => series.primaryIds.length).sort();
    expect(sizes).toEqual([2, 2]);
    // 弱关联不产生家族（缺少第二类证据）
    expect(out.franchises).toHaveLength(0);
  });

  it('未收藏中继节点不再阻断同一 Series（空之境界第七章场景）', () => {
    const nodes = new Map([
      [1, node(1, '第一章', { year: 2007, format: '剧场版' })],
      [2, node(2, '第七章', { year: 2009, format: '剧场版', collected: false })],
      [3, node(3, '未来福音', { year: 2013, format: '剧场版' })],
    ]);
    const edges = [edge(1, 2, '续集'), edge(2, 1, '前传'), edge(3, 2, '前传'), edge(2, 3, '续集')];
    const out = resolveGraph(nodes, edges, options());
    expect(out.series).toHaveLength(1);
    expect(out.series[0]!.primaryIds).toEqual([1, 2, 3]);
    expect(out.series[0]!.coverage).toBe('partial');
  });

  it('未知关系默认不合并，并进入审计', () => {
    const nodes = new Map([
      [1, node(1, '作品 A')],
      [2, node(2, '作品 B')],
    ]);
    const out = resolveGraph(nodes, [edge(1, 2, '未来新关系')], options());
    expect(out.series).toHaveLength(2);
    expect(out.series.every((series) => series.primaryIds.length === 1)).toBe(true);
    expect(out.unknownRelations.get('未来新关系')).toBe(1);
  });

  it('不同演绎各自成 Series，但可以提出 Franchise 候选', () => {
    const nodes = new Map([
      [1, node(1, '钢之炼金术师 2003', { year: 2003 })],
      [2, node(2, '钢之炼金术师 FA', { year: 2009 })],
      [3, node(3, '钢之炼金术师 剧场版', { year: 2005, format: '剧场版' })],
    ]);
    const edges = [edge(1, 2, '不同演绎'), edge(2, 1, '不同演绎'), edge(1, 3, '总集篇')];
    const out = resolveGraph(nodes, edges, options());
    // 不同演绎不合并 1 / 2；但总集篇把 3 并入 1
    expect(out.series).toHaveLength(2);
    const sizes = out.series.map((series) => series.primaryIds.length).sort();
    expect(sizes).toEqual([1, 2]);
    expect(out.franchises).toHaveLength(1);
    expect(out.franchises[0]!.seriesLocalIds).toHaveLength(2);
  });

  it('单成员 Series 在数据层存在', () => {
    const nodes = new Map([[1, node(1, '独立作品')]]);
    const out = resolveGraph(nodes, [], options());
    expect(out.series).toHaveLength(1);
    expect(out.series[0]!.primaryIds).toEqual([1]);
    expect(out.series[0]!.state).toBe('stable');
  });

  it('缺失 relation 时使用标题启发式，但标记为推测', () => {
    const nodes = new Map([
      [1, node(1, '进击的巨人', { year: 2013 })],
      [2, node(2, '进击的巨人 第二季', { year: 2017 })],
      [3, node(3, '完全无关的作品', { year: 2013 })],
    ]);
    const out = resolveGraph(nodes, [], options());
    const heuristic = out.series.find((series) => series.state === 'provisional');
    expect(heuristic).toBeTruthy();
    expect(heuristic!.primaryIds).toEqual([1, 2]);
    expect(out.series.some((series) => series.primaryIds.includes(3))).toBe(true);
  });
});

describe('canonical title 证据', () => {
  const member = (title: string, core = true, tags: string[] = []) => ({ title, core, tags });

  it('成员标题品牌优先于成员自身标题（空之境界场景）', () => {
    const result = resolveTitle({
      members: [
        member('剧场版 空之境界 第一章 俯瞰风景'),
        member('剧场版 空之境界 第二章 杀人考察（前）'),
        member('剧场版 空之境界 终章 空之境界'),
      ],
      tagFrequency: new Map(),
      rareTagLimit: 10,
      isExcludedTag: () => true,
      anchorTitle: '剧场版 空之境界 第一章 俯瞰风景',
      singleton: false,
      fallbackLabel: '未确认系列',
    });
    expect(result.title).toBe('空之境界');
    expect(result.source).toBe('brand:members');
  });

  it('无共同品牌时使用稀有品牌标签（物语系列场景）', () => {
    const result = resolveTitle({
      members: [
        member('化物语', true, ['物语系列']),
        member('伪物语', true, ['物语系列']),
        member('猫物语（黑）', true, ['物语系列']),
      ],
      tagFrequency: new Map([['物语系列', 3]]),
      rareTagLimit: 10,
      isExcludedTag: () => false,
      anchorTitle: '化物语',
      singleton: false,
      fallbackLabel: '未确认系列',
    });
    expect(result.title).toBe('物语系列');
    expect(result.state).toBe('resolved');
  });

  it('稀有标签与起点作品一致时压过单薄的成员前缀（孤独摇滚场景）', () => {
    const result = resolveTitle({
      members: [
        member('孤独摇滚！', true, ['孤独摇滚']),
        member('剧场总集篇孤独摇滚！ Re:', true, ['孤独摇滚']),
        member('孤独', false),
        member('孤独 第二回', false),
        member('孤独 特别篇', false),
        member('孤独 广播剧', false),
      ],
      tagFrequency: new Map([['孤独摇滚', 2]]),
      rareTagLimit: 10,
      isExcludedTag: () => false,
      anchorTitle: '孤独摇滚！',
      singleton: false,
      fallbackLabel: '未确认系列',
    });
    expect(result.title).toBe('孤独摇滚！');
    expect(result.state).toBe('resolved');
    // 衍生成员的子品牌不允许进入候选
    expect(result.candidates.some((candidate) => candidate.title === '孤独')).toBe(false);
  });

  it('衍生成员标题不会污染核心品牌（路人女主场景）', () => {
    const result = resolveTitle({
      members: [
        member('路人女主的养成方法', true, ['路人女主的养成方法']),
        member('路人女主的养成方法 ♭', true, ['路人女主的养成方法']),
        member('路人女主的养成方法 Fine', true, []),
        member('不起眼广播的培育法', false),
        member('不起眼广播的培育法 特别篇', false),
        member('不起眼广播的培育法 第2回', false),
      ],
      tagFrequency: new Map([['路人女主的养成方法', 2]]),
      rareTagLimit: 10,
      isExcludedTag: () => false,
      anchorTitle: '路人女主的养成方法',
      singleton: false,
      fallbackLabel: '未确认系列',
    });
    expect(result.title).toBe('路人女主的养成方法');
    expect(result.source).toBe('brand:members');
    expect(result.candidates.some((candidate) => candidate.title.includes('广播'))).toBe(false);
  });

  it('结构异常的候选（未闭合括号 / 截断）不参与展示竞争', () => {
    expect(validateCandidateStructure('その着せ替え人形(ビスク').valid).toBe(false);
    expect(validateCandidateStructure('亚人 -冲').valid).toBe(false);
    expect(validateCandidateStructure('新世紀エヴァンゲリオン 第四季').valid).toBe(false);
    expect(validateCandidateStructure('更衣人偶坠入爱河').valid).toBe(true);
    expect(validateCandidateStructure('AIR').valid).toBe(true);

    const result = resolveTitle({
      members: [
        member('更衣人偶坠入爱河', true, ['更衣人偶坠入爱河']),
        member('更衣人偶坠入爱河 第二季', true, ['更衣人偶坠入爱河']),
        member('その着せ替え人形(ビスク', false),
        member('その着せ替え人形(ビスク 第2巻', false),
      ],
      tagFrequency: new Map([['更衣人偶坠入爱河', 2]]),
      rareTagLimit: 10,
      isExcludedTag: () => false,
      anchorTitle: '更衣人偶坠入爱河',
      singleton: false,
      fallbackLabel: '未确认系列',
    });
    expect(result.title).toBe('更衣人偶坠入爱河');
    expect(result.state).toBe('resolved');
  });

  it('已确立名称不会被新证据静默替换，只产生 proposed', () => {
    const result = resolveTitle({
      members: [member('新名字'), member('新名字 第二季')],
      tagFrequency: new Map(),
      rareTagLimit: 10,
      isExcludedTag: () => true,
      anchorTitle: '新名字',
      singleton: false,
      fallbackLabel: '未确认系列',
      existing: { title: '旧名字', state: 'resolved', source: 'brand:members' },
    });
    expect(result.title).toBe('旧名字');
    expect(result.state).toBe('resolved');
    expect(result.proposed?.title).toBe('新名字');
  });

  it('未确认的展示名可以随更强证据重新选择（不再被旧候选锁死）', () => {
    const result = resolveTitle({
      members: [
        member('路人女主的养成方法', true, ['路人女主的养成方法']),
        member('路人女主的养成方法 ♭', true, ['路人女主的养成方法']),
        member('不起眼广播的培育法', false),
        member('不起眼广播的培育法 特别篇', false),
      ],
      tagFrequency: new Map([['路人女主的养成方法', 2]]),
      rareTagLimit: 10,
      isExcludedTag: () => false,
      anchorTitle: '路人女主的养成方法',
      singleton: false,
      fallbackLabel: '未确认系列',
      existing: { title: '不起眼广播的培育法', state: 'provisional', source: 'brand:members' },
    });
    expect(result.title).toBe('路人女主的养成方法');
    expect(result.changed).toBe(true);
  });

  it('证据增强时未确认名称可以在不改名的前提下提升为 resolved', () => {
    const result = resolveTitle({
      members: [
        member('隐瞒之事', true, ['隐瞒之事']),
        member('隐瞒之事 特别篇', true, ['隐瞒之事']),
      ],
      tagFrequency: new Map([['隐瞒之事', 2]]),
      rareTagLimit: 10,
      isExcludedTag: () => false,
      anchorTitle: '隐瞒之事',
      singleton: false,
      fallbackLabel: '未确认系列',
      existing: { title: '隐瞒之事', state: 'provisional', source: 'brand:tag' },
    });
    expect(result.title).toBe('隐瞒之事');
    expect(result.state).toBe('resolved');
    expect(result.changed).toBe(false);
  });

  it('无法可靠判断时返回 unresolved，而不是猜一个名字', () => {
    const result = resolveTitle({
      members: [member('Alpha 作品'), member('Beta 作品')],
      tagFrequency: new Map(),
      rareTagLimit: 10,
      isExcludedTag: () => true,
      anchorTitle: null,
      singleton: false,
      fallbackLabel: '未确认系列（2 部）',
    });
    expect(result.state).toBe('unresolved');
    expect(result.title).toBe('未确认系列（2 部）');
  });
});
