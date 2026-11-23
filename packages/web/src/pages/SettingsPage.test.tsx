import type { AppConfigPublic } from '@bangumi-analyzer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaterialProvider } from '../components/layout/material.js';
import { WallpaperProvider } from '../components/layout/wallpaper.js';
import { ToastProvider } from '../components/ui/toast.js';
import { queryKeys } from '../lib/queries.js';
import { SettingsPage } from './SettingsPage.js';

function makeConfig(hideNsfw = false): AppConfigPublic {
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
    hideNsfw,
    dataDir: 'C:/data',
    dbPath: 'C:/data/bangumi.db',
    dbSizeBytes: 1,
    version: '1.5.2',
    ai: {
      enabled: false,
      provider: 'openai-compatible',
      baseUrl: '',
      model: '',
      hasApiKey: false,
      apiKeyHint: null,
    },
    wallpaper: { image: '', focusX: 50, focusY: 50, blur: 10, strength: 60 },
    material: { preset: 'balanced', clarity: 50, frosted: 50 },
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

function renderPage(config: AppConfigPublic, entry = '/settings?tab=appearance') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.config, config);
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <WallpaperProvider>
            <MaterialProvider>
              <SettingsPage />
            </MaterialProvider>
          </WallpaperProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('设置 → 外观 → 内容可见性（隐藏 NSFW）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('关于页显式重开引导不改步骤或保存展示状态', async () => {
    const config = makeConfig();
    const { writes } = installFetch(config);
    renderPage(config, '/settings?tab=about');
    const link = await screen.findByRole('link', { name: '重新显示引导' });
    expect(link.getAttribute('href')).toBe('/me?onboarding=show');
    fireEvent.click(link);
    expect(writes).toEqual([]);
  });

  it('默认关闭时开关未选中，开启后写入 hideNsfw 并即时反映状态', async () => {
    const { writes } = installFetch(makeConfig(false));
    renderPage(makeConfig(false));

    const toggle = await screen.findByRole('switch', { name: /隐藏 NSFW 内容/ });
    expect(toggle.getAttribute('data-state')).toBe('unchecked');

    fireEvent.click(toggle);

    await waitFor(() => expect(writes).toEqual([{ hideNsfw: true }]));
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: /隐藏 NSFW 内容/ }).getAttribute('data-state'),
      ).toBe('checked'),
    );
    expect(screen.getByText(/当前隐藏已开启/)).toBeTruthy();
    expect(screen.getByText(/当前隐藏已开启/).textContent).toContain('家族仅隐藏其中不可见的系列');
  });

  it('关闭 NSFW 过滤时不声称解除主动隐藏', async () => {
    const { writes } = installFetch(makeConfig(true));
    renderPage(makeConfig(true));

    const toggle = await screen.findByRole('switch', { name: /隐藏 NSFW 内容/ });
    expect(toggle.getAttribute('data-state')).toBe('checked');
    expect(screen.getByText(/当前隐藏已开启/)).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() => expect(writes).toEqual([{ hideNsfw: false }]));
    expect(await screen.findByText(/NSFW 展示过滤已关闭；主动隐藏仍然生效/)).toBeTruthy();
  });
});
