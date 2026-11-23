import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTheme } from './theme.js';

function Controls({ name }: { name: string }) {
  const { mode, resolved, setMode, toggle } = useTheme();
  return <div><output data-testid={name}>{mode}/{resolved}</output><button onClick={() => setMode('dark')}>{name}深色</button><button onClick={() => setMode('system')}>{name}系统</button><button onClick={toggle}>{name}切换</button></div>;
}
describe('跨入口主题状态', () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.classList.remove('dark'); });
  it('设置与顶栏共享模式和切换方向', async () => {
    render(<><Controls name="设置" /><Controls name="顶栏" /></>);
    fireEvent.click(screen.getByText('设置深色'));
    await waitFor(() => expect(screen.getByTestId('顶栏').textContent).toBe('dark/dark'));
    fireEvent.click(screen.getByText('顶栏切换'));
    await waitFor(() => expect(screen.getByTestId('设置').textContent).toBe('light/light'));
    expect(localStorage.getItem('bangumi-analyzer-theme')).toBe('light');
    fireEvent.click(screen.getByText('设置系统'));
    await waitFor(() => expect(screen.getByTestId('顶栏').textContent).toMatch(/^system\//));
    expect(localStorage.getItem('bangumi-analyzer-theme')).toBeNull();
  });
  it('其他标签的存储变化同步模式，不把它覆盖回旧值', async () => {
    localStorage.setItem('bangumi-analyzer-theme', 'dark'); render(<Controls name="顶栏" />);
    localStorage.setItem('bangumi-analyzer-theme', 'light'); window.dispatchEvent(new StorageEvent('storage', { key: 'bangumi-analyzer-theme', newValue: 'light' }));
    await waitFor(() => expect(screen.getByTestId('顶栏').textContent).toBe('light/light'));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
