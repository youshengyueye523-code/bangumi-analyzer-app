import { Link } from 'react-router-dom';
import type { ProfileDataset } from '@bangumi-analyzer/shared';
import { cn } from '../../lib/cn.js';
import { formatNumber, formatPercent, formatRate } from '../../lib/format.js';
import { Card, CardBody, CardHeader } from '../ui/card.js';
import { InlineNote } from '../ui/feedback.js';

/** 画像的明细面板：把结论背后的结构数据摊开给用户自己核对。 */
export function StructurePanel({ dataset }: { dataset: ProfileDataset }) {
  const { tagPairs, tags, avoidance, breadth, length, series, periods } = dataset;

  const highLiftTags = [...tags]
    .filter((tag) => tag.count >= 8 && tag.lift !== null)
    .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0))
    .slice(0, 8);

  return (
    <div className="grid gap-4 xl:grid-cols-safe-2">
      <Card>
        <CardHeader
          title="高分作品中的标签组合"
          description="只使用 Bangumi 维基维护的类型标签，按「区分度」（实际共现 ÷ 独立假设期望）排序"
        />
        <CardBody className="space-y-1.5 pt-2">
          {tagPairs.length > 0 ? (
            tagPairs.slice(0, 8).map((pair) => (
              <div
                key={`${pair.a}-${pair.b}`}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-[10px] border border-border bg-surface-2 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate-line text-note">
                  {pair.a} <span className="text-subtle">+</span> {pair.b}
                </span>
                <span className="numeric text-caption text-subtle">
                  {pair.count} 部 · 占高分 {formatPercent(pair.share, 0)} · 倍数 {pair.lift}
                </span>
              </div>
            ))
          ) : (
            <InlineNote tone="neutral">
              当前的高分作品还不足以统计标签组合（需要同一组合至少出现 3 次）。
            </InlineNote>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="你更容易给高分的标签"
          description="倍数 = 在高分作品中的占比 ÷ 在全部收藏中的占比"
        />
        <CardBody className="space-y-1.5 pt-2">
          {highLiftTags.map((tag) => (
            <Link
              key={tag.name}
              to={`/library?tags=${encodeURIComponent(tag.name)}`}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-[10px] border border-border bg-surface-2 px-3 py-2 transition-colors hover:border-border-strong"
            >
              <span className="min-w-0 flex-1 truncate-line text-note">{tag.name}</span>
              <span className="numeric text-caption text-subtle">
                {tag.count} 部 · 高分 {formatPercent(tag.highShare, 0)} · 平均 {formatRate(tag.averageRate, 2)} ·{' '}
                <span className={cn((tag.lift ?? 0) >= 1.5 ? 'text-success' : 'text-subtle')}>
                  {tag.lift}×
                </span>
              </span>
            </Link>
          ))}
          {highLiftTags.length === 0 ? (
            <InlineNote tone="neutral">标签样本不足，暂无可靠的偏好倍数。</InlineNote>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="可能被主动避开的模式"
          description="基于「反复接触但持续低评价 / 长期搁置 / 一直停在想看」的行为推断"
        />
        <CardBody className="space-y-1.5 pt-2">
          {avoidance.length > 0 ? (
            avoidance.slice(0, 6).map((item) => (
              <div
                key={`${item.dimension}-${item.name}`}
                className="rounded-[10px] border border-border bg-surface-2 px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                  <span className="min-w-0 flex-1 truncate-line text-note">
                    {item.dimension} · {item.name}
                  </span>
                  <span className="numeric text-caption text-subtle">
                    {item.count} 部 · 平均 {formatRate(item.averageRate, 2)}
                    {item.gap !== null ? ` (${item.gap > 0 ? '+' : ''}${item.gap})` : ''}
                  </span>
                </div>
                <p className="mt-1 text-caption leading-5 text-subtle">{item.note}</p>
              </div>
            ))
          ) : (
            <InlineNote tone="neutral">没有发现明显的回避模式（需要同一分类至少接触 4 部）。</InlineNote>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="兴趣边界与结构" description="广度、集中度与作品形态" />
        <CardBody className="space-y-3 pt-2">
          <div className="grid grid-cols-safe-2 gap-3 sm:grid-cols-safe-4">
            {[
              { label: '不同标签', value: formatNumber(breadth.distinctTags) },
              { label: '高分作品标签', value: formatNumber(breadth.distinctTagsInHighRated) },
              { label: '制作公司', value: formatNumber(breadth.distinctStudios) },
              { label: '导演', value: formatNumber(breadth.distinctDirectors) },
            ].map((item) => (
              <div key={item.label} className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
                <p className="text-caption text-subtle">{item.label}</p>
                <p className="numeric mt-0.5 text-section">{item.value}</p>
              </div>
            ))}
          </div>
          <p className="text-note leading-6 text-muted">{breadth.verdict}</p>
          <div className="space-y-1.5">
            {length.map((bucket) => (
              <div key={bucket.bucket} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-20 shrink-0 text-caption text-subtle sm:w-24">{bucket.bucket}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{
                      width: `${Math.min(100, (bucket.count / Math.max(1, dataset.sample.total)) * 300)}%`,
                    }}
                  />
                </div>
                <span className="numeric w-[104px] shrink-0 text-right text-caption text-subtle">
                  {bucket.count} 部 · {formatRate(bucket.averageRate, 2)} 分
                </span>
              </div>
            ))}
          </div>
          <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-caption leading-5 text-subtle">
            系列作品 {series.groupedWorks} 部（{series.groupCount} 组，平均每组 {series.averageGroupSize ?? '—'} 部，
            平均 {formatRate(series.averageRateGrouped, 2)} 分）；
            独立作品 {series.standaloneWorks} 部，平均 {formatRate(series.averageRateStandalone, 2)} 分。
          </div>
        </CardBody>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader
          title="按收藏活动年份的兴趣快照"
          description="使用 Bangumi 的最后更新时间近似（官方没有真正的收藏时间字段）"
        />
        <CardBody className="pt-2">
          <div className="overflow-x-auto">
            <table className="numeric w-full min-w-[640px] border-collapse text-note">
              <thead>
                <tr className="border-b border-border text-left text-caption text-subtle">
                  <th className="py-2 pr-3 font-medium">年份</th>
                  <th className="py-2 pr-3 text-right font-medium">作品数</th>
                  <th className="py-2 pr-3 text-right font-medium">已评分</th>
                  <th className="py-2 pr-3 text-right font-medium">平均我的评分</th>
                  <th className="py-2 pr-3 text-right font-medium">标签分散度</th>
                  <th className="py-2 pr-3 font-medium">主要标签</th>
                  <th className="py-2 font-medium">新出现的标签</th>
                </tr>
              </thead>
              <tbody>
                {[...periods].reverse().map((period) => (
                  <tr key={period.period} className="border-b border-border/70 last:border-b-0">
                    <td className="py-1.5 pr-3">{period.period}</td>
                    <td className="py-1.5 pr-3 text-right">{period.count}</td>
                    <td className="py-1.5 pr-3 text-right">{period.ratedCount}</td>
                    <td className="py-1.5 pr-3 text-right">
                      {formatRate(period.averageRate, 2)}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{period.tagEntropy ?? '—'}</td>
                    <td className="max-w-[220px] truncate py-1.5 pr-3 text-subtle" title={period.topTags.join('、')}>
                      {period.topTags.slice(0, 3).join('、')}
                    </td>
                    <td className="max-w-[220px] truncate py-1.5 text-subtle" title={period.newTags.join('、')}>
                      {period.newTags.slice(0, 3).join('、') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {periods.length < 3 ? (
            <InlineNote tone="warning" className="mt-3">
              目前只有 {periods.length} 个可分析年份，兴趣随时间的变化还不能可靠判断；
              随着后续同步与阶段快照的积累会自动变得完整。
            </InlineNote>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
