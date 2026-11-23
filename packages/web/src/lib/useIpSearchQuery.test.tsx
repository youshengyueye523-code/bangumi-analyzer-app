import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useIpSearchQuery } from './useIpSearchQuery.js';

function Probe() {
  const { searchValue, setSearchValue, keyword, awaitingKeyword } = useIpSearchQuery();
  const location = useLocation(), navigate = useNavigate();
  return <>
    <input aria-label="关键词" value={searchValue} onChange={(e) => setSearchValue(e.target.value)} />
    <output data-testid="url">{location.search}</output>
    <output data-testid="query">{keyword}</output>
    <output data-testid="waiting">{String(awaitingKeyword)}</output>
    <button onClick={() => navigate(-1)}>后退</button>
    <button onClick={() => navigate(1)}>前进</button>
  </>;
}

describe('Series / Franchise URL 搜索状态', () => {
  it('后退和前进恢复各自关键词，不把当前输入写回旧历史项', async () => {
    render(<MemoryRouter initialEntries={['/series', '/series?sort=title']}><Probe /></MemoryRouter>);
    const user = userEvent.setup(), input = screen.getByRole('textbox');
    await user.type(input, '甲');
    await waitFor(() => expect(screen.getByTestId('query').textContent).toBe('甲'));
    await user.click(screen.getByText('后退'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    // Longer than the debounce: stale scheduled draft must not rewrite history.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByTestId('url').textContent).toBe('');
    await user.click(screen.getByText('前进'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('甲'));
    expect(screen.getByTestId('url').textContent).toContain('sort=title');
  });

  it('防抖窗口立即标记不匹配，提交只替换q且保留筛选', async () => {
    render(<MemoryRouter initialEntries={['/franchises?state=candidate&q=甲']}><Probe /></MemoryRouter>);
    const user = userEvent.setup(), input = screen.getByRole('textbox');
    await user.clear(input); await user.type(input, '乙');
    expect(screen.getByTestId('waiting').textContent).toBe('true');
    expect(screen.getByTestId('query').textContent).toBe('甲');
    await waitFor(() => expect(screen.getByTestId('query').textContent).toBe('乙'));
    expect(screen.getByTestId('waiting').textContent).toBe('false');
    expect(screen.getByTestId('url').textContent).toContain('state=candidate');
    await user.clear(input);
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('?state=candidate'));
  });

  it('历史导航取消未提交的防抖输入', async () => {
    render(<MemoryRouter initialEntries={['/series?q=历史', '/series?q=当前']}><Probe /></MemoryRouter>);
    const user = userEvent.setup(), input = screen.getByRole('textbox');
    await user.clear(input); await user.type(input, '未提交');
    await user.click(screen.getByText('后退'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('历史'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByTestId('query').textContent).toBe('历史');
  });
});
