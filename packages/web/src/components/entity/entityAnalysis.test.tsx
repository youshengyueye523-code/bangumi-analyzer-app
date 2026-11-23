import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MetricValue } from './MetricValue.js';
import { SampleBadge } from './SampleBadge.js';
import { VisibilityContextBar } from './VisibilityContextBar.js';

describe('SampleBadge（v1.8 样本量一等信息）', () => {
  it('n>=3 → n=N；n=2 → 样本不足；n=1 → 单样本；n=0 不渲染徽标', () => {
    const { rerender } = render(<SampleBadge sample={5} />);
    expect(screen.getByText('n=5')).toBeTruthy();

    rerender(<SampleBadge sample={2} />);
    expect(screen.getByText('样本不足 · n=2')).toBeTruthy();

    rerender(<SampleBadge sample={1} />);
    expect(screen.getByText('单样本 · n=1')).toBeTruthy();

    rerender(<SampleBadge sample={0} />);
    expect(screen.queryByText(/n=/)).toBeNull();
  });
});

describe('MetricValue（五态语义 + 估算标记）', () => {
  it('value 与 0 都是合法数值，null 显示「无样本」而不是 0', () => {
    const { rerender } = render(<MetricValue value={7.25} format={(v) => v.toFixed(2)} sample={7} />);
    expect(screen.getByText('7.25')).toBeTruthy();
    expect(screen.getByText('n=7')).toBeTruthy();

    rerender(<MetricValue value={0} format={(v) => `${v}%`} sample={3} />);
    expect(screen.getByText('0%')).toBeTruthy();

    rerender(<MetricValue value={null} sample={0} />);
    expect(screen.getByText('— 无样本')).toBeTruthy();
    expect(screen.queryByText('n=0')).toBeNull();
  });

  it('hidden / unknown 与 null 使用不同文案', () => {
    const { rerender } = render(<MetricValue value={null} state="hidden" note="内容仍在，只是当前不显示" />);
    expect(screen.getByText('已隐藏')).toBeTruthy();
    expect(screen.getByText('内容仍在，只是当前不显示')).toBeTruthy();

    rerender(<MetricValue value={null} state="unknown" note="源数据不足" />);
    expect(screen.getByText('未知 · 数据不足')).toBeTruthy();
    expect(screen.getByText('源数据不足')).toBeTruthy();
  });

  it('estimate 永久携带「估算」徽标，并展示样本量', () => {
    render(<MetricValue value={576} format={(v) => `${v} 分钟`} estimate sample={2} />);
    expect(screen.getByText('576 分钟')).toBeTruthy();
    expect(screen.getByText('估算')).toBeTruthy();
    expect(screen.getByText('样本不足 · n=2')).toBeTruthy();
  });

  it('value 与 sample 是两个层级但阅读连续：统一用 · 分隔（v1.8.1）', () => {
    const { rerender } = render(<MetricValue value={7.91} format={(v) => v.toFixed(2)} sample={11} />);
    const line = screen.getByText('7.91').closest('div');
    expect(line?.textContent?.replace(/\s+/g, '')).toBe('7.91·n=11');

    rerender(<MetricValue value={1} format={(v) => `${Math.round(v * 100)}%`} sample={11} />);
    expect(screen.getByText('100%').closest('div')?.textContent?.replace(/\s+/g, '')).toBe('100%·n=11');

    // sample = 0 时不渲染悬空分隔符（由 MetricValue 表达「无样本」）
    rerender(<MetricValue value={null} sample={0} />);
    expect(screen.queryByText('·')).toBeNull();
  });
});

describe('VisibilityContextBar（口径条）', () => {
  it('没有隐藏内容时不渲染', () => {
    const { container } = render(
      <VisibilityContextBar hidden={{ series: 0, members: 0 }} visibility="visible" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('有隐藏内容时说明口径与范围，并提供整页切换', () => {
    const onToggle = vi.fn();
    render(
      <VisibilityContextBar
        hidden={{ series: 1, members: 2 }}
        visibility="visible"
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText(/当前可见口径 · 已隐藏 2 个成员（来自 1 个系列）/)).toBeTruthy();
    expect(screen.getByText(/隐藏只作用于显示层/)).toBeTruthy();

    fireEvent.click(screen.getByText('完整数据'));
    expect(onToggle).toHaveBeenCalledWith('real');
  });

  it('完整数据口径明确说明包含隐藏内容，可切回可见', () => {
    const onToggle = vi.fn();
    render(
      <VisibilityContextBar
        hidden={{ series: 0, members: 3 }}
        visibility="real"
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText(/完整数据口径 · 已包含 3 个成员的隐藏内容/)).toBeTruthy();
    fireEvent.click(screen.getByText('当前可见'));
    expect(onToggle).toHaveBeenCalledWith('visible');
  });
});
