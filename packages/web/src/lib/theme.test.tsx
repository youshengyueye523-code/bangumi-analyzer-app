import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetThemeSyncStateForTest, syncThemeFromServerConfig, useTheme } from './theme.js';
import { api } from './api.js';

function Controls({ name }: { name: string }) {
  const { mode, resolved, setMode, toggle } = useTheme();
  return <div><output data-testid={name}>{mode}/{resolved}</output><button onClick={() => setMode('dark')}>{name}深色</button><button onClick={() => setMode('light')}>{name}浅色</button><button onClick={() => setMode('system')}>{name}系统</button><button onClick={toggle}>{name}切换</button></div>;
}
describe('跨入口主题状态', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    resetThemeSyncStateForTest();
    vi.restoreAllMocks();
  });
  it('设置与顶栏共享模式和切换方向', async () => {
    const updateSpy = vi.spyOn(api, 'updateConfig').mockResolvedValue({ theme: 'dark' } as never);
    render(<><Controls name="设置" /><Controls name="顶栏" /></>);
    fireEvent.click(screen.getByText('设置深色'));
    await waitFor(() => expect(screen.getByTestId('顶栏').textContent).toBe('dark/dark'));
    expect(updateSpy).toHaveBeenCalledWith({ theme: 'dark' });
    fireEvent.click(screen.getByText('顶栏切换'));
    await waitFor(() => expect(screen.getByTestId('设置').textContent).toBe('light/light'));
    expect(localStorage.getItem('bangumi-analyzer-theme')).toBe('light');
    expect(updateSpy).toHaveBeenCalledWith({ theme: 'light' });
    fireEvent.click(screen.getByText('设置系统'));
    await waitFor(() => expect(screen.getByTestId('顶栏').textContent).toMatch(/^system\//));
    expect(localStorage.getItem('bangumi-analyzer-theme')).toBeNull();
    expect(updateSpy).toHaveBeenCalledWith({ theme: 'system' });
  });
  it('其他标签的存储变化同步模式，不把它覆盖回旧值', async () => {
    localStorage.setItem('bangumi-analyzer-theme', 'dark'); render(<Controls name="顶栏" />);
    localStorage.setItem('bangumi-analyzer-theme', 'light'); window.dispatchEvent(new StorageEvent('storage', { key: 'bangumi-analyzer-theme', newValue: 'light' }));
    await waitFor(() => expect(screen.getByTestId('顶栏').textContent).toBe('light/light'));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('服务端配置同步可在新端口下恢复持久化主题，并忽略保存中的过期响应', async () => {
    render(<Controls name="面板" />);
    syncThemeFromServerConfig('dark');
    await waitFor(() => expect(screen.getByTestId('面板').textContent).toBe('dark/dark'));
    expect(localStorage.getItem('bangumi-analyzer-theme')).toBe('dark');

    let resolvePut!: (v: never) => void;
    vi.spyOn(api, 'updateConfig').mockImplementationOnce(
      () => new Promise((resolve) => { resolvePut = resolve; }),
    );
    fireEvent.click(screen.getByText('面板浅色'));
    await waitFor(() => expect(screen.getByTestId('面板').textContent).toBe('light/light'));

    // While PUT { theme: 'light' } is in-flight, stale GET/poll with 'dark' must not revert local selection.
    syncThemeFromServerConfig('dark');
    expect(screen.getByTestId('面板').textContent).toBe('light/light');

    resolvePut({ theme: 'light' } as never);
    await waitFor(() => {
      syncThemeFromServerConfig('system');
      expect(screen.getByTestId('面板').textContent).toMatch(/^system\//);
    });
  });
});
