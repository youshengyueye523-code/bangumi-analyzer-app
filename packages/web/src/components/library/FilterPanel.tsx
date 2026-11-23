import {
  ANIME_FORMAT_LABEL,
  COLLECTION_TYPE_LABEL,
  PROGRESS_FILTER_LABEL,
  SEASONS,
  type AnimeFormat,
  type FilterFacets,
  type ProgressFilter,
  type Season,
  type SubjectQuery,
  type TagCountList,
} from '@bangumi-analyzer/shared';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.js';
import {
  getActiveAdvancedFilterCount,
  rankMatches,
  resetFilters,
  toggleArrayValue,
} from '../../lib/filters.js';
import { useStaffSearch } from '../../lib/queries.js';
import { Button } from '../ui/button.js';
import { NumberField, SearchInput, Segmented, SelectMenu } from '../ui/form.js';

/**
 * 标签区块默认展示多少个芯片。
 *
 * 收藏库有近 3000 个标签，全量铺开会让面板被几十行标签撑爆：
 *   - 默认只展示「当前收藏里出现次数最多」的 36 个（按 facets 的 count 降序，来自本地收藏统计）；
 *   - 搜索时放宽到 120 个，保证任何标签（含只出现一次的）都能被搜到并选中；
 *   - 已选中的标签无论排第几都会保留在列表里，方便取消。
 */
const TAG_CHIP_DEFAULT = 36;
const TAG_CHIP_SEARCH = 120;
const REVERSE_TAG_LIMIT = 30;
/** 公司 / 导演列表默认展示条数（搜索时可命中全部） */
const FACET_CHIP_LIMIT = 60;

/**
 * 面板高度规则（固定，不可拖拽）。
 *
 * 高级筛选是固定功能面板，不是自由布局画布：高度只由「视口高度 + 固定上限」决定，
 * 内部滚动，不保存任何用户调整过的高度。想找拖拽逻辑的话：这里没有，
 * 组件里也不存在任何指针拖拽 / 高度持久化代码（有回归测试守着）。
 */
const PANEL_HEIGHT_CLASS = 'max-h-[min(70vh,560px)]';

function ChipGroup<T extends string | number>({
  values,
  selected,
  onToggle,
  labelOf,
  countOf,
  max = 24,
  testId,
}: {
  values: T[];
  selected: T[] | undefined;
  onToggle: (value: T) => void;
  labelOf?: (value: T) => string;
  countOf?: (value: T) => number;
  max?: number;
  /** 供测试定位使用的分组标识（不影响样式） */
  testId?: string;
}) {
  const active = selected ?? [];
  return (
    <div className="flex flex-wrap gap-1.5" data-chip-group={testId}>
      {values.slice(0, max).map((value) => {
        const isActive = active.includes(value);
        return (
          <button
            key={value}
            type="button"
            onClick={() => onToggle(value)}
            aria-pressed={isActive}
            data-chip-value={labelOf ? labelOf(value) : String(value)}
            className={cn(
              // max-w-full + 单行截断：超长标签（中日英混排）不能撑破容器
              'inline-flex max-w-full items-center gap-1 rounded-chip border px-2 py-1 text-caption transition-colors',
              isActive
                ? 'border-accent/50 bg-accent-soft text-accent'
                : 'border-border bg-surface-2 text-muted hover:border-border-strong hover:text-text active:bg-surface-3',
            )}
          >
            <span className="truncate-line">{labelOf ? labelOf(value) : value}</span>
            {countOf ? (
              <span className="shrink-0 text-caption text-subtle">{countOf(value)}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function FilterSection({
  title,
  children,
  hint,
}: {
  title: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <section className="space-y-2">
      {/* min-w-0 + 截断：长标题 / 长提示不能把这一行撑得比面板宽 */}
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <h4 className="min-w-0 truncate-line text-caption font-semibold uppercase tracking-wide text-subtle">
          {title}
        </h4>
        {hint ? (
          <span className="min-w-0 truncate-line text-caption text-subtle" title={hint}>
            {hint}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function FilterPanel({
  facets,
  tagScope,
  query,
  onChange,
  onReset,
  onClose,
}: {
  facets: FilterFacets | undefined;
  /** 当前筛选结果内的标签分布（制作人员 → 作品 → 标签 的反向追溯） */
  tagScope?: TagCountList | undefined;
  query: SubjectQuery;
  onChange: (patch: Partial<SubjectQuery>) => void;
  /**
   * 重置：必须是「替换式」清空，而不是把 resetFilters 的结果合并进当前查询
   * （合并会让旧的 tags/staff/... 残留，导致徽标与结果都不归零）。
   */
  onReset?: () => void;
  onClose?: () => void;
}) {
  const activeCount = getActiveAdvancedFilterCount(query);
  const [tagSearch, setTagSearch] = useState('');
  const [studioSearch, setStudioSearch] = useState('');
  const [directorSearch, setDirectorSearch] = useState('');
  const [staffSearch, setStaffSearch] = useState('');
  const [debouncedStaffSearch, setDebouncedStaffSearch] = useState('');
  const rateRange: [number, number] = [query.rateMin ?? 0, query.rateMax ?? 10];
  const bgmRange: [number, number] = [query.bgmScoreMin ?? 0, query.bgmScoreMax ?? 10];
  const yearMin = facets?.yearMin ?? 1960;
  const yearMax = facets?.yearMax ?? new Date().getFullYear();

  const allTags = facets?.tags ?? [];
  /*
   * 默认只渲染最常用的 TAG_CHIP_DEFAULT 个标签；搜索时放宽到 TAG_CHIP_SEARCH。
   * rankMatches 在无关键词时保持 facets 的顺序（即收藏库内出现次数降序），
   * 有关键词时按「完全匹配 → 前缀 → 包含」再按出现次数排序。
   */
  const tagMatches = rankMatches(
    allTags,
    tagSearch,
    tagSearch.trim() ? TAG_CHIP_SEARCH : TAG_CHIP_DEFAULT,
  );
  const visibleTags = tagMatches.visible;
  const tagTotal = facets?.tagTotal ?? allTags.length;
  const selectedTags = query.tags ?? [];
  const selectedStaff = query.staff ?? [];

  /**
   * 已选中的标签必须始终可见（否则用户无法在面板里取消一个排名靠后的标签）。
   * 合并时保持「出现次数降序」的顺序，并避免重复。
   */
  const visibleTagValues = (() => {
    const ordered = visibleTags.map((item) => item.value);
    const missing = selectedTags.filter((tag) => !ordered.includes(tag));
    if (missing.length === 0) return ordered;
    const appended = missing.map((tag) => ({ value: tag, count: -1 }));
    return [...visibleTags, ...appended]
      .sort((a, b) => b.count - a.count)
      .slice(0, TAG_CHIP_SEARCH)
      .map((item) => item.value);
  })();


  const studioMatches = rankMatches(facets?.studios ?? [], studioSearch, FACET_CHIP_LIMIT);
  const directorMatches = rankMatches(facets?.directors ?? [], directorSearch, FACET_CHIP_LIMIT);

  // 人员检索做 250ms 防抖：输入过程中不打断用户，也不打满后端
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedStaffSearch(staffSearch), 250);
    return () => window.clearTimeout(timer);
  }, [staffSearch]);
  const staffResults = useStaffSearch(debouncedStaffSearch, 60);

  return (
    /* 宽度跟随容器：不再写死 620px，避免比 popover 容器更宽而产生横向滚动 */
    <div className="w-full max-w-[620px] space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-body font-semibold">高级筛选</p>
          <p className="text-caption text-subtle">
            {activeCount > 0 ? `已启用 ${activeCount} 个条件` : '多个条件之间为「且」关系'}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={13} />}
            onClick={() => (onReset ? onReset() : onChange(resetFilters(query)))}
          >
            重置
          </Button>
          {onClose ? (
            <Button size="sm" variant="primary" onClick={onClose}>
              完成
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-safe-2">
        <FilterSection title="放送年份">
          <div className="grid grid-cols-safe-2 gap-2">
            <NumberField
              label="起始年份"
              value={query.yearFrom}
              min={yearMin}
              max={yearMax}
              placeholder={String(yearMin)}
              onChange={(value) =>
                onChange({ yearFrom: value, ...(value !== undefined ? { page: 1 } : {}) })
              }
            />
            <NumberField
              label="结束年份"
              value={query.yearTo}
              min={yearMin}
              max={yearMax}
              placeholder={String(yearMax)}
              onChange={(value) =>
                onChange({ yearTo: value, ...(value !== undefined ? { page: 1 } : {}) })
              }
            />
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {[
              { label: '近 5 年', from: new Date().getFullYear() - 4, to: new Date().getFullYear() },
              { label: '2010 年代', from: 2010, to: 2019 },
              { label: '2000 年代', from: 2000, to: 2009 },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => onChange({ yearFrom: preset.from, yearTo: preset.to, page: 1 })}
                className="rounded-[8px] border border-border bg-surface-2 px-2 py-1 text-caption text-muted transition-colors hover:border-border-strong hover:text-text"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </FilterSection>

        <FilterSection title="放送季度">
          <ChipGroup<Season>
            values={SEASONS as unknown as Season[]}
            selected={query.season}
            onToggle={(season) =>
              onChange({ season: toggleArrayValue(query.season, season) as Season[], page: 1 })
            }
            labelOf={(season) => (season === '冬' ? '冬季' : season === '春' ? '春季' : season === '夏' ? '夏季' : '秋季')}
            countOf={(season) => facets?.seasons.find((item) => item.value === season)?.count ?? 0}
          />
        </FilterSection>

        <FilterSection title="我的评分" hint={`${rateRange[0]} – ${rateRange[1]} 分`}>
          <div className="grid grid-cols-safe-2 gap-2">
            <NumberField
              label="最低分"
              value={query.rateMin}
              min={0}
              max={10}
              placeholder="不限"
              onChange={(value) => onChange({ rateMin: value, page: 1 })}
            />
            <NumberField
              label="最高分"
              value={query.rateMax}
              min={0}
              max={10}
              placeholder="不限"
              onChange={(value) => onChange({ rateMax: value, page: 1 })}
            />
          </div>
          <Segmented
            size="sm"
            className="mt-1"
            value={query.rated}
            options={[
              { value: 'all', label: '全部' },
              { value: 'rated', label: '已评分' },
              { value: 'unrated', label: '未评分' },
            ]}
            onChange={(value) => onChange({ rated: value as 'all' | 'rated' | 'unrated', page: 1 })}
          />
        </FilterSection>

        <FilterSection title="Bangumi 平均分" hint={`${bgmRange[0]} – ${bgmRange[1]} 分`}>
          <div className="grid grid-cols-safe-2 gap-2">
            <NumberField
              label="最低分"
              value={query.bgmScoreMin}
              min={0}
              max={10}
              step={0.1}
              placeholder="不限"
              onChange={(value) => onChange({ bgmScoreMin: value, page: 1 })}
            />
            <NumberField
              label="最高分"
              value={query.bgmScoreMax}
              min={0}
              max={10}
              step={0.1}
              placeholder="不限"
              onChange={(value) => onChange({ bgmScoreMax: value, page: 1 })}
            />
          </div>
          <Segmented
            size="sm"
            className="mt-1"
            value={query.bias}
            options={[
              { value: 'all', label: '全部' },
              { value: 'over', label: '我更喜欢' },
              { value: 'under', label: '我更不喜欢' },
            ]}
            onChange={(value) => onChange({ bias: value as 'all' | 'over' | 'under', page: 1 })}
          />
        </FilterSection>

        <FilterSection title="放送形态">
          <ChipGroup<AnimeFormat>
            values={facets?.formats.map((item) => item.value) ?? []}
            selected={query.format}
            onToggle={(format) =>
              onChange({ format: toggleArrayValue(query.format, format) as AnimeFormat[], page: 1 })
            }
            labelOf={(format) => ANIME_FORMAT_LABEL[format] ?? format}
            countOf={(format) => facets?.formats.find((item) => item.value === format)?.count ?? 0}
          />
        </FilterSection>

        <FilterSection title="观看进度">
          {/* 统一使用 SelectMenu：展开层走设计 token，不再由系统绘制 */}
          <SelectMenu
            ariaLabel="观看进度"
            value={(query.progress ?? 'all') as ProgressFilter}
            options={Object.entries(PROGRESS_FILTER_LABEL).map(([value, label]) => ({
              value: value as ProgressFilter,
              label,
            }))}
            onChange={(next) => onChange({ progress: next, page: 1 })}
          />
          <div className="grid grid-cols-safe-2 gap-2 pt-1">
            <NumberField
              label="评分人数下限"
              value={query.ratingMin}
              min={0}
              placeholder="不限"
              onChange={(value) => onChange({ ratingMin: value, page: 1 })}
            />
            <NumberField
              label="评分人数上限"
              value={query.ratingMax}
              min={0}
              placeholder="不限"
              onChange={(value) => onChange({ ratingMax: value, page: 1 })}
            />
          </div>
        </FilterSection>

        <FilterSection title="收藏状态">
          <ChipGroup
            values={[1, 2, 3, 4, 5]}
            selected={query.status as unknown as number[]}
            onToggle={(value) =>
              onChange({ status: toggleArrayValue(query.status, value as 1), page: 1 })
            }
            labelOf={(value) => COLLECTION_TYPE_LABEL[value as 1]}
            countOf={(value) => facets?.statuses.find((item) => item.value === value)?.count ?? 0}
          />
        </FilterSection>
      </div>

      <FilterSection
        title="标签"
        hint={`共 ${tagTotal} 个标签 · ${query.tagMode === 'all' ? '同时具备' : '命中任意'}`}
      >
        <Segmented
          size="sm"
          value={query.tagMode ?? 'any'}
          options={[
            { value: 'any', label: '任意命中' },
            { value: 'all', label: '同时具备' },
          ]}
          onChange={(value) => onChange({ tagMode: value as 'any' | 'all', page: 1 })}
          className="mb-2"
        />
        <SearchInput
          value={tagSearch}
          onValueChange={setTagSearch}
          placeholder="在全部标签中搜索…"
          className="mb-2"
        />
        <div className="max-h-[200px] overflow-y-auto pr-1">
          <ChipGroup
            values={visibleTagValues}
            selected={selectedTags}
            onToggle={(tag) =>
              onChange({ tags: toggleArrayValue(query.tags, tag), page: 1 })
            }
            countOf={(tag) => facets?.tags.find((item) => item.value === tag)?.count ?? 0}
            max={TAG_CHIP_SEARCH}
            testId="tag-facets"
          />
        </div>
        <p className="text-caption leading-4 text-subtle">
          {tagSearch.trim()
            ? `匹配 ${tagMatches.matched} 个标签，显示前 ${visibleTags.length} 个（完全匹配优先）`
            : `默认显示收藏中出现次数最多的 ${visibleTags.length} / ${tagTotal} 个（可用搜索查找全部标签）`}
          {facets?.tagSingletonCount
            ? ` · 其中 ${facets.tagSingletonCount} 个标签只出现过一次，可用搜索直接定位`
            : ''}
        </p>
      </FilterSection>

      <FilterSection
        title="当前结果的标签（反向追溯）"
        hint={tagScope ? `${tagScope.matchedSubjects} 部作品 · ${tagScope.total} 个标签` : '计算中…'}
      >
        <p className="mb-2 text-caption leading-4 text-subtle">
          这里统计的是「当前筛选结果里实际出现的标签」，可以先用制作人员 / 系列 / 年份筛出作品，再看这批作品的标签。
        </p>
        {tagScope && tagScope.tags.length > 0 ? (
          <div className="max-h-[168px] overflow-y-auto pr-1">
            <ChipGroup
              values={tagScope.tags.slice(0, REVERSE_TAG_LIMIT).map((item) => item.value)}
              selected={selectedTags}
              onToggle={(tag) => onChange({ tags: toggleArrayValue(query.tags, tag), page: 1 })}
              countOf={(tag) => tagScope.tags.find((item) => item.value === tag)?.count ?? 0}
              max={REVERSE_TAG_LIMIT}
              testId="tag-scope"
            />
          </div>
        ) : (
          <p className="text-caption text-subtle">
            {tagScope ? '当前筛选结果中没有标签数据。' : '正在计算当前结果的标签分布…'}
          </p>
        )}
        {tagScope && tagScope.tags.length > REVERSE_TAG_LIMIT ? (
          <p className="mt-1 text-caption text-subtle">
            仅显示出现次数最多的 {REVERSE_TAG_LIMIT} 个（共 {tagScope.total} 个）
          </p>
        ) : null}
      </FilterSection>

      <FilterSection
        title="制作人员 / 公司"
        hint={`共 ${facets?.staffTotal ?? 0} 位`}
      >
        <SearchInput
          value={staffSearch}
          onValueChange={setStaffSearch}
          placeholder="搜索导演 / 音响监督 / 脚本 / 音乐 / 公司…"
          className="mb-2"
        />
        <p className="mb-1.5 text-caption leading-4 text-subtle">
          {staffSearch.trim()
            ? `匹配 ${staffResults.data?.matched ?? 0} 位，显示参与作品最多的前 ${staffResults.data?.items.length ?? 0} 位`
            : `按参与作品数显示前 ${staffResults.data?.items.length ?? 0} 位（共 ${staffResults.data?.total ?? 0} 位，含只出现一次的人员）`}
        </p>
        <div className="max-h-[180px] overflow-y-auto pr-1">
          {(staffResults.data?.items ?? []).map((item) => {
            const active = selectedStaff.includes(item.name);
            return (
              <button
                key={item.name}
                type="button"
                onClick={() => onChange({ staff: toggleArrayValue(query.staff, item.name), page: 1 })}
                aria-pressed={active}
                className={cn(
                  'mb-1 flex w-full items-center justify-between gap-2 rounded-[10px] border px-2.5 py-1.5 text-left text-note transition-colors',
                  active
                    ? 'border-accent/50 bg-accent-soft text-accent'
                    : 'border-border bg-surface-2 text-muted hover:border-border-strong hover:text-text',
                )}
              >
                <span className="min-w-0 truncate">{item.name}</span>
                <span className="shrink-0 text-caption text-subtle">
                  {item.works} 部
                  {item.relations.length > 0 ? ` · ${item.relations.slice(0, 2).join('/')}` : ''}
                </span>
              </button>
            );
          })}
          {staffResults.data && staffResults.data.items.length === 0 ? (
            <p className="px-1 py-2 text-caption text-subtle">
              没有匹配的制作人员，试试更短的关键词（支持中文 / 日文 / 英文）。
            </p>
          ) : null}
        </div>
        {selectedStaff.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedStaff.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => onChange({ staff: toggleArrayValue(query.staff, name), page: 1 })}
                className="inline-flex items-center gap-1 rounded-[8px] border border-accent/50 bg-accent-soft px-2 py-1 text-caption text-accent"
                title="点击移除"
              >
                {name} ✕
              </button>
            ))}
          </div>
        ) : null}
      </FilterSection>

      <div className="grid gap-5 sm:grid-cols-safe-2">
        <FilterSection title="制作公司">
          <SearchInput
            value={studioSearch}
            onValueChange={setStudioSearch}
            placeholder="在全部制作公司中搜索…"
            className="mb-2"
          />
          <div className="max-h-[140px] overflow-y-auto pr-1">
            <ChipGroup
              values={studioMatches.visible.map((item) => item.value)}
              selected={query.studios}
              onToggle={(studio) =>
                onChange({ studios: toggleArrayValue(query.studios, studio), page: 1 })
              }
              countOf={(studio) => facets?.studios.find((item) => item.value === studio)?.count ?? 0}
              max={FACET_CHIP_LIMIT}
            />
          </div>
          <p className="mt-1 text-caption text-subtle">
            {studioSearch.trim()
              ? `匹配 ${studioMatches.matched} 家，显示前 ${studioMatches.visible.length} 家`
              : `显示前 ${studioMatches.visible.length} / ${facets?.studios.length ?? 0} 家（含只出现一次的公司）`}
          </p>
        </FilterSection>
        <FilterSection title="导演">
          <SearchInput
            value={directorSearch}
            onValueChange={setDirectorSearch}
            placeholder="在全部导演中搜索…"
            className="mb-2"
          />
          <div className="max-h-[140px] overflow-y-auto pr-1">
            <ChipGroup
              values={directorMatches.visible.map((item) => item.value)}
              selected={query.directors}
              onToggle={(director) =>
                onChange({ directors: toggleArrayValue(query.directors, director), page: 1 })
              }
              countOf={(director) =>
                facets?.directors.find((item) => item.value === director)?.count ?? 0
              }
              max={FACET_CHIP_LIMIT}
            />
          </div>
          <p className="mt-1 text-caption text-subtle">
            {directorSearch.trim()
              ? `匹配 ${directorMatches.matched} 位，显示前 ${directorMatches.visible.length} 位`
              : `显示前 ${directorMatches.visible.length} / ${facets?.directors.length ?? 0} 位（含只出现一次的导演）`}
          </p>
        </FilterSection>
      </div>
    </div>
  );
}
