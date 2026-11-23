import { describe, expect, it } from 'vitest';
import {
  classifyRelation,
  isFranchiseEvidenceClass,
  isTopologyClass,
  relationTaxonomySnapshot,
} from '../src/series/taxonomy.js';

/**
 * 关系类型审计：覆盖当前真实数据库出现的全部 relation，
 * 并锁定「未知关系默认安全」的契约。
 */
const REAL_RELATIONS = [
  '其他',
  '书籍',
  '原声集',
  '片尾曲',
  '游戏',
  '片头曲',
  '角色歌',
  '广播剧',
  '续集',
  '画集',
  '前传',
  '衍生',
  '番外篇',
  '插入歌',
  '角色出演',
  '全集',
  '三次元',
  '不同演绎',
  '联动',
  '主线故事',
  '相同世界观',
  '总集篇',
  '不同世界观',
  '单行本',
  '印象曲',
  '不同版本',
  '动画',
  '外传',
];

describe('relation taxonomy', () => {
  it('覆盖真实数据库的全部关系类型', () => {
    const snapshot = relationTaxonomySnapshot();
    const known = new Set(snapshot.map((entry) => entry.relation));
    const missing = REAL_RELATIONS.filter((relation) => !known.has(relation));
    // 「其他」是 unknown 默认类，不在登记表中；其余必须全部登记
    expect(missing).toEqual(['其他']);
  });

  it('连续性 / 派生 / 弱关联 / 跨媒体分类正确', () => {
    expect(classifyRelation('续集').klass).toBe('continuity');
    expect(classifyRelation('前传').klass).toBe('continuity');
    expect(classifyRelation('主线故事').klass).toBe('continuity');
    expect(classifyRelation('总集篇').klass).toBe('derivation');
    expect(classifyRelation('全集').klass).toBe('derivation');
    expect(classifyRelation('外传').klass).toBe('derivative');
    expect(classifyRelation('番外篇').klass).toBe('derivative');
    expect(classifyRelation('衍生').klass).toBe('derivative');
    expect(classifyRelation('不同演绎').klass).toBe('alternate');
    expect(classifyRelation('相同世界观').klass).toBe('association');
    expect(classifyRelation('不同世界观').polarity).toBe('negative');
    expect(classifyRelation('书籍').klass).toBe('material');
    expect(classifyRelation('原声集').klass).toBe('material');
  });

  it('未知关系默认安全：不参与任何合并，并进入审计', () => {
    const future = classifyRelation('未来新关系');
    expect(future.klass).toBe('unknown');
    expect(future.polarity).toBe('neutral');
    expect(isTopologyClass(future.klass)).toBe(false);
    expect(isFranchiseEvidenceClass(future.klass)).toBe(false);
    expect(classifyRelation('其他').klass).toBe('unknown');
  });
});
