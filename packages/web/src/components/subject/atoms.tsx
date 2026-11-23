import { ImageOff, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { formatRate, statusColorVar, statusLabel } from '../../lib/format.js';

/** 封面图：统一走本地代理，已缓存时可离线显示，未缓存时回退到 Bangumi 图床。 */
export function CoverImage({
  id,
  title,
  className,
  rounded = 'rounded-[10px]',
}: {
  id: number;
  title: string;
  className?: string;
  rounded?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn('relative overflow-hidden bg-surface-2', rounded, className)}>
      {failed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-subtle">
          <ImageOff size={16} />
          <span className="text-caption">无封面</span>
        </div>
      ) : (
        <img
          src={api.coverUrl(id)}
          alt={`${title} 封面`}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}

export function StatusBadge({
  type,
  size = 'md',
  className,
}: {
  type: number;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const color = statusColorVar(type);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-chip border font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-caption' : 'px-2 py-0.5 text-note',
        'whitespace-nowrap',
        className,
      )}
      style={{ color, borderColor: 'transparent', backgroundColor: 'color-mix(in oklab, currentColor 14%, transparent)' }}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {statusLabel(type)}
    </span>
  );
}

export function RatePill({
  value,
  label,
  tone = 'default',
  className,
}: {
  value: number | null | undefined;
  label?: string;
  tone?: 'default' | 'accent' | 'muted';
  className?: string;
}) {
  const isEmpty = value === null || value === undefined || value <= 0;
  return (
    <span
      className={cn(
        'numeric inline-flex items-center gap-1 whitespace-nowrap rounded-[8px] border border-border bg-surface-2 px-1.5 py-0.5 text-caption',
        tone === 'accent' && 'border-transparent bg-accent-soft text-accent',
        isEmpty && 'text-subtle',
        className,
      )}
      title={label}
    >
      <Star size={10} className={isEmpty ? 'text-subtle' : 'text-warning'} />
      {isEmpty ? '—' : formatRate(value)}
    </span>
  );
}

export function ProgressMeter({
  value,
  watched,
  total,
  className,
  showLabel = true,
}: {
  value: number;
  watched?: number;
  total?: number;
  className?: string;
  showLabel?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, backgroundColor: 'var(--accent)' }}
        />
      </div>
      {showLabel ? (
        <span className="numeric shrink-0 text-caption text-subtle">
          {watched !== undefined && total !== undefined ? `${watched}/${total || '?'}` : `${Math.round(value * 100)}%`}
        </span>
      ) : null}
    </div>
  );
}

export function TagList({
  tags,
  max = 4,
  className,
  onSelect,
}: {
  tags: string[];
  max?: number;
  className?: string;
  onSelect?: (tag: string) => void;
}) {
  const visible = tags.slice(0, max);
  const rest = tags.length - visible.length;
  const chipClass =
    'max-w-full truncate-line rounded border border-border bg-surface-2 px-1.5 py-0.5 text-caption text-muted';
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {visible.map((tag) => onSelect ? (
        <button
          key={tag}
          type="button"
          data-tag={tag}
          onClick={() => onSelect(tag)}
          className={cn(chipClass, 'transition-colors hover:border-accent/40 hover:text-accent')}
        >
          {tag}
        </button>
      ) : (
        <span key={tag} data-tag={tag} className={chipClass}>{tag}</span>
      ))}
      {rest > 0 ? <span className="text-caption text-subtle">+{rest}</span> : null}
    </div>
  );
}

export function MetaRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-subtle', className)}>
      {children}
    </div>
  );
}

export function MetaDivider() {
  return (
    <span aria-hidden className="text-caption opacity-50">
      •
    </span>
  );
}
