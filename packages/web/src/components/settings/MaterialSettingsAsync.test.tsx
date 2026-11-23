import type { AppConfigPublic } from '@bangumi-analyzer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queries.js';
import { MaterialProvider } from '../layout/material.js';
import { WallpaperProvider } from '../layout/wallpaper.js';
import { ToastProvider } from '../ui/toast.js';
import { MaterialSettingsCard } from './MaterialSettingsCard.js';

const initial = { material: { preset: 'balanced', clarity: 50, frosted: 50 }, wallpaper: { image: '', focusX: 50, focusY: 50, strength: 60, blur: 10 } } as AppConfigPublic;
function show() {
  vi.spyOn(api, 'config').mockResolvedValue(initial);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.config, initial);
  render(<QueryClientProvider client={client}><ToastProvider><WallpaperProvider><MaterialProvider><MaterialSettingsCard /></MaterialProvider></WallpaperProvider></ToastProvider></QueryClientProvider>);
}
describe('材质保存的编辑边界', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('慢响应时锁定预设与滑块，成功后可继续编辑', async () => {
    let release!: (value: AppConfigPublic) => void;
    const update = vi.spyOn(api, 'updateConfig').mockImplementation(() => new Promise(r => { release = r; }));
    show(); fireEvent.click(screen.getByRole('button', { name: '磨砂' })); fireEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    const clear = screen.getByRole('button', { name: '清透' }) as HTMLButtonElement;
    expect(clear.matches(':disabled')).toBe(true);
    expect(screen.getByRole('slider', { name: '通透度' }).hasAttribute('data-disabled')).toBe(true);
    const material = { ...initial.material, ...update.mock.calls[0]![0].material };
    release({ ...initial, material });
    await waitFor(() => expect(screen.getByText('已应用 · 磨砂')).toBeTruthy());
    expect(clear.matches(':disabled')).toBe(false); fireEvent.click(clear); expect(screen.getByText('预览中 · 未应用')).toBeTruthy();
  });
  it('保存失败保留预览，解锁后可重试', async () => {
    const update = vi.spyOn(api, 'updateConfig').mockRejectedValueOnce(new Error('隔离失败')).mockResolvedValueOnce({ ...initial, material: { preset: 'frosted', clarity: 24, frosted: 82 } });
    show(); fireEvent.click(screen.getByRole('button', { name: '磨砂' })); fireEvent.click(screen.getByRole('button', { name: '应用' }));
    await screen.findByText('隔离失败'); expect(screen.getByText('预览中 · 未应用')).toBeTruthy(); expect((screen.getByRole('button', { name: '应用' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '应用' })); await screen.findByText('已应用 · 磨砂'); expect(update).toHaveBeenCalledTimes(2);
  });
});
