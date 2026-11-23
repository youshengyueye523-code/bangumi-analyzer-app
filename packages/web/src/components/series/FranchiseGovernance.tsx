/**
 * Franchise 成员 / 名称治理（v1.7.0）。
 *
 * 与数据中枢共用同一套语义：Preview → Execute → Verify。
 * - 预览：当前状态 / 将变成什么 / 原因 / 来源 / 直接修改 / 自动派生 / 不会修改 / 影响链；
 * - 执行：只修改真实 source-of-truth（成员排除治理记录 / 家族名称）；
 * - 结果：逐层验证（真实数据 / 治理状态 / 派生投影 / 搜索 / API / 缓存 / 重新检测），
 *   未通过全部检查时如实显示为「修复部分成功」。
 */
import { BadgeCheck, Wrench, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiRequestError } from '../../lib/api.js';
import { isVisibleText, verificationSummary, visibleEvidenceText } from '../../lib/evidenceDisplay.js';
import type {
  DiagnosticRepairPreview,
  FranchiseGovernanceKind,
  FranchiseGovernanceResult,
} from '@bangumi-analyzer/shared';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { InlineNote, Skeleton } from '../ui/feedback.js';
import { Input } from '../ui/form.js';
import { Dialog } from '../ui/overlay.js';
import { useFranchiseGovernance, useFranchiseGovernancePreview } from '../../lib/queries.js';

const LAYER_LABEL: Record<string, string> = {
  source: '真实数据',
  governance: '治理状态',
  projection: '派生投影',
  search: '搜索',
  api: 'API',
  ui: 'UI',
  detector: '重新检测',
  cache: '缓存',
};

export interface FranchiseGovernanceTarget {
  kind: FranchiseGovernanceKind;
  /** 成员治理的目标（exclude / reopen）。 */
  seriesKey?: string;
  /** 用于文案展示的系列名。 */
  seriesTitle?: string;
  /** adopt-franchise-title 的初始名称。 */
  initialTitle?: string;
}

function GovernanceResultCard({
  result,
}: {
  result: FranchiseGovernanceResult;
}) {
  const ok = result.verification.verified;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-body font-medium">
          {ok ? (
            <BadgeCheck size={16} className="text-success" />
          ) : (
            <XCircle size={16} className="text-warning" />
          )}
          {ok ? '修复完成并已验证' : '修复部分成功'}
        </p>
        <Badge tone={ok ? 'success' : 'warning'}>{result.repair.label}</Badge>
      </div>
      <p className="text-note text-muted">{verificationSummary(result.verification.summary)}</p>
      <div className="space-y-1">
        {result.verification.checks.map((check, index) => (
          <p
            key={`${check.layer}-${check.label}-${index}`}
            className="flex items-start gap-1.5 text-caption text-muted"
          >
            {check.ok ? (
              <BadgeCheck size={12} className="mt-0.5 shrink-0 text-success" />
            ) : (
              <XCircle size={12} className="mt-0.5 shrink-0 text-warning" />
            )}
            <span className="min-w-0">
              <span className="mr-1 rounded-chip bg-surface-2 px-1.5 py-0.5 text-[10px] text-subtle">
                {LAYER_LABEL[check.layer] ?? check.layer}
              </span>
              {visibleEvidenceText(check.label) ? <span className="text-subtle">{check.label}：</span> : null}
              {visibleEvidenceText(check.detail)}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

function PreviewBody({
  preview,
}: {
  preview: DiagnosticRepairPreview;
}) {
  const lists = [
    { label: '直接修改', items: preview.directlyChanges.filter(isVisibleText) },
    { label: '自动派生（系统负责重算）', items: preview.derivedChanges.filter(isVisibleText) },
    { label: '不会修改', items: preview.untouched.filter(isVisibleText) },
  ].filter(({ items }) => items.length > 0);
  const chain = preview.chain.filter((step) => isVisibleText(step.label) || isVisibleText(step.detail));

  return (
    <div className="space-y-3">
      {visibleEvidenceText(preview.current) ? <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
        <p className="text-caption text-subtle">当前</p>
        <p className="mt-0.5 text-note">{preview.current}</p>
      </div> : null}
      {visibleEvidenceText(preview.next) ? <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
        <p className="text-caption text-subtle">将修改为</p>
        <p className="mt-0.5 text-note">{preview.next}</p>
      </div> : null}
      {visibleEvidenceText(preview.reason) || visibleEvidenceText(preview.source) ? <div className="space-y-2 rounded-[10px] border border-border px-3 py-2">
        {visibleEvidenceText(preview.reason) ? <div>
          <p className="text-caption text-subtle">为什么修改</p>
          <p className="mt-0.5 text-caption text-muted">{preview.reason}</p>
        </div> : null}
        {visibleEvidenceText(preview.source) ? <div>
          <p className="text-caption text-subtle">修改来源</p>
          <p className="mt-0.5 text-caption text-muted">{preview.source}</p>
        </div> : null}
      </div> : null}
      {lists.map(({ label, items }) => (
        <div key={label}>
          <p className="text-caption font-medium text-subtle">{label}</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-caption text-muted">
            {items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ))}
      {chain.length > 0 ? <div className="rounded-[10px] border border-border px-3 py-2">
        <p className="text-caption font-medium text-subtle">影响链</p>
        <ol className="mt-1.5 space-y-1">
          {chain.map((step, index) => (
            <li key={`${step.layer}-${index}`} className="flex items-start gap-2 text-caption text-muted">
              <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] text-subtle">
                {index + 1}
              </span>
              <span className="min-w-0">
                {visibleEvidenceText(step.label) ? <span className="text-text">{step.label}</span> : null}
                {visibleEvidenceText(step.detail) ? <span className="text-subtle">{isVisibleText(step.label) ? '：' : ''}{step.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </div> : null}
    </div>
  );
}

export function FranchiseGovernanceDialog(props: {franchiseKey: string; target: FranchiseGovernanceTarget | null; onClose: () => void}) {
  return props.target ? <GovernanceDialogContent key={props.franchiseKey + props.target.kind + (props.target.seriesKey ?? '')} {...props} /> : null;
}
function GovernanceDialogContent({
  franchiseKey,
  target,
  onClose,
}: {
  franchiseKey: string;
  target: FranchiseGovernanceTarget | null;
  onClose: () => void;
}) {
  const open = target !== null;
  const isAdopt = target?.kind === 'adopt-franchise-title';
  const [titleDraft, setTitleDraft] = useState('');
  const [submittedTitle, setSubmittedTitle] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<FranchiseGovernanceResult | null>(null);

  useEffect(() => {
    if (!target) return;
    setTitleDraft(target.initialTitle ?? '');
    setSubmittedTitle(target.kind === 'adopt-franchise-title' ? null : '');
    setReason('');
    setResult(null);
  }, [target]);

  const previewQuery = useFranchiseGovernancePreview(
    franchiseKey,
    target && (!isAdopt || submittedTitle !== null)
      ? {
          kind: target.kind,
          ...(target.seriesKey ? { series: target.seriesKey } : {}),
          ...(isAdopt && submittedTitle ? { title: submittedTitle } : {}),
        }
      : null,
  );
  const mutation = useFranchiseGovernance();
  const unexpectedEvidence = previewQuery.data?.presentation?.mode === 'real';
  const preview = unexpectedEvidence ? null : previewQuery.data?.preview ?? null;
  const restricted = preview?.requiresRealEvidence || previewQuery.data?.requiresRealEvidence;
  const blocked = Boolean(previewQuery.data && !previewQuery.data.allowed);
  const loading = previewQuery.isLoading || previewQuery.isFetching;
  const sourceRejected = mutation.error instanceof ApiRequestError &&
    mutation.error.code === 'protected_source_write_violation';
  const ready = Boolean(preview && !blocked && !loading && !previewQuery.error && !restricted && !sourceRejected);

  const execute = () => {
    if (!target || !ready || mutation.isPending) return;
    mutation.mutate(
      {
        key: franchiseKey,
        payload: {
          kind: target.kind,
          ...(target.seriesKey ? { series: target.seriesKey } : {}),
          ...(isAdopt && submittedTitle ? { title: submittedTitle } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      },
      { onSuccess: (data) => setResult(data) },
    );
  };

  const showPreviewStep = !result && (!isAdopt || submittedTitle !== null);
  const title =
    target?.kind === 'exclude-franchise-member'
      ? '移出这个家族成员？'
      : target?.kind === 'reopen-franchise-member'
        ? '撤销成员排除？'
        : target?.kind === 'supersede-franchise-member'
          ? '迁移已被取代的家族成员？'
          : target?.kind === 'adopt-franchise-title'
            ? '设置家族名称'
            : '恢复自动解析？';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !mutation.isPending) onClose();
      }}
      title={result ? '验证结果' : title}
      description={
        target?.seriesTitle
          ? `成员「${target.seriesTitle}」`
          : target?.kind === 'adopt-franchise-title'
            ? '人工名称会成为正式展示名，自动 resolver 之后只能提出候选'
            : undefined
      }
      footer={
        result ? (
          <Button onClick={onClose}>完成</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              取消
            </Button>
            {isAdopt && submittedTitle === null ? (
              <Button
                disabled={titleDraft.trim().length === 0}
                onClick={() => setSubmittedTitle(titleDraft.trim())}
              >
                查看变更预览
              </Button>
            ) : (
              <Button
                icon={<Wrench size={13} />}
                loading={mutation.isPending}
                disabled={mutation.isPending || !ready}
                onClick={execute}
              >
                执行修复
              </Button>
            )}
          </>
        )
      }
    >
      {restricted && !unexpectedEvidence ? <InlineNote tone="warning">此计划涉及受保护的历史引用，当前不可执行。</InlineNote> : null}
      {result ? (
        result.report.presentation?.mode === 'real'
          ? <InlineNote tone="warning">验证响应不符合当前隐私展示要求，未展示证据。请读取当前状态核对结果。</InlineNote>
          : <GovernanceResultCard result={result} />
      ) : isAdopt && submittedTitle === null ? (
        <div className="space-y-3">
          <div>
            <p className="text-caption text-subtle">新的家族名称</p>
            <Input
              aria-label="家族名称"
              className="mt-1"
              maxLength={120}
              placeholder="输入用于长期展示的名称"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
            />
          </div>
          <InlineNote tone="neutral">
            只修改家族的展示名称与候选 provenance，不会改变成员构成、Series identity、
            收藏或原始关系数据。下一步会先展示影响预览。
          </InlineNote>
        </div>
      ) : loading ? (
        <Skeleton className="h-[220px]" />
      ) : previewQuery.error ? (
        <div className="space-y-2">
          <InlineNote tone="warning">
            无法读取影响预览：{(previewQuery.error as Error).message}
          </InlineNote>
          <Button size="sm" onClick={() => void previewQuery.refetch()}>重试</Button>
        </div>
      ) : unexpectedEvidence ? (
        <InlineNote tone="warning">预览响应不符合当前隐私展示要求，未展示明细。</InlineNote>
      ) : blocked ? (
        <InlineNote tone="warning">{visibleEvidenceText(previewQuery.data?.message) ?? '此操作当前不可执行。'}</InlineNote>
      ) : preview ? (
        <div className="space-y-3">
          <PreviewBody preview={preview} />
          <div>
            <p className="text-caption text-subtle">可选：记录这次决定的原因</p>
            <Input
              aria-label="治理原因"
              className="mt-1"
              maxLength={240}
              placeholder="例如：该成员与家族其他作品无关"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <InlineNote tone="neutral">
            修复完成后会自动重新运行检测，并用真实数据逐层验证；未通过全部检查时会明确标记为部分成功。
          </InlineNote>
          {mutation.error ? (
            <p className="text-caption text-danger">{(mutation.error as Error).message}</p>
          ) : null}
          {sourceRejected ? (
            <InlineNote tone="warning">请关闭此对话框，重新检测并查看新的变更预览；不要重复提交旧预览。</InlineNote>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

