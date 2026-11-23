import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDetailPath,
  shouldResetDetailScroll,
  supportsMemberAnchor,
  useDetailScrollPolicy,
} from './detailScrollPolicy.js';

/**
 * v1.8.2：全局 Detail Navigation Scroll Policy。
 * 纯规则 + 导航生命周期（push / 参数变化 / member anchor 不干预）。
 */
describe('Detail Scroll Policy 规则', () => {
  it('只把真实详情路由视为 Detail', () => {
    expect(isDetailPath('/subjects/1671')).toBe(true);
    expect(isDetailPath('/series/sr_8')).toBe(true);
    expect(isDetailPath('/franchises/fr_14')).toBe(true);
    expect(isDetailPath('/series')).toBe(false);
    expect(isDetailPath('/franchises')).toBe(false);
    expect(isDetailPath('/library')).toBe(false);
    expect(isDetailPath('/subjects')).toBe(false);
    expect(isDetailPath('/')).toBe(false);
  });

  it('member hash 只在拥有成员锚点的页面才算显式定位', () => {
    expect(supportsMemberAnchor('/series/sr_8')).toBe(true);
    expect(supportsMemberAnchor('/franchises/fr_14')).toBe(true);
    expect(supportsMemberAnchor('/subjects/1671')).toBe(false);

    expect(shouldResetDetailScroll('/series/sr_8', '#member-1671')).toBe(false);
    expect(shouldResetDetailScroll('/franchises/fr_14', '#member-1')).toBe(false);
    // Subject 详情没有成员锚点：残留 hash 不能污染首屏
    expect(shouldResetDetailScroll('/subjects/1671', '#member-1671')).toBe(true);
    // 未知 hash 与无 hash 一律回到顶部
    expect(shouldResetDetailScroll('/series/sr_8', '#other')).toBe(true);
    expect(shouldResetDetailScroll('/series/sr_8', '')).toBe(true);
    // 列表页不属于 Detail → 保留浏览器原生位置恢复
    expect(shouldResetDetailScroll('/library', '')).toBe(false);
    expect(shouldResetDetailScroll('/library', '#member-1')).toBe(false);
  });
});

function Harness() {
  useDetailScrollPolicy();
  return (
    <Routes>
      <Route
        path="/library"
        element={
          <div>
            <Link to="/subjects/1">open subject</Link>
            <Link to="/series/sr_1#member-5">open anchor</Link>
            <Link to="/subjects/2">open second subject</Link>
          </div>
        }
      />
      <Route path="/subjects/:id" element={<div>subject detail</div>} />
      <Route path="/series/:key" element={<div>series detail</div>} />
    </Routes>
  );
}

describe('Detail Scroll Policy 导航生命周期', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('列表 → 详情：进入 Detail 时回到顶部', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    render(
      <MemoryRouter initialEntries={['/library']}>
        <Harness />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('open subject'));
    expect(await screen.findByText('subject detail')).toBeTruthy();
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' }),
    );
  });

  it('详情 → 详情（参数变化）：仍然回到顶部', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    function DetailHarness() {
      useDetailScrollPolicy();
      return (
        <Routes>
          <Route
            path="/subjects/:id"
            element={
              <div>
                subject detail <Link to="/subjects/2">next subject</Link>
              </div>
            }
          />
        </Routes>
      );
    }
    render(
      <MemoryRouter initialEntries={['/subjects/1']}>
        <DetailHarness />
      </MemoryRouter>,
    );
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    scrollTo.mockClear();

    // 同一个路由组件实例，仅参数变化（Detail → Detail）
    fireEvent.click(screen.getByText('next subject'));
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' }),
    );
  });

  it('member anchor：不触发顶部重置（交给 useMemberAnchor）', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    render(
      <MemoryRouter initialEntries={['/series/sr_1#member-5']}>
        <Harness />
      </MemoryRouter>,
    );

    expect(await screen.findByText('series detail')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('列表页本身不触发任何滚动重置', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    render(
      <MemoryRouter initialEntries={['/library']}>
        <Harness />
      </MemoryRouter>,
    );

    expect(await screen.findByText('open subject')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('延迟校正让位于随后的 member anchor（v1.8.1 优先）', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    render(
      <MemoryRouter initialEntries={['/series/sr_1']}>
        <Harness />
      </MemoryRouter>,
    );
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    scrollTo.mockClear();

    // 模拟 useMemberAnchor 在延迟校正之前完成锚点定位（pushState 更新真实 hash）
    window.history.pushState(null, '', '#member-5');
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
