import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { SubjectListItem } from '@bangumi-analyzer/shared';
import { cn } from '../../lib/cn.js';
import { formatDate, formatRate, primaryTitle } from '../../lib/format.js';
import { CoverImage, ProgressMeter, StatusBadge } from './atoms.js';

/** 仪表盘侧栏使用的紧凑条目行。 */
export function MiniSubjectRow({
  item,
  meta,
  showProgress = false,
}: {
  item: SubjectListItem;
  meta?: 'updated' | 'added' | 'score';
  showProgress?: boolean;
}) {
  return (
    <Link
      to={`/subjects/${item.id}`}
      className="group flex items-center gap-3 rounded-[10px] px-1.5 py-2 transition-colors hover:bg-surface-2"
    >
      <CoverImage
        id={item.id}
        title={primaryTitle(item)}
        className="h-[46px] w-[33px] shrink-0"
        rounded="rounded"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {/* 列表行是 Dashboard 的数据正文：用 text-body(13px) 保证可读 */}
          <span className="truncate-line text-body font-medium" title={primaryTitle(item)}>
            {primaryTitle(item)}
          </span>
          {meta === 'score' && item.delta !== null ? (
            <span
              className={cn(
                'shrink-0 text-caption numeric',
                item.delta > 0 ? 'text-success' : 'text-danger',
              )}
            >
              {item.delta > 0 ? '+' : ''}
              {item.delta.toFixed(1)}
            </span>
          ) : null}
        </div>
        {showProgress ? (
          <ProgressMeter
            className="mt-1"
            value={item.progress}
            watched={item.watchedEpisodes}
            total={item.totalEpisodes}
          />
        ) : (
          <div className="mt-0.5 flex items-center gap-2 text-data text-subtle">
            <StatusBadge type={item.collectionType} size="sm" className="scale-95" />
            <span className="numeric">
              {meta === 'added'
                ? `首次记录 ${formatDate(item.firstSeenAt).replace(/\//g, '-')}`
                : meta === 'updated'
                  ? `最后更新 ${item.collectionUpdatedAt ? formatDate(item.collectionUpdatedAt) : '—'}`
                  : `${item.year ?? '—'} · ${formatRate(item.bgmScore)} 分`}
            </span>
          </div>
        )}
      </div>
      <ArrowUpRight
        size={13}
        className="shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100"
      />
    </Link>
  );
}
