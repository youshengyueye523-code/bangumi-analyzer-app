import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

/**
 * v1.8.1：Entity 成员锚点定位（`#member-{subjectId}`）。
 *
 * 实测根因（真实 DOM：content 滚动容器是 document，页头是 sticky h-14）：
 * 1. 浏览器 fragment 定位把目标行对齐到视口顶部 → 顶部 56px 被 sticky header 遮挡；
 * 2. 首次加载时成员是异步渲染的，fragment 定位发生时元素还不存在 → 完全不滚动；
 * 3. 没有 hashchange / 重复点击的再定位，也没有任何视觉反馈。
 *
 * 因此这里不依赖 scrollIntoView：直接按「目标几何 + 实际 header 高度」计算
 * scrollTop，并在布局可能变化后再校正一次。
 */

export const MEMBER_ANCHOR_PREFIX = '#member-';
/** 目标行顶部与 sticky header 之间保留的呼吸空间 */
export const MEMBER_ANCHOR_MARGIN = 12;
/** 高亮保持时长（ms）：轻量、短暂、不改变永久状态 */
const FOCUS_DURATION = 1600;
const FOCUS_CLASS = 'entity-member-focus';

/** 纯函数：计算把目标行放到「header 下方 + margin」处所需的 scrollTop。 */
export function anchorScrollTop(
  targetTop: number,
  scrollY: number,
  headerHeight: number,
  margin = MEMBER_ANCHOR_MARGIN,
): number {
  return Math.max(0, Math.round(targetTop + scrollY - headerHeight - margin));
}

export function memberSubjectIdFromHash(hash: string): number | null {
  if (!hash.startsWith(MEMBER_ANCHOR_PREFIX)) return null;
  const id = Number(hash.slice(MEMBER_ANCHOR_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function stickyHeaderHeight(): number {
  const header = document.querySelector('header');
  if (!header) return 0;
  const style = window.getComputedStyle(header);
  if (style.position !== 'sticky' && style.position !== 'fixed') return 0;
  return header.getBoundingClientRect().height;
}

function targetOf(subjectId: number): HTMLElement | null {
  return document.getElementById(`member-${subjectId}`);
}

function isModifiedClick(event: MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

export interface UseMemberAnchorOptions {
  /** 数据是否已渲染完成（数据未就绪时不尝试定位） */
  ready: boolean;
  /**
   * 目标不存在时的兜底（例如长 Series 只渲染前 30 个未收藏成员）。
   * 返回 true 表示已请求补充渲染，hook 会在下一轮 ready 变化后重试。
   */
  onMissing?: (subjectId: number) => boolean;
}

export function useMemberAnchor({ ready, onMissing }: UseMemberAnchorOptions) {
  const focusTimer = useRef<number | null>(null);
  const rafIds = useRef<number[]>([]);
  const layoutTimers = useRef<number[]>([]);
  const disposed = useRef(false);
  const missingRequested = useRef<number | null>(null);
  /** 请求页面补充渲染（例如展开未收藏成员）后，用它触发一次重试 */
  const [retryTick, setRetryTick] = useState(0);
  /*
   * onMissing 通常是页面的内联闭包（每次渲染都是新引用）。
   * 放进 ref 避免 effect 因身份变化反复执行、导致重复滚动。
   */
  const onMissingRef = useRef(onMissing);
  onMissingRef.current = onMissing;

  const requestMissing = useCallback((subjectId: number): boolean => {
    if (missingRequested.current === subjectId) return false;
    if (!onMissingRef.current?.(subjectId)) return false;
    missingRequested.current = subjectId;
    setRetryTick((tick) => tick + 1);
    return true;
  }, []);

  const align = useCallback((subjectId: number) => {
    const element = targetOf(subjectId);
    if (!element) return false;

    const apply = () => {
      if (disposed.current) return;
      const rect = element.getBoundingClientRect();
      window.scrollTo({ top: anchorScrollTop(rect.top, window.scrollY, stickyHeaderHeight()), behavior: 'auto' });
    };
    apply();

    // 布局可能继续变化（懒加载 / 字体 / 上方内容高度收敛）→ 帧后与 220ms 后各校正一次
    rafIds.current.push(requestAnimationFrame(apply));
    layoutTimers.current.push(window.setTimeout(apply, 220));

    // 轻量高亮 + 可聚焦，不改变永久状态
    element.classList.remove(FOCUS_CLASS);
    if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
    element.focus({ preventScroll: true });
    element.classList.add(FOCUS_CLASS);
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => {
      element.classList.remove(FOCUS_CLASS);
      focusTimer.current = null;
    }, FOCUS_DURATION);
    return true;
  }, []);

  const focusMember = useCallback(
    (subjectId: number) => {
      if (!align(subjectId)) requestMissing(subjectId);
      // 保持 URL 与锚点语义一致（与浏览器默认 fragment 行为对齐，含历史记录）
      const hash = `${MEMBER_ANCHOR_PREFIX}${subjectId}`;
      if (window.location.hash !== hash) {
        window.history.pushState(null, '', hash);
      }
    },
    [align, requestMissing],
  );

  /** 供评分样本链接使用：保留 href（复制 / 中键），左键由整页逻辑接管。 */
  const onMemberLinkClick = useCallback(
    (event: MouseEvent, subjectId: number) => {
      if (isModifiedClick(event)) return;
      event.preventDefault();
      focusMember(subjectId);
    },
    [focusMember],
  );

  // 数据就绪后处理「直接带 hash 打开 / 刷新」；hash 变化（后退、前进）时重新定位
  useEffect(() => {
    if (!ready) return;
    const subjectId = memberSubjectIdFromHash(window.location.hash);
    if (subjectId === null) return;
    if (align(subjectId)) {
      missingRequested.current = null;
      return;
    }
    requestMissing(subjectId);
  }, [ready, align, requestMissing, retryTick]);

  useEffect(() => {
    const onHashChange = () => {
      const subjectId = memberSubjectIdFromHash(window.location.hash);
      if (subjectId === null) return;
      if (!align(subjectId)) requestMissing(subjectId);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [align, requestMissing]);

  useEffect(
    () => () => {
      disposed.current = true;
      if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
      for (const id of rafIds.current) cancelAnimationFrame(id);
      for (const id of layoutTimers.current) window.clearTimeout(id);
      rafIds.current = [];
      layoutTimers.current = [];
    },
    [],
  );

  return { focusMember, onMemberLinkClick };
}
