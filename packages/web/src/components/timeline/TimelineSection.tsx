import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { TimelinePoint, TimelineStats } from '@bangumi-analyzer/shared';
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import { TimelineMetricChart, TimelineOverview } from '../charts/TimelineCharts.js';
import { Button } from '../ui/button.js';
import { Card, CardBody, CardHeader } from '../ui/card.js';
import { EmptyState, ErrorState, InlineNote, Skeleton } from '../ui/feedback.js';
import { Input, Segmented } from '../ui/form.js';
import { Dialog } from '../ui/overlay.js';
import { TimelineNavigator } from './TimelineNavigator.js';
import { formatNumber, formatRate } from '../../lib/format.js';
import { useTimeline } from '../../lib/queries.js';
import {
  grainSize,
  periodIndex,
  periodKey,
  periodLabel,
  periodMonths,
  rangePoints,
  readTimelineRange,
  resolveTimelineRange,
  summarizeTimeline,
  timelineCapability,
  timelineDomain,
  writeTimelineRange,
  type PeriodRange,
  type TimelineGrain,
  type TimelineRange,
} from '../../lib/timeline.js';

const grains = [
  { value: 'month', label: '按月' },
  { value: 'quarter', label: '按季度' },
  { value: 'year', label: '按年' },
];

export function TimelineSection() {
  const [params] = useSearchParams(),
    state = readTimelineRange(params);
  const query = useTimeline(state.grain);
  if (query.error)
    return (
      <div className="timeline-intro space-y-3">
        <ErrorState error={query.error} />
        <Button onClick={() => void query.refetch()}>重新读取</Button>
      </div>
    );
  if (!query.data) return <Skeleton className="h-[420px]" />;
  return <TimelineView data={query.data} refreshing={query.isFetching} />;
}

export function TimelineView({
  data,
  refreshing = false,
}: {
  data: TimelineStats;
  refreshing?: boolean;
}) {
  const [params, setParams] = useSearchParams(),
    state = readTimelineRange(params);
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState({ from: '', to: '' });
  const [page, setPage] = useState(0);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const capability = useMemo(() => timelineCapability(data), [data]);
  const domain = useMemo(() => timelineDomain(data), [data]);
  const range = useMemo(
    () => resolveTimelineRange(data, state),
    [data, state.grain, state.mode, state.from, state.to],
  );
  const points = useMemo(
    () => (range ? rangePoints(data, range) : []),
    [data, range?.first, range?.last],
  );
  const summary = useMemo(() => summarizeTimeline(points), [points]);
  const commit = useCallback(
    (next: TimelineRange) => {
      setParams(writeTimelineRange(params, next));
      setPage(0);
    },
    [params, setParams],
  );
  const locate = useCallback(
    (first: string, last: string) => {
      const a = periodIndex(first, state.grain),
        b = periodIndex(last, state.grain);
      if (a !== null && b !== null)
        commit({
          ...state,
          mode: 'custom',
          from: periodMonths(a, state.grain).from,
          to: periodMonths(b, state.grain).to,
        });
    },
    [state.grain, state.mode, state.from, state.to, commit],
  );
  const draftRange = useMemo(
    () => resolveTimelineRange(data, { ...state, mode: 'custom', ...draft }),
    [data, state.grain, draft.from, draft.to],
  );

  if (data.granularity !== state.grain) return <Skeleton className="h-[420px]" />;
  if (capability === 'invalid')
    return (
      <InlineNote tone="warning">
        时间序列与完整性信息不一致。请重新读取；当前不展示可能误导的局部结果。
      </InlineNote>
    );
  const complete = capability === 'complete',
    single = domain?.first === domain?.last || (data.points.length === 1 && points.length === 1);
  const title = range
    ? `${periodLabel(periodKey(range.first, state.grain), state.grain)} — ${periodLabel(periodKey(range.last, state.grain), state.grain)}`
    : '请选择有效范围';
  const custom = (r: PeriodRange) =>
    commit({
      ...state,
      mode: 'custom',
      from: periodMonths(r.first, state.grain).from,
      to: periodMonths(r.last, state.grain).to,
    });
  const changeGrain = (grain: string) => {
    if (state.mode === 'all' || !range) {
      commit({ ...state, grain: grain as TimelineGrain });
      return;
    }
    // Preserve the user's absolute calendar intent; only the containing bucket changes.
    commit({
      grain: grain as TimelineGrain,
      mode: 'custom',
      from: state.mode === 'custom' ? state.from : periodMonths(range.first, state.grain).from,
      to: state.mode === 'custom' ? state.to : periodMonths(range.last, state.grain).to,
    });
  };
  const tablePage = Math.min(page, Math.max(0, Math.ceil(points.length / 50) - 1));
  const rows = points
    .slice(Math.max(0, points.length - (tablePage + 1) * 50), points.length - tablePage * 50)
    .reverse();
  const peak = points.reduce<TimelinePoint | null>(
    (best, p) => (!best || p.added > best.added ? p : best),
    null,
  );
  const small = points
    .filter((p) => p.added > 0 && p.added < (peak?.added ?? 0))
    .sort((a, b) => a.added - b.added)
    .slice(0, 12);

  return (
    <div className="timeline-product space-y-5">
      <section className="timeline-intro space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-section">时间趋势</h2>
            <p className="mt-1 max-w-[720px] text-note text-muted">
              当前收藏按最后更新时间归集。数量、评分与集数反映当前快照，不代表真实历史观看事件。
            </p>
          </div>
          <Segmented value={state.grain} options={grains} onChange={changeGrain} />
        </div>
        {!complete ? (
          <InlineNote tone="warning">
            兼容视图：服务未提供完整性证明。这里只展示已返回的周期，不补齐未知月份；不能确认全历史或最新记录。评分样本缺失时不计算范围均分。
          </InlineNote>
        ) : (
          <div
            className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted"
            aria-label="数据覆盖"
          >
            <span>完整序列 · {data.context!.visibility === 'real' ? '完整口径' : '可见口径'}</span>
            <span>
              可归期 {formatNumber(data.context!.timeCoverage.datedCollections)} 部 · 无日期{' '}
              {formatNumber(data.context!.timeCoverage.undatedCollections)} 部
            </span>
            <span
              title={`读取于 ${data.context!.viewReferenceAt} · 数据版本 ${data.context!.dataVersion}`}
            >
              日历基准 {data.context!.referenceMonth} · 上海时间{refreshing ? ' · 正在刷新' : ''}
            </span>
            <span>来源同步 {data.context!.sourceRefreshedAt?.slice(0, 10) ?? '未提供'}</span>
          </div>
        )}
      </section>

      {data.points.length === 0 ? (
        <div className="timeline-empty-panel">
          <EmptyState
            title={
              complete && data.context!.timeCoverage.undatedCollections > 0
                ? '收藏尚无可归期日期'
                : complete
                  ? '暂无收藏记录'
                  : '未返回时间数据'
            }
            description={
              complete
                ? '没有可按最后更新时间归集的记录；这不代表曾经没有观看。'
                : '旧服务未提供覆盖信息，无法区分没有记录与日期缺失。'
            }
          />
        </div>
      ) : (
        <>
          <RangePreview data={data} range={range} points={points} grain={state.grain}>
            {(onPreview) => <>
              <div>
                <Button variant="ghost" size="sm" aria-expanded={overviewOpen}
                  aria-controls="timeline-history-overview" onClick={() => setOverviewOpen(!overviewOpen)}>
                  {`${overviewOpen ? '收起' : '展开'}${complete ? '全历史概览' : '已返回记录概览'}`}
                </Button>
                {overviewOpen ? (
                  <div id="timeline-history-overview" className="mt-2"><Card>
                    <CardHeader title={complete ? '全历史概览' : '已返回记录概览'}
                      description={`${data.points[0]!.label} — ${data.points.at(-1)!.label} · ${formatNumber(data.points.length)} 期 · 辅助定位视图`} />
                    <CardBody>
                      <TimelineOverview points={data.points}
                        selectedFrom={range ? periodKey(range.first, state.grain) : ''}
                        selectedTo={range ? periodKey(range.last, state.grain) : ''} onLocate={locate} />
                    </CardBody>
                  </Card></div>
                ) : null}
              </div>
          <section className="timeline-range-bar" aria-label="统一精读范围">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <Button
                variant="outline"
                className="max-w-full"
                icon={<CalendarRange size={15} />}
                onClick={() => {
                  setDraft(
                    range
                      ? {
                          from: periodMonths(range.first, state.grain).from,
                          to: periodMonths(range.last, state.grain).to,
                        }
                      : { from: state.from, to: state.to },
                  );
                  setEditing(true);
                }}
              >
                <span className="truncate">{title}</span>
                <span className="text-caption text-muted">更改范围</span>
              </Button>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant={state.mode === 'recent' ? 'primary' : 'ghost'}
                  onClick={() => commit({ ...state, mode: 'recent' })}
                >
                  {complete ? '最近 12 期' : '末 12 个已返回周期'}
                </Button>
                {complete ? (
                  <Button
                    size="sm"
                    variant={state.mode === 'recorded' ? 'primary' : 'ghost'}
                    onClick={() => commit({ ...state, mode: 'recorded' })}
                  >
                    最近有记录
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant={state.mode === 'all' ? 'primary' : 'ghost'}
                  onClick={() => commit({ ...state, mode: 'all' })}
                >
                  {complete ? '全部历史' : '全部已返回'}
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-caption text-muted">
              <p role="status">
                {range
                  ? `精读 ${formatNumber(points.length)} 期 · 图表、摘要与明细共用此范围`
                  : '范围无效或已不在当前数据域。保留原选择，请主动重选。'}
              </p>
              {domain && range && !single ? (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="前一段范围"
                    disabled={range.first <= domain.first}
                    onClick={() => {
                      const shift = Math.min(
                        range.last - range.first + 1,
                        range.first - domain.first,
                      );
                      custom({ first: range.first - shift, last: range.last - shift });
                    }}
                  >
                    <ChevronLeft size={15} />
                    前一段
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="后一段范围"
                    disabled={range.last >= domain.last}
                    onClick={() => {
                      const shift = Math.min(
                        range.last - range.first + 1,
                        domain.last - range.last,
                      );
                      custom({ first: range.first + shift, last: range.last + shift });
                    }}
                  >
                    后一段
                    <ChevronRight size={15} />
                  </Button>
                </div>
              ) : null}
            </div>
            {domain && range && !single ? (
              <TimelineNavigator range={range} domain={domain} grain={state.grain}
                snapshot={`${data.context?.dataVersion ?? ''}:${data.context?.visibility ?? ''}`}
                onCommit={custom} onPreview={onPreview} />
            ) : null}
          </section>
            </>}
          </RangePreview>

          {range ? (
            <div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="范围摘要">
                <Metric
                  label="归集收藏"
                  value={`${formatNumber(summary.added)} 部`}
                  hint="当前范围内的最后更新时间归集"
                />
                <Metric
                  label="当前看过"
                  value={`${formatNumber(summary.done)} 部`}
                  hint="这些归集条目当前处于看过状态"
                />
                <Metric
                  label="范围平均评分"
                  value={summary.samplesKnown ? formatRate(summary.averageRate, 2) : '未提供'}
                  hint={
                    summary.samplesKnown
                      ? `有效评分 ${formatNumber(summary.ratedCount!)} 部 · 按样本加权`
                      : '旧服务未提供评分总和与样本数'
                  }
                />
                <Metric
                  label="归集已看集数"
                  value={`${formatNumber(summary.episodes)} 集`}
                  hint="当前进度按条目最后更新时间归集"
                />
              </div>
              {summary.added === 0 ? (
                <p className="timeline-context-note mt-3 text-note text-muted">
                  {complete
                    ? '此日历范围内无归集记录，可主动定位最近有记录的时期。零值仅表示此范围没有归集。'
                    : '此返回范围内没有归集；未知历史仍不能按零处理。'}
                </p>
              ) : null}
              {complete &&
              range.last >=
                Math.floor(
                  periodIndex(data.context!.referenceMonth, 'month')! /
                    (12 / grainSize(state.grain)),
                ) ? (
                <p className="timeline-context-note mt-2 text-caption text-muted">
                  本范围可能含尚未结束或未来的日历周期；当前快照会随收藏更新而变化。
                </p>
              ) : null}
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader
                    title="归集数量"
                    description="线性尺度 · 部；小值可在深入查看中单独比较"
                  />
                  <CardBody>
                    <TimelineMetricChart points={points} metric="added" />
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader
                    title="平均评分"
                    description="独立 0–10 分尺度；无有效评分留空，不连跨缺失值"
                  />
                  <CardBody>
                    <TimelineMetricChart points={points} metric="averageRate" />
                  </CardBody>
                </Card>
                <Card className="xl:col-span-2">
                  <CardHeader
                    title="归集已看集数"
                    description="独立线性尺度 · 集；不是该时期实际观看事件数"
                  />
                  <CardBody>
                    <TimelineMetricChart points={points} metric="episodes" />
                  </CardBody>
                </Card>
              </div>
              <details className="timeline-disclosure mt-4">
                <summary>深入查看 · 极值与小值比较</summary>
                <div className="space-y-3 p-4 text-note">
                  {peak && peak.added > 0 ? (
                    <p>
                      峰值：
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => locate(peak.period, peak.period)}
                      >
                        {peak.label} · {formatNumber(peak.added)} 部 · 定位此期
                      </Button>
                    </p>
                  ) : (
                    <p>当前范围没有非零周期。</p>
                  )}
                  <p className="text-muted">
                    {small.length
                      ? `低于峰值的最小 ${small.length} 个非零周期，局部使用独立线性尺度；主图及原始数值保持不变。`
                      : '没有低于峰值的非零周期，无需单独放大。'}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {small.map((p) => (
                      <button
                        key={p.period}
                        className="timeline-small-row"
                        onClick={() => locate(p.period, p.period)}
                        title="定位此期"
                      >
                        <span>{p.label}</span>
                        <span className="timeline-small-track">
                          <span
                            style={{ width: `${(p.added / (small.at(-1)?.added || 1)) * 100}%` }}
                          />
                        </span>
                        <strong className="numeric">{p.added} 部</strong>
                      </button>
                    ))}
                  </div>
                </div>
              </details>
              <details className="timeline-disclosure mt-3">
                <summary>深入查看 · 累计归集曲线</summary>
                <div className="p-4">
                  <h3 className="text-card">累计归集（当前快照）</h3>
                  <p className="mt-1 text-note text-muted">
                    当前收藏按最后更新时间归集的前缀累计，不代表真实历史收藏增长或真实观看发生时间。
                    {!complete
                      ? '完整性未确认，仅能读取服务已返回的累计。'
                      : '范围起点保留全历史前缀，不从零重算。'}
                  </p>
                  <TimelineMetricChart points={points} metric="total" />
                </div>
              </details>
              <Card className="mt-4">
                <CardHeader
                  title="精确明细"
                  description="同一精读范围 · 新到旧；每页最多 50 期，全部周期均可翻页访问"
                />
                <CardBody>
                  <div className="overflow-x-auto">
                    <table
                      className="w-full min-w-[640px] border-collapse text-note"
                      aria-label="时间趋势精确明细"
                    >
                      <thead>
                        <tr className="border-b border-border text-left text-caption text-muted">
                          {[
                            '周期',
                            '归集 / 部',
                            '当前看过 / 部',
                            '已看 / 集',
                            '平均评分',
                            '评分样本',
                            '累计归集 / 部',
                          ].map((t) => (
                            <th key={t} className="px-2 py-3 font-medium">
                              {t}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((p) => (
                          <tr key={p.period} className="border-b border-border/60">
                            <th
                              scope="row"
                              className="whitespace-nowrap px-2 py-2.5 text-left font-normal"
                            >
                              {p.label}
                            </th>
                            {[
                              p.added,
                              p.updated,
                              p.episodes,
                              formatRate(p.averageRate, 2),
                              p.ratingSample?.ratedCount ?? '未提供',
                              p.total,
                            ].map((v, i) => (
                              <td key={i} className="numeric px-2 py-2.5">
                                {v}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {points.length > 50 ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-note">
                      <span>
                        共 {formatNumber(points.length)} 期 · 第 {tablePage + 1} /{' '}
                        {Math.ceil(points.length / 50)} 页
                      </span>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={tablePage === 0}
                          onClick={() => setPage(tablePage - 1)}
                        >
                          上一页
                        </Button>
                        <label className="flex items-center gap-1">
                          页码
                          <Input
                            className="w-20"
                            type="number"
                            aria-label="明细页码"
                            min={1}
                            max={Math.ceil(points.length / 50)}
                            value={tablePage + 1}
                            onChange={(e) =>
                              setPage(
                                Math.max(
                                  0,
                                  Math.min(
                                    Math.ceil(points.length / 50) - 1,
                                    Number(e.target.value) - 1,
                                  ),
                                ),
                              )
                            }
                          />
                        </label>
                        <Button
                          size="sm"
                          disabled={(tablePage + 1) * 50 >= points.length}
                          onClick={() => setPage(tablePage + 1)}
                        >
                          下一页
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            </div>
          ) : (
            <InlineNote tone="warning">
              当前范围无法应用。请更改范围或恢复最近 12 期；图表不会静默使用另一段历史。
            </InlineNote>
          )}
        </>
      )}

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="更改精读范围"
        description="预览起止后应用，所有精读图表、摘要与明细一同更新。"
        footer={
          <>
            <Button onClick={() => setEditing(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={!draftRange}
              onClick={() => {
                commit({ ...state, mode: 'custom', ...draft });
                setEditing(false);
              }}
            >
              应用范围
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-note">
              起始月份
              <Input
                type="text"
                placeholder="YYYY-MM"
                maxLength={7}
                aria-label="起始月份"
                value={draft.from}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-note">
              结束月份
              <Input
                type="text"
                placeholder="YYYY-MM"
                maxLength={7}
                aria-label="结束月份"
                value={draft.to}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </label>
          </div>
          <p className="text-caption text-muted">
            {state.grain !== 'month'
              ? '按所选粒度包含起止月份所在的完整年或季度。'
              : '起止均包含在内。'}
            取消或 Esc 不改变已提交范围。
          </p>
          <p
            role="status"
            className={draftRange ? 'text-note text-muted' : 'text-note text-warning'}
          >
            {draftRange
              ? `待应用：${periodLabel(periodKey(draftRange.first, state.grain), state.grain)} — ${periodLabel(periodKey(draftRange.last, state.grain), state.grain)}`
              : '起止日期无效、顺序颠倒或超出当前可用范围。'}
          </p>
          {single ? <p className="text-note text-muted">当前仅一期，无需范围导航。</p> : null}
        </div>
      </Dialog>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="timeline-metric">
      <h3 className="text-note text-muted">{label}</h3>
      <p className="numeric my-2 text-metric">{value}</p>
      <p className="text-caption text-muted">{hint}</p>
    </div>
  );
}

/** Keep high-frequency drafts out of TimelineView: no summary/table work or data requests per move. */
function RangePreview({ data, range, points, grain, children }: {
  data: TimelineStats; range: PeriodRange | null; points: TimelinePoint[]; grain: TimelineGrain;
  children: (onPreview: (next: PeriodRange | null) => void) => ReactNode;
}) {
  const [draft, setDraft] = useState<{ identity: string; range: PeriodRange } | null>(null);
  const frame = useRef<number | null>(null), pending = useRef<PeriodRange | null>(null);
  const identity = `${data.context?.dataVersion}:${data.context?.visibility}:${grain}:${range?.first}:${range?.last}`;
  const onPreview = useCallback((next: PeriodRange | null) => {
    pending.current = next;
    if (!next) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null; setDraft(null); return;
    }
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const nextRange = pending.current;
      if (nextRange) setDraft(previous => previous?.identity === identity &&
        previous.range.first === nextRange.first && previous.range.last === nextRange.last
        ? previous : { identity, range: nextRange });
    });
  }, [identity]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const preview = draft?.identity === identity ? draft.range : null;
  const shown = useMemo(() => preview ? rangePoints(data, preview) : points,
    [data, preview, points]);
  const shownRange = preview ?? range;
  return <div className="space-y-3">
    {shownRange ? <Card>
      <CardHeader title="当前范围趋势"
        description={`${periodLabel(periodKey(shownRange.first, grain), grain)} — ${periodLabel(periodKey(shownRange.last, grain), grain)} · ${formatNumber(shown.length)} 期`} />
      <CardBody>
        <div role="img" aria-label="当前范围归集数量趋势" data-testid="timeline-main"
          data-from={periodKey(shownRange.first, grain)} data-to={periodKey(shownRange.last, grain)}
          data-periods={shown.length} data-preview={Boolean(preview)}>
          <TimelineOverview points={shown} selectedFrom="" selectedTo="" currentRange />
        </div>
        <p className="mt-1 min-h-5 text-caption text-muted">
          {preview ? '拖动预览 · 松手后统一更新摘要、精读图表与明细；Esc取消。' : '拖动范围时此图实时预览；摘要、下方精读图表与明细仅在松手后更新。'}
        </p>
      </CardBody>
    </Card> : null}
    {children(onPreview)}
  </div>;
}
