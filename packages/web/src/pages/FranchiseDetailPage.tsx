import { ManualFranchiseControls } from '../components/series/ManualFranchiseControls.js';
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  RotateCcw,
  UserMinus,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { FranchiseDetail } from '@bangumi-analyzer/shared';
import {
  AirTimelineSection,
  ConsumptionEvidenceSection,
  PersonalOverviewSection,
  RatingProfileSection,
  type RatingSampleItem,
} from '../components/entity/EntityAnalysisPanel.js';
import { VisibilityContextBar } from '../components/entity/VisibilityContextBar.js';
import {
  FranchiseGovernanceDialog,
  type FranchiseGovernanceTarget,
} from '../components/series/FranchiseGovernance.js';
import { SubjectRow } from '../components/subject/cards.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardBody, CardHeader } from '../components/ui/card.js';
import { ErrorState, HiddenState, InlineNote, Skeleton } from '../components/ui/feedback.js';
import { Dialog } from '../components/ui/overlay.js';
import { ApiRequestError } from '../lib/api.js';
import { evidenceDisplayError, isVisibleText, visibleEvidenceText } from '../lib/evidenceDisplay.js';
import { formatDateTime } from '../lib/format.js';
import { useMemberAnchor } from '../lib/useMemberAnchor.js';
import {
  FRANCHISE_STATE_LABEL,
  FRANCHISE_STATE_TONE,
  TITLE_STATE_LABEL,
  TITLE_STATE_TONE,
} from '../lib/entities.js';
import {
  useConfirmFranchise,
  useFranchiseDetail,
  useRejectFranchise,
  useReopenFranchise,
} from '../lib/queries.js';

const LINK_STATE_LABEL: Record<string, string> = {
  candidate: '候选',
  provisional: '暂定',
  confirmed: '已确认',
  conflict: '冲突',
};

const LINK_STATE_TONE: Record<string, 'neutral' | 'warning' | 'success' | 'danger'> = {
  candidate: 'neutral',
  provisional: 'warning',
  confirmed: 'success',
  conflict: 'danger',
};

export function FranchiseDetailPage() {
  const {key} = useParams();
  return <FranchiseDetailContent key={key} />;
}
function FranchiseDetailContent() {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const key = params.key ? decodeURIComponent(params.key) : '';
  // v1.8 整页口径：默认跟随 hideNsfw，用户显式切换只影响本次访问（不记忆）
  const [visibility, setVisibility] = useState<'visible' | 'real' | undefined>(undefined);
  const { data, isLoading, isFetching, error, refetch } = useFranchiseDetail(key, visibility);
  const confirm = useConfirmFranchise();
  const reject = useRejectFranchise();
  const reopen = useReopenFranchise();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [governance, setGovernance] = useState<FranchiseGovernanceTarget | null>(null);
  const [actionFailure, setActionFailure] = useState<{ key: string; label: string; error: unknown; uncertain: boolean } | null>(null);
  const actionInFlight = useRef(false);
  const currentKey = useRef(key);
  currentKey.current = key;
  const actionPending = confirm.isPending || reject.isPending || reopen.isPending;

  useEffect(() => { setActionFailure(null); setRejectOpen(false); }, [key]);

  const runDirectAction = async (action: 'confirm' | 'reject' | 'reopen') => {
    if (!data || actionInFlight.current || actionPending || isFetching || actionFailure?.uncertain) return;
    const routeKey = key;
    actionInFlight.current = true;
    setActionFailure(null);
    try {
      if (action === 'confirm') await confirm.mutateAsync(data.key);
      else if (action === 'reopen') await reopen.mutateAsync({ key: data.key });
      else await reject.mutateAsync({ key: data.key });
      if (currentKey.current === routeKey) setRejectOpen(false);
    } catch (error) {
      if (currentKey.current === routeKey) setActionFailure({
        key: data.key,
        label: action === 'confirm' ? '确认' : action === 'reopen' ? '重新评估' : '否决',
        error,
        uncertain: error instanceof ApiRequestError && (error.resultUnknown || error.code === 'network_error'),
      });
    } finally { actionInFlight.current = false; }
  };
  // v1.8.1：评分样本 → 成员锚点定位（同一套整页滚动 / 高亮逻辑）
  const { onMemberLinkClick } = useMemberAnchor({ ready: Boolean(data) });

  useEffect(() => {
    if (data?.aliasedFrom && data.canonicalKey && data.canonicalKey !== key) {
      navigate({ pathname: `/franchises/${encodeURIComponent(data.canonicalKey)}`, search: location.search, hash: location.hash }, { replace: true });
    }
  }, [data?.aliasedFrom, data?.canonicalKey, key, navigate, location.search, location.hash]);

  if (isLoading) return <Skeleton className="h-[420px]" />;
  if (error || !data) {
    const displayError = evidenceDisplayError(error);
    // v1.5.3：家族内所有系列都隐藏时，家族整体进入隐藏状态
    if (displayError instanceof ApiRequestError && displayError.code === 'franchise_hidden') {
      return (
        <div className="space-y-4">
          <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>
            返回
          </Button>
          <HiddenState hint={displayError.hint} />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>
          返回
        </Button>
        <ErrorState error={displayError ?? new Error('未找到该家族')} onRetry={() => void refetch()} />
      </div>
    );
  }
  if (data.presentation?.mode === 'real') {
    return <InlineNote tone="warning">家族响应不符合当前隐私展示要求，未展示详情。</InlineNote>;
  }

  const detail: FranchiseDetail = data;
  const analysis = detail.analysis;
  const ratingSamples: RatingSampleItem[] = detail.series
    .flatMap((series) => series.entries)
    .filter((item) => item.rate > 0)
    .map((item) => ({
      id: item.id,
      title: item.nameCn || item.name,
      myRate: item.rate,
      bgmScore: item.bgmScore,
      delta: item.delta,
    }))
    .sort((a, b) => b.myRate - a.myRate);
  const canConfirm = detail.state !== 'confirmed';
  const canReject = ['candidate', 'provisional', 'contested'].includes(detail.state);
  const canReopen = detail.state === 'rejected';
  const failure = actionFailure?.key === detail.key ? actionFailure : null;
  const actionDisabled = actionPending || isFetching || Boolean(failure?.uncertain);

  return (
    <div className="space-y-4">
      {data.protectedTitleCandidateCount ? <InlineNote tone="neutral">另有 {data.protectedTitleCandidateCount} 条历史候选受隐私保护，未展示；不代表无效或删除。</InlineNote> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>
          返回
        </Button>
        <div className="flex items-center gap-2">
          <Link to="/franchises">
            <Button size="sm" variant="ghost">
              全部家族
            </Button>
          </Link>
          {canReopen ? (
            <Button
              size="sm"
              icon={<RotateCcw size={13} />}
              disabled={actionDisabled}
              onClick={() => void runDirectAction('reopen')}
            >
              {reopen.isPending ? '处理中…' : '重新进入评估'}
            </Button>
          ) : null}
          {canReject ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<XCircle size={13} />}
              disabled={actionDisabled}
              onClick={() => { setActionFailure(null); setRejectOpen(true); }}
            >
              否决该家族
            </Button>
          ) : null}
          {canConfirm ? (
            <Button
              size="sm"
              icon={<CheckCircle2 size={13} />}
              disabled={actionDisabled}
              onClick={() => void runDirectAction('confirm')}
            >
              {confirm.isPending ? '确认中…' : '确认该家族'}
            </Button>
          ) : (
            <Badge tone="success">已确认 · 自动重算不会覆盖</Badge>
          )}
        </div>
      </div>

      {failure ? (
        <InlineNote tone="warning">
          <div role="alert" className="space-y-2">
            <p>{failure.uncertain ? `${failure.label}结果尚未确认：连接中断，操作可能已经提交。请先读取当前状态并核对治理历史。` : `${failure.label}未成功：${failure.error instanceof Error ? failure.error.message : '请求失败'}。可以重试原操作。`}</p>
            {failure.uncertain ? <Button size="sm" loading={isFetching} onClick={() => void refetch().then((result) => {
              if (!result.isError && currentKey.current === key) setActionFailure(null);
            })}>读取当前状态</Button> : null}
          </div>
        </InlineNote>
      ) : null}

      <ManualFranchiseControls family={detail.key} />
      <VisibilityContextBar
        hidden={analysis.hidden}
        visibility={analysis.visibility}
        onToggle={(next) => setVisibility(next)}
      />

      <div className="card-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-title">{detail.title}</h1>
              <Badge tone={FRANCHISE_STATE_TONE[detail.state]}>
                {FRANCHISE_STATE_LABEL[detail.state]}
              </Badge>
              <Badge tone={TITLE_STATE_TONE[detail.titleState]}>
                名称{TITLE_STATE_LABEL[detail.titleState]}
              </Badge>
            </div>
            <p className="mt-1 text-note text-muted">
              {/* 整页单口径：结构规模也跟随当前 analysis 口径（部分隐藏时 != Real 计数） */}
              {detail.series.length} 个系列 · 已知 {analysis.coverage.knownMembers} 个成员 · 我的收藏{' '}
              {analysis.coverage.localCollected} 部
            </p>
            <p className="mt-0.5 text-caption text-subtle">
              名称来源 {detail.titleSource}
              {detail.candidateSeriesCount > 0
                ? ` · 候选系列 ${detail.candidateSeriesCount}`
                : ''}
              {detail.conflictSeriesCount > 0
                ? ` · 冲突系列 ${detail.conflictSeriesCount}`
                : ''}
            </p>
          </div>
        </div>

        {detail.titleCandidates.length > 0 ? (
          <InlineNote tone="warning" className="mt-4">
            名称候选：
            {detail.titleCandidates
              .map((candidate) => `「${candidate.title}」${visibleEvidenceText(candidate.evidence) ? `（${candidate.evidence}）` : ''}`)
              .join('；')}
          </InlineNote>
        ) : null}

        {detail.state === 'candidate' ? (
          <InlineNote tone="warning" className="mt-4">
            这是由证据提出的候选家族，尚未确认。候选成员不计入「已确认」统计；
            确认后新的同步只会提出新增候选或冲突，不会静默改写。
          </InlineNote>
        ) : null}

        {/* 名称治理（v1.7.0）：名称与成员构成分开维护，各自 Preview → Execute → Verify */}
        <div
          data-testid="franchise-name-governance"
          className="mt-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            {detail.titleState === 'manual' ? (
              <>
                <Badge tone="accent">人工确认名称</Badge>
                <span className="text-caption text-subtle">
                  自动解析不会覆盖这个名称；新证据只会记录为候选。
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw size={13} />}
                  onClick={() => setGovernance({ kind: 'reset-franchise-title' })}
                >
                  恢复自动解析
                </Button>
              </>
            ) : (
              <>
                <span className="text-caption text-subtle">
                  {detail.titleState === 'unresolved'
                    ? '当前名称只是 fallback，不适合长期展示？'
                    : '名称有误？'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setGovernance({
                      kind: 'adopt-franchise-title',
                      initialTitle: detail.title,
                    })
                  }
                >
                  设置名称
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <PersonalOverviewSection analysis={analysis} scope="franchise" />
      <RatingProfileSection
        analysis={analysis}
        samples={ratingSamples}
        onMemberClick={onMemberLinkClick}
      />
      <AirTimelineSection analysis={analysis} />
      <ConsumptionEvidenceSection analysis={analysis} />

      {analysis.visibility === 'visible' && analysis.hidden.members > 0 ? (
        <InlineNote tone="neutral">
          家族内另有 {analysis.hidden.series} 个系列按当前可见性策略隐藏（hidden，共{' '}
          {analysis.hidden.members} 个成员），不参与当前口径的统计；可在页面顶部切换完整数据。
        </InlineNote>
      ) : null}

      {detail.series.map((series) => {
        const evidence = series.evidence.filter(isVisibleText);
        return (
        <Card key={series.key}>
          <CardHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                <Link
                  to={`/series/${encodeURIComponent(series.key)}`}
                  className="text-accent hover:underline"
                >
                  {series.title}
                </Link>
                <Badge tone={LINK_STATE_TONE[series.linkState] ?? 'neutral'}>
                  {LINK_STATE_LABEL[series.linkState] ?? series.linkState}
                </Badge>
              </span>
            }
            description={`系列内已知 ${series.memberCount} 部 · 我的收藏 ${series.collectedCount} 部${evidence.length > 0 ? ` · 证据：${evidence.join('；')}` : ''}`}
            actions={
              <Button
                size="sm"
                variant="ghost"
                icon={<UserMinus size={13} />}
                title="否决该系列属于这个家族的 membership 推断：不会拆分家族，也不会删除任何数据"
                onClick={() =>
                  setGovernance({
                    kind: 'exclude-franchise-member',
                    seriesKey: series.key,
                    seriesTitle: series.title,
                  })
                }
              >
                移出该家族
              </Button>
            }
          />
          <CardBody className="pt-2">
            {series.entries.length === 0 ? (
              <p className="text-note text-subtle">该系列当前没有收藏条目。</p>
            ) : (
              series.entries.map((item) => (
                <div key={item.id} id={`member-${item.id}`}>
                  <SubjectRow item={item} />
                </div>
              ))
            )}
          </CardBody>
        </Card>
        );
      })}

      {detail.exclusions.length > 0 ? (
        <Card>
          <CardHeader
            title="成员排除记录"
            description="人工移出的成员：排除是真实治理状态（重建不会静默加回），撤销后按当前证据重新评估。"
          />
          <CardBody className="space-y-2 pt-2">
            {detail.exclusions.map((exclusion) => (
              <div
                key={`${exclusion.seriesKey}-${exclusion.createdAt}`}
                data-testid="franchise-exclusion-row"
                className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-note">
                    {exclusion.identityProtected ? <span>{exclusion.seriesTitle}</span> : <Link
                      to={`/series/${encodeURIComponent(exclusion.seriesKey)}`}
                      className="text-accent hover:underline"
                    >
                      {exclusion.seriesTitle}
                    </Link>}
                    <Badge tone={exclusion.state === 'active' ? 'warning' : 'neutral'}>
                      {exclusion.state === 'active' ? '已移出' : '已撤销'}
                    </Badge>
                  </p>
                  <p className="text-caption text-subtle">
                    {exclusion.state === 'active' ? '移出于' : '撤销于'}{' '}
                    {formatDateTime(exclusion.revokedAt ?? exclusion.createdAt)}
                    {visibleEvidenceText(exclusion.reason) ? ` · 原因：${exclusion.reason}` : ''}
                    {exclusion.state === 'revoked' && visibleEvidenceText(exclusion.revokedReason)
                      ? ` · 撤销说明：${exclusion.revokedReason}`
                      : ''}
                  </p>
                </div>
                {exclusion.state === 'active' ? (
                  <Button
                    disabled={exclusion.identityProtected}
                    size="sm"
                    variant="ghost"
                    icon={<RotateCcw size={13} />}
                    onClick={() =>
                      setGovernance({
                        kind: 'reopen-franchise-member',
                        seriesKey: exclusion.seriesKey,
                        seriesTitle: exclusion.seriesTitle,
                      })
                    }
                  >
                    撤销排除（重新评估）
                  </Button>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {detail.identityConflicts.length > 0 ? (
        <div data-testid="franchise-identity-conflicts">
        <Card>
          <CardHeader
            title="身份冲突"
            description="成员链接指向已被身份恢复取代的历史 Series。已确认家族的成员身份不会被系统自动改写：只有存在可验证的 lifecycle 谱系时，才允许人工执行一次「迁移已被取代的家族成员」。"
          />
          <CardBody className="space-y-2 pt-2">
            {detail.identityConflicts.map((conflict) => (
              <div
                key={conflict.fromSeriesKey}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-note">
                    <span className="text-subtle">{conflict.evidenceProtected ? conflict.fromSeriesTitle : conflict.fromSeriesKey}</span>
                    {conflict.toSeriesKey ? (
                      <>
                        <span className="text-subtle">→</span>
                        <span>{conflict.toSeriesKey}</span>
                        <Badge tone="warning">已被取代</Badge>
                      </>
                    ) : (
                      <Badge tone="neutral">{conflict.evidenceProtected ? '谱系证据受保护' : '缺少谱系'}</Badge>
                    )}
                  </p>
                  <p className="text-caption text-subtle">
                    {conflict.evidenceProtected ? '历史引用受隐私保护，未展示；不代表谱系缺失。' : conflict.reason === 'superseded' && conflict.evidence
                      ? `生命周期证据：alias ${conflict.evidence.aliasReason} · merged #${conflict.evidence.mergedEventId} · 成员一致性 ${
                          conflict.evidence.exact ? '完全一致' : '高度一致'
                        }（${conflict.evidence.members.length} 个成员）`
                      : '缺少可验证的 rebuilt-into / merged 谱系，需要人工核查后才能决定如何处理。'}
                  </p>
                </div>
                {conflict.reason === 'superseded' && conflict.toSeriesKey ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setGovernance({
                        kind: 'supersede-franchise-member',
                        seriesKey: conflict.fromSeriesKey,
                        seriesTitle: conflict.fromSeriesTitle,
                      })
                    }
                  >
                    迁移已被取代的成员
                  </Button>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
        </div>
      ) : null}

      <InlineNote tone="neutral">
        家族的成员是「系列」而不是单个作品；同一作品只会通过它所属的系列进入家族，
        不会出现两套互相冲突的归属。
      </InlineNote>

      <p className="text-caption text-subtle">
        提示：证据不足时系统会显示候选/未确认，而不是给出一个看起来确定的名字。
        <a
          className="ml-1 inline-flex items-center gap-1 text-accent hover:underline"
          href="https://bgm.tv/"
          target="_blank"
          rel="noreferrer noopener"
        >
          在 Bangumi 核对 <ExternalLink size={11} />
        </a>
      </p>

      <Dialog
        open={rejectOpen}
        onOpenChange={(open) => { if (!actionInFlight.current && !actionPending) setRejectOpen(open); }}
        title="否决这个家族候选"
        description={`「${detail.title}」· ${detail.seriesCount} 个系列`}
        footer={
          <>
            <Button variant="ghost" onClick={() => { if (!actionInFlight.current && !actionPending) setRejectOpen(false); }} disabled={reject.isPending}>
              取消
            </Button>
            <Button
              icon={<XCircle size={13} />}
              loading={reject.isPending}
              disabled={actionDisabled}
              onClick={() => void runDirectAction('reject')}
            >
              确认否决
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-note text-muted">
          {failure ? <p role="alert" className="text-warning">{failure.uncertain ? '否决结果尚未确认；请关闭弹窗后读取当前状态并核对历史。' : `否决未成功：${failure.error instanceof Error ? failure.error.message : '请求失败'}。可以重试。`}</p> : null}
          <p>
            Analyzer 可以推断，但不拥有最终裁决权。否决会写入真实的治理状态
            （candidate → rejected），数据中枢不会再把它列为待确认候选。
          </p>
          <p className="text-caption text-subtle">
            不会修改：Franchise / Series / Subject 数据本身、原始关系证据、Series identity。
            否决之后仍然可以在这里点「重新进入评估」把它放回候选状态。
          </p>
        </div>
      </Dialog>

      <FranchiseGovernanceDialog
        franchiseKey={detail.key}
        target={governance}
        onClose={() => setGovernance(null)}
      />
    </div>
  );
}
