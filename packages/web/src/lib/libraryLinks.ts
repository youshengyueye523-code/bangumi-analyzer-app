/**
 * 收藏库检索链接的统一构造器。
 *
 * 这里定义了全局搜索与「作品详情 → 实体」两类入口**唯一**的语义：
 *
 * - `buildEntitySearchHref`：**替换式**（以某个实体为主检索）。
 *   点击作品里的标签 / 人员 / 公司时，得到的是一条全新的查询，
 *   只带上来源作品上下文（fromSubject / sourceRelation，仅用于界面提示）。
 *   以前这里是把上一页的全部条件合并进来，导致「第二次搜索仍然被上一次的结果绑住」。
 *
 * - `composeLibraryQuery`：**叠加式**（在当前结果中继续筛选）。
 *   只用于筛选面板里的显式勾选（面板上明确写了「多个条件之间为『且』关系」）。
 */

import type { SubjectQuery } from '@bangumi-analyzer/shared';

/** 让顶栏主搜索栏获得焦点（收藏库里的「修改搜索」按钮使用） */
export const FOCUS_SEARCH_EVENT = 'bangumi-analyzer:focus-search';

export type EntityKind = 'work' | 'tag' | 'staff' | 'studio' | 'director';

export interface EntityTarget {
  kind: EntityKind;
  value: string;
  /** 来源作品：只是上下文，不参与筛选 */
  fromSubject?: number;
  /** 来源关系名（导演 / 音响监督 / 标签…），仅用于提示 */
  sourceRelation?: string;
}

export const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  work: '作品',
  tag: '标签',
  staff: '制作人员',
  studio: '制作公司',
  director: '导演',
};

/** 以某个实体为主检索（替换语义，不继承上一次的搜索词与筛选条件）。 */
export function buildEntitySearchHref(target: EntityTarget): string {
  const params = new URLSearchParams();
  switch (target.kind) {
    case 'work':
      params.set('q', target.value);
      break;
    case 'tag':
      params.set('tags', target.value);
      break;
    case 'staff':
      params.set('staff', target.value);
      break;
    case 'studio':
      params.set('studios', target.value);
      break;
    case 'director':
      params.set('directors', target.value);
      break;
  }
  if (target.fromSubject) params.set('fromSubject', String(target.fromSubject));
  if (target.sourceRelation) params.set('sourceRelation', target.sourceRelation);
  return `/library?${params.toString()}`;
}

/** 全局搜索（关键词）：命中标题 / 别名 / ID / 标签 / 人员 / 公司。 */
export function buildKeywordSearchHref(keyword: string): string {
  const trimmed = keyword.trim();
  if (!trimmed) return '/library';
  return `/library?q=${encodeURIComponent(trimmed)}`;
}

/** 在当前查询之上叠加条件（仅用于筛选面板里的显式勾选）。 */
export function composeLibraryQuery(
  base: SubjectQuery,
  patch: Partial<SubjectQuery>,
): SubjectQuery {
  return { ...base, ...patch };
}

/** 详情页的「返回筛选结果」链接。 */
export function buildLibraryHrefFromParams(params: URLSearchParams): string {
  const text = params.toString();
  return text ? `/library?${text}` : '/library';
}
