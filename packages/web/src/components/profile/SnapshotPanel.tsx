import { CalendarClock, GitCompare, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { ProfileComparison, ProfileSnapshotSummary } from '@bangumi-analyzer/shared';
import { formatDateTime, formatNumber, formatPercent } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardBody, CardHeader } from '../ui/card.js';
import { ErrorState, InlineNote, Skeleton } from '../ui/feedback.js';
import { Field, Input } from '../ui/form.js';
import { Dialog } from '../ui/overlay.js';

const VERDICT_META = {
  continued: { label: '延续的判断', tone: 'success' as const },
  strengthened: { label: '被强化的判断', tone: 'accent' as const },
  weakened: { label: '被削弱的判断', tone: 'warning' as const },
  overturned: { label: '被推翻的判断', tone: 'danger' as const },
  insufficient: { label: '证据不足', tone: 'neutral' as const },
};

/** 阶段快照 + 阶段对比（支持未来的 Rank 复盘）。 */
export function SnapshotPanel({
  snapshots,
  snapshotsLoading = false,
  snapshotsError,
  onRetrySnapshots,
  compare,
  compareReason,
  compareError,
  onRetryCompare,
  onCreate,
  onDelete,
  creating,
}: {
  snapshots: ProfileSnapshotSummary[];
  snapshotsLoading?: boolean;
  snapshotsError?: unknown;
  onRetrySnapshots?: () => void;
  compare: ProfileComparison | null;
  compareReason: string;
  compareError?: unknown;
  onRetryCompare?: () => void;
  onCreate: (input: {
    stageLabel: string;
    note?: string;
    source?: string;
    rankFrom?: number;
    rankTo?: number;
    candidates?: string;
  }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  creating: boolean;
}) {
  const [open, setOpen] = useState(false);
  const formId = useId();
  const [stageLabel, setStageLabel] = useState('');
  const [note, setNote] = useState('');
  const [source, setSource] = useState('');
  const [rankFrom, setRankFrom] = useState('');
  const [rankTo, setRankTo] = useState('');
  const [candidates, setCandidates] = useState('');
  const [createError, setCreateError] = useState<unknown>(null);
  const [deleteError, setDeleteError] = useState<{ id: number; error: unknown } | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function saveSnapshot() {
    setCreateError(null);
    try {
      const parsedRankFrom = rankFrom.trim() ? Number(rankFrom) : undefined;
      const parsedRankTo = rankTo.trim() ? Number(rankTo) : undefined;
      if (parsedRankFrom !== undefined && !Number.isFinite(parsedRankFrom)) {
        throw new Error('Rank 起始必须是有效数字；不填写可留空。');
      }
      if (parsedRankTo !== undefined && !Number.isFinite(parsedRankTo)) {
        throw new Error('Rank 结束必须是有效数字；不填写可留空。');
      }
      await onCreate({
        stageLabel: stageLabel.trim() || `第 ${snapshots.length + 1} 阶段`,
        note: note.trim(),
        source: source.trim(),
        ...(parsedRankFrom !== undefined ? { rankFrom: parsedRankFrom } : {}),
        ...(parsedRankTo !== undefined ? { rankTo: parsedRankTo } : {}),
        ...(candidates.trim() ? { candidates } : {}),
      });
      setOpen(false);
      setStageLabel('');
      setNote('');
      setCandidates('');
    } catch (error) {
      setCreateError(error);
    }
  }

  async function deleteSnapshot(id: number) {
    setDeletingId(id);
    setDeleteError(null);
    try {
      await onDelete(id);
    } catch (error) {
      setDeleteError({ id, error });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="阶段快照与复盘"
        description="保存当前阶段的完整数据画像（Real），不受隐藏设置影响；下一次复盘可对比判断变化"
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={13} />} disabled={creating || deletingId !== null} onClick={() => { setCreateError(null); setOpen(true); }}>
            保存当前阶段
          </Button>
        }
      />
      <CardBody className="space-y-3 pt-2">
        {snapshotsError ? <ErrorState error={snapshotsError} onRetry={onRetrySnapshots} /> : null}
        {deleteError ? <ErrorState error={deleteError.error} onRetry={() => void deleteSnapshot(deleteError.id)} /> : null}
        {snapshots.length > 0 ? (
          <div className="space-y-1.5">
            {snapshots.map((snapshot) => (
              <div
                key={snapshot.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate-line text-note font-medium">{snapshot.stageLabel}</p>
                  <p className="text-caption text-subtle">
                    {snapshot.visibility === 'real' ? '完整数据' : snapshot.visibility === 'visible' ? '可见数据' : '历史口径未确认'} · {formatDateTime(snapshot.createdAt)} · 收藏 {snapshot.collectionCount} 部 · 已评分{' '}
                    {snapshot.ratedCount} 部 · 平均 {snapshot.averageRate ?? '—'} 分
                    {snapshot.rankFrom !== null && snapshot.rankTo !== null
                      ? ` · Rank ${snapshot.rankFrom}–${snapshot.rankTo}`
                      : ''}
                    {snapshot.hasCandidateList ? ` · 候选清单 ${formatNumber(snapshot.candidateCount ?? 0)} 条` : ''}
                  </p>
                  {snapshot.note ? (
                    <p className="mt-0.5 line-clamp-2 text-caption text-subtle">{snapshot.note}</p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={13} />}
                  loading={deletingId === snapshot.id}
                  disabled={creating || deletingId !== null}
                  onClick={() => void deleteSnapshot(snapshot.id)}
                  aria-label={`删除快照 ${snapshot.stageLabel}`}
                >
                  删除
                </Button>
              </div>
            ))}
          </div>
        ) : snapshotsError ? null : snapshotsLoading ? (
          <Skeleton className="h-20" />
        ) : (
          <InlineNote tone="neutral">
            还没有阶段快照。建议在每次「阶段性复盘」时保存一个，之后就能看到审美判断的变化。
          </InlineNote>
        )}

        <div className="border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <GitCompare size={14} className="text-subtle" />
            <h4 className="text-note font-semibold">与上一阶段的对比</h4>
          </div>

          {compareError ? (
            <ErrorState error={compareError} onRetry={onRetryCompare} />
          ) : compare ? (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-safe-2 gap-3 sm:grid-cols-safe-4">
                {[
                  { label: '本阶段新增作品', value: formatNumber(compare.stageWorks.newWorks) },
                  {
                    label: '新增作品平均分',
                    value: compare.stageWorks.newWorksAverageRate ?? '—',
                  },
                  {
                    label: '新增作品主要状态',
                    value:
                      Object.entries(compare.stageWorks.newWorksByStatus)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 2)
                        .map(([status, count]) => `${status} ${count}`)
                        .join(' / ') || '—',
                  },
                  { label: '已取消收藏', value: formatNumber(compare.stageWorks.removedWorks) },
                ].map((item) => (
                  <div key={item.label} className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
                    <p className="text-caption text-subtle">{item.label}</p>
                    <p className="mt-0.5 text-card font-semibold numeric">{item.value}</p>
                  </div>
                ))}
              </div>

              <div className="space-y-1.5">
                {compare.changes.map((change) => {
                  const meta = VERDICT_META[change.verdict];
                  return (
                    <div key={change.id} className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <span className="min-w-0 truncate-line text-note font-medium">
                          {change.dimension}
                        </span>
                        <Badge tone={meta.tone} className="shrink-0">
                          {meta.label}
                        </Badge>
                      </div>
                      <p className="mt-1 text-note leading-5 text-muted">{change.statement}</p>
                      <ul className="mt-1 space-y-0.5">
                        {change.evidence.map((line) => (
                          <li key={line} className="text-caption leading-5 text-subtle">
                            · {line}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>

              <div
                className={cn(
                  'rounded-[10px] border px-3 py-2 text-note leading-5',
                  compare.rankReview.available
                    ? 'border-border bg-surface-2'
                    : 'border-dashed border-border text-subtle',
                )}
              >
                <p className="font-medium">Rank 阶段复盘</p>
                {compare.rankReview.available ? (
                  <p className="mt-1 text-muted">
                    候选 {formatNumber(compare.rankReview.candidateCount ?? 0)} 部，最终进入收藏{' '}
                    {formatNumber(compare.rankReview.collectedCount ?? 0)} 部（
                    {formatPercent(compare.rankReview.hitRate ?? 0)}）；
                    {Object.entries(compare.rankReview.byStatus ?? {})
                      .map(([status, count]) => `${status} ${count}`)
                      .join('、')}
                  </p>
                ) : (
                  <p className="mt-1">当前数据不足，无法计算。{compare.rankReview.reason}</p>
                )}
              </div>
            </div>
          ) : (
            <InlineNote tone="neutral" className="mt-3">
              <span className="flex items-center gap-1.5">
                <CalendarClock size={12} />
                等待下一阶段复盘数据：{compareReason}
              </span>
            </InlineNote>
          )}
        </div>
      </CardBody>

      <Dialog
        open={open}
        onOpenChange={(next) => { if (!creating) setOpen(next); }}
        title="保存阶段快照"
        description="快照会保存当前阶段的全部画像数据（不含任何凭据），用于未来的阶段对比与 Rank 复盘。"
        width={560}
        footer={
          <>
            <Button disabled={creating} onClick={() => setOpen(false)}>取消</Button>
            <Button
              variant="primary"
              loading={creating}
              onClick={() => void saveSnapshot()}
            >
              保存快照
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError ? <ErrorState error={createError} onRetry={() => void saveSnapshot()} /> : null}
          <Field htmlFor={`${formId}-stage`} label="阶段名称" hint="例如「2026 秋 · 第一轮复盘」。">
            <Input
              id={`${formId}-stage`}
              value={stageLabel}
              placeholder={`第 ${snapshots.length + 1} 阶段`}
              onChange={(event) => setStageLabel(event.target.value)}
            />
          </Field>
          <Field htmlFor={`${formId}-note`} label="备注（可选）" hint="记录这一阶段的观察重点或结论，方便日后回看。">
            <Input id={`${formId}-note`} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-safe-3">
            <Field htmlFor={`${formId}-source`} label="数据来源（可选）" hint="例如 Bangumi Rank / 季度追番清单">
              <Input id={`${formId}-source`} value={source} onChange={(event) => setSource(event.target.value)} />
            </Field>
            <Field htmlFor={`${formId}-rank-from`} label="Rank 起始（可选）">
              <Input
                id={`${formId}-rank-from`}
                inputMode="numeric"
                value={rankFrom}
                onChange={(event) => setRankFrom(event.target.value)}
              />
            </Field>
            <Field htmlFor={`${formId}-rank-to`} label="Rank 结束（可选）">
              <Input
                id={`${formId}-rank-to`}
                inputMode="numeric"
                value={rankTo}
                onChange={(event) => setRankTo(event.target.value)}
              />
            </Field>
          </div>
          <Field
            htmlFor={`${formId}-candidates`}
            label="候选清单（可选）"
            hint="粘贴这一阶段候选作品的 Bangumi ID（逗号或换行分隔）。只有记录了候选清单，之后才能计算「候选中有多少最终进入收藏」。"
          >
            <textarea
              id={`${formId}-candidates`}
              value={candidates}
              onChange={(event) => setCandidates(event.target.value)}
              rows={4}
              placeholder="1, 2, 3, 4"
              className="w-full rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-note text-text placeholder:text-subtle focus:border-ring focus:bg-surface focus:outline-none focus:ring-2 focus:ring-ring-soft"
            />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
