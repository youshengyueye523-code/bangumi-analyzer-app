import { ArrowRight, Building2, Clapperboard, Film, Search, Tag, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MATCH_REASON_LABEL } from '@bangumi-analyzer/shared';
import { cn } from '../../lib/cn.js';
import { formatNumber } from '../../lib/format.js';
import {
  FOCUS_SEARCH_EVENT,
  buildEntitySearchHref,
  buildKeywordSearchHref,
} from '../../lib/libraryLinks.js';
import { useEntitySearch } from '../../lib/queries.js';
import { SearchInput } from '../ui/form.js';
import { ErrorState } from '../ui/feedback.js';

/**
 * 收藏库的唯一主搜索栏（同时也是全站搜索入口）。
 *
 * 一处输入框，两种用法：
 *   · 回车 → 全局搜索：命中标题 / 别名 / Bangumi ID / 标签 / 制作人员 / 公司 / 导演；
 *   · 点击下拉里的实体 → 以该实体为主检索（与「作品详情点击标签 / 人员」完全同一套语义）。
 */
export function GlobalSearch() {
  const [value, setValue] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), 220);
    return () => window.clearTimeout(timer);
  }, [value]);

  const keyword = debounced.trim();
  const awaitingKeyword = value.trim() !== keyword;
  const entities = useEntitySearch(keyword, open);

  // `/` 快捷键与收藏库里的「修改搜索」按钮都能聚焦这里
  useEffect(() => {
    const focusInput = () => {
      const input = wrapperRef.current?.querySelector('input');
      input?.focus();
      input?.select();
      setOpen(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        focusInput();
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(FOCUS_SEARCH_EVENT, focusInput);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(FOCUS_SEARCH_EVENT, focusInput);
    };
  }, []);

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const data = awaitingKeyword || entities.error ? undefined : entities.data;
  const hasResults = Boolean(
    data &&
      (data.works.length > 0 ||
        data.tags.length > 0 ||
        data.staff.length > 0 ||
        data.studios.length > 0 ||
        data.directors.length > 0),
  );

  const groups = useMemo(() => {
    if (!data) return [];
    return [
      { key: 'works', label: '作品', items: data.works.length },
      { key: 'tags', label: '标签', items: data.tags.length },
      { key: 'staff', label: '制作人员', items: data.staff.length },
      { key: 'studios', label: '制作公司', items: data.studios.length },
      { key: 'directors', label: '导演', items: data.directors.length },
    ].filter((group) => group.items > 0);
  }, [data]);

  function go(href: string) {
    setOpen(false);
    navigate(href);
  }

  return (
    <div ref={wrapperRef} className="relative w-full max-w-[520px]">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          go(buildKeywordSearchHref(value));
        }}
      >
        <SearchInput
          value={value}
          onValueChange={(next) => {
            setValue(next);
            setOpen(true);
          }}
          placeholder="搜索作品 / 标签 / 制作人员 / 公司（按 / 聚焦）"
        />
      </form>

      {open && value.trim().length > 0 ? (
        <div
          data-testid="global-search-panel"
          className="material-pop absolute left-0 right-0 top-[calc(100%+6px)] z-[80] max-h-[440px] overflow-y-auto rounded-card border border-border p-2"
        >
          {(awaitingKeyword || entities.isLoading) && !data ? (
            <p className="px-2 py-3 text-note text-subtle">搜索中…</p>
          ) : null}

          {!awaitingKeyword && entities.error ? <ErrorState error={entities.error} onRetry={() => void entities.refetch()} /> : null}

          {!awaitingKeyword && !entities.isLoading && !entities.error && !hasResults ? (
            <p className="px-2 py-3 text-note text-subtle">
              没有匹配的实体，可以换更短的关键词，或回车在收藏库中搜索。
            </p>
          ) : null}

          {hasResults ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 pt-1 text-caption text-subtle">
                <Search size={11} />
                <span>
                  「{keyword}」共匹配 {formatNumber(data?.workTotal ?? 0)} 部作品
                </span>
                {groups.map((group) => (
                  <span
                    key={group.key}
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5"
                  >
                    {group.label} {group.items}
                  </span>
                ))}
              </div>

              {data && data.works.length > 0 ? (
                <Group title="作品（标题 / 别名 / ID 命中）" icon={<Film size={12} />}>
                  {data.works.map((work) => (
                    <Row
                      key={work.id}
                      onClick={() => go(`/subjects/${work.id}`)}
                      title={work.title}
                      subtitle={[
                        work.year ? `${work.year} 年` : null,
                        work.reasons
                          .map((reason) => MATCH_REASON_LABEL[reason] ?? reason)
                          .join('、'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      meta={`#${work.id}`}
                    />
                  ))}
                </Group>
              ) : null}

              {data && data.tags.length > 0 ? (
                <Group title="标签" icon={<Tag size={12} />}>
                  {data.tags.slice(0, 6).map((tag) => (
                    <Row
                      key={tag.value}
                      onClick={() => go(buildEntitySearchHref({ kind: 'tag', value: tag.value }))}
                      title={tag.value}
                      subtitle="标签命中"
                      meta={`${formatNumber(tag.count)} 部作品`}
                    />
                  ))}
                </Group>
              ) : null}

              {data && data.staff.length > 0 ? (
                <Group title="制作人员 / 公司" icon={<User size={12} />}>
                  {data.staff.slice(0, 6).map((person) => (
                    <Row
                      key={person.name}
                      onClick={() => go(buildEntitySearchHref({ kind: 'staff', value: person.name }))}
                      title={person.name}
                      subtitle={person.relations.slice(0, 3).join(' / ') || '制作人员命中'}
                      meta={`${formatNumber(person.works)} 部作品`}
                    />
                  ))}
                </Group>
              ) : null}

              {data && data.studios.length > 0 ? (
                <Group title="制作公司" icon={<Building2 size={12} />}>
                  {data.studios.slice(0, 5).map((studio) => (
                    <Row
                      key={studio.value}
                      onClick={() =>
                        go(buildEntitySearchHref({ kind: 'studio', value: studio.value }))
                      }
                      title={studio.value}
                      subtitle="制作公司命中"
                      meta={`${formatNumber(studio.count)} 部作品`}
                    />
                  ))}
                </Group>
              ) : null}

              {data && data.directors.length > 0 ? (
                <Group title="导演" icon={<Clapperboard size={12} />}>
                  {data.directors.slice(0, 5).map((director) => (
                    <Row
                      key={director.value}
                      onClick={() =>
                        go(buildEntitySearchHref({ kind: 'director', value: director.value }))
                      }
                      title={director.value}
                      subtitle="导演命中"
                      meta={`${formatNumber(director.count)} 部作品`}
                    />
                  ))}
                </Group>
              ) : null}
            </>
          ) : null}

          <button
            type="button"
            onClick={() => go(buildKeywordSearchHref(value))}
            className="mt-1 flex w-full items-center justify-between gap-2 rounded-[10px] bg-surface-2 px-2.5 py-2 text-left text-note transition-colors hover:bg-surface-3"
          >
            <span className="min-w-0 truncate">
              在收藏库中搜索「{value.trim()}」（标题 / 别名 / 标签 / 人员 / 公司）
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-subtle">
              {data ? `${formatNumber(data.workTotal)} 部` : '回车搜索'}
              <ArrowRight size={12} />
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Group({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-1.5">
      <h4 className="flex items-center gap-1.5 px-2 py-1 text-caption font-medium text-subtle">
        {icon}
        {title}
      </h4>
      {children}
    </section>
  );
}

function Row({
  title,
  subtitle,
  meta,
  onClick,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-surface-2',
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-note">{title}</span>
        {subtitle ? (
          <span className="block truncate text-caption text-subtle">{subtitle}</span>
        ) : null}
      </span>
      {meta ? <span className="shrink-0 text-caption text-subtle">{meta}</span> : null}
    </button>
  );
}
