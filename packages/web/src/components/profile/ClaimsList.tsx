import { BarChart3, Lightbulb } from 'lucide-react';
import type { ProfileClaim } from '@bangumi-analyzer/shared';
import { Badge } from '../ui/badge.js';

const CONFIDENCE_LABEL: Record<ProfileClaim['confidence'], string> = {
  high: '证据充分',
  medium: '样本一般',
  low: '样本较少',
};

/** 单条画像结论：结论 + 支撑数字 + 置信度 + 证据不足说明。 */
export function ClaimCard({ claim }: { claim: ProfileClaim }) {
  const data = claim.kind === 'data';
  return (
    <article
      className={
        data
          ? 'card-surface flex flex-col gap-2 p-4'
          : 'flex flex-col gap-2 rounded-[14px] border border-dashed border-warning/40 bg-warning-soft/20 p-4'
      }
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="clamp-2 text-card">{claim.title}</h3>
        <Badge
          tone={data ? 'accent' : 'warning'}
          className="shrink-0"
          title={`置信度：${CONFIDENCE_LABEL[claim.confidence]}`}
        >
          {data ? <BarChart3 size={10} /> : <Lightbulb size={10} />}
          {data ? '数据结论' : '推测'}
        </Badge>
      </div>

      <p className="text-note leading-6 text-muted">{claim.statement}</p>

      {claim.insufficient ? (
        <p className="rounded-[10px] border border-warning/30 bg-warning-soft/40 px-2.5 py-1.5 text-caption leading-5 text-warning">
          当前数据不足：{claim.insufficient}
        </p>
      ) : null}

      {claim.evidence.length > 0 ? (
        <ul className="mt-0.5 space-y-1 border-t border-border/70 pt-2">
          {claim.evidence.map((line) => (
            <li key={line} className="flex gap-2 text-caption leading-5 text-subtle">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-subtle" />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <span className="text-caption text-subtle">置信度：{CONFIDENCE_LABEL[claim.confidence]}</span>
    </article>
  );
}
