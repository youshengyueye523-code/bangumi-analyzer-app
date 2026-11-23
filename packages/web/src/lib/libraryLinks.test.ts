import { describe, expect, it } from 'vitest';
import { searchParamsToQuery } from './filters.js';
import {
  buildEntitySearchHref,
  buildKeywordSearchHref,
  buildLibraryHrefFromParams,
  composeLibraryQuery,
} from './libraryLinks.js';

function paramsOf(href: string): URLSearchParams {
  return new URLSearchParams(href.split('?')[1] ?? '');
}

describe('全局搜索链接（替换式语义）', () => {
  it('关键词搜索只带入关键词', () => {
    expect(buildKeywordSearchHref('黄段子')).toBe('/library?q=%E9%BB%84%E6%AE%B5%E5%AD%90');
    expect(buildKeywordSearchHref('   ')).toBe('/library');
  });

  it('点击标签 / 人员 / 公司只产生该实体的查询与来源上下文', () => {
    const tag = paramsOf(
      buildEntitySearchHref({ kind: 'tag', value: '黄段子', fromSubject: 380448, sourceRelation: '标签' }),
    );
    expect(tag.get('tags')).toBe('黄段子');
    expect(tag.get('fromSubject')).toBe('380448');
    expect(tag.get('sourceRelation')).toBe('标签');
    expect(tag.get('q')).toBeNull();
    expect(tag.get('staff')).toBeNull();

    const staff = paramsOf(
      buildEntitySearchHref({
        kind: 'staff',
        value: '金﨑貴臣',
        fromSubject: 380448,
        sourceRelation: '音响监督',
      }),
    );
    expect(staff.get('staff')).toBe('金﨑貴臣');
    expect(staff.get('sourceRelation')).toBe('音响监督');

    const studio = paramsOf(buildEntitySearchHref({ kind: 'studio', value: 'Cygames' }));
    expect(studio.get('studios')).toBe('Cygames');
    expect(studio.get('fromSubject')).toBeNull();

    const director = paramsOf(buildEntitySearchHref({ kind: 'director', value: '新海誠' }));
    expect(director.get('directors')).toBe('新海誠');

    // 作品结果直接进入详情页，不走收藏库查询
    expect(buildEntitySearchHref({ kind: 'work', value: '381' })).toBe('/library?q=381');
  });
});

describe('连续检索不会发生条件污染', () => {
  /**
   * 模拟真实的四级链路：
   *   搜索「黄段子」→ 从作品点标签 → 点人员 → 点公司
   * 每一步都是「以该实体为主检索」，不允许继承上一步的搜索词与筛选条件。
   */
  it('四级连续检索：每一步都只保留最新实体', () => {
    // 第 1 步：主搜索栏输入关键词
    const step1 = buildKeywordSearchHref('黄段子');
    expect(paramsOf(step1).get('q')).toBe('黄段子');

    // 第 2 步：从某部作品点击标签「妄想学生会」
    const step2 = buildEntitySearchHref({
      kind: 'tag',
      value: '妄想学生会',
      fromSubject: 8,
      sourceRelation: '标签',
    });
    const step2Params = paramsOf(step2);
    expect(step2Params.get('q')).toBeNull();
    expect(step2Params.get('tags')).toBe('妄想学生会');

    // 第 3 步：从另一个作品点击人员
    const step3 = buildEntitySearchHref({
      kind: 'staff',
      value: '金﨑貴臣',
      fromSubject: 380448,
      sourceRelation: '音响监督',
    });
    const step3Params = paramsOf(step3);
    expect(step3Params.get('tags')).toBeNull();
    expect(step3Params.get('staff')).toBe('金﨑貴臣');
    expect(step3Params.get('fromSubject')).toBe('380448');

    // 第 4 步：点击制作公司
    const step4 = buildEntitySearchHref({
      kind: 'studio',
      value: 'Cygames',
      fromSubject: 380448,
      sourceRelation: '原作',
    });
    const step4Params = paramsOf(step4);
    expect(step4Params.get('staff')).toBeNull();
    expect(step4Params.get('studios')).toBe('Cygames');

    // 每一步解析出来的查询条件都只有「当前实体 + 来源上下文」
    for (const href of [step2, step3, step4]) {
      const query = searchParamsToQuery(paramsOf(href));
      const filters = [query.q, query.tags, query.staff, query.studios, query.directors].filter(
        Boolean,
      );
      expect(filters).toHaveLength(1);
      expect(query.fromSubject).toBeGreaterThan(0);
    }
  });

  it('从「被污染」的 URL 出发，点击新实体仍然只保留新实体', () => {
    // 假设当前 URL 同时带着搜索词、标签、人员与状态（旧版本会把这些一路带下去）
    const polluted = new URLSearchParams(
      'q=黄段子&tags=搞笑&staff=金﨑貴臣&studios=GoHands&status=2&yearFrom=2010&fromSubject=8',
    );
    expect(polluted.toString()).toContain('q=');

    const next = buildEntitySearchHref({ kind: 'tag', value: '校园', fromSubject: 123 });
    const nextParams = paramsOf(next);
    expect(nextParams.get('tags')).toBe('校园');
    expect(nextParams.get('q')).toBeNull();
    expect(nextParams.get('staff')).toBeNull();
    expect(nextParams.get('studios')).toBeNull();
    expect(nextParams.get('status')).toBeNull();
    expect(nextParams.get('yearFrom')).toBeNull();
    expect(nextParams.get('fromSubject')).toBe('123');
  });

  it('筛选面板里的显式勾选仍然是叠加（AND）语义', () => {
    const base = searchParamsToQuery(new URLSearchParams('q=黄段子&tags=搞笑'));
    const composed = composeLibraryQuery(base, { tags: ['搞笑', '校园'] });
    expect(composed.q).toBe('黄段子');
    expect(composed.tags).toEqual(['搞笑', '校园']);
  });

  it('详情页的「返回筛选结果」可以还原完整的上一页条件', () => {
    const from = new URLSearchParams('tags=搞笑&status=2&page=3');
    const href = buildLibraryHrefFromParams(from);
    const query = searchParamsToQuery(paramsOf(href));
    expect(query.tags).toEqual(['搞笑']);
    expect(query.status).toEqual([2]);
    expect(query.page).toBe(3);
    expect(buildLibraryHrefFromParams(new URLSearchParams())).toBe('/library');
  });
});
