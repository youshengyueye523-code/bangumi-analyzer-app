import { describe, expect, it } from 'vitest';
import {
  countActiveFilters,
  getActiveAdvancedFilterCount,
  queryToSearchParams,
  rankMatches,
  resetFilters,
  searchParamsToQuery,
  summarizeActiveFilters,
} from './filters.js';

describe('筛选条件与 URL 的相互转换', () => {
  it('完整往返不会丢失条件', () => {
    const query = {
      q: '冰菓',
      status: [2, 3] as const,
      format: ['TV'] as const,
      season: ['春'] as const,
      tags: ['科幻', '音乐'],
      studios: ['京都动画'],
      directors: ['新海诚'],
      yearFrom: 2015,
      yearTo: 2020,
      rateMin: 8,
      rateMax: 10,
      progress: 'completed' as const,
      tagMode: 'all' as const,
      sort: 'rate' as const,
      order: 'desc' as const,
      page: 2,
      pageSize: 96,
    };
    const params = queryToSearchParams(query as never);
    const parsed = searchParamsToQuery(params);

    expect(parsed.q).toBe('冰菓');
    expect(parsed.status).toEqual([2, 3]);
    expect(parsed.format).toEqual(['TV']);
    expect(parsed.season).toEqual(['春']);
    expect(parsed.tags).toEqual(['科幻', '音乐']);
    expect(parsed.studios).toEqual(['京都动画']);
    expect(parsed.yearFrom).toBe(2015);
    expect(parsed.rateMin).toBe(8);
    expect(parsed.progress).toBe('completed');
    expect(parsed.tagMode).toBe('all');
    expect(parsed.sort).toBe('rate');
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(96);
  });

  it('非法值会被安全忽略，不会抛出异常', () => {
    const params = new URLSearchParams('status=99&format=XYZ&sort=hack&page=-3&yearFrom=abc');
    const parsed = searchParamsToQuery(params);
    expect(parsed.status).toBeUndefined();
    expect(parsed.format).toBeUndefined();
    expect(parsed.sort).toBeUndefined();
    expect(parsed.page).toBe(1);
    expect(parsed.yearFrom).toBeUndefined();
  });

  it('默认分页参数不会出现在 URL 上', () => {
    const params = queryToSearchParams({ page: 1, pageSize: 48 });
    expect(params.toString()).toBe('');
  });

  it('统计生效条件数量', () => {
    expect(countActiveFilters({})).toBe(0);
    expect(countActiveFilters({ q: 'a', status: [2], yearFrom: 2010 })).toBe(3);
    expect(countActiveFilters({ progress: 'all', rated: 'all' })).toBe(0);
  });

  describe('高级筛选条件计数（统一口径）', () => {
    it('没有条件时为 0', () => {
      expect(getActiveAdvancedFilterCount({})).toBe(0);
      expect(getActiveAdvancedFilterCount({ progress: 'all', rated: 'all', bias: 'all' })).toBe(0);
    });

    it('多值维度按「选中的个数」计数：1 / 3 / 5 个标签', () => {
      expect(getActiveAdvancedFilterCount({ tags: ['日常'] })).toBe(1);
      expect(getActiveAdvancedFilterCount({ tags: ['日常', '治愈', '校园'] })).toBe(3);
      expect(getActiveAdvancedFilterCount({ tags: ['a', 'b', 'c', 'd', 'e'] })).toBe(5);
    });

    it('制作人员 / 公司 / 导演 / 状态 / 季度 / 放送形态同样按个数计数', () => {
      expect(getActiveAdvancedFilterCount({ staff: ['金﨑貴臣', '石原立也', '山田尚子'] })).toBe(3);
      expect(getActiveAdvancedFilterCount({ studios: ['Cygames', '京都动画'] })).toBe(2);
      expect(getActiveAdvancedFilterCount({ directors: ['新海诚'] })).toBe(1);
      expect(getActiveAdvancedFilterCount({ status: [1, 2, 4] })).toBe(3);
      expect(getActiveAdvancedFilterCount({ season: ['春', '秋'] })).toBe(2);
      expect(getActiveAdvancedFilterCount({ format: ['TV', 'OVA'] })).toBe(2);
    });

    it('混合条件：2 个标签 + 1 个制作人员 = 3', () => {
      expect(getActiveAdvancedFilterCount({ tags: ['日常', '治愈'], staff: ['石原立也'] })).toBe(3);
    });

    it('区间 / 单选维度每个算 1', () => {
      expect(getActiveAdvancedFilterCount({ yearFrom: 2015, yearTo: 2020 })).toBe(1);
      expect(getActiveAdvancedFilterCount({ rateMin: 8 })).toBe(1);
      expect(getActiveAdvancedFilterCount({ bgmScoreMin: 7, bgmScoreMax: 9 })).toBe(1);
      expect(getActiveAdvancedFilterCount({ ratingMin: 1000 })).toBe(1);
      expect(getActiveAdvancedFilterCount({ progress: 'in-progress' })).toBe(1);
      expect(getActiveAdvancedFilterCount({ rated: 'rated' })).toBe(1);
      expect(getActiveAdvancedFilterCount({ bias: 'over' })).toBe(1);
    });

    it('搜索关键词与系列上下文不属于高级筛选条件，但要计入总数', () => {
      const summary = summarizeActiveFilters({ q: '黄段子', seriesKey: 'bgm:1', tags: ['日常'] });
      expect(summary.advanced).toBe(1);
      expect(summary.search).toBe(1);
      expect(summary.context).toBe(1);
      expect(summary.total).toBe(3);
      expect(countActiveFilters({ q: '黄段子', tags: ['日常', '治愈'] })).toBe(3);
    });

    it('综合场景：多实体 + 区间 = 实际条件数', () => {
      const query = {
        tags: ['日常', '治愈'],
        staff: ['石原立也'],
        studios: ['京都动画'],
        directors: ['山田尚子'],
        yearFrom: 2015,
        yearTo: 2020,
        rated: 'rated' as const,
      };
      // 2 标签 + 1 人员 + 1 公司 + 1 导演 + 1 年份区间 + 1 已评分 = 7
      expect(getActiveAdvancedFilterCount(query)).toBe(7);
    });
  });

  it('重置筛选会保留排序与分页大小', () => {
    const reset = resetFilters({ q: 'x', sort: 'rate', order: 'asc', pageSize: 96, page: 5 });
    expect(reset).toMatchObject({ sort: 'rate', order: 'asc', pageSize: 96, page: 1 });
    expect(reset.q).toBeUndefined();
  });

  it('制作人员与来源上下文参数可以双向传递（反向检索的关键链路）', () => {
    // 以前 staff 没有出现在 URL 白名单里，点击人员后筛选被静默丢弃
    const parsed = searchParamsToQuery(
      new URLSearchParams(
        'staff=%E9%87%91%EF%A8%91%E8%B2%B4%E8%87%A3&fromSubject=380448&sourceRelation=%E9%9F%B3%E5%93%8D%E7%9B%91%E7%9D%A3&tags=%E4%B9%99',
      ),
    );
    expect(parsed.staff).toEqual(['金﨑貴臣']);
    expect(parsed.fromSubject).toBe(380448);
    expect(parsed.sourceRelation).toBe('音响监督');
    expect(parsed.tags).toEqual(['乙']);

    const params = queryToSearchParams(parsed);
    expect(params.getAll('staff')).toEqual(['金﨑貴臣']);
    expect(params.get('fromSubject')).toBe('380448');
    expect(params.get('sourceRelation')).toBe('音响监督');
    expect(params.get('tags')).toBe('乙');

    // 来源上下文不是筛选条件；人员筛选要计入「已应用条件」
    expect(countActiveFilters(parsed)).toBe(2);
  });

  it('多个制作人员可以同时筛选', () => {
    const parsed = searchParamsToQuery(new URLSearchParams('staff=Cygames,%E5%B1%B1%E7%94%B0'));
    expect(parsed.staff).toEqual(['Cygames', '山田']);
  });
});

describe('检索排序（完全匹配优先）', () => {
  const items = [
    { value: '动画', count: 300 },
    { value: '京都动画', count: 120 },
    { value: '动画制作', count: 200 },
    { value: 'アニメ', count: 50 },
  ];

  it('完全匹配排在第一，其次前缀，再其次包含，最后按次数', () => {
    const { matched, visible } = rankMatches(items, '动画', 10);
    expect(matched).toBe(3);
    expect(visible.map((item) => item.value)).toEqual(['动画', '动画制作', '京都动画']);
  });

  it('没有关键词时按传入顺序（次数）返回并给出总数', () => {
    const { matched, visible } = rankMatches(items, '   ', 2);
    expect(matched).toBe(4);
    // 生产环境传入的列表已经按出现次数排好序，这里保持原顺序
    expect(visible.map((item) => item.value)).toEqual(['动画', '京都动画']);
  });

  it('没有匹配时返回空列表而不是全部数据', () => {
    const { matched, visible } = rankMatches(items, '不存在的标签', 10);
    expect(matched).toBe(0);
    expect(visible).toEqual([]);
  });
});
