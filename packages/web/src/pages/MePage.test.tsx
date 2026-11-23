import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../components/ui/overlay.js';
import { ToastProvider } from '../components/ui/toast.js';
import { MePage } from './MePage.js';

const CONFIG = {
  username: 'alice',
  hasToken: true,
  tokenHint: 'bgm_…f3a2',
  nickname: '',
  avatar: '',
  onboardingSeen: false,
  subjectTypes: [2],
  requestIntervalMs: 1000,
  detailRefreshDays: 30,
  userAgent: 'bangumi-analyzer/1.3.1',
  cacheCovers: true,
  httpProxy: '',
  dataDir: 'C:/data',
  dbPath: 'C:/data/bangumi.db',
  dbSizeBytes: 1024,
  version: '1.3.1',
  ai: {
    enabled: false,
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hasApiKey: false,
    apiKeyHint: null,
  },
};

const HEALTH = {
  ok: true,
  version: '1.3.1',
  uptimeSeconds: 10,
  dataDir: 'C:/data',
  dbPath: 'C:/data/bangumi.db',
  subjects: 12,
  collections: 12,
  syncRunning: false,
};

function onboarding(completed: boolean) {
  return {
    completed,
    seen: completed,
    collections: 12,
    profile: { nickname: '', avatar: '', username: 'alice', hasToken: true },
    steps: [
      { id: 'profile', title: '设置昵称 / 头像', description: '本机资料', done: completed },
      { id: 'bangumi', title: '配置 Bangumi 账号', description: '填写用户名', done: true },
      { id: 'sync', title: '完成一次同步', description: '同步后本地可用', done: true },
    ],
  };
}

/** 安装受控的 fetch，并记录所有写请求（用于断言保存内容）。 */
function installFetch(options: { completed?: boolean; failSkip?: boolean } = {}) {
  const writes: Array<{ url: string; body: unknown }> = [];
  let current = { ...CONFIG };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (init?.method === 'PUT' && url.startsWith('/api/config')) {
      const body = JSON.parse(String(init.body)) as Partial<typeof CONFIG>;
      writes.push({ url, body });
      if (options.failSkip && body.onboardingSeen) return new Response(JSON.stringify({ error: { message: 'fixture save failed' } }), { status: 500 });
      current = { ...current, ...body };
      return json(current);
    }
    if (url.startsWith('/api/config')) return json(current);
    if (url.startsWith('/api/profile/local')) return json({ ...onboarding(options.completed ?? false), completed: (options.completed ?? false) || current.onboardingSeen, seen: current.onboardingSeen });
    if (url.startsWith('/api/health')) return json(HEALTH);
    if (url.startsWith('/api/sync/status'))
      return json({ running: false, progress: null, lastRun: null, lastSuccessfulSyncAt: null });
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, writes };
}

function renderPage(entry = '/me') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>
            <MePage />
          </MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function makeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('个人资料页', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('没有自定义昵称时回退显示 Bangumi 用户名与数据状态', async () => {
    installFetch();
    renderPage();
    expect(await screen.findByRole('heading', { name: '个人资料' })).toBeTruthy();
    expect(await screen.findByText(/Bangumi 账号：@alice/)).toBeTruthy();
    expect(await screen.findByTitle('C:/data/bangumi.db')).toBeTruthy();
    // 画像页的统计数据不应出现在个人资料页
    expect(screen.queryByText('完成率')).toBeNull();
  });

  it('修改昵称并保存后立即更新界面', async () => {
    const { writes } = installFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }));
    const input = await screen.findByLabelText('昵称');
    fireEvent.change(input, { target: { value: '深夜补番的人' } });
    fireEvent.click(screen.getByRole('button', { name: '保存资料' }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]!.body).toMatchObject({ nickname: '深夜补番的人', avatar: '' });
    expect(await screen.findByRole('heading', { name: '深夜补番的人' })).toBeTruthy();
  });

  it('头像只接受图片且限制 2MB，超大文件给出可读提示且不发请求', async () => {
    const { writes } = installFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [makeFile('big.png', 'image/png', 5 * 1024 * 1024)] },
    });
    expect(await screen.findByText(/图片过大/)).toBeTruthy();

    fireEvent.change(fileInput, { target: { files: [makeFile('note.txt', 'text/plain', 10)] } });
    expect(await screen.findByText(/不是图片文件/)).toBeTruthy();
    expect(writes.length).toBe(0);
  });

  it('引导未完成时显示步骤，完成后不再显示', async () => {
    installFetch({ completed: false });
    const { unmount } = renderPage();
    expect(await screen.findByText('开始使用')).toBeTruthy();
    expect(screen.getByText('设置昵称 / 头像')).toBeTruthy();
    unmount();

    installFetch({ completed: true });
    renderPage();
    expect(await screen.findByRole('heading', { name: '个人资料' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('开始使用')).toBeNull());
  });

  it('跳过只写展示偏好，收起后能重新展开，不调用同步', async () => {
    const { writes, fetchMock } = installFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '暂时跳过' }));
    await waitFor(() => expect(screen.queryByText('开始使用')).toBeNull());
    expect(writes.map(w => w.body)).toEqual([{ onboardingSeen: true }]);
    fireEvent.click(await screen.findByRole('button', { name: '展开开始使用引导' }));
    expect(await screen.findByText('开始使用')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/sync/start'))).toBe(false);
  });
  it('完成用户默认收起，但显式重开仍能查看，且不伪造未完成步骤', async () => {
    const { writes } = installFetch({ completed: true });
    renderPage('/me?onboarding=show');
    expect(await screen.findByText('开始使用')).toBeTruthy();
    expect(screen.getByText('设置昵称 / 头像')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起引导' }));
    await waitFor(() => expect(screen.queryByText('开始使用')).toBeNull());
    expect(writes).toEqual([]);
  });
  it('跳过保存失败时保留引导并准确反馈', async () => {
    installFetch({ failSkip: true }); renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '暂时跳过' }));
    expect(await screen.findByText('无法收起引导')).toBeTruthy();
    expect(screen.getByText('开始使用')).toBeTruthy();
  });
});
