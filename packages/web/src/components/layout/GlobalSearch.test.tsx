import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalSearch } from './GlobalSearch.js';

const clients: QueryClient[] = [];
afterEach(() => {
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><MemoryRouter><GlobalSearch /></MemoryRouter></QueryClientProvider>);
  return screen.getByRole('searchbox');
}
function result(query: string, title: string | null) {
  return new Response(JSON.stringify({ query, workTotal: title ? 1 : 0, works: title ? [{ id: 1, title, originalTitle: title, year: null, cover: null, reasons: [] }] : [], tags: [], staff: [], studios: [], directors: [] }), { status: 200 });
}

describe('全局搜索异步反馈', () => {
  it('新关键词等待时不显示旧实体，晚到响应不覆盖当前关键词', async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.fn((input: string) => {
      const query = new URL(input, 'http://localhost').searchParams.get('q')!;
      return query === '乙' ? new Promise<Response>((resolve) => { release = resolve; }) : Promise.resolve(result(query, `${query}作品`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup(), input = mount();
    await user.type(input, '甲');
    await screen.findByText('甲作品');
    await user.clear(input); await user.type(input, '乙');
    // Do not wait for the debounce/request: stale entities must disappear now.
    expect(screen.queryByText('甲作品')).toBeNull();
    expect(screen.getByText('搜索中…')).toBeDefined();
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.queryByText('甲作品')).toBeNull();
    expect(screen.getByText('搜索中…')).toBeDefined();
    await user.clear(input); await user.type(input, '丙');
    await screen.findByText('丙作品');
    release(result('乙', '乙作品'));
    await waitFor(() => expect(screen.queryByText('乙作品')).toBeNull());
    expect(screen.getByText('丙作品')).toBeDefined();
  });

  it('失败明确显示错误与重试，不伪装零匹配；重试可恢复结果', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: '搜索暂不可用' }), { status: 503 })).mockImplementation(() => Promise.resolve(result('甲', '甲作品')));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    await user.type(mount(), '甲');
    await screen.findByRole('alert');
    expect(screen.queryByText(/没有匹配的实体/)).toBeNull();
    expect(screen.queryByText('0 部')).toBeNull();
    await user.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('甲作品');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('成功的空结果仍说明无匹配并显示真实零值', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(result('空', null))));
    await userEvent.setup().type(mount(), '空');
    await screen.findByText(/没有匹配的实体/);
    expect(screen.getByText('0 部')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
