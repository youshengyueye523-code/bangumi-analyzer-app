import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { memberSubjectIdFromHash } from './useMemberAnchor.js';

/**
 * v1.8.2：全局 Detail Navigation Scroll Policy。
 *
 * 实测根因：所有详情入口都走同一套 SPA 客户端跳转，而应用没有任何 route 级滚动策略，
 * 浏览器会保留当前文档的滚动位置（同文档 pushState 不重置）。于是：
 * - 列表页滚动到中段后点进详情 → 详情直接停在中部；
 * - 详情 → 详情（参数变化复用组件）→ 继承上一个详情的滚动高度；
 * - 缓存热 / 提交时机不同 → 有时被骨架屏高度截断掩盖，表现为「有时」；
 * - back / forward 由浏览器按 entry 恢复，回到详情时也会回到详情中部。
 *
 * 规则（与 v1.8.1 的成员锚点并列为两个层级）：
 * 1. 任何进入 Detail 的 location（push / replace / back / forward / 直接加载）
 *    → 顶部；重复校正以赢过浏览器 entry 恢复与晚渲染；
 * 2. `#member-<id>` 是显式「详情内部定位」→ 交给 `useMemberAnchor`，本策略不干预；
 * 3. 非 Detail 路由不触碰 → 列表页的浏览器原生位置恢复保持不变。
 */

const DETAIL_PATH_PATTERNS = [
  /^\/subjects\/\d+\/?$/,
  /^\/series\/[^/]+\/?$/,
  /^\/franchises\/[^/]+\/?$/,
];

/** 只有 Series / Franchise 详情存在 `#member-<id>` 锚点元素。 */
const MEMBER_ANCHOR_PATH_PATTERNS = [/^\/series\/[^/]+\/?$/, /^\/franchises\/[^/]+\/?$/];

export function isDetailPath(pathname: string): boolean {
  return DETAIL_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function supportsMemberAnchor(pathname: string): boolean {
  return MEMBER_ANCHOR_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

/** 只有明确的 `#member-<正整数>` 才算「详情内部定位意图」。 */
export function isMemberAnchorHash(hash: string): boolean {
  return memberSubjectIdFromHash(hash) !== null;
}

export function shouldResetDetailScroll(pathname: string, hash: string): boolean {
  if (!isDetailPath(pathname)) return false;
  // 仅当页面真的拥有成员锚点时，member hash 才是「内部定位意图」；
  // 其它详情（如 Subject）上的残留 hash 视为来源污染，仍回到顶部。
  return !(supportsMemberAnchor(pathname) && isMemberAnchorHash(hash));
}

/** 顶部校正节奏：即时 + 下一帧 + 160ms（覆盖 entry 恢复与异步内容高度变化）。 */
const RESET_PASSES_MS = [0, 160];

export function useDetailScrollPolicy(): void {
  const location = useLocation();

  useEffect(() => {
    if (!shouldResetDetailScroll(location.pathname, location.hash)) return;
    const reset = () => {
      /*
       * 每次校正前重新读取「当前真实 hash」：v1.8.1 的成员锚点可能在本策略的
       * 延迟校正（160ms）之前完成定位；显式锚点优先，策略必须让位。
       * pathname 用 router location（测试与真实导航都可靠），hash 用 window.location
       * （成员锚点是 pushState，只更新浏览器地址，不更新 router state）。
       */
      if (!shouldResetDetailScroll(location.pathname, window.location.hash)) return;
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    };
    reset();
    const raf = requestAnimationFrame(reset);
    const timers = RESET_PASSES_MS.map((delay) => window.setTimeout(reset, delay));
    return () => {
      cancelAnimationFrame(raf);
      for (const timer of timers) window.clearTimeout(timer);
    };
    // location.key：同一 pathname 的再次导航（含 replace / 同路由参数变化）也要重置
  }, [location.key, location.pathname, location.search, location.hash]);
}
