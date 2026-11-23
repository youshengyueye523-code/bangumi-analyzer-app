import type { EntityRankingMeta } from '@bangumi-analyzer/shared';
import { cn } from '../../lib/cn.js';
import { formatPercent, formatRate } from '../../lib/format.js';
import { MetricValue } from './MetricValue.js';

const METRIC_META: Record<
  EntityRankingMeta['metric'],
  { label: string; format: (value: number) => string }
> = {
  coverage: { label: '覆盖率', format: (value) => formatPercent(value) },
  completion: { label: '完成度', format: (value) => formatPercent(value) },
  rate: { label: '我的评分', format: (value) => formatRate(value, 2) },
};

/**
 * v1.8 Ranking 行内展示：指标值 + 样本量。
 * display ≠ rankable：sample < 3 仍显示数值，由 SampleBadge 明示「单样本 / 样本不足」。
 */
export function RankingMetricLine({
  ranking,
  className,
}: {
  ranking: EntityRankingMeta;
  className?: string;
}) {
  const meta = METRIC_META[ranking.metric];
  return (
    <div
      data-testid="ranking-metric-line"
      className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-1', className)}
    >
      <span className="text-caption text-subtle">{meta.label}</span>
      <MetricValue
        size="sm"
        value={ranking.value}
        format={meta.format}
        sample={ranking.sample}
      />
    </div>
  );
}
