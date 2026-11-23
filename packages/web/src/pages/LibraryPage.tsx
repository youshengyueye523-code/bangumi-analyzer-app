import {
  COLLECTION_TYPE_LABEL,
  SORT_FIELD_LABEL,
  type CollectionType,
  type SortField,
  type SubjectQuery,
} from '@bangumi-analyzer/shared';
import {
  ArrowDownUp,
  LayoutGrid,
  List as ListIcon,
  Search,
  SearchX,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { FilterPanel } from '../components/library/FilterPanel.js';
import { SubjectCard, SubjectRow } from '../components/subject/cards.js';
import { OnboardingCard } from '../components/OnboardingCard.js';
import { Button } from '../components/ui/button.js';
import { SectionTitle } from '../components/ui/card.js';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/feedback.js';
import { SearchInput, Segmented, SelectMenu } from '../components/ui/form.js';
import { Dropdown, DropdownItem, DropdownLabel, Popover, Tooltip } from '../components/ui/overlay.js';
import {
  DEFAULT_PAGE_SIZE,
  countActiveFilters,
  getActiveAdvancedFilterCount,
  queryToSearchParams,
  searchParamsToQuery,
} from '../lib/filters.js';
import { FOCUS_SEARCH_EVENT } from '../lib/libraryLinks.js';
import { formatNumber, statusColorVar } from '../lib/format.js';
import { useFacets, useSubjectTags, useSubjects } from '../lib/queries.js';

const VIEW_STORAGE_KEY = 'bangumi-analyzer-library-view';

export function LibraryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => searchParamsToQuery(searchParams), [searchParams]);
  const location = useLocation();
  const navigationType = useNavigationType();
  const pendingPageScroll = useRef<string | null>(null);
  const { data, isLoading, isFetching, error, refetch } = useSubjects(query);
  const { data: facets } = useFacets();
  // 反向追溯：当前筛选结果内的标签分布（例如按制作人员筛选后，看其作品的标签）
  const tagScope = useSubjectTags(query);
  const [filterOpen, setFilterOpen] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>(() => {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    return stored === 'list' ? 'list' : 'grid';
  });

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

  useEffect(() => {
    const pending = pendingPageScroll.current;
    if (pending === null) return;
    if (navigationType === 'POP' || pending !== searchParams.toString()) {
      pendingPageScroll.current = null;
      return;
    }
    // useSubjects 保留旧页作占位；目标查询完成、列表提交之后才执行这次主动翻页。
    if (!data || isFetching || error) return;
    pendingPageScroll.current = null;
    // AppShell 的 main 随文档滚动；独立 overflow 仅在侧栏。顶部保留 sticky 页头。
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.key, navigationType, searchParams, data, isFetching, error]);

  function changePage(nextPage: number) {
    if (nextPage === (query.page ?? 1)) return;
    const params = queryToSearchParams({ ...query, page: nextPage });
    pendingPageScroll.current = params.toString();
    setSearchParams(params);
  }

  function update(patch: Partial<SubjectQuery>, options: { replace?: boolean } = {}) {
    const next: SubjectQuery = { ...query, ...patch };
    if (patch.page === undefined && Object.keys(patch).some((key) => key !== 'page')) {
      next.page = 1;
    }
    setSearchParams(queryToSearchParams(next), { replace: options.replace ?? false });
  }

  /** 高级筛选条件数量（多值维度按选中个数），用于徽标与说明 */
  const activeCount = getActiveAdvancedFilterCount(query);
  /** 全部条件（含搜索关键词与系列上下文），用于「清除筛选」与空状态判断 */
  const totalActiveConditions = countActiveFilters(query);
  const total = data?.total ?? 0;
  // v1.5.3：隐藏开启时，主数字是「当前可见」；真实收藏总数单独标注，不做替换
  const hiddenCount = facets?.hiddenCount ?? 0;
  const realTotal = facets?.realTotal ?? 0;
  const page = data?.page ?? 1;
  const pageCount = data?.pageCount ?? 1;
  const fromSubjectId = query.fromSubject;
  const context = data?.context ?? null;
  const libraryQueryString = searchParams.toString();

  return (
    <div className="space-y-4">
      <SectionTitle
        title="收藏库"
        description={
          // 两个数据源都就绪后才给出数字：facets 未返回时不能先用「共 N 部」冒充可见口径
          data && facets
            ? hiddenCount > 0
              ? `当前可见 ${formatNumber(total)} 部作品 · 真实收藏 ${formatNumber(realTotal)} 部（已隐藏 ${formatNumber(hiddenCount)} 部）${activeCount > 0 ? ` · 已应用 ${activeCount} 个筛选条件` : ''}`
              : `共 ${formatNumber(total)} 部作品${activeCount > 0 ? ` · 已应用 ${activeCount} 个筛选条件` : ''}`
            : '搜索、筛选与排序你的全部收藏'
        }
        actions={
          <>
            <Segmented
              size="sm"
              value={view}
              options={[
                { value: 'grid', label: <LayoutGrid size={13} />, title: '卡片视图' },
                { value: 'list', label: <ListIcon size={13} />, title: '列表视图' },
              ]}
              onChange={(value) => setView(value as 'grid' | 'list')}
            />
            <Dropdown
              trigger={
                <Button size="sm" icon={<ArrowDownUp size={13} />}>
                  {SORT_FIELD_LABEL[(query.sort ?? 'updated') as SortField]}
                </Button>
              }
            >
              <DropdownLabel>排序字段</DropdownLabel>
              {(Object.keys(SORT_FIELD_LABEL) as SortField[]).map((field) => (
                <DropdownItem
                  key={field}
                  selected={(query.sort ?? 'updated') === field}
                  onSelect={() => update({ sort: field, page: 1 })}
                >
                  {SORT_FIELD_LABEL[field]}
                </DropdownItem>
              ))}
            </Dropdown>
            <Button
              size="sm"
              icon={<ArrowDownUp size={13} className={query.order === 'asc' ? 'rotate-180' : ''} />}
              onClick={() => update({ order: query.order === 'asc' ? 'desc' : 'asc', page: 1 })}
            >
              {query.order === 'asc' ? '升序' : '降序'}
            </Button>
          </>
        }
      />

      {fromSubjectId ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-accent/30 bg-accent-soft/20 px-4 py-3">
          <div className="min-w-0 text-note">
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-subtle">来源作品上下文</span>
              <Link
                to={`/subjects/${fromSubjectId}${libraryQueryString ? `?from=${encodeURIComponent(libraryQueryString)}` : ''}`}
                className="font-medium text-accent hover:underline"
              >
                《{context?.title ?? `#${fromSubjectId}`}》
              </Link>
              {query.sourceRelation ? (
                <span className="text-subtle">· 来源关系：{query.sourceRelation}</span>
              ) : null}
            </p>
            <p className="mt-0.5 text-caption text-subtle">
              {context
                ? context.present
                  ? '该作品已包含在当前筛选结果中（筛选条件只作用于收藏库，不会隐式扩大范围）'
                  : '⚠ 该作品不在当前筛选结果中：可能是它没有满足当前的组合条件（例如同时包含多个标签/人员），可减少条件后重试'
                : '正在计算来源作品是否命中当前筛选…'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to={`/subjects/${fromSubjectId}${libraryQueryString ? `?from=${encodeURIComponent(libraryQueryString)}` : ''}`}
            >
              <Button size="sm">打开来源作品</Button>
            </Link>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('fromSubject');
                next.delete('sourceRelation');
                setSearchParams(next);
              }}
            >
              清除来源标记
            </Button>
          </div>
        </div>
      ) : null}

      {/* 筛选工具条：第一行是操作，第二行是可横向滚动的状态筛选，
          避免在窄窗口把「高级筛选 / 清除」挤到难以点击的位置。 */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {/*
            收藏库不再有自己的搜索框：全站搜索统一由顶栏主搜索栏承担，
            这里只显示当前搜索词并提供「修改 / 清除」两个明确操作。
          */}
          {query.q ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-[10px] border border-accent/40 bg-accent-soft px-2.5 py-1.5 text-note text-accent">
                <Search size={12} className="shrink-0" />
                <span className="truncate-line">全局搜索：「{query.q}」</span>
                <button
                  type="button"
                  onClick={() => update({ q: undefined, page: 1 })}
                  aria-label="清除搜索关键词"
                  className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent/20"
                >
                  <X size={12} />
                </button>
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<Search size={12} />}
                onClick={() => window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT))}
              >
                修改搜索
              </Button>
              <span className="hidden text-caption text-subtle lg:inline">
                命中标题 / 别名 / ID / 标签 / 制作人员 / 公司
              </span>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon={<Search size={13} />}
              onClick={() => window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT))}
            >
              搜索
            </Button>
          )}

          <Popover
            open={filterOpen}
            onOpenChange={setFilterOpen}
            align="end"
            width={660}
            trigger={
              <Button
                size="sm"
                variant={activeCount > 0 ? 'primary' : 'secondary'}
                icon={<SlidersHorizontal size={13} />}
              >
                高级筛选{activeCount > 0 ? ` · ${activeCount}` : ''}
              </Button>
            }
          >
            <FilterPanel
              facets={facets}
              tagScope={tagScope.data}
              query={query}
              onChange={(patch) => update(patch)}
              onReset={() =>
                setSearchParams(
                  queryToSearchParams({
                    sort: query.sort,
                    order: query.order,
                    pageSize: query.pageSize,
                    page: 1,
                  }),
                )
              }
              onClose={() => setFilterOpen(false)}
            />
          </Popover>

          {totalActiveConditions > 0 ? (
            <Tooltip content="清除全部筛选条件">
              <Button
                size="sm"
                variant="ghost"
                icon={<X size={13} />}
                onClick={() =>
                  setSearchParams(
                    queryToSearchParams({ sort: query.sort, order: query.order, pageSize: query.pageSize, page: 1 }),
                  )
                }
              >
                清除筛选
              </Button>
            </Tooltip>
          ) : null}
        </div>

        {/*
          状态筛选允许横向滚动：窄窗口不会换行成三排，
          也不会把右侧按钮挤出屏幕（这是「控件不被压缩」与「无横向溢出」的折中）。
        */}
        <div
          className="-mx-1 flex touch-pan-x snap-x gap-2 overflow-x-auto px-1 pb-1"
          role="group"
          aria-label="按收藏状态筛选"
        >
          <Segmented
            className="snap-start"
            wrap={false}
            value={query.status as unknown as CollectionType[] | undefined}
            options={[1, 2, 3, 4, 5].map((type) => ({
              value: type as CollectionType,
              label: (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: statusColorVar(type) }}
                  />
                  {COLLECTION_TYPE_LABEL[type as CollectionType]}
                </span>
              ),
              count: facets?.statuses.find((item) => item.value === type)?.count,
            }))}
            onChange={(value) => {
              const current = query.status ?? [];
              const next = current.includes(value)
                ? current.filter((item) => item !== value)
                : [...current, value];
              update({ status: next.length > 0 ? next : undefined, page: 1 });
            }}
          />
        </div>
      </div>

      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {isLoading ? (
        <div className={view === 'grid' ? 'grid grid-cols-safe-2 gap-3 sm:grid-cols-safe-3 lg:grid-cols-safe-5 xl:grid-cols-safe-6' : 'space-y-2'}>
          {Array.from({ length: 12 }).map((_, index) => (
            <Skeleton key={index} className={view === 'grid' ? 'h-[268px]' : 'h-[78px]'} />
          ))}
        </div>
      ) : null}

      {!isLoading && data && data.items.length === 0 ? (
        total === 0 && totalActiveConditions === 0 ? (
          <OnboardingCard />
        ) : (
          <EmptyState
            icon={<SearchX size={20} />}
            title="没有符合条件的作品"
            description="试试放宽年份、评分或标签条件，或者清除全部筛选条件。"
            action={
              <Button
                size="sm"
                onClick={() =>
                  setSearchParams(
                    queryToSearchParams({
                      sort: query.sort,
                      order: query.order,
                      pageSize: query.pageSize,
                      page: 1,
                    }),
                  )
                }
              >
                清除筛选条件
              </Button>
            }
          />
        )
      ) : null}

      {data && data.items.length > 0 ? (
        <>
          {view === 'grid' ? (
            <div className="grid grid-cols-safe-2 gap-3 sm:grid-cols-safe-3 lg:grid-cols-safe-5 xl:grid-cols-safe-6">
              {data.items.map((item) => (
                <SubjectCard
                  key={item.id}
                  item={item}
                  onTagClick={(tag) => update({ tags: [tag], page: 1 })}
                  fromQuery={libraryQueryString}
                />
              ))}
            </div>
          ) : (
            <div className="card-surface overflow-hidden">
              {data.items.map((item) => (
                <SubjectRow key={item.id} item={item} fromQuery={libraryQueryString} />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <p className="text-note text-subtle">
              第 {page} / {pageCount} 页 · 共 {formatNumber(total)} 部
              {isFetching ? ' · 正在更新…' : ''}
            </p>
            <div className="flex items-center gap-2">
              {/* 统一使用 SelectMenu：展开层走设计 token，不再由系统绘制 */}
              <SelectMenu
                ariaLabel="每页数量"
                className="h-8 w-auto text-note"
                value={Number(query.pageSize ?? DEFAULT_PAGE_SIZE)}
                options={[24, 48, 96, 192].map((size) => ({
                  value: size,
                  label: `每页 ${size}`,
                }))}
                onChange={(size) => update({ pageSize: size, page: 1 })}
              />
              <Button
                size="sm"
                disabled={page <= 1}
                onClick={() => changePage(Math.max(1, page - 1))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                disabled={page >= pageCount}
                onClick={() => changePage(Math.min(pageCount, page + 1))}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
