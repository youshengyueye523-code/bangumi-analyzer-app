import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { MATCH_REASON_LABEL, type SubjectListItem } from '@bangumi-analyzer/shared';
import { cn } from '../../lib/cn.js';
import {
  bangumiSubjectUrl,
  formatLabel,
  formatRate,
  primaryTitle,
  secondaryTitle,
} from '../../lib/format.js';
import { CoverImage, MetaDivider, MetaRow, ProgressMeter, RatePill, StatusBadge, TagList } from './atoms.js';

/** 主搜索栏命中原因：告诉用户「这条结果为什么会出现」。 */
function MatchReasons({ reasons, className }: { reasons?: string[]; className?: string }) {
  if (!reasons || reasons.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {reasons.slice(0, 4).map((reason) => (
        <span
          key={reason}
          className="rounded bg-accent-soft px-1.5 py-0.5 text-caption leading-4 text-accent"
        >
          {MATCH_REASON_LABEL[reason] ?? reason}
        </span>
      ))}
    </div>
  );
}

export function SubjectCard({
  item,
  className,
  onTagClick,
  fromQuery,
}: {
  item: SubjectListItem;
  className?: string;
  onTagClick?: (tag: string) => void;
  /** 当前收藏库的筛选条件：带进详情页后，详情页的「反向检索」会保留整条上下文 */
  fromQuery?: string;
}) {
  const subtitle = secondaryTitle(item);
  const detailHref = fromQuery
    ? `/subjects/${item.id}?from=${encodeURIComponent(fromQuery)}`
    : `/subjects/${item.id}`;
  const hasTagActions = onTagClick !== undefined && item.tags.length > 0;
  return (
    <article
      className={cn(
        'group card-surface card-surface-interactive relative flex flex-col overflow-hidden',
        'hover:-translate-y-0.5',
        className,
      )}
    >
      <Link
        to={detailHref}
        className={cn('flex flex-1 flex-col p-2.5 focus-visible:-outline-offset-2', hasTagActions && 'pb-0')}
      >
        <div className="relative">
          <CoverImage
            id={item.id}
            title={primaryTitle(item)}
            className="aspect-[5/7] w-full"
            rounded="rounded-[8px]"
          />
          <div className="absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
            <StatusBadge type={item.collectionType} size="sm" className="backdrop-blur-sm" />
          </div>
          {item.rate > 0 ? (
            /*
             * 评分角标：底色已经是 62% 黑，模糊在这块区域没有可感知收益，
             * 却会在每个封面上多出一层合成。去掉它，把模糊留给真正需要它的
             * 半透明状态徽标（见下方 StatusBadge）。
             */
            <div className="absolute right-1.5 top-1.5 rounded-chip bg-black/62 px-1.5 py-0.5 text-caption font-semibold numeric text-white">
              {formatRate(item.rate, 0)}
            </div>
          ) : null}
        </div>

        <h3 className="mt-2.5 line-clamp-2 text-body font-medium leading-5" title={primaryTitle(item)}>
          {primaryTitle(item)}
        </h3>
        {subtitle ? (
          <p className="mt-0.5 line-clamp-1 text-caption text-subtle" title={subtitle}>
            {subtitle}
          </p>
        ) : null}

        <MetaRow className="mt-1.5">
          <span className="numeric">{item.year ?? '年份未知'}</span>
          <MetaDivider />
          <span>{formatLabel(item.format)}</span>
          {item.totalEpisodes > 0 ? (
            <>
              <MetaDivider />
              <span className="numeric">{item.totalEpisodes} 集</span>
            </>
          ) : null}
        </MetaRow>

        {item.collectionType === 3 || (item.progress > 0 && item.progress < 1) ? (
          <ProgressMeter
            className="mt-2"
            value={item.progress}
            watched={item.watchedEpisodes}
            total={item.totalEpisodes}
          />
        ) : null}

        <div className="mt-auto pt-2">
          <div className="flex items-center justify-between gap-2">
            <RatePill value={item.bgmScore} label="Bangumi 平均分" tone="muted" />
            {item.delta !== null ? (
              <span
                className={cn(
                  'text-caption numeric',
                  item.delta > 0 ? 'text-success' : item.delta < 0 ? 'text-danger' : 'text-subtle',
                )}
                title="我的评分与 Bangumi 平均分之差"
              >
                {item.delta > 0 ? '+' : ''}
                {item.delta.toFixed(1)}
              </span>
            ) : null}
          </div>
          {!hasTagActions && item.tags.length > 0 ? (
            <TagList tags={item.tags} max={3} className="mt-1.5" />
          ) : null}
          <MatchReasons reasons={item.matchReasons} className="mt-1.5" />
        </div>
      </Link>
      {hasTagActions ? (
        <div role="group" aria-label="按标签筛选收藏库" className="mt-1.5 px-2.5 pb-2.5">
          <TagList tags={item.tags} max={3} onSelect={onTagClick} />
        </div>
      ) : null}
    </article>
  );
}

export function SubjectRow({
  item,
  className,
  fromQuery,
}: {
  item: SubjectListItem;
  className?: string;
  fromQuery?: string;
}) {
  const subtitle = secondaryTitle(item);
  const detailHref = fromQuery
    ? `/subjects/${item.id}?from=${encodeURIComponent(fromQuery)}`
    : `/subjects/${item.id}`;
  return (
    <div
      className={cn(
        'group flex items-center gap-3 border-b border-border px-3 py-2.5 transition-colors last:border-b-0 hover:bg-surface-2',
        className,
      )}
    >
      <Link to={detailHref} className="flex min-w-0 flex-1 items-center gap-3">
        <CoverImage
          id={item.id}
          title={primaryTitle(item)}
          className="h-[54px] w-[39px] shrink-0 sm:h-[62px] sm:w-[44px]"
          rounded="rounded-[8px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate-line text-body font-medium" title={primaryTitle(item)}>
              {primaryTitle(item)}
            </h3>
            <StatusBadge type={item.collectionType} size="sm" className="shrink-0 whitespace-nowrap" />
          </div>
          {subtitle ? (
            <p className="truncate-line text-caption text-subtle" title={subtitle}>
              {subtitle}
            </p>
          ) : null}
          <MetaRow className="mt-1">
            <span className="numeric">{item.year ?? '—'}</span>
            <MetaDivider />
            <span>{formatLabel(item.format)}</span>
            <MetaDivider />
            <span className="numeric">
              {item.watchedEpisodes}/{item.totalEpisodes || '?'} 集
            </span>
            {item.studios.length > 0 ? (
              <>
                <MetaDivider />
                <span className="max-w-[10rem] truncate-line">{item.studios[0]}</span>
              </>
            ) : null}
          </MetaRow>
          <MatchReasons reasons={item.matchReasons} className="mt-1" />
        </div>
      </Link>

      <div className="hidden w-32 shrink-0 sm:block">
        <ProgressMeter value={item.progress} showLabel={false} />
        <p className="mt-1 text-right text-caption numeric text-subtle">
          {Math.round(item.progress * 100)}%
        </p>
      </div>

      <div className="flex w-[92px] shrink-0 flex-col items-end gap-1 sm:w-[104px]">
        <RatePill value={item.rate} label="我的评分" tone="accent" />
        <span className="text-caption numeric text-subtle" title="Bangumi 平均分">
          大众 {formatRate(item.bgmScore)}
        </span>
      </div>

      <a
        href={bangumiSubjectUrl(item.id)}
        target="_blank"
        rel="noreferrer noopener"
        title="在 Bangumi 打开"
        className="hidden shrink-0 rounded-[8px] p-1.5 text-subtle opacity-0 transition-all hover:bg-surface-3 hover:text-text group-hover:opacity-100 md:block"
      >
        <ExternalLink size={14} />
      </a>
    </div>
  );
}
