import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui/toast.js';
import { SubjectDetailPage } from './SubjectDetailPage.js';

vi.mock('../components/charts/generic.js', () => ({ CategoryBar: () => null }));
vi.mock('../components/subject/SummarySection.js', () => ({ SummarySection: () => null }));
const detail = {
  id: 1, name: 'Fixture', nameCn: '本地作品', collectionType: 2, rate: 8,
  epStatus: 12, totalEpisodes: 12, watchedEpisodes: 12, progress: 1,
  bgmScore: 7, bgmRank: 1, delta: 1, ratingTotal: 2, collectionTotal: 3,
  tags: [], metaTags: [], staff: [], relations: [], infobox: [], ratingDistribution: {},
  collectionBreakdown: {}, format: 'TV', summary: '', rawSubject: null, rawCollection: null,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function setup(next: () => Promise<Response>) {
  let reads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/subjects/1') { reads++; return reads === 1 ? json(detail) : next(); }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  render(<QueryClientProvider client={client}><ToastProvider><MemoryRouter initialEntries={['/subjects/1']}><Routes><Route path="/subjects/:id" element={<SubjectDetailPage />} /></Routes></MemoryRouter></ToastProvider></QueryClientProvider>);
  return { fetchMock, reads: () => reads };
}
afterEach(() => vi.unstubAllGlobals());
describe('条目刷新仅重读本地数据库', () => {
  it('无变化给出准确反馈且只发GET，不触发同步或远程更新', async () => {
    const { fetchMock, reads } = setup(async () => json(detail));
    fireEvent.click(await screen.findByRole('button', { name: '刷新本地数据' }));
    expect(await screen.findByText('本地数据没有变化')).toBeTruthy();
    expect(reads()).toBe(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === '/api/subjects/1')).toBe(true);
  });
  it('本地数据变化后展示新值并反馈已读取，不声称已更新Bangumi', async () => {
    setup(async () => json({ ...detail, nameCn: '本地新标题' }));
    fireEvent.click(await screen.findByRole('button', { name: '刷新本地数据' }));
    expect(await screen.findByRole('heading', { name: '本地新标题' })).toBeTruthy();
    expect(await screen.findByText('已读取最新本地数据')).toBeTruthy();
  });
  it('在途禁用且重复点击不取消重发', async () => {
    let finish!: (r: Response) => void;
    const { reads } = setup(() => new Promise(resolve => { finish = resolve; }));
    const button = await screen.findByRole('button', { name: '刷新本地数据' });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(reads()).toBe(2);
    finish(json(detail));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });
  it.each([0, 500, 404])('读取失败(%s)不显示成功，失败后可重试', async status => {
    setup(async () => {
      if (!status) throw new TypeError('offline');
      return json({ error: { code: status === 404 ? 'subject_not_found' : 'fixture_error', message: '读取失败', dataIntact: true } }, status);
    });
    fireEvent.click(await screen.findByRole('button', { name: '刷新本地数据' }));
    expect(await screen.findByText('无法刷新本地数据')).toBeTruthy();
    expect(screen.queryByText('已读取最新本地数据')).toBeNull();
    expect(await screen.findByRole('button', { name: '重试' })).toBeTruthy();
  });
});
