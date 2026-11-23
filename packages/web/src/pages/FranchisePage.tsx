import { Layers, ShieldQuestion } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { RankingMetricLine } from '../components/entity/RankingMetricLine.js';
import { CoverImage } from '../components/subject/atoms.js';
import { Badge } from '../components/ui/badge.js';
import { SectionTitle } from '../components/ui/card.js';
import { EmptyState, ErrorState, InlineNote, Skeleton } from '../components/ui/feedback.js';
import { Segmented, SelectMenu } from '../components/ui/form.js';
import { ManualFranchiseControls } from '../components/series/ManualFranchiseControls.js';
import { IpSearchPanel } from '../components/series/IpSearchPanel.js';
import { formatNumber, formatRate } from '../lib/format.js';
import {
  FRANCHISE_STATE_LABEL,
  FRANCHISE_STATE_TONE,
  TITLE_STATE_LABEL,
  TITLE_STATE_TONE,
} from '../lib/entities.js';
import { useFranchiseSearch, useFranchises } from '../lib/queries.js';
import { useIpSearchQuery } from '../lib/useIpSearchQuery.js';

/** v1.8 Ranking：排序键 → 用户可读名称（仅这些排序带 sample ≥ 3 门槛语义）。 */
const RANKING_SORT_LABEL: Record<string, string> = {
  coverage: '覆盖率',
  completion: '完成度',
  rate: '我的评分',
};

export function FranchisePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const sort = searchParams.get('sort') ?? 'size';
  const state = searchParams.get('state') ?? 'all';
  const { data, isLoading, error, refetch } = useFranchises(sort, state);
  const { searchValue, setSearchValue, keyword: debouncedQuery, awaitingKeyword } = useIpSearchQuery();
  const searching = searchValue.trim().length > 0;
  const search = useFranchiseSearch(debouncedQuery);

  const franchises = data?.franchises ?? [];
  const uncertain = franchises.filter((entry) => entry.state !== 'confirmed').length;

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value && value !== 'all') next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next);
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        title="作品家族（Franchise）"
        description="不同连续性、但可能属于同一作品家族时给出候选；候选不会自动变成已确认事实。"
        actions={
          <>
            <Segmented
              size="sm"
              value="franchise"
              options={[
                { value: 'series', label: 'Series' },
                { value: 'franchise', label: 'Franchise' },
              ]}
              onChange={(value) => {
                if (value === 'series') {
                  navigate(
                    searching ? `/series?q=${encodeURIComponent(searchValue.trim())}` : '/series',
                  );
                }
              }}
            />
            {!searching ? (
              <SelectMenu
                ariaLabel="家族排序"
                className="h-8 w-auto text-note"
                value={sort}
                options={[
                { value: 'size', label: '按系列数' },
                { value: 'collected', label: '按收藏数' },
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

      <ManualFranchiseControls />
      {/* 搜索面板保持同一实例：输入 identity / 焦点不随结果与列表切换而重建 */}
      <IpSearchPanel
        mode="franchise"
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
        家族由多类证据综合提出（衍生 / 不同演绎 / 相同世界观 + 品牌或稀有标签等）。
        仅「相同世界观」不会产生家族；候选与暂定状态都明确标注，确认后的家族不会被自动重算静默改写。
      </InlineNote>

      {RANKING_SORT_LABEL[sort] ? (
        <InlineNote tone="neutral">
          按{RANKING_SORT_LABEL[sort]}排序：仅样本量 ≥ 3 的家族参与排名；样本不足的家族仍会展示在列表后部，但不计入排名。
        </InlineNote>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          value={state}
          options={[
            { value: 'all', label: '全部' },
            { value: 'candidate', label: '候选' },
            { value: 'provisional', label: '暂定' },
            { value: 'confirmed', label: '已确认' },
            { value: 'rejected', label: '已否决' },
          ]}
          onChange={(value) => update({ state: String(value) })}
        />
        <Link
          to={searching ? `/series?q=${encodeURIComponent(debouncedQuery.trim())}` : '/series'}
          className="text-accent hover:underline"
        >
          ← 返回 Series 视图
        </Link>
      </div>

      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-safe-2 xl:grid-cols-safe-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-[180px]" />
          ))}
        </div>
      ) : null}

      {!isLoading && franchises.length === 0 ? (
        <EmptyState
          icon={<Layers size={20} />}
          title="暂时没有足够证据的家族"
          description="当不同系列之间出现衍生、不同演绎或品牌级证据时，这里会出现候选家族。宁可不合并，也不会猜测。"
        />
      ) : null}

      {franchises.length > 0 ? (
        <>
          <p className="text-note text-subtle">
            共 {franchises.length} 个家族，其中 {uncertain} 个尚未确认
            {uncertain > 0 ? <ShieldQuestion size={12} className="ml-1 inline text-warning" /> : null}
          </p>
          <div className="grid gap-3 md:grid-cols-safe-2 xl:grid-cols-safe-3">
            {franchises.map((entry) => (
              <Link
                key={entry.key}
                to={`/franchises/${encodeURIComponent(entry.key)}`}
                className="card-surface card-surface-interactive flex flex-col gap-2 p-4 hover:-translate-y-0.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="clamp-2 text-card" title={entry.title}>
                    {entry.title}
                  </h3>
                  <Badge tone={FRANCHISE_STATE_TONE[entry.state]}>
                    {FRANCHISE_STATE_LABEL[entry.state]}
                  </Badge>
                </div>
                <p className="text-caption text-subtle">
                  {entry.seriesCount} 个系列 · 我的收藏 {entry.collectedCount} 部 ·{' '}
                  {entry.firstYear ?? '—'} – {entry.lastYear ?? '—'}
                </p>
                {entry.coverSubjects.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {entry.coverSubjects.slice(0, 3).map((item) => (
                      <CoverImage
                        key={item.id}
                        id={item.id}
                        title={item.title}
                        className="h-[60px] w-[43px] shrink-0"
                        rounded="rounded-[7px]"
                      />
                    ))}
                    {entry.collectedCount > Math.min(3, entry.coverSubjects.length) ? (
                      <span className="grid h-[60px] w-[43px] shrink-0 place-items-center rounded-[7px] border border-dashed border-border text-caption text-subtle">
                        +{entry.collectedCount - Math.min(3, entry.coverSubjects.length)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {entry.ranking ? <RankingMetricLine ranking={entry.ranking} /> : null}
                <div className="flex flex-wrap items-center gap-1.5 text-caption text-subtle">
                  <Badge tone={TITLE_STATE_TONE[entry.titleState]}>
                    名称{TITLE_STATE_LABEL[entry.titleState]}
                  </Badge>
                  {entry.candidateSeriesCount > 0 ? (
                    <span>候选系列 {entry.candidateSeriesCount}</span>
                  ) : null}
                  {entry.conflictSeriesCount > 0 ? (
                    <span className="text-danger">冲突 {entry.conflictSeriesCount}</span>
                  ) : null}
                  {entry.ranking?.metric === 'rate' ? null : (
                    <span>平均 {formatRate(entry.averageRate, 2)}</span>
                  )}
                  <span>已知 {formatNumber(entry.knownCount)} 部</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      ) : null}
        </>
      )}
    </div>
  );
}
