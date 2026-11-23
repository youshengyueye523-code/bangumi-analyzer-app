import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/queries.js';
import type { AppConfigPublic } from '@bangumi-analyzer/shared';
import { WallpaperLayer, WallpaperProvider, useWallpaper } from './wallpaper.js';

function config(wallpaper: Partial<AppConfigPublic['wallpaper']>): AppConfigPublic {
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

/** 通过 context 暴露预览操作，用于验证「预览优先 / 取消恢复」 */
function Probe() {
  const { active, dirty, updatePreview, cancelPreview } = useWallpaper();
  return (
    <div>
      <span data-testid="active-image">{active.image}</span>
      <span data-testid="dirty">{String(dirty)}</span>
      <button type="button" onClick={() => updatePreview({ image: 'data:image/png;base64,AAA' })}>
        换预览图
      </button>
      <button type="button" onClick={() => updatePreview({ strength: 100 })}>
        拉满强度
      </button>
      <button type="button" onClick={cancelPreview}>
        取消
      </button>
    </div>
  );
}

function renderShell(appConfig: AppConfigPublic) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.config, appConfig);
  return render(
    <QueryClientProvider client={queryClient}>
      <WallpaperProvider>
        <WallpaperLayer />
        <Probe />
      </WallpaperProvider>
    </QueryClientProvider>,
  );
}

describe('全局背景板图层', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-wallpaper');
    document.documentElement.style.removeProperty('--wp-strength');
    document.documentElement.style.removeProperty('--wp-blur');
  });

  it('没有背景时不渲染图层，也不写入任何 CSS 变量（视觉等同 v1.4.2.2）', async () => {
    renderShell(config({}));
    await waitFor(() => expect(screen.getByTestId('active-image').textContent).toBe(''));
    expect(screen.queryByTestId('wallpaper-layer')).toBeNull();
    expect(document.documentElement.dataset.wallpaper).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--wp-strength')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--wp-blur')).toBe('');
  });

  it('有背景时渲染图片层与暗化层，并把强度 / 模糊度写进 CSS 变量', async () => {
    renderShell(
      config({ image: 'wp-0123456789abcdef.png', focusX: 30, focusY: 70, blur: 16, strength: 80 }),
    );
    const image = await screen.findByTestId('wallpaper-image');
    expect(image.style.backgroundImage).toContain('/api/wallpaper/wp-0123456789abcdef.png');
    expect(image.style.backgroundPosition).toBe('30% 70%');
    expect(screen.getByTestId('wallpaper-scrim')).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.wallpaper).toBe('on'));
    expect(document.documentElement.style.getPropertyValue('--wp-strength')).toBe('0.800');
    expect(document.documentElement.style.getPropertyValue('--wp-blur')).toBe('16px');
  });

  it('编辑进入预览态：预览优先于已保存配置，取消后回到已保存状态', async () => {
    renderShell(config({ image: 'wp-0123456789abcdef.png' }));
    expect(screen.queryByTestId('wallpaper-layer')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '换预览图' }));
    await waitFor(() =>
      expect(screen.getByTestId('active-image').textContent).toBe('data:image/png;base64,AAA'),
    );
    expect(screen.getByTestId('dirty').textContent).toBe('true');
    expect(screen.getByTestId('wallpaper-image').style.backgroundImage).toContain(
      'data:image/png;base64,AAA',
    );

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.getByTestId('active-image').textContent).toBe('wp-0123456789abcdef.png'),
    );
    expect(screen.getByTestId('dirty').textContent).toBe('false');
    expect(screen.getByTestId('wallpaper-image').style.backgroundImage).toContain(
      '/api/wallpaper/wp-0123456789abcdef.png',
    );
  });

  it('强度变化会实时改写 CSS 变量（用于面板透明度合成）', async () => {
    renderShell(config({ image: 'wp-0123456789abcdef.png', strength: 20 }));
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--wp-strength')).toBe('0.200'),
    );
    fireEvent.click(screen.getByRole('button', { name: '拉满强度' }));
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--wp-strength')).toBe('1.000'),
    );
  });
});
