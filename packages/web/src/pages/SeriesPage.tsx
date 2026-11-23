import { Layers, ShieldQuestion } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { SeriesGroupSummary } from '@bangumi-analyzer/shared';
import { RankingMetricLine } from '../components/entity/RankingMetricLine.js';
import { CoverImage } from '../components/subject/atoms.js';
import { Badge } from '../components/ui/badge.js';
import { SectionTitle } from '../components/ui/card.js';
import { EmptyState, ErrorState, InlineNote, Skeleton } from '../components/ui/feedback.js';
import { Segmented, SelectMenu } from '../components/ui/form.js';
import { IpSearchPanel } from '../components/series/IpSearchPanel.js';
import { formatNumber, formatRate, statusLabel } from '../lib/format.js';
import { COVERAGE_LABEL, SERIES_STATE_LABEL, TITLE_STATE_LABEL, TITLE_STATE_TONE } from '../lib/entities.js';
import { useSeries, useSeriesSearch } from '../lib/queries.js';
import { useIpSearchQuery } from '../lib/useIpSearchQuery.js';

/** v1.8 Ranking：排序键 → 用户可读名称（仅这些排序带 sample ≥ 3 门槛语义）。 */
const RANKING_SORT_LABEL: Record<string, string> = {
  coverage: '覆盖率',
  completion: '完成度',
  rate: '我的评分',
};

function SeriesCard({ group }: { group: SeriesGroupSummary }) {
  return (
    <Link
      to={`/series/${encodeURIComponent(group.key)}`}
      className="card-surface card-surface-interactive group flex flex-col gap-3 p-4 hover:-translate-y-0.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="clamp-2 text-card" title={group.title}>
            {group.title}
          </h3>
          <p className="mt-0.5 text-caption text-subtle">
            {group.firstYear ?? '—'} – {group.lastYear ?? '—'} · 系列共 {group.memberCount} 部 ·
            我的收藏 {group.collectedCount} 部 · {formatNumber(group.totalEpisodes)} 集
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={TITLE_STATE_TONE[group.titleState]}>
            {TITLE_STATE_LABEL[group.titleState]}
          </Badge>
          <Badge tone={group.state === 'provisional' ? 'warning' : 'success'}>
            {SERIES_STATE_LABEL[group.state]}
          </Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-caption text-subtle">
        <span title="名称来源">{group.titleSource}</span>
        <span>·</span>
        <span title="证据覆盖度">{COVERAGE_LABEL[group.evidenceCoverage]}</span>
        {group.candidateCount > 0 ? (
          <span className="text-warning">· 候选成员 {group.candidateCount}</span>
        ) : null}
      </div>

      {group.coverSubjects.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {group.coverSubjects.slice(0, 3).map((item) => (
            <CoverImage
              key={item.id}
              id={item.id}
              title={item.title}
              className="h-[72px] w-[51px] shrink-0"
              rounded="rounded-[8px]"
            />
          ))}
          {group.collectedCount > Math.min(3, group.coverSubjects.length) ? (
            <span className="grid h-[72px] w-[51px] shrink-0 place-items-center rounded-[8px] border border-dashed border-border text-caption text-subtle">
              +{group.collectedCount - Math.min(3, group.coverSubjects.length)}
            </span>
          ) : null}
        </div>
      ) : null}

      {group.ranking ? <RankingMetricLine ranking={group.ranking} /> : null}

      <div className="flex flex-col gap-1 text-caption text-subtle sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        {group.ranking?.metric === 'rate' ? null : (
          <span className="shrink-0">平均我的评分 {formatRate(group.averageRate, 2)}</span>
        )}
        <span className="min-w-0 truncate-line" title="按我的收藏条目统计">
          {Object.entries(group.statusCounts)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([type, count]) => `${statusLabel(Number(type))} ${count}`)
            .join(' · ')}
        </span>
      </div>
    </Link>
  );
}

export function SeriesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const sort = searchParams.get('sort') ?? 'size';
  const includeSingletons = searchParams.get('includeSingletons') === '1';
  const { data, isLoading, error, refetch } = useSeries(sort, includeSingletons);
  const allSeries = useSeries('size', true);
  // The existing list API is capped at 1000; reaching that cap cannot prove a total.
  const entityCount = !allSeries.error && allSeries.data && allSeries.data.series.length < 1000
    ? allSeries.data.series.length : undefined;
  const { searchValue, setSearchValue, keyword: debouncedQuery, awaitingKeyword } = useIpSearchQuery();
  const searching = searchValue.trim().length > 0;
  const search = useSeriesSearch(debouncedQuery);

  const groups = data?.series ?? [];
  const stats = useMemo(
    () => ({
      total: groups.length,
      multi: groups.filter((group) => group.memberCount >= 2).length,
      works: groups.reduce((sum, group) => sum + group.collectedCount, 0),
      uncertain: groups.filter(({ titleState }) =>
        titleState === 'provisional' || titleState === 'unresolved' || titleState === 'contested'
      ).length,
    }),
    [groups],
  );

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next);
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        title="系列 / 家族"
        description="同一连续作品体系归入 Series；不同连续性但同属一个作品家族时给出 Franchise 候选。"
        actions={
          <>
            <Segmented
              size="sm"
              value="series"
              options={[
                { value: 'series', label: 'Series' },
                { value: 'franchise', label: 'Franchise' },
              ]}
              onChange={(value) => {
                if (value === 'franchise') {
                  navigate(
                    searching ? `/franchises?q=${encodeURIComponent(searchValue.trim())}` : '/franchises',
                  );
                }
              }}
            />
            {!searching ? (
              <SelectMenu
                ariaLabel="系列排序"
                className="h-8 w-auto text-note"
                value={sort}
                options={[
                  { value: 'size', label: '按作品数' },
                  { value: 'coverage', label: '按覆盖率' },
                  { value: 'completion', label: '按完成度' },
                  { value: 'rate', label: '按我的评分' },
                  { value: 'year', label: '按起始年份' },
                  { value: 'title', label: '按名称' },
                ]}
                onChange={(next) => update({ sort: next })}
              />
            ) : null}
          </>
        }
      />

      {/*
       * 搜索面板始终是同一个实例：输入框的 identity 与焦点不随「搜索中 / 浏览列表」切换而变化。
       * 只有下方内容在「搜索结果」与「普通列表」之间切换。
       */}
      <IpSearchPanel
        mode="series"
        entityCount={entityCount}
        query={searchValue}
        onQueryChange={setSearchValue}
        data={searching && !awaitingKeyword && !search.error ? search.data : undefined}
        isLoading={searching && (awaitingKeyword || (search.isFetching && !search.data))}
        error={searching && !awaitingKeyword ? ((search.error as Error | null) ?? null) : null}
        onRetry={() => void search.refetch()}
      />

      {searching ? null : (
        <>
      <InlineNote tone="neutral">
        分组只依据证据：连续性关系（前传 / 续集 / 主线故事 / 总集篇等）决定 Series
        成员；「相同世界观 / 联动 / 角色出演」只作为相关作品展示，不会自动合并；
        未识别的关系默认不合并，并会在诊断中列出。名称不确定时会明确标记为推测、未确认或有争议。
      </InlineNote>

      {RANKING_SORT_LABEL[sort] ? (
        <InlineNote tone="neutral">
          按{RANKING_SORT_LABEL[sort]}排序：仅样本量 ≥ 3 的条目参与排名；样本不足的条目仍会展示在列表后部，但不计入排名。
        </InlineNote>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-note">
        <Segmented
          size="sm"
          value={includeSingletons ? 'all' : 'multi'}
          options={[
            { value: 'multi', label: '多成员系列' },
            { value: 'all', label: '包含单成员' },
          ]}
          onChange={(value) => update({ includeSingletons: value === 'all' ? '1' : '' })}
        />
        <Link
          to={searching ? `/franchises?q=${encodeURIComponent(searchValue.trim())}` : '/franchises'}
          className="text-accent hover:underline"
        >
          查看 Franchise 家族 →
        </Link>
      </div>

      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-safe-2 xl:grid-cols-safe-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-[210px]" />
          ))}
        </div>
      ) : null}

      {!isLoading && groups.length === 0 ? (
        <EmptyState
          icon={<Layers size={20} />}
          title="还没有识别出系列"
          description="系列会在同步完成后自动计算。执行「深度同步」抓取官方条目关系可以显著提高识别率。"
        />
      ) : null}

      {groups.length > 0 ? (
        <>
          <p className="text-note text-subtle">
            共 {stats.total} 个系列（多成员 {stats.multi}），覆盖收藏 {formatNumber(stats.works)} 部，
            其中 {stats.uncertain} 个名称尚未完全确定
            {stats.uncertain > 0 ? (
              <ShieldQuestion size={12} className="ml-1 inline text-warning" />
            ) : null}
          </p>
          <div className="grid gap-3 md:grid-cols-safe-2 xl:grid-cols-safe-3">
            {groups.map((group) => (
              <SeriesCard key={group.key} group={group} />
            ))}
          </div>
        </>
      ) : null}
        </>
      )}
    </div>
  );
}
