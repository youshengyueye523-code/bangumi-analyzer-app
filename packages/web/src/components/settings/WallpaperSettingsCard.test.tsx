import type { AppConfigPublic } from '@bangumi-analyzer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/queries.js';
import { WallpaperLayer, WallpaperProvider } from '../layout/wallpaper.js';
import { ToastProvider } from '../ui/toast.js';
import { WallpaperSettingsCard } from './WallpaperSettingsCard.js';

const UPLOADED = 'wp-0123456789abcdef.png';

function makeConfig(wallpaper: Partial<AppConfigPublic['wallpaper']> = {}): AppConfigPublic {
  return {
    username: 'alice',
    hasToken: false,
    tokenHint: null,
    nickname: '',
    avatar: '',
    onboardingSeen: true,
    summaryAutoTranslate: true,
    summaryConcurrency: 2,
    subjectTypes: [2],
    requestIntervalMs: 1000,
    detailRefreshDays: 30,
    userAgent: 'ua',
    cacheCovers: true,
    httpProxy: '',
    hideNsfw: false,
    dataDir: 'C:/data',
    dbPath: 'C:/data/bangumi.db',
    dbSizeBytes: 1,
    version: '1.4.3',
    ai: {
      enabled: false,
      provider: 'openai-compatible',
      baseUrl: '',
      model: '',
      hasApiKey: false,
      apiKeyHint: null,
    },
    wallpaper: { image: '', focusX: 50, focusY: 50, blur: 10, strength: 60, ...wallpaper },
    material: { preset: 'balanced', clarity: 50, frosted: 50 },
  };
}

/** 受控 fetch：记录写请求，并把配置读 / 写串起来 */
function installFetch(initial: AppConfigPublic) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let current = initial;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/wallpaper') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { dataUrl: string };
        calls.push({ url, method, body });
        return json({ image: UPLOADED, bytes: body.dataUrl.length, mime: 'image/png' });
      }
      if (url.startsWith('/api/config') && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Partial<AppConfigPublic>;
        calls.push({ url, method, body });
        current = { ...current, ...body, wallpaper: { ...current.wallpaper, ...body.wallpaper } };
        return json(current);
      }
      if (url.startsWith('/api/config')) return json(current);
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls, setConfig: (next: AppConfigPublic) => (current = next) };
}

function renderCard(initial: AppConfigPublic) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.config, initial);
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <WallpaperProvider>
            {/* 与 AppShell 一致：图层挂在全局，设置页只负责编辑预览 */}
            <WallpaperLayer />
            <WallpaperSettingsCard />
          </WallpaperProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

function pickFile(type = 'image/png', name = 'wall.png') {
  const input = screen.getByTestId('wallpaper-file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['fake-bytes'], name, { type })] } });
}

describe('设置 → 外观 → 背景', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('没有背景时显示空状态，应用按钮不可用', async () => {
    installFetch(makeConfig());
    renderCard(makeConfig());
    expect(await screen.findByText('当前没有背景')).toBeTruthy();
    expect(screen.queryByTestId('wallpaper-layer')).toBeNull();
    expect((screen.getByRole('button', { name: '应用' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('选择图片进入预览态：整站生效但不写配置', async () => {
    const { calls } = installFetch(makeConfig());
    renderCard(makeConfig());
    pickFile();
    await waitFor(() => expect(screen.getByTestId('wallpaper-layer')).toBeTruthy());
    expect(screen.getByText('预览中 · 未应用')).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect((screen.getByRole('button', { name: '应用' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('应用时才上传并写入配置，图片以文件名保存而不是 data URL', async () => {
    const { calls } = installFetch(makeConfig());
    renderCard(makeConfig());
    pickFile();
    await waitFor(() => expect(screen.getByTestId('wallpaper-layer')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(calls.filter((call) => call.url === '/api/config')).toHaveLength(1));
    const upload = calls.find((call) => call.url === '/api/wallpaper');
    expect(upload?.body).toMatchObject({ dataUrl: expect.stringContaining('data:image/png;base64') });
    const patch = calls.find((call) => call.url === '/api/config')!.body as {
      wallpaper: { image: string; blur: number; strength: number };
    };
    expect(patch.wallpaper.image).toBe(UPLOADED);
    expect(patch.wallpaper.blur).toBe(10);
    expect(patch.wallpaper.strength).toBe(60);
    // 应用后回到「已应用」状态，并改用服务端地址
    await waitFor(() => expect(screen.getByText('已应用')).toBeTruthy());
    expect(screen.getByTestId('wallpaper-image').style.backgroundImage).toContain(
      `/api/wallpaper/${UPLOADED}`,
    );
  });

  it('取消预览：不发任何请求，回到已保存状态', async () => {
    const { calls } = installFetch(makeConfig());
    renderCard(makeConfig());
    pickFile();
    await waitFor(() => expect(screen.getByTestId('wallpaper-layer')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByTestId('wallpaper-layer')).toBeNull());
    expect(calls).toHaveLength(0);
    expect(screen.getByText('当前无背景')).toBeTruthy();
  });

  it('非图片文件给出可读提示，且不发请求', async () => {
    const { calls } = installFetch(makeConfig());
    renderCard(makeConfig());
    pickFile('text/plain', 'note.txt');
    expect(await screen.findByText(/不是受支持的图片格式/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('清除背景同样先进入预览态，应用后写回空文件名', async () => {
    const { calls } = installFetch(makeConfig({ image: UPLOADED }));
    renderCard(makeConfig({ image: UPLOADED }));
    fireEvent.click(await screen.findByRole('button', { name: '清除背景' }));
    await waitFor(() => expect(screen.queryByTestId('wallpaper-layer')).toBeNull());
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ wallpaper: { image: '' } });
  });

  it('在预览区拖动只改变构图，不改变页面其它状态', async () => {
    const { calls } = installFetch(makeConfig({ image: UPLOADED }));
    renderCard(makeConfig({ image: UPLOADED }));
    const preview = await screen.findByTestId('wallpaper-preview');
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({
      width: 560,
      height: 315,
      top: 0,
      left: 0,
      right: 560,
      bottom: 315,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(preview, { clientX: 280, clientY: 157, button: 0, pointerId: 1 });
    fireEvent.pointerMove(preview, { clientX: 420, clientY: 197, pointerId: 1 });
    fireEvent.pointerUp(preview, { pointerId: 1 });

    await waitFor(() =>
      expect(screen.getByTestId('wallpaper-preview-image').style.backgroundPosition).not.toBe(
        '50% 50%',
      ),
    );
    expect(screen.getByText('预览中 · 未应用')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
