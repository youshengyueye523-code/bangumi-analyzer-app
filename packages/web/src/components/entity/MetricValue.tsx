import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';
import { Badge } from '../ui/badge.js';
import { SampleBadge } from './SampleBadge.js';

/**
 * v1.8 五态语义：value / null（无样本）/ unknown（数据不足）/ hidden（当前不可见）。
 * `0` 是合法数值，必须与 null 区分；估计值永久携带「估算」徽标。
 */
export type MetricValueState = 'value' | 'null' | 'unknown' | 'hidden';

const SIZES = {
  sm: 'text-body',
  md: 'text-section',
  lg: 'text-title',
} as const;

export function MetricValue({
  value,
  state,
  format,
  sample,
  estimate = false,
  note,
  size = 'md',
  className,
}: {
  value: number | null;
  state?: MetricValueState;
  format?: (value: number) => ReactNode;
  sample?: number | null;
  estimate?: boolean;
  note?: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const resolved: MetricValueState = state ?? (value === null ? 'null' : 'value');

  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {resolved === 'value' && value !== null ? (
          <span className={cn('numeric font-semibold', SIZES[size])}>
            {format ? format(value) : value}
          </span>
        ) : resolved === 'hidden' ? (
          <Badge tone="neutral">已隐藏</Badge>
        ) : (
          <span className="text-note text-subtle">
            {resolved === 'unknown' ? '未知 · 数据不足' : '— 无样本'}
          </span>
        )}
        {estimate ? <Badge tone="neutral">估算</Badge> : null}
        {/* v1.8.1：value 与 sample 是两个层级，但阅读上必须连续 → 统一用 · 分隔 */}
        {typeof sample === 'number' && sample > 0 ? (
          <>
            <span aria-hidden className="text-subtle">
              ·
            </span>
            <SampleBadge sample={sample} />
          </>
        ) : null}
      </div>
      {note ? <p className="mt-1 text-caption text-subtle">{note}</p> : null}
    </div>
  );
}
