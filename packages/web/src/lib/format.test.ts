import { describe, expect, it, vi } from 'vitest';
import {
  formatDelta,
  formatDuration,
  formatEta,
  formatNumber,
  formatPercent,
  formatRate,
  formatRelative,
  primaryTitle,
  secondaryTitle,
  statusLabel,
} from './format.js';

describe('格式化工具', () => {
  it('数字与百分比', () => {
    expect(formatNumber(12345)).toBe('12,345');
    expect(formatNumber(null)).toBe('—');
    expect(formatPercent(0.4567)).toBe('45.7%');
    expect(formatPercent(null)).toBe('—');
    expect(formatRate(8)).toBe('8.0');
    expect(formatDelta(1.234)).toBe('+1.23');
    expect(formatDelta(-1.2)).toBe('-1.20');
    expect(formatDelta(null)).toBe('—');
  });

  it('时长与剩余时间', () => {
    expect(formatDuration(30)).toBe('30 分钟');
    expect(formatDuration(600)).toBe('10.0 小时');
    expect(formatDuration(9000)).toBe('150 小时');
    expect(formatEta(30)).toBe('约 30 秒');
    expect(formatEta(120)).toBe('约 2 分钟');
    expect(formatEta(null)).toBe('计算中');
  });

  it('相对时间', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    expect(formatRelative('2026-09-15T11:30:00Z')).toContain('分钟');
    expect(formatRelative('2026-09-10T12:00:00Z')).toContain('天');
    expect(formatRelative(null)).toBe('从未');
    vi.useRealTimers();
  });

  it('收藏状态文案', () => {
    expect(statusLabel(1)).toBe('想看');
    expect(statusLabel(2)).toBe('看过');
    expect(statusLabel(5)).toBe('抛弃');
    expect(statusLabel(null)).toBe('未收藏');
  });

  it('标题优先使用中文名', () => {
    expect(primaryTitle({ name: 'Hyouka', nameCn: '冰菓' })).toBe('冰菓');
    expect(primaryTitle({ name: 'Hyouka', nameCn: '' })).toBe('Hyouka');
    expect(secondaryTitle({ name: 'Hyouka', nameCn: '冰菓' })).toBe('Hyouka');
    expect(secondaryTitle({ name: '冰菓', nameCn: '冰菓' })).toBe('');
  });
});
