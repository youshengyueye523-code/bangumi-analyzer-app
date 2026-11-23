import { AlertCircle, EyeOff, Inbox, Loader2, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiRequestError } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { Button } from './button.js';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-[10px]', className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('animate-spin text-muted', className)} size={16} />;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-border px-6 py-10 text-center',
        className,
      )}
    >
      <div className="rounded-full bg-surface-2 p-3 text-subtle">{icon ?? <Inbox size={20} />}</div>
      <div>
        <p className="text-body font-medium">{title}</p>
        {description ? (
          <p className="mx-auto mt-1 max-w-[46ch] text-note text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const isApiError = error instanceof ApiRequestError;
  const message = error instanceof Error ? error.message : '发生未知错误';
  const hint = isApiError ? error.hint : undefined;
  const dataIntact = isApiError ? error.dataIntact : true;

  return (
    <div
      role="alert"
      className={cn(
        'rounded-[14px] border border-danger/30 bg-danger-soft/40 px-4 py-3.5 text-left sm:px-5 sm:py-4',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-text">{message}</p>
          {hint ? <p className="mt-1 text-note text-muted">{hint}</p> : null}
          {!dataIntact ? (
            <p className="mt-1 text-note text-warning">
              注意：该操作可能已影响到部分数据，请检查同步记录或使用备份恢复。
            </p>
          ) : (
            <p className="mt-1 text-note text-subtle">本地已保存的数据不受影响。</p>
          )}
          {onRetry ? (
            <Button size="sm" className="mt-3" icon={<RefreshCw size={13} />} onClick={onRetry}>
              重试
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 被当前隐私设置隐藏的内容占位（v1.5.3）。
 *
 * 不渲染任何被隐藏实体的标题 / 封面 / metadata，只说明当前状态与恢复方式。
 */
export function HiddenState({ hint, className }: { hint?: string; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-border px-6 py-10 text-center',
        className,
      )}
    >
      <div className="rounded-full bg-surface-2 p-3 text-subtle">
        <EyeOff size={20} />
      </div>
      <div>
        <p className="text-body font-medium">内容已被当前隐私设置隐藏</p>
        <p className="mx-auto mt-1 max-w-[46ch] text-note text-muted">
          {hint ?? '可在「设置 → 外观 → 隐藏 NSFW 内容」中关闭该设置以恢复显示。'}
        </p>
      </div>
    </div>
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
  className,
  height = 6,
}: {
  value: number;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
  height?: number;
}) {
  const background =
    tone === 'success'
      ? 'var(--success)'
      : tone === 'warning'
        ? 'var(--warning)'
        : tone === 'danger'
          ? 'var(--danger)'
          : 'var(--accent)';
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('w-full overflow-hidden rounded-full bg-surface-3', className)}
      style={{ height }}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, backgroundColor: background }}
      />
    </div>
  );
}

export function InlineNote({
  children,
  tone = 'info',
  className,
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'neutral';
  className?: string;
}) {
  const styles =
    tone === 'warning'
      ? 'border-warning/30 bg-warning-soft/50 text-warning'
      : tone === 'neutral'
        ? 'border-border bg-surface-2 text-muted'
        : 'border-info/25 bg-info-soft/50 text-info';
  return (
    <div className={cn('rounded-[10px] border px-3 py-2 text-note', styles, className)}>
      {children}
    </div>
  );
}
