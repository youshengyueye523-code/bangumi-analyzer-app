import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export function Card({
  children,
  className,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <section
      className={cn(
        'card-surface',
        // 卡片经常作为 grid / flex 子项使用：默认 min-width:auto 会被内部
        // nowrap 文本的 min-content 撑破布局，这里统一允许收缩。
        'min-w-0',
        interactive && 'card-surface-interactive',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex items-start justify-between gap-4 px-5 pt-4', className)}>
      <div className="min-w-0">
        {/* 标题可能被 data-min-width 撑破卡片：默认允许两行换行，长标题不再被截断 */}
        <h3 className="clamp-2 text-card">{title}</h3>
        {description ? <p className="mt-0.5 text-note text-muted">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
      ) : null}
    </header>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-5 pb-5 pt-3', className)}>{children}</div>;
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-accent'
      : tone === 'success'
        ? 'text-success'
        : tone === 'warning'
          ? 'text-warning'
          : tone === 'danger'
            ? 'text-danger'
            : 'text-text';
  return (
    <div
      className={cn(
        'card-surface group relative flex flex-col overflow-hidden px-4 py-3.5 transition-colors duration-200 hover:border-border-strong',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {/* 指标说明属于数据标签，用 12px 保证在桌面距离下可读 */}
        <span data-stat-label className="clamp-2 text-data font-medium text-muted">
          {label}
        </span>
        {icon ? (
          <span className="shrink-0 text-subtle transition-colors group-hover:text-muted">{icon}</span>
        ) : null}
      </div>
      {/*
        核心统计数字：明显高于正文（24px vs 13px），保持 tabular numbers；
        mt-auto 让数字在标签换行时仍然底部对齐，「2085 小时」这类带单位的值不折行。
      */}
      <div
        data-stat-value
        className={cn('numeric mt-auto whitespace-nowrap pt-2 text-metric', toneClass)}
      >
        {value}
      </div>
      {hint ? <div className="clamp-2 mt-1.5 text-data text-subtle">{hint}</div> : null}
    </div>
  );
}

export function SectionTitle({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="section-title-copy min-w-0">
        <h2 className="text-title">{title}</h2>
        {description ? <p className="mt-0.5 text-body text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
