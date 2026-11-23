import { SearchX } from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  FranchiseSearchHit,
  IpSearchMatch,
  IpSearchResponse,
  SeriesSearchHit,
} from '@bangumi-analyzer/shared';
import { CoverImage } from '../subject/atoms.js';
import { Badge } from '../ui/badge.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/feedback.js';
import { SearchInput } from '../ui/form.js';
import {
  FRANCHISE_STATE_LABEL,
  FRANCHISE_STATE_TONE,
  TITLE_STATE_LABEL,
  TITLE_STATE_TONE,
} from '../../lib/entities.js';

const MATCH_LABEL: Record<IpSearchMatch['type'], string> = {
  title: '标题匹配',
  alias: '命中别名',
  series: '命中系列',
  member: '命中成员',
  'member-alias': '命中成员别名',
  key: '实体编号匹配',
};

function reasonText(reason: IpSearchMatch): string {
  if (reason.type === 'title') return '标题匹配';
  const label = MATCH_LABEL[reason.type] ?? '命中';
  const via = reason.via ? `（所属系列：${reason.via}）` : '';
  return `${label}：${reason.text}${via}`;
}

function HitCard({
  mode,
  hit,
}: {
  mode: 'series' | 'franchise';
  hit: SeriesSearchHit | FranchiseSearchHit;
}) {
  const href =
    mode === 'series'
      ? `/series/${encodeURIComponent(hit.key)}`
      : `/franchises/${encodeURIComponent(hit.key)}`;
  const meta =
    mode === 'series'
      ? `Series · 已知 ${(hit as SeriesSearchHit).memberCount} 部 · 我的收藏 ${hit.collectedCount} 部`
      : `Franchise · ${(hit as FranchiseSearchHit).seriesCount} 个系列 · 我的收藏 ${hit.collectedCount} 部`;

  return (
    <Link
      to={href}
      className="card-surface card-surface-interactive flex flex-col gap-3 p-3 sm:flex-row sm:items-start"
    >
      {hit.coverSubjects.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {hit.coverSubjects.slice(0, 3).map((cover) => (
            <CoverImage
              key={cover.id}
              id={cover.id}
              title={cover.title}
              className="h-[64px] w-[46px] shrink-0"
              rounded="rounded-[7px]"
            />
          ))}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-card">{hit.title}</h3>
          <Badge tone={TITLE_STATE_TONE[hit.titleState]}>{TITLE_STATE_LABEL[hit.titleState]}</Badge>
          {mode === 'franchise' ? (
            <Badge
              tone={
                FRANCHISE_STATE_TONE[hit.state as keyof typeof FRANCHISE_STATE_TONE] ?? 'neutral'
              }
            >
              {FRANCHISE_STATE_LABEL[hit.state as keyof typeof FRANCHISE_STATE_LABEL] ?? hit.state}
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 text-caption text-subtle">{meta}</p>
        {hit.matchReasons.length > 0 ? (
          <p className="mt-1 text-caption text-muted">
            {hit.matchReasons.slice(0, 3).map(reasonText).join(' · ')}
            {hit.matchReasons.length > 3 ? ` · 等 ${hit.matchReasons.length} 条命中` : ''}
          </p>
        ) : null}
      </div>
    </Link>
  );
}

export function IpSearchPanel({
  mode,
  query,
  onQueryChange,
  data,
  isLoading = false,
  error = null,
  onRetry = () => undefined,
  entityCount,
}: {
  mode: 'series' | 'franchise';
  query: string;
  onQueryChange: (value: string) => void;
  data?: IpSearchResponse<SeriesSearchHit> | IpSearchResponse<FranchiseSearchHit>;
  isLoading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  entityCount?: number;
}) {
  const items = data?.items ?? [];
  return (
    <div className="space-y-3">
      <SearchInput
        value={query}
        onValueChange={onQueryChange}
        placeholder={
          mode === 'series'
            ? `搜索 Series：标题 / 别名 / 成员作品（覆盖全部${entityCount === undefined ? '' : ` ${entityCount} 个`}实体，含隐藏的单成员系列）`
            : '搜索 Franchise：家族名 / 成员 Series / 成员作品'
        }
      />

      {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
      {isLoading ? <Skeleton className="h-[120px]" /> : null}

      {!isLoading && data && items.length === 0 ? (
        <EmptyState
          icon={<SearchX size={20} />}
          title={`没有找到匹配的 ${mode === 'series' ? 'Series' : 'Franchise'}`}
          description="搜索域是全部 Series / Franchise 实体（含当前列表隐藏的单成员系列）；可以尝试标题、成员作品名或别名。"
        />
      ) : null}

      {items.length > 0 ? (
        <>
          <p className="text-note text-subtle">
            共 {data?.total ?? items.length} 个结果 · 搜索覆盖完整实体域，不受当前筛选 / 排序 / 单成员开关影响
          </p>
          <div className="space-y-2">
            {items.map((hit) => (
              <HitCard key={hit.key} mode={mode} hit={hit} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
