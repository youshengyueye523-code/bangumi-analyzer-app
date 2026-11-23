import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui/toast.js';
import { TooltipProvider } from '../components/ui/overlay.js';
import { FOCUS_SEARCH_EVENT } from '../lib/libraryLinks.js';
import { LibraryPage } from './LibraryPage.js';

const item = {
  id: 253,
  name: 'Hyouka',
  nameCn: '冰菓',
  cover: null,
  coverCached: false,
  platform: 'TV',
  format: 'TV',
  date: '2012-04-22',
  year: 2012,
  month: 4,
  season: '春',
  yearQuarter: '2012Q2',
  totalEpisodes: 22,
  collectionType: 2,
  rate: 10,
  epStatus: 22,
  watchedEpisodes: 22,
  progress: 1,
  comment: '',
  userTags: [],
  bgmScore: 7.9,
  bgmRank: 100,
  ratingTotal: 12000,
  collectionTotal: 20000,
  delta: 2.1,
  tags: ['日常'],
  studios: ['京都动画'],
  directors: ['武本康弘'],
  collectionUpdatedAt: null,
  firstSeenAt: null,
  detailSyncedAt: null,
  seriesKey: null,
};

const requests: string[] = [];

function installFetchMock(options: { realTotal?: number; hiddenCount?: number } = {}) {
  requests.length = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    requests.push(url);
    if (url.startsWith('/api/subjects/facets')) {
      return new Response(
        JSON.stringify({
          years: [{ value: 2012, count: 1 }],
          formats: [{ value: 'TV', label: 'TV', count: 1 }],
          seasons: [{ value: '春', count: 1 }],
          tags: [{ value: '日常', count: 1 }],
          studios: [{ value: '京都动画', count: 1 }],
          directors: [{ value: '武本康弘', count: 1 }],
          statuses: [{ value: 2, count: 1 }],
          total: 1,
          realTotal: options.realTotal ?? 1,
          hiddenCount: options.hiddenCount ?? 0,
          ratedCount: 1,
          yearMin: 2012,
          yearMax: 2012,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith('/api/subjects')) {
      return new Response(
        JSON.stringify({ items: [item], total: 1, page: 1, pageSize: 48, pageCount: 1 }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function HistoryControls() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate(-1)}>history back</button><button onClick={() => navigate(1)}>history forward</button></>;
}

function renderPage(initialUrl = '/library', historyControls = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[initialUrl]}>
            {historyControls ? <HistoryControls /> : null}
            <LibraryPage />
          </MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('收藏库页面', () => {
  beforeEach(() => {
    installFetchMock();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('加载后展示作品与结果统计', async () => {
    renderPage();
    expect(await screen.findByText('冰菓')).toBeTruthy();
    expect(screen.getByText(/共 1 部作品/)).toBeTruthy();
  });

  it('隐藏 NSFW 时同时展示真实收藏数与当前可见数', async () => {
    installFetchMock({ realTotal: 745, hiddenCount: 10 });
    renderPage();
    expect(await screen.findByText('冰菓')).toBeTruthy();
    expect(
      screen.getByText(/当前可见 1 部作品 · 真实收藏 745 部（已隐藏 10 部）/),
    ).toBeTruthy();
  });

  describe('高级筛选条件徽标', () => {
    it('没有任何条件时不显示数字', async () => {
      renderPage();
      await screen.findByText('冰菓');
      expect(screen.getByRole('button', { name: '高级筛选' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /高级筛选 · / })).toBeNull();
    });

    it('1 个标签显示 1', async () => {
      renderPage('/library?tags=%E6%97%A5%E5%B8%B8');
      await screen.findByText('冰菓');
      expect(await screen.findByRole('button', { name: '高级筛选 · 1' })).toBeTruthy();
    });

    it('3 个标签显示 3（不是 1）', async () => {
      renderPage('/library?tags=%E6%97%A5%E5%B8%B8%2C%E6%B2%BB%E6%84%88%2C%E6%A0%A1%E5%9B%AD');
      await screen.findByText('冰菓');
      expect(await screen.findByRole('button', { name: '高级筛选 · 3' })).toBeTruthy();
    });

    it('2 个标签 + 1 个制作人员显示 3', async () => {
      renderPage(
        '/library?tags=%E6%97%A5%E5%B8%B8%2C%E6%B2%BB%E6%84%88&staff=%E7%9F%B3%E5%8E%9F%E7%AB%8B%E4%B9%9F',
      );
      await screen.findByText('冰菓');
      expect(await screen.findByRole('button', { name: '高级筛选 · 3' })).toBeTruthy();
    });

    it('多实体 + 区间条件按实际条件数显示', async () => {
      renderPage(
        '/library?tags=%E6%97%A5%E5%B8%B8%2C%E6%B2%BB%E6%84%88&staff=%E7%9F%B3%E5%8E%9F%E7%AB%8B%E4%B9%9F&studios=Cygames&directors=%E6%96%B0%E6%B5%B7%E8%AA%A0&yearFrom=2015&yearTo=2020&rated=rated',
      );
      await screen.findByText('冰菓');
      // 2 标签 + 1 人员 + 1 公司 + 1 导演 + 1 年份区间 + 1 已评分 = 7
      expect(await screen.findByRole('button', { name: '高级筛选 · 7' })).toBeTruthy();
    });

    it('搜索关键词不计入高级筛选条件数', async () => {
      renderPage('/library?q=%E5%86%B0%E8%8F%93');
      await screen.findByText('冰菓');
      expect(screen.queryByRole('button', { name: /高级筛选 · / })).toBeNull();
      // 但「清除筛选」仍然可用（存在搜索关键词）
      expect(await screen.findByRole('button', { name: '清除筛选' })).toBeTruthy();
    });
  });

  it('收藏库不再有自己的搜索框，只显示顶栏搜索栏带进来的关键词', async () => {
    renderPage('/library?q=%E5%86%B0%E8%8F%93');
    await screen.findByText('冰菓');
    // 关键词来自主搜索栏（URL），收藏库只展示当前搜索状态
    expect(screen.queryByPlaceholderText(/搜索中文名/)).toBeNull();
    expect(screen.getByText(/全局搜索：「冰菓」/)).toBeTruthy();
    expect(requests.some((url) => url.includes('q=%E5%86%B0%E8%8F%93'))).toBe(true);
  });

  it('可以清除搜索关键词', async () => {
    renderPage('/library?q=%E5%86%B0%E8%8F%93');
    await screen.findByText('冰菓');
    await userEvent.click(screen.getByRole('button', { name: '清除搜索关键词' }));
    await waitFor(() => {
      expect(requests.some((url) => !url.includes('q=') && url.startsWith('/api/subjects?'))).toBe(true);
    });
  });

  it('「搜索」按钮会请求顶栏搜索栏聚焦', async () => {
    const focused = vi.fn();
    window.addEventListener(FOCUS_SEARCH_EVENT, focused);
    renderPage();
    await screen.findByText('冰菓');
    await userEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(focused).toHaveBeenCalled();
    window.removeEventListener(FOCUS_SEARCH_EVENT, focused);
  });

  it('点击状态筛选会更新查询条件', async () => {
    renderPage();
    await screen.findByText('冰菓');
    await userEvent.click(screen.getByRole('button', { name: /看过/ }));
    await waitFor(() => {
      expect(requests.some((url) => url.includes('status=2'))).toBe(true);
    });
  });

  it('URL 中的筛选条件会被还原到界面', async () => {
    renderPage('/library?status=2&q=%E5%86%B0%E8%8F%93&sort=rate');
    await screen.findByText('冰菓');
    expect(requests.some((url) => url.includes('status=2'))).toBe(true);
    expect(requests.some((url) => url.includes('sort=rate'))).toBe(true);
    expect(screen.getByText(/全局搜索：「冰菓」/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /看过/ })).toBeTruthy();
  });

  it('可以切换到列表视图并持久化偏好', async () => {
    renderPage();
    await screen.findByText('冰菓');
    await userEvent.click(screen.getByRole('button', { name: '列表视图' }));
    expect(localStorage.getItem('bangumi-analyzer-library-view')).toBe('list');
    expect(await screen.findByText('大众 7.9')).toBeTruthy();
  });

  function installPagedFetch(pageTwo: Promise<Response>) {
    const fallback = installFetchMock();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (!url.startsWith('/api/subjects?')) return fallback(input);
      const params = new URL(url, 'http://localhost').searchParams;
      const page = Number(params.get('page') ?? 1);
      if (page === 2) return pageTwo.then((response) => response.clone());
      return pageResponse(page);
    });
  }

  function pageResponse(page: number) {
    return new Response(JSON.stringify({ items: [{ ...item, id: page, nameCn: `分页 ${page}` }], total: 72, page, pageSize: 24, pageCount: 3 }),
      { headers: { 'content-type': 'application/json' } });
  }

  it('主动分页等待目标数据提交才回顶；筛选/排序更新不会再次回顶', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    let resolvePage!: (response: Response) => void;
    installPagedFetch(new Promise((resolve) => { resolvePage = resolve; }));
    renderPage('/library?pageSize=24');
    await screen.findByText('分页 1');
    await userEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('分页 1')).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
    resolvePage(pageResponse(2));
    await screen.findByText('分页 2');
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
    await userEvent.click(screen.getByRole('button', { name: '上一页' }));
    await screen.findByText('分页 1');
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole('button', { name: '降序' }));
    await screen.findByText('分页 1');
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('分页请求尚未完成时 POP 取消回顶意图，前进到目标页也不主动回顶', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    let resolvePage!: (response: Response) => void;
    installPagedFetch(new Promise((resolve) => { resolvePage = resolve; }));
    renderPage('/library?pageSize=24', true);
    await screen.findByText('分页 1');
    await userEvent.click(screen.getByRole('button', { name: '下一页' }));
    await userEvent.click(screen.getByRole('button', { name: 'history back' }));
    resolvePage(pageResponse(2));
    await userEvent.click(screen.getByRole('button', { name: 'history forward' }));
    await screen.findByText('分页 2');
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
