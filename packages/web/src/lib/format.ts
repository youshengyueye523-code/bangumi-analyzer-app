import {
  COLLECTION_TYPE_LABEL,
  type AnimeFormat,
  type CollectionType,
  type Season,
} from '@bangumi-analyzer/shared';

const numberFormatter = new Intl.NumberFormat('zh-CN');
const compactFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return numberFormatter.format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.abs(value) >= 10_000 ? compactFormatter.format(value) : numberFormatter.format(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatRate(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function formatDelta(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '从未';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffSeconds = Math.round((Date.now() - date.getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  const minute = 60;
  const hour = 3600;
  const day = 86_400;
  const month = 2_592_000;
  const year = 31_536_000;
  const abs = Math.abs(diffSeconds);
  if (abs < minute) return formatter.format(-Math.round(diffSeconds), 'second');
  if (abs < hour) return formatter.format(-Math.round(diffSeconds / minute), 'minute');
  if (abs < day) return formatter.format(-Math.round(diffSeconds / hour), 'hour');
  if (abs < month) return formatter.format(-Math.round(diffSeconds / day), 'day');
  if (abs < year) return formatter.format(-Math.round(diffSeconds / month), 'month');
  return formatter.format(-Math.round(diffSeconds / year), 'year');
}

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const hours = minutes / 60;
  if (hours < 1) return `${Math.round(minutes)} 分钟`;
  if (hours < 100) return `${hours.toFixed(1)} 小时`;
  return `${Math.round(hours)} 小时`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return '计算中';
  }
  if (seconds < 60) return `约 ${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `约 ${Math.round(seconds / 60)} 分钟`;
  return `约 ${(seconds / 3600).toFixed(1)} 小时`;
}

export function statusLabel(type: number | null | undefined): string {
  if (!type) return '未收藏';
  return COLLECTION_TYPE_LABEL[type as CollectionType] ?? '未知';
}

export function statusColorVar(type: number | null | undefined): string {
  switch (type) {
    case 1:
      return 'var(--status-wish)';
    case 2:
      return 'var(--status-done)';
    case 3:
      return 'var(--status-doing)';
    case 4:
      return 'var(--status-hold)';
    case 5:
      return 'var(--status-dropped)';
    default:
      return 'var(--text-subtle)';
  }
}

export const SEASON_TEXT: Record<Season, string> = {
  冬: '冬季',
  春: '春季',
  夏: '夏季',
  秋: '秋季',
};

export function seasonLabel(season: Season | null | undefined): string {
  return season ? SEASON_TEXT[season] : '—';
}

export function formatLabel(format: AnimeFormat | null | undefined): string {
  switch (format) {
    case 'TV':
      return 'TV';
    case 'Movie':
      return '剧场版';
    case 'OVA':
      return 'OVA';
    case 'ONA':
      return '网络动画';
    case 'Special':
      return '特别篇';
    case 'Music':
      return '音乐';
    default:
      return '其他';
  }
}

export function bangumiSubjectUrl(id: number): string {
  return `https://bgm.tv/subject/${id}`;
}

export function bangumiUserUrl(username: string): string {
  return `https://bgm.tv/user/${username}`;
}

export function primaryTitle(item: { nameCn: string; name: string }): string {
  return item.nameCn || item.name || '未知作品';
}

export function secondaryTitle(item: { nameCn: string; name: string }): string {
  if (item.nameCn && item.name && item.nameCn !== item.name) return item.name;
  return '';
}
