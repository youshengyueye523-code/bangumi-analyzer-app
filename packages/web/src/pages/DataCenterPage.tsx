/**
 * 数据中枢（v1.6.0）：Data Integrity & Diagnostics。
 *
 * 产品职责：发现问题 → 解释证据 → 说明影响 → 修复预览 → 执行 → 重新检测 → 验证。
 * 页面不直接编辑派生数据：修复动作由后端执行真实 source-of-truth 修改并回传验证结果。
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  CircleHelp,
  Database,
  Home,
  Layers,
  Link2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDiagnosticExpired } from '../lib/diagnosticFreshness.js';
import { Link } from 'react-router-dom';
import {
  DIAGNOSTIC_SEVERITY_LABEL,
  type DiagnosticAction,
  type DiagnosticForeignKeyCheck,
  type DiagnosticSourceSnapshots,
  type DiagnosticIssue,
  type DiagnosticModuleStatus,
  type DiagnosticSeverity,
  type DiagnosticsRepairResult,
  type DiagnosticsReport,
} from '@bangumi-analyzer/shared';
import { Badge, type BadgeTone } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardBody, CardHeader, SectionTitle, StatCard } from '../components/ui/card.js';
import { EmptyState, ErrorState, InlineNote, Skeleton } from '../components/ui/feedback.js';
import { Dialog } from '../components/ui/overlay.js';
import { Segmented } from '../components/ui/form.js';
import { useToast } from '../components/ui/toast.js';
import { api } from '../lib/api.js';
import { evidenceDisplayError, isVisibleText, verificationSummary, WITHHELD_EVIDENCE } from '../lib/evidenceDisplay.js';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format.js';
import {
  queryKeys,
  useDiagnostics,
  useDiagnosticsHistory,
  useDiagnosticsRepair,
} from '../lib/queries.js';

const SEVERITY_TONE: Record<DiagnosticSeverity, BadgeTone> = {
  error: 'danger',
  suspicious: 'warning',
  'needs-review': 'accent',
  uncertain: 'info',
  external: 'neutral',
  info: 'neutral',
};

/** 展示顺序：严重度从高到低，只有真正出现的问题才渲染分区。 */
const SEVERITY_ORDER: DiagnosticSeverity[] = [
  'error',
  'suspicious',
  'needs-review',
  'uncertain',
  'external',
  'info',
];

const MODULE_STATUS_META: Record<
  DiagnosticModuleStatus,
  { label: string; tone: BadgeTone; dot: string }
> = {
  ok: { label: '通过', tone: 'success', dot: 'bg-success' },
  attention: { label: '需留意', tone: 'warning', dot: 'bg-warning' },
  error: { label: '发现问题', tone: 'danger', dot: 'bg-danger' },
  skipped: { label: '未启用', tone: 'neutral', dot: 'bg-subtle' },
};

type RepairAction = Extract<DiagnosticAction, { kind: 'repair' }>;

const CHECK_LAYER_LABEL: Record<string, string> = {
  source: '真实数据',
  governance: '治理状态',
  projection: '派生投影',
  search: '搜索',
  api: 'API',
  ui: 'UI',
  detector: '重新检测',
  cache: '缓存',
};

const WAITING_KIND_LABEL: Record<string, string> = {
  collection: '等待收藏',
  'detail-sync': '等待详情同步',
  'bangumi-field': '等待 Bangumi 字段',
  'relation-update': '等待关系更新',
  'manual-review': '等待人工确认',
  network: '等待网络 / 服务端',
  none: '可在本地处理',
};

const HISTORY_ACTOR_META: Record<string, { label: string; tone: BadgeTone }> = {
  user: { label: '本地用户', tone: 'accent' },
  system: { label: '系统自动', tone: 'neutral' },
  maintenance: { label: '维护操作', tone: 'warning' },
};

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 1);
  } catch {
    return value;
  }
}

function moduleDetails(module: DiagnosticsReport['modules'][number], report: DiagnosticsReport): string[] {
  const visible = module.details.filter(isVisibleText);
  if (!report.presentation?.privacyApplied || visible.length === module.details.length) return visible;

  // Restore old rows only when the same fact is present in a structured public field.
  // Never estimate a detector counter or reconstruct historical free text.
  const { scope, dataVersion, lastMutation } = report;
  const uncollected = report.issues.find((issue) => issue.id === 'relations.uncollected-members')?.affectedCount;
  switch (module.id) {
    case 'storage':
      return [...new Set([
        `数据版本 ${dataVersion}`,
        `${scope.subjects} Subjects · ${scope.collections} Collections · ${scope.relations} Relations`,
        `最近一次数据变更：${lastMutation.scope ?? '暂无记录'}${lastMutation.at ? ` · ${lastMutation.at}` : ''}`,
        ...visible,
      ])];
    case 'series':
      return [...new Set([`${scope.series} 个 Series（非 stale）`, `保留的历史实体行（stale）：${scope.staleSeries} 条，不参与展示`, ...visible])];
    case 'franchise':
      return [...new Set([`${scope.franchises} 个 Franchise（非 stale）`, ...visible])];
    case 'relations':
      return [...new Set([`${scope.relations} 条关系`, ...(uncollected === undefined ? [] : [`未收藏 Series 成员：${uncollected} 个（只有关系行名称）`]), ...visible])];
    case 'collections':
      return [...new Set([`${scope.subjects} 个 Subject`, ...visible])];
    case 'translation':
      return [...new Set([`${module.checked} 条翻译任务`, ...visible])];
    default:
      return visible;
  }
}

function ModuleCard({ module, report }: { module: DiagnosticsReport['modules'][number]; report: DiagnosticsReport }) {
  const meta = MODULE_STATUS_META[module.status];
  const details = moduleDetails(module, report);
  return (
    <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-note font-medium">
          <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${meta.dot}`} />
          <span className="truncate">{module.label}</span>
        </span>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      {isVisibleText(module.description) ? <p className="mt-1 text-caption text-subtle">{module.description}</p> : null}
      {details.length > 0 ? <div className="mt-1.5 space-y-0.5">
        {details.map((detail) => (
          <p key={detail} className="text-caption text-muted">
            {detail}
          </p>
        ))}
      </div> : null}
      <p className="mt-1.5 text-caption text-subtle">检查范围：{formatNumber(module.checked)} 条记录</p>
      {module.foreignKeys ? <ForeignKeyEvidence check={module.foreignKeys} compact /> : null}
      {module.sourceSnapshots ? <SourceSnapshotEvidence check={module.sourceSnapshots} compact /> : null}
    </div>
  );
}

function SourceSnapshotEvidence({ check, compact = false }: { check: DiagnosticSourceSnapshots; compact?: boolean }) {
  return <div className="mt-2 space-y-1 text-caption text-muted">
    <p>来源快照表示检查：扫描 {formatNumber(check.rowsScanned)} 条；无效 {formatNumber(check.invalidCount)} 条；超预算未判定 {formatNumber(check.uncheckedCount)} 条。</p>
    <p>仅检查本地 JSON 表示，不证明远端真实性、身份一致或字段完整；对象 {formatNumber(check.objectCount)} 条，合法缺省/缺失 {formatNumber(check.absentCount)} 条，非对象需核查来源 {formatNumber(check.nonObjectCount)} 条。</p>
    {check.uncheckedCount > 0 ? <p className="text-warning">单条解析上限 {formatNumber(check.maxBytesPerSnapshot)} bytes；未判定不能解释为正常。</p> : null}
    {!compact ? <><p>定位样本 {check.samples.length} / {formatNumber(check.invalidCount)}{check.samplesTruncated ? '（有界样本，非全量明细）' : ''}：</p>
      <ul>{check.samples.map((s,index)=><li key={index}>{s.table}.raw · {s.reason==='invalid-json' ? 'JSON 不可解析' : '非文本存储'} · {s.identityProtected ? '记录位置受保护' : `记录 ID=${s.recordId}`}</li>)}</ul>
      <p>保留原文与备份；不提供自动来源修复。</p></> : null}
  </div>;
}

function ForeignKeyEvidence({ check, compact = false }: { check: DiagnosticForeignKeyCheck; compact?: boolean }) {
  return <div className="mt-2 space-y-1 text-caption text-muted">
    <p>声明外键检查已完成：枚举 {formatNumber(check.tablesInspected)} 张表 / {formatNumber(check.constraintCount)} 个约束；{formatNumber(check.violationCount)} 处失效引用。</p>
    <p>仅检查 SQLite 已声明外键，不涵盖未声明的业务关系或全部来源字段；引用数不等于作品数。</p>
    {!check.foreignKeysEnabled ? <p className="text-warning">当前连接未启用外键写入强制约束；本次只读检查不修改开关，也不保证后续写入安全。</p> : null}
    {!compact ? <>
      <ul className="space-y-0.5">{check.groups.map((g,index)=><li key={index}>{g.schemaProtected ? '未登记约束名称受保护' : `${g.table}.${g.columns.join(',')} → ${g.parent}.${g.parentColumns.map(c=>c ?? '未显式指定主键列').join(',')}`}：{formatNumber(g.violationCount)} 处失效引用</li>)}</ul>
      {check.groupsTruncated ? <p>仅展示 {check.groups.length} / {check.groupCount} 个违规约束分组，判定总数未截断。</p> : null}
      <p>定位样本 {check.samples.length} / {formatNumber(check.violationCount)}{check.samplesTruncated ? '（有界样本，非全量明细）' : ''}：</p>
      <ul className="space-y-0.5">{check.samples.map((s,index)=><li key={index}>{s.schemaProtected ? '受保护约束' : `${s.table} · FK #${s.foreignKeyId}`} · {s.identityProtected ? '记录位置受保护' : s.rowid === null ? '无 rowid；需按实际主键定位，不能猜测' : `rowid=${s.rowid}`}</li>)}</ul>
      {check.samples.some(s=>s.identityProtected) ? <p>受保护的记录位置不在此展示，不应据此删除或补建记录。</p> : null}
    </> : null}
  </div>;
}

function ImpactChips({ issue }: { issue: DiagnosticIssue }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {issue.impact.map((impact) => {
        // These were links to the public Series list, not to an evidence item or hidden identity.
        const seriesListImpact = issue.id === 'relations.uncollected-members' &&
          (impact.label === 'Series 成员（仅名称）' || impact.label === 'Series 搜索（可用关系行名称命中）');
        const href = impact.href ?? (seriesListImpact ? '/series' : undefined);
        return href ? (
          <Link
            key={`${impact.kind}-${impact.label}`}
            to={href}
            className="inline-flex items-center gap-1 rounded-chip border border-border px-1.5 py-0.5 text-caption text-muted transition-colors hover:border-border-strong hover:text-text"
          >
            <Link2 size={10} />
            {impact.label}
          </Link>
        ) : (
          <span
            key={`${impact.kind}-${impact.label}`}
            className="inline-flex items-center gap-1 rounded-chip border border-border px-1.5 py-0.5 text-caption text-subtle"
          >
            {impact.label}
          </span>
        );
      })}
    </div>
  );
}

function IssueCard({
  issue,
  onRepair,
  repairDisabled,
  projected,
}: {
  issue: DiagnosticIssue;
  onRepair: (issue: DiagnosticIssue, action: RepairAction) => void;
  repairDisabled?: boolean;
  projected?: boolean;
}) {
  const evidence = issue.evidence.flatMap((row) => {
    if (isVisibleText(row.value)) return [{ ...row, label: isVisibleText(row.label) ? row.label : '证据' }];
    // This original evidence row is the same public affected count, not a sample of identities.
    return projected && issue.id === 'relations.uncollected-members' && row.label === '未收藏的 Series 成员'
      ? [{ label: row.label, value: `${issue.affectedCount} 个` }] : [];
  });
  const title = projected && issue.id === 'relations.uncollected-members'
    ? `${issue.affectedCount} 个 Series 成员没有本地详情` : issue.title;
  const explanation = issue.explanation.replace('；具体原因、展示数量与未展示数量见完整审计证据，安全摘要不代表完整证据。', '。');
  const affected = issue.affected.filter((entry) =>
    entry.href || entry.detail !== WITHHELD_EVIDENCE || entry.label !== '受保护或无法证明公开的关联对象');
  const actions = issue.actions.filter((action) => action.kind !== 'link' || (action.href !== '/diagnostics' || action.hint !== WITHHELD_EVIDENCE));
  const waitingFor = issue.waitingFor && isVisibleText(issue.waitingFor) ? issue.waitingFor : null;
  const waitingDetail = issue.waiting?.detail && isVisibleText(issue.waiting.detail) ? issue.waiting.detail : null;
  return (
    <div className="card-surface px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={SEVERITY_TONE[issue.severity]}>{DIAGNOSTIC_SEVERITY_LABEL[issue.severity]}</Badge>
            <span className="text-caption text-subtle">{issue.category}</span>
            {issue.affectedCount > 1 ? (
              <span className="text-caption text-subtle">· 影响 {formatNumber(issue.affectedCount)} 项</span>
            ) : null}
          </div>
          <p className="mt-1.5 text-body font-medium">{title}</p>
          {isVisibleText(explanation) ? <p className="mt-1 max-w-[76ch] text-note text-muted">{explanation}</p> : null}
        </div>
      </div>

      {evidence.length > 0 ? (
        <div className="mt-2.5 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
          <p className="text-caption font-medium text-subtle">证据</p>
          <div className="mt-1 space-y-0.5">
            {evidence.map((row) => (
              <p key={`${row.label}-${row.value}`} className="text-caption text-muted">
                <span className="text-subtle">{row.label}：</span>
                {row.value}
              </p>
            ))}
          </div>
        </div>
      ) : null}

      {affected.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {affected.map((entity) =>
            entity.href ? (
              <Link
                key={`${entity.label}-${entity.href}`}
                to={entity.href}
                className="inline-flex items-center gap-1 rounded-chip bg-surface-2 px-1.5 py-0.5 text-caption text-muted transition-colors hover:text-text"
                title={entity.detail && isVisibleText(entity.detail) ? entity.detail.replace('；历史关联证据需独立确认。', '。') : undefined}
              >
                {entity.label}
                <ArrowUpRight size={10} />
              </Link>
            ) : (
              <span
                key={entity.label}
                className="rounded-chip bg-surface-2 px-1.5 py-0.5 text-caption text-muted"
                title={entity.detail && isVisibleText(entity.detail) ? entity.detail : undefined}
              >
                {entity.label}
              </span>
            ),
          )}
          {issue.affectedCount > affected.length ? (
            <span className="px-1.5 py-0.5 text-caption text-subtle">
              等 {formatNumber(issue.affectedCount)} 项
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2.5">
        <p className="text-caption font-medium text-subtle">影响范围</p>
        <div className="mt-1">
          <ImpactChips issue={issue} />
        </div>
      </div>
      {issue.foreignKeys ? <ForeignKeyEvidence check={issue.foreignKeys} /> : null}
      {issue.sourceSnapshots ? <SourceSnapshotEvidence check={issue.sourceSnapshots} /> : null}

      {waitingFor || waitingDetail || issue.waiting ? (
        <p className="mt-2 flex flex-wrap items-start gap-1.5 text-caption text-muted">
          <CircleHelp size={12} className="mt-0.5 shrink-0 text-subtle" />
          {issue.waiting ? (
            <Badge tone="neutral">{WAITING_KIND_LABEL[issue.waiting.kind] ?? issue.waiting.label}</Badge>
          ) : null}
          <span className="min-w-0">
            {waitingFor}
            {waitingDetail ? <span className="text-subtle">{waitingFor ? `（${waitingDetail}）` : waitingDetail}</span> : null}
          </span>
        </p>
      ) : null}

      {actions.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
          {actions.map((action) =>
            action.kind === 'repair' ? (
              <Button
                key={`repair-${action.repairKind}-${action.target ?? ''}`}
                size="sm"
                icon={<Wrench size={13} />}
                disabled={repairDisabled}
                onClick={() => onRepair(issue, action)}
              >
                {action.label}
              </Button>
            ) : (
              <Link key={`link-${action.href}`} to={action.href} title={action.hint && isVisibleText(action.hint) ? action.hint : undefined}>
                <Button size="sm" variant="secondary" icon={<ArrowUpRight size={13} />}>
                  {action.label}
                </Button>
              </Link>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function VerificationBanner({
  result,
  onDismiss,
}: {
  result: DiagnosticsRepairResult;
  onDismiss: () => void;
}) {
  const ok = result.verification.verified;
  return (
    <Card>
      <CardBody className="space-y-2 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-body font-medium">
            {ok ? (
              <BadgeCheck size={16} className="text-success" />
            ) : (
              <XCircle size={16} className="text-warning" />
            )}
            {ok ? '修复完成并已验证' : '修复部分成功'}
          </p>
          <div className="flex items-center gap-2">
            <Badge tone={ok ? 'success' : 'warning'}>{result.repair.label}</Badge>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              关闭
            </Button>
          </div>
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
                  {CHECK_LAYER_LABEL[check.layer] ?? check.layer}
                </span>
                <span className="text-subtle">{check.label}：</span>
                {check.detail}
              </span>
            </p>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function RepairPreviewDialog({
  selection,
  pending,
  expired,
  onOpenChange,
  onConfirm,
}: {
  selection: { issue: DiagnosticIssue; action: RepairAction } | null;
  pending: boolean;
  expired?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const preview = selection?.action.preview;
  const changeLists = preview ? [
    { label: '直接修改', items: preview.directlyChanges.filter(isVisibleText) },
    { label: '自动派生（系统负责重算）', items: preview.derivedChanges.filter(isVisibleText) },
    { label: '不会修改', items: preview.untouched.filter(isVisibleText) },
  ] : [];
  const chain = preview?.chain.filter((step) => isVisibleText(step.label) || isVisibleText(step.detail)) ?? [];
  return (
    <Dialog
      open={selection !== null}
      onOpenChange={onOpenChange}
      title="修复预览"
      description={selection?.issue.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button
            icon={<Wrench size={13} />}
            loading={pending}
            onClick={onConfirm}
            disabled={pending || expired || preview?.requiresRealEvidence}
          >
            执行修复
          </Button>
        </>
      }
    >
      {preview ? (
        <div className="space-y-3">
          {preview.requiresRealEvidence ? <InlineNote tone="warning">此计划含受保护或无法证明公开的历史引用，不能在数据中枢执行。</InlineNote> : null}
          {isVisibleText(preview.current) ? <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
            <p className="text-caption text-subtle">当前</p>
            <p className="mt-0.5 text-note">{preview.current}</p>
          </div> : null}
          {isVisibleText(preview.next) ? <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
            <p className="text-caption text-subtle">将修改为</p>
            <p className="mt-0.5 text-note">{preview.next}</p>
          </div> : null}
          {isVisibleText(preview.reason) || isVisibleText(preview.source) ? <div className="space-y-2 rounded-[10px] border border-border px-3 py-2">
            {isVisibleText(preview.reason) ? <div>
              <p className="text-caption text-subtle">为什么修改</p>
              <p className="mt-0.5 text-caption text-muted">{preview.reason}</p>
            </div> : null}
            {isVisibleText(preview.source) ? <div>
              <p className="text-caption text-subtle">修改来源</p>
              <p className="mt-0.5 text-caption text-muted">{preview.source}</p>
            </div> : null}
          </div> : null}
          {changeLists.filter(({ items }) => items.length > 0).map(({ label, items }) => (
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
                    {isVisibleText(step.label) ? <span className="text-text">{step.label}</span> : null}
                    {isVisibleText(step.detail) ? <span className="text-subtle">{isVisibleText(step.label) ? '：' : ''}{step.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </div> : null}
          <InlineNote tone="neutral">
            修复完成后会自动重新运行检测，并用真实数据验证问题是否真正消失；如果未通过验证会明确标记为部分成功。
          </InlineNote>
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * 治理历史（v1.6.2）。
 *
 * 只读视图：数据完全来自 entity_events 与 candidate_decisions。
 * 这里没有任何修改治理状态的入口——决定只能在治理流程（Title Review / 家族页 / 修复预览）里做出。
 */
function HistoryCard({ privacyRequired }: { privacyRequired: boolean }) {
  /** 每次「显示更多」追加的条数（初始显示同样用这个值）。 */
  const HISTORY_PAGE_SIZE = 20;
  const [kind, setKind] = useState<'all' | 'series' | 'franchise'>('all');
  const [actor, setActor] = useState<'all' | 'user' | 'system' | 'maintenance'>('all');
  const [limit, setLimit] = useState(HISTORY_PAGE_SIZE);
  const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useDiagnosticsHistory(kind, actor, limit);
  if (data && (data.presentation?.mode === 'real' || (privacyRequired && !data.presentation?.privacyApplied))) {
    return <InlineNote tone="warning">历史响应未通过隐私保护检查，未展示证据。</InlineNote>;
  }
  const projected = data?.presentation?.privacyApplied === true;

  return (
    <Card>
      <CardHeader
        title="治理历史"
        description="只读记录：来自 entity_events 与 candidate_decisions，展示操作时间、操作者、对象与可见证据。"
      />
      <CardBody className="pt-2">
        <div data-testid="governance-history" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="sm"
            value={kind}
            options={[
              { value: 'all', label: '全部' },
              { value: 'series', label: 'Series' },
              { value: 'franchise', label: 'Franchise' },
            ]}
            onChange={(value) => {
              setKind(value as 'all' | 'series' | 'franchise');
              setLimit(HISTORY_PAGE_SIZE);
            }}
          />
          <Segmented
            size="sm"
            value={actor}
            options={[
              { value: 'all', label: '全部来源' },
              { value: 'user', label: '用户决定' },
              { value: 'system', label: '系统自动' },
              { value: 'maintenance', label: '维护' },
            ]}
            onChange={(value) => {
              setActor(value as 'all' | 'user' | 'system' | 'maintenance');
              setLimit(HISTORY_PAGE_SIZE);
            }}
          />
          {data ? (
            <span className="text-caption text-subtle">
              共 {formatNumber(data.total)} 条记录 · 已显示 {formatNumber(data.entries.length)} 条
            </span>
          ) : null}
        </div>

        {isLoading ? <Skeleton className="h-[120px]" /> : null}
        {isFetching && isPlaceholderData ? (
          <InlineNote tone="neutral">
            正在读取当前请求的治理记录；下方暂时保留上一结果以保持阅读位置。
          </InlineNote>
        ) : null}
        {error ? <ErrorState error={evidenceDisplayError(error)} onRetry={() => void refetch()} /> : null}
        {!error && !isLoading && !isPlaceholderData && (data?.entries.length ?? 0) === 0 ? (
          <p className="text-note text-subtle">当前筛选下还没有治理记录。</p>
        ) : null}

        {(data?.entries ?? []).map((entry) => {
          const actor = HISTORY_ACTOR_META[entry.actor] ?? HISTORY_ACTOR_META.system!;
          const snapshot = entry.evidence && isVisibleText(entry.evidence) &&
            !(projected && entry.evidence.startsWith('安全摘要：事件类型、时间、操作者与当前可见对象如上；'))
            ? entry.evidence : null;
          const entityHref =
            entry.entityKind === 'series' && entry.entityKey
              ? `/series/${entry.entityKey}`
              : entry.entityKind === 'franchise' && entry.entityKey
                ? `/franchises/${entry.entityKey}`
                : null;
          return (
            <div key={entry.id} className="rounded-[10px] border border-border bg-surface-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={actor.tone}>{actor.label}</Badge>
                <span className="min-w-0 text-note">{projected ? entry.summary.replace(/；历史证据原文保留$/, '') : entry.summary}</span>
                <span className="ml-auto shrink-0 text-caption text-subtle">
                  {formatDateTime(entry.at)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-subtle">
                {entry.entityKey ? (
                  entityHref ? (
                    <Link to={entityHref} className="text-accent hover:underline">
                      {entry.entityKind === 'series' ? 'Series' : 'Franchise'} {entry.entityKey}
                      {entry.entityTitle ? ` · ${entry.entityTitle}` : ''}
                    </Link>
                  ) : (
                    <span>
                      {entry.entityKind} {entry.entityKey}
                    </span>
                  )
                ) : entry.entityId > 0 ? (
                  <span>
                    {entry.entityKind} #{entry.entityId}
                  </span>
                ) : null}
                {entry.candidate && isVisibleText(entry.candidate.title) ? <span>候选：{entry.candidate.title}</span> : null}
                {entry.stateChange && isVisibleText(entry.stateChange) ? <span>状态：{entry.stateChange}</span> : null}
                {entry.currentState ? <span>当前：{entry.currentState}</span> : null}
              </div>
              {entry.reason && isVisibleText(entry.reason) ? (
                <p className="mt-1 text-caption text-muted">原因：{entry.reason}</p>
              ) : null}
              {snapshot ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-caption text-subtle">证据快照</summary>
                  <pre className="mt-1 max-h-[180px] overflow-auto whitespace-pre-wrap break-all rounded-[8px] bg-surface-3 px-2 py-1.5 text-caption text-muted">
                    {prettyJson(snapshot)}
                  </pre>
                </details>
              ) : null}
            </div>
          );
        })}

        {data && data.total > data.entries.length ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setLimit((current) => current + HISTORY_PAGE_SIZE)}
          >
            显示更多（还有 {formatNumber(data.total - data.entries.length)} 条）
          </Button>
        ) : null}
        <InlineNote tone="neutral">
          历史是事实记录，不能在这里修改治理状态；确认 / 否决 / 重新进入评估仍然只能通过各自的治理入口完成。
        </InlineNote>
        </div>
      </CardBody>
    </Card>
  );
}

export function DataCenterPage() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [issueOffset, setIssueOffset] = useState(0);
  const { data, isLoading, error, refetch } = useDiagnostics(issueOffset);
  const observationExpired = useDiagnosticExpired(data?.freshness);
  const repair = useDiagnosticsRepair();
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<{ issue: DiagnosticIssue; action: RepairAction } | null>(
    null,
  );
  const [lastResult, setLastResult] = useState<DiagnosticsRepairResult | null>(null);

  async function runDetection() {
    setRefreshing(true);
    try {
      const fresh = await api.diagnostics(true);
      setIssueOffset(0);
      if (!mounted.current) return;
      queryClient.setQueryData(queryKeys.diagnostics, fresh);
      setSelection(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics, refetchType: 'none' });
    } catch (refreshError) {
      if (!mounted.current) return;
      toast.push({
        tone: 'error',
        title: '重新检测失败',
        description: refreshError instanceof Error ? refreshError.message : String(refreshError),
      });
    } finally {
      setRefreshing(false);
    }
  }

  async function executeRepair() {
    if (!selection || selection.action.preview.requiresRealEvidence || observationExpired) return;
    const { issue, action } = selection;
    repair.mutate(
      {
        issueId: issue.id,
        kind: action.repairKind,
        ...(action.target ? { target: action.target } : {}),
        ...(action.value ? { value: action.value } : {}),
      },
      {
        onSuccess: (result) => {
          if (!mounted.current) return;
          setIssueOffset(0);
          setSelection(null);
          setLastResult(result);
          toast.push({
            tone: result.ok ? 'success' : 'warning',
            title: result.ok ? '修复完成并已验证' : '修复部分成功',
            description: verificationSummary(result.verification.summary),
          });
        },
        onError: (repairError) => {
          if (!mounted.current) return;
          setSelection(null);
          toast.push({
            tone: 'error',
            title: '修复未执行',
            description: repairError instanceof Error ? repairError.message : String(repairError),
          });
        },
      },
    );
  }

  if (error) return <ErrorState error={evidenceDisplayError(error)} onRetry={() => void refetch()} />;
  if (data && (data.presentation?.mode === 'real' || (data.hideNsfw && !data.presentation?.privacyApplied))) {
    return <InlineNote tone="warning">诊断响应缺少安全隐私投影证明，未展示明细。不能将其解释为没有问题。</InlineNote>;
  }
  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-3 sm:grid-cols-safe-3 lg:grid-cols-safe-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-[84px]" />
          ))}
        </div>
        <Skeleton className="h-[260px]" />
      </div>
    );
  }

  const actionable = data.summary.total > 0;
  const totalChecked = data.modules.reduce((sum, module) => sum + module.checked, 0);
  const grouped = SEVERITY_ORDER.map((severity) => ({
    severity,
    issues: data.issues.filter((issue) => issue.severity === severity),
  })).filter((group) => group.issues.length > 0);

  return (
    <div className="space-y-4">
      <SectionTitle
        title="数据中枢"
        description="检查 Analyzer 自身的数据链路：发现问题、解释原因、修复并验证结果。"
        actions={
          <>
            <Badge tone="neutral">最后检查 {formatRelative(data.generatedAt)}</Badge>
            <Button
              size="sm"
              icon={<RefreshCw size={13} />}
              loading={refreshing}
              onClick={() => void runDetection()}
            >
              重新检测
            </Button>
          </>
        }
      />

      {lastResult ? (
        <VerificationBanner result={lastResult} onDismiss={() => setLastResult(null)} />
      ) : null}

      <InlineNote tone={data.coverage?.status === 'complete' ? 'neutral' : 'warning'}>
        {data.coverage?.note ?? '此服务未提供检测完整性声明；当前结果仅代表已返回的检查，不得据此认定全量通过。'}
      </InlineNote>

      <InlineNote tone={observationExpired || !data.freshness ? 'warning' : 'neutral'}>
        {observationExpired ? '观察结果已过期，待重新检测；下列为历史结果，不能认定当前健康。修复前请重新检测并预览。'
          : data.freshness ? '这是生成时的本地观察，不是持续实时健康保证。' : '服务未提供观察有效性信息，不能据此证明当前健康。'}
        {data.freshness?.boundary}
      </InlineNote>

      <div className="grid gap-3 sm:grid-cols-safe-3 lg:grid-cols-safe-5">
        <StatCard
          label="检测模块"
          value={formatNumber(data.modules.length)}
          hint={`模块检查计数 ${formatNumber(totalChecked)}（跨模块可能重复）`}
          icon={<ShieldCheck size={14} />}
        />
        <StatCard
          label="确定错误"
          value={formatNumber(data.summary.error)}
          hint="有真实数据依据、必须处理"
          tone={data.summary.error > 0 ? 'danger' : 'default'}
          icon={<AlertTriangle size={14} />}
        />
        <StatCard
          label="待处理"
          value={formatNumber(data.summary['needs-review'] + data.summary.suspicious)}
          hint="待确认 / 高度可疑"
          tone={data.summary['needs-review'] + data.summary.suspicious > 0 ? 'warning' : 'default'}
          icon={<Wrench size={14} />}
        />
        <StatCard
          label="外部依赖 / 不确定"
          value={formatNumber(data.summary.external + data.summary.uncertain)}
          hint="等待同步或更强证据"
          icon={<CircleHelp size={14} />}
        />
        <StatCard
          label="数据规模"
          value={formatNumber(data.scope.collections)}
          hint={`${data.scope.subjects} Subjects · ${data.scope.series} Series · ${data.scope.franchises} Franchise`}
          icon={<Database size={14} />}
        />
      </div>

      <Card>
        <CardHeader
          title="检测模块"
          description={`数据版本 ${data.dataVersion} · 检查耗时 ${data.durationMs} ms · 生成于 ${formatDateTime(data.generatedAt)}`}
        />
        <CardBody className="pt-2">
          <div className="grid gap-2.5 md:grid-cols-safe-2 xl:grid-cols-safe-3">
            {data.modules.map((module) => (
              <ModuleCard key={module.id} module={module} report={data} />
            ))}
          </div>
        </CardBody>
      </Card>

      {actionable ? (
        grouped.map((group) => (
          <div key={group.severity} className="space-y-2.5">
            <div className="flex items-center gap-2">
              <h3 className="text-section">{DIAGNOSTIC_SEVERITY_LABEL[group.severity]}</h3>
              <Badge tone={SEVERITY_TONE[group.severity]}>{group.issues.length}</Badge>
            </div>
            {group.issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                projected={data.presentation?.privacyApplied}
                repairDisabled={observationExpired}
                onRepair={(currentIssue, action) => { if (!observationExpired) setSelection({ issue: currentIssue, action }); }}
              />
            ))}
          </div>
        ))
      ) : (
        <EmptyState
          icon={<ShieldCheck size={20} />}
          title={observationExpired ? '历史检查未报告问题，当前待重新观察' : '当前没有检测到需要处理的数据问题'}
          description={`已检查 ${data.modules.length} 个模块、${formatNumber(totalChecked)} 条记录（${data.scope.subjects} Subjects · ${data.scope.relations} Relations · ${data.scope.series} Series · ${data.scope.franchises} Franchise）。暂定标题与等待同步的字段属于正常状态，不会被当作错误。`}
        />
      )}

      {data.issuePage ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-subtle">
            问题总数 {formatNumber(data.issuePage.total)} · 当前页 {data.issues.length ? data.issuePage.offset + 1 : 0}–{data.issuePage.offset + data.issues.length}
          </span>
          <Button size="sm" variant="secondary" disabled={data.issuePage.offset === 0}
            onClick={() => setIssueOffset(Math.max(0, data.issuePage!.offset - data.issuePage!.limit))}>上一页问题</Button>
          <Button size="sm" variant="secondary" disabled={!data.issuePage.hasMore}
            onClick={() => setIssueOffset(data.issuePage!.offset + data.issuePage!.limit)}>下一页问题</Button>
        </div>
      ) : null}

      {actionable && data.issues.length === 0 ? (
        <InlineNote tone="warning">
          当前问题页没有返回项目，但汇总仍有 {data.summary.total} 个问题；不能解释为没有异常。
          <Button size="sm" variant="secondary" onClick={() => setIssueOffset(0)}>返回问题首页</Button>
        </InlineNote>
      ) : null}

      <InlineNote tone="neutral">
        <span className="flex flex-wrap items-center gap-1.5">
          <Home size={12} className="text-subtle" />
          <Sparkles size={12} className="text-subtle" />
          <Layers size={12} className="text-subtle" />
          数据中枢只修复系统允许人工决定的 source-of-truth 与由它派生的投影；搜索索引、缓存与统计这类派生层由系统自动重算，不需要手动维护。
        </span>
      </InlineNote>

      {/*
       * freshness 边界（v1.6.2）：核心写入（同步 / 导入 / 治理 / 修复）会推进数据版本并
       * 自动使本报告失效；翻译内容与封面缓存属于缓存层写入，不推进数据版本，可能短暂滞后。
       */}
      <InlineNote tone="info">
        本报告基于数据版本 {data.dataVersion} 生成（{formatRelative(data.generatedAt)}）。同步 / 导入 /
        治理 / 修复会自动使报告失效；翻译内容与封面缓存属于缓存层写入，不会推进数据版本——如果刚完成翻译或
        封面下载，可点「重新检测」刷新。检测始终读取真实数据库，不会把暂时状态当成新的数据错误。
      </InlineNote>

      <HistoryCard privacyRequired={data.hideNsfw} />

      <RepairPreviewDialog
        selection={selection}
        pending={repair.isPending}
        expired={observationExpired}
        onOpenChange={(open) => {
          if (!open && !repair.isPending) setSelection(null);
        }}
        onConfirm={() => void executeRepair()}
      />
    </div>
  );
}
