import { describe, expect, it } from 'vitest';
import { anchorScrollTop, memberSubjectIdFromHash } from './useMemberAnchor.js';

/**
 * v1.8.1：成员锚点定位的纯计算（与 DOM 解耦，锁定 fixed-header 偏移规则）。
 */
describe('useMemberAnchor 计算', () => {
  it('把目标行对齐到 sticky header 下方 + margin（不被页头遮挡）', () => {
    // 目标当前在视口顶部 0.33px，页面已滚动 1733px，header 56px，margin 12px
    expect(anchorScrollTop(0.33, 1733, 56, 12)).toBe(1665);
    // 未滚动时直接定位到 1733px 的目标
    expect(anchorScrollTop(1733, 0, 56, 12)).toBe(1665);
    // 没有 sticky header 时只保留 margin
    expect(anchorScrollTop(100, 0, 0, 12)).toBe(88);
    // 顶部目标不允许滚出负值
    expect(anchorScrollTop(0, 0, 56, 12)).toBe(0);
  });

  it('只接受 #member-<正整数> 形式的 hash', () => {
    expect(memberSubjectIdFromHash('#member-1671')).toBe(1671);
    expect(memberSubjectIdFromHash('#member-0')).toBeNull();
    expect(memberSubjectIdFromHash('#member-abc')).toBeNull();
    expect(memberSubjectIdFromHash('#member-')).toBeNull();
    expect(memberSubjectIdFromHash('#other')).toBeNull();
    expect(memberSubjectIdFromHash('')).toBeNull();
  });
});
