import type { AppConfigPublic } from '@bangumi-analyzer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/queries.js';
import { MaterialProvider } from '../layout/material.js';
import { WallpaperProvider } from '../layout/wallpaper.js';
import { ToastProvider } from '../ui/toast.js';
import { MaterialSettingsCard } from './MaterialSettingsCard.js';

function makeConfig(
  options: {
    material?: Partial<AppConfigPublic['material']>;
    wallpaperImage?: string;
  } = {},
): AppConfigPublic {
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
    version: '1.5.0',
    ai: {
      enabled: false,
      provider: 'openai-compatible',
      baseUrl: '',
      model: '',
      hasApiKey: false,
      apiKeyHint: null,
    },
    wallpaper: {
      image: options.wallpaperImage ?? '',
      focusX: 50,
      focusY: 50,
      blur: 10,
      strength: 60,
    },
    material: { preset: 'balanced', clarity: 50, frosted: 50, ...options.material },
  };
}

function installFetch(initial: AppConfigPublic) {
  const writes: Array<Record<string, unknown>> = [];
  let current = initial;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/config') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(body);
        current = { ...current, ...body } as AppConfigPublic;
        return json(current);
      }
      if (url.startsWith('/api/config')) return json(current);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return { writes };
}

function renderCard(config: AppConfigPublic) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.config, config);
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <WallpaperProvider>
            <MaterialProvider>
              <MaterialSettingsCard />
            </MaterialProvider>
          </WallpaperProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const vars = () => ({
  clarity: document.documentElement.style.getPropertyValue('--mat-clarity'),
  frost: document.documentElement.style.getPropertyValue('--mat-frost'),
});

describe('设置 → 外观 → 界面材质', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty('--mat-clarity');
    document.documentElement.style.removeProperty('--mat-frost');
  });

  it('默认显示平衡，并把材质写入 CSS 变量', async () => {
    installFetch(makeConfig());
    renderCard(makeConfig());
    expect(await screen.findByText('已应用 · 平衡')).toBeTruthy();
    expect(screen.getByRole('button', { name: '平衡' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(vars().clarity).toBe('0.500'));
    expect(vars().frost).toBe('0.500');
  });

  it('选择预设立即进入预览态，取消后回到已保存值且不写配置', async () => {
    const { writes } = installFetch(makeConfig());
    renderCard(makeConfig());
    fireEvent.click(await screen.findByRole('button', { name: '磨砂' }));
    await waitFor(() => expect(vars().frost).toBe('0.820'));
    expect(screen.getByText('预览中 · 未应用')).toBeTruthy();
    expect(writes).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(vars().frost).toBe('0.500'));
    expect(writes).toHaveLength(0);
    expect(screen.getByText('已应用 · 平衡')).toBeTruthy();
  });

  it('应用后写回配置，并且只提交材质字段', async () => {
    const { writes } = installFetch(makeConfig());
    renderCard(makeConfig());
    fireEvent.click(await screen.findByRole('button', { name: '清透' }));
    await waitFor(() => expect(vars().clarity).toBe('0.780'));
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ material: { preset: 'clear', clarity: 78, frosted: 22 } });
    expect(Object.keys(writes[0]!)).toEqual(['material']);
  });

  it('单独拖动滑块后不再高亮任何预设，但仍可应用', async () => {
    const { writes } = installFetch(makeConfig());
    renderCard(makeConfig());
    const clarity = await screen.findByRole('slider', { name: '通透度' });
    clarity.focus();
    fireEvent.keyDown(clarity, { key: 'Home' });
    await waitFor(() => expect(vars().clarity).toBe('0.000'));
    expect(screen.getByText('预览中 · 未应用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(writes).toHaveLength(1));
  });

  it('没有背景时给出「材质需要背景」的提示', async () => {
    installFetch(makeConfig({ wallpaperImage: '' }));
    renderCard(makeConfig({ wallpaperImage: '' }));
    expect(await screen.findByText(/材质需要背景作为「环境」/)).toBeTruthy();
  });

  it('已经设置背景时不出现该提示', async () => {
    installFetch(makeConfig({ wallpaperImage: 'wp-0123456789abcdef.jpg' }));
    renderCard(makeConfig({ wallpaperImage: 'wp-0123456789abcdef.jpg' }));
    expect(await screen.findByText('已应用 · 平衡')).toBeTruthy();
    expect(screen.queryByText(/材质需要背景作为「环境」/)).toBeNull();
  });
});
