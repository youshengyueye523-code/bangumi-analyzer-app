/**
 * Relation Taxonomy（关系语义分类）
 *
 * 这一层只回答「一条官方关系在语义上属于哪一类证据」，
 * **不直接决定任何 membership**。是否合并、是否建立家族，
 * 由 evidence resolver 结合更多证据判断。
 *
 * 设计约束：
 * - 未登记的关系类型（Bangumi 未来新增）必须落到 `unknown`，默认安全（不合并）；
 * - 分类是版本化常量，变化必须通过本文件与测试同步更新；
 * - `polarity` 表达这条证据的方向性：positive 支持关联，negative 反对关联。
 */

export type RelationClass =
  | 'continuity'
  | 'derivation'
  | 'derivative'
  | 'alternate'
  | 'association'
  | 'material'
  | 'unknown';

export type RelationPolarity = 'positive' | 'negative' | 'neutral';

export interface RelationKind {
  klass: RelationClass;
  polarity: RelationPolarity;
  note: string;
}

export const RELATION_TAXONOMY_VERSION = 1;

const CONTINUITY = ['前传', '续集', '续作', '前作', '后续', '正传', '主线故事'];
const DERIVATION = ['总集篇', '全集', '重编', '重制', '再编集', '総集編'];
const DERIVATIVE = ['外传', '番外篇', '衍生', '同系列'];
const ALTERNATE = ['不同演绎', '不同版本', '三次元'];
const ASSOCIATION = ['相同世界观', '联动', '角色出演'];
const NEGATIVE = ['不同世界观'];
const MATERIAL = [
  '书籍',
  '单行本',
  '原声集',
  '片头曲',
  '片尾曲',
  '角色歌',
  '广播剧',
  '游戏',
  '画集',
  '插入歌',
  '印象曲',
  '动画',
];

const REGISTRY = new Map<string, RelationKind>();

function register(names: string[], kind: RelationKind): void {
  for (const name of names) REGISTRY.set(name, kind);
}

register(CONTINUITY, {
  klass: 'continuity',
  polarity: 'positive',
  note: '同一时间线/连续故事的核心关系，可构成 Series 核心。',
});
register(DERIVATION, {
  klass: 'derivation',
  polarity: 'positive',
  note: '总集篇/全集/重编：同一作品体的派生版本，可并入同一 Series。',
});
register(DERIVATIVE, {
  klass: 'derivative',
  polarity: 'positive',
  note: '外传/番外/衍生：可能属于同一 Series（无独立连续体时），也可能是独立 Series；仅作证据。',
});
register(ALTERNATE, {
  klass: 'alternate',
  polarity: 'positive',
  note: '不同演绎/不同版本/三次元：不合并 Series，只作为 Franchise 候选证据。',
});
register(ASSOCIATION, {
  klass: 'association',
  polarity: 'positive',
  note: '相同世界观/联动/角色出演：弱关联，单独不足以形成 Series 或 Franchise。',
});
register(NEGATIVE, {
  klass: 'association',
  polarity: 'negative',
  note: '不同世界观：反对关联的显式证据。',
});
register(MATERIAL, {
  klass: 'material',
  polarity: 'neutral',
  note: '跨媒体素材/媒介关系：不参与 Series / Franchise 成员资格。',
});

const UNKNOWN_KIND: RelationKind = {
  klass: 'unknown',
  polarity: 'neutral',
  note: '未登记的关系类型，默认不参与任何合并；会进入关系审计。',
};

/** 其它/未识别的关系名一律归入 unknown（安全默认：不合并）。 */
export function classifyRelation(relation: string): RelationKind {
  const key = (relation ?? '').trim();
  return REGISTRY.get(key) ?? UNKNOWN_KIND;
}

export function isTopologyClass(klass: RelationClass): boolean {
  return klass === 'continuity' || klass === 'derivation';
}

export function isFranchiseEvidenceClass(klass: RelationClass): boolean {
  return klass === 'derivative' || klass === 'alternate' || klass === 'association';
}

export interface TaxonomyEntry extends RelationKind {
  relation: string;
}

/** 供审计/诊断使用：返回分类表的稳定快照。 */
export function relationTaxonomySnapshot(): TaxonomyEntry[] {
  return [...REGISTRY.entries()]
    .map(([relation, kind]) => ({ relation, ...kind }))
    .sort((a, b) => a.relation.localeCompare(b.relation, 'zh-Hans-CN'));
}
