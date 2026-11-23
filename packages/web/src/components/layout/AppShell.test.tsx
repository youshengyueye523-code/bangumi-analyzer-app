import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../ui/overlay.js';
import { ToastProvider } from '../ui/toast.js';
import { AppShell } from './AppShell.js';
import { WallpaperProvider } from './wallpaper.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 侧栏身份区必须与「个人资料」共用同一份配置数据（/api/config）。 */
function installFetch(config: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/config')) return json(config);
    if (url.startsWith('/api/health'))
      return json({ ok: true, version: '1.3.1', uptimeSeconds: 1, dataDir: 'd', dbPath: 'd/db', subjects: 1, collections: 1, syncRunning: false });
    if (url.startsWith('/api/sync/status'))
      return json({ running: false, progress: null, lastRun: null, lastSuccessfulSyncAt: null });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const BASE_CONFIG = {
  username: '1249167',
  hasToken: true,
  tokenHint: 'bgm_…f3a2',
  nickname: '',
  avatar: '',
  onboardingSeen: true,
  subjectTypes: [2],
  requestIntervalMs: 1000,
  detailRefreshDays: 30,
  userAgent: 'x',
  cacheCovers: true,
  httpProxy: '',
  dataDir: 'd',
  dbPath: 'd/db',
  dbSizeBytes: 1,
  version: '1.3.1',
  ai: { enabled: false, provider: 'openai-compatible', baseUrl: '', model: '', hasApiKey: false, apiKeyHint: null },
};

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={['/']}>
            {/* 与 App.tsx 一致：AppShell 需要背景板 Provider（提供全局图层状态） */}
            <WallpaperProvider>
              <AppShell />
            </WallpaperProvider>
          </MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('左侧导航身份区', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('设置了本地昵称与头像时优先展示它们', async () => {
    installFetch({ ...BASE_CONFIG, nickname: '深夜补番的人', avatar: PNG });
    renderShell();

    expect(await screen.findByText('深夜补番的人')).toBeTruthy();
    const avatar = screen.getByAltText('深夜补番的人 的头像') as HTMLImageElement;
    expect(avatar.getAttribute('src')).toBe(PNG);
    // 不再把 Bangumi 用户名当作主名称
    expect(screen.queryByText('@1249167')).toBeNull();
  });

  it('没有昵称时回退到 Bangumi 用户名，没有头像时使用文字 fallback', async () => {
    installFetch(BASE_CONFIG);
    renderShell();

    expect(await screen.findByText('1249167')).toBeTruthy();
    // 纯数字账号不会渲染成孤零零的数字，而是通用头像图标
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('既没有昵称也没有用户名时显示占位名称而不是空白', async () => {
    installFetch({ ...BASE_CONFIG, username: '', hasToken: false });
    renderShell();
    expect(await screen.findByText('未命名用户')).toBeTruthy();
    expect(await screen.findByText('仅公开收藏')).toBeTruthy();
  });

  it('超长昵称被截断且保留完整 title，不破坏布局', async () => {
    const longName = '这是一个非常非常长的本地昵称用于验证侧边栏不会被撑破布局';
    installFetch({ ...BASE_CONFIG, nickname: longName });
    renderShell();

    const node = await screen.findByText(longName);
    expect(node.className).toContain('truncate-line');
    expect(node.getAttribute('title')).toContain(longName);
  });
});
