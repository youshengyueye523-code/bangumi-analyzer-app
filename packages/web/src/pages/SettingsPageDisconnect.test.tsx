import type { AppConfigPublic } from '@bangumi-analyzer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui/toast.js';
import { queryKeys } from '../lib/queries.js';
import { SettingsPage } from './SettingsPage.js';

const config = (portable = true): AppConfigPublic => ({
  ...(portable ? { canDisconnectBangumi: true } : {}), username: 'alice', hasToken: true, tokenHint: 'fix…ure', nickname: 'local name', avatar: '',
  onboardingSeen: true, summaryAutoTranslate: false, summaryConcurrency: 2, subjectTypes: [2], requestIntervalMs: 1000,
  detailRefreshDays: 30, userAgent: 'fixture', cacheCovers: false, httpProxy: '', hideNsfw: false, dataDir: 'fixture', dbPath: 'fixture.db', dbSizeBytes: 1, version: '2.0.0',
  ai: { enabled: false, provider: 'openai-compatible', baseUrl: '', model: 'fixture-model', hasApiKey: true, apiKeyHint: 'AI…key' },
  wallpaper: { image: '', focusX: 50, focusY: 50, blur: 10, strength: 60 }, material: { preset: 'balanced', clarity: 50, frosted: 50 },
});
function setup(portable = true, fail = false) {
  let current = config(portable), disconnects = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/config/disconnect' && init?.method === 'POST') {
      disconnects++;
      if (fail) return response({ error: { message: 'fixture disconnect failed', code: 'fixture_failure' } }, 409);
      current = { ...current, username: '', hasToken: false, tokenHint: null }; return response(current);
    }
    if (url === '/api/config/verify') return response({ ok: true, message: '认证成功：fixture-alice' });
    if (url === '/api/config') return response(current);
    if (url.startsWith('/api/sync/history')) return response({ runs: [] });
    if (url === '/api/sync/status') return response({ running: false, progress: null, lastRun: null, lastSuccessfulSyncAt: null });
    return response({});
  }));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(queryKeys.config, current);
  render(<QueryClientProvider client={cache}><ToastProvider><MemoryRouter initialEntries={['/settings?tab=bangumi']}><SettingsPage /></MemoryRouter></ToastProvider></QueryClientProvider>);
  return { cache, count: () => disconnects };
}
afterEach(() => vi.unstubAllGlobals());
describe('portable account disconnect UI', () => {
  it('ordinary Local has no new entry', async () => {
    setup(false); await screen.findByRole('button', { name: '保存配置' });
    expect(screen.queryByRole('button', { name: '断开 Bangumi 账号' })).toBeNull();
  });
  it('confirmation explains retention; cancelling makes no request', async () => {
    const state = setup(); fireEvent.click(await screen.findByRole('button', { name: '断开 Bangumi 账号' }));
    const dialog = screen.getByRole('dialog'); expect(dialog.textContent).toContain('独立 AI 配置全部保留');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' })); expect(state.count()).toBe(0);
  });
  it('successful disconnect clears token draft and old verification, updates shared config to unbound', async () => {
    const state = setup();
    fireEvent.change(screen.getByLabelText('Access Token'), { target: { value: 'unsaved-fixture-token' } });
    fireEvent.click(screen.getByRole('button', { name: '验证 Token' }));
    await screen.findAllByText('认证成功：fixture-alice');
    await waitFor(() => expect((screen.getByRole('button', { name: '断开 Bangumi 账号' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '断开 Bangumi 账号' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认断开' }));
    await screen.findByText('未绑定 Bangumi 账号');
    expect((screen.getByLabelText('Bangumi 用户名（或数字 UID）') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Access Token') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: '断开 Bangumi 账号' })).toBeNull();
    expect(state.cache.getQueryData<AppConfigPublic>(queryKeys.config)).toMatchObject({ username: '', hasToken: false, nickname: 'local name', ai: { hasApiKey: true } });
    expect(state.count()).toBe(1);
  });
  it('failure does not display success or discard account/draft', async () => {
    setup(true, true);
    fireEvent.change(screen.getByLabelText('Access Token'), { target: { value: 'unsaved-fixture-token' } });
    fireEvent.click(screen.getByRole('button', { name: '断开 Bangumi 账号' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认断开' }));
    await screen.findByText('断开失败');
    expect((screen.getByLabelText('Access Token') as HTMLInputElement).value).toBe('unsaved-fixture-token');
    expect(screen.queryByText('未绑定 Bangumi 账号')).toBeNull();
    expect((screen.getByLabelText('Bangumi 用户名（或数字 UID）') as HTMLInputElement).value).toBe('alice');
  });
});
