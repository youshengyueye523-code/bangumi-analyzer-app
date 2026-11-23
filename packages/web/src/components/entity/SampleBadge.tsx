import { Badge } from '../ui/badge.js';

/**
 * v1.8：样本量是一等信息 —— 固定三档语义，不用颜色弱化 n。
 * n = 0 不渲染徽标（由 MetricValue 显示「无样本」）。
 */
export function SampleBadge({ sample, className }: { sample: number; className?: string }) {
  if (sample >= 3) {
    return (
      <Badge tone="neutral" className={className}>
        n={sample}
      </Badge>
    );
  }
  if (sample === 2) {
    return (
      <Badge tone="neutral" className={className}>
        样本不足 · n=2
      </Badge>
    );
  }
  if (sample === 1) {
    return (
      <Badge tone="warning" className={className}>
        单样本 · n=1
      </Badge>
    );
  }
  return null;
}
