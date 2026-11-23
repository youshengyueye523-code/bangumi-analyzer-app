import { ManualFranchiseControls } from '../components/series/ManualFranchiseControls.js';
import { ArrowLeft, ExternalLink, Layers } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AirTimelineSection,
  ConsumptionEvidenceSection,
  PersonalOverviewSection,
  RatingProfileSection,
  type RatingSampleItem,
} from '../components/entity/EntityAnalysisPanel.js';
import { VisibilityContextBar } from '../components/entity/VisibilityContextBar.js';
import { SubjectRow } from '../components/subject/cards.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardBody, CardHeader } from '../components/ui/card.js';
import { ErrorState, HiddenState, InlineNote, Skeleton } from '../components/ui/feedback.js';
import { Input } from '../components/ui/form.js';
import { ApiRequestError } from '../lib/api.js';
import { evidenceDisplayError, isVisibleText, visibleEvidenceText } from '../lib/evidenceDisplay.js';
import { formatDateTime, formatNumber } from '../lib/format.js';
import { useMemberAnchor } from '../lib/useMemberAnchor.js';
import {
  COVERAGE_LABEL,
  MEMBERSHIP_STATE_LABEL,
  SERIES_STATE_LABEL,
  TITLE_STATE_LABEL,
  TITLE_STATE_TONE,
} from '../lib/entities.js';
import {
  useReopenSeriesTitleCandidate,
  useRejectSeriesTitleCandidate,
  useResetSeriesTitle,
  useSeriesDetail,
  useSetSeriesTitle,
} from '../lib/queries.js';

const TITLE_SOURCE_LABEL: Record<string, string> = {
  'brand:members': '成员品牌',
  'brand:tag': '品牌标签',
  anchor: '起点作品',
  manual: '人工确认',
};

export function SeriesDetailPage() {
  const {key} = useParams();
  return <SeriesDetailContent key={key} />;
}
function SeriesDetailContent() {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const key = params.key ? decodeURIComponent(params.key) : '';
  // v1.8 整页口径：默认跟随 hideNsfw，用户显式切换只影响本次访问（不记忆）
  const [visibility, setVisibility] = useState<'visible' | 'real' | undefined>(undefined);
  const { data, isLoading, error, refetch } = useSeriesDetail(key, visibility);
  const [showAllUncollected, setShowAllUncollected] = useState(false);
  // 数据中枢等入口可以通过 ?review=1 直接展开 Title Review 候选列表
  const [reviewOpen, setReviewOpen] = useState(() => searchParams.get('review') === '1');
  const [customOpen, setCustomOpen] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  /*
   * v1.8.1：成员锚点定位（评分样本点击 / 直接 hash 打开 / hashchange）。
   * 长 Series 只渲染前 30 个未收藏成员；目标未渲染时按 hash 需求自动展开。
   */
  const { onMemberLinkClick } = useMemberAnchor({
    ready: Boolean(data),
    onMissing: (subjectId) => {
      const member = data?.members.find(
        (entry) => entry.role === 'primary' && entry.subjectId === subjectId,
      );
      if (member && !member.collected) {
        setShowAllUncollected(true);
        return true;
      }
      return false;
    },
  });
  const setTitle = useSetSeriesTitle();
  const resetTitle = useResetSeriesTitle();
  const rejectCandidate = useRejectSeriesTitleCandidate();
  const reopenCandidate = useReopenSeriesTitleCandidate();

  // 旧 key 通过 alias 解析后，把地址栏替换成 canonical key。
  useEffect(() => {
    if (data?.aliasedFrom && data.canonicalKey && data.canonicalKey !== key) {
      navigate({ pathname: `/series/${encodeURIComponent(data.canonicalKey)}`, search: location.search, hash: location.hash }, { replace: true });
    }
  }, [data?.aliasedFrom, data?.canonicalKey, key, navigate, location.search, location.hash]);

  if (isLoading) return <Skeleton className="h-[420px]" />;
  if (error || !data) {
    const displayError = evidenceDisplayError(error);
    // v1.5.3：系列含 NSFW 成员时整体隐藏，不展示系列名与成员
    if (displayError instanceof ApiRequestError && displayError.code === 'series_hidden') {
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
        <ErrorState error={displayError ?? new Error('未找到该系列')} onRetry={() => void refetch()} />
      </div>
    );
  }
  if (data.presentation?.mode === 'real') {
    return <InlineNote tone="warning">系列响应不符合当前隐私展示要求，未展示详情。</InlineNote>;
  }

  const primaryMembers = data.members.filter((member) => member.role === 'primary');
  const candidateMembers = data.members.filter((member) => member.role === 'candidate');
  const collectedMembers = primaryMembers.filter((member) => member.collected);
  const uncollectedMembers = primaryMembers.filter((member) => !member.collected);
  const activeTitleCandidates = data.titleCandidates.filter((candidate) => candidate.valid !== false);
  const rejectedTitleCandidates = data.titleCandidates.filter((candidate) => candidate.valid === false);
  const conflictingAutoProposals =
    data.titleState === 'manual'
      ? activeTitleCandidates.filter(
          (candidate) =>
            candidate.source !== 'manual' &&
            candidate.title.trim().toLowerCase() !== data.title.trim().toLowerCase(),
        )
      : [];
  const seriesKey = data.key;
  const analysis = data.analysis;
  const ratingSamples: RatingSampleItem[] = collectedMembers
    .filter((member) => member.item && member.item.rate > 0)
    .map((member) => ({
      id: member.subjectId,
      title: member.title || member.item?.nameCn || member.item?.name || `条目 ${member.subjectId}`,
      myRate: member.item!.rate,
      bgmScore: member.item!.bgmScore,
      delta: member.item!.delta,
    }))
    .sort((a, b) => b.myRate - a.myRate);

  function applyTitle(override: { mode: 'confirm-current' | 'candidate' | 'custom'; title?: string }) {
    setReviewError(null);
    setTitle.mutate(
      { key: seriesKey, override },
      {
        onSuccess: () => {
          setReviewOpen(false);
          setCustomOpen(false);
        },
        onError: (mutationError) => setReviewError((mutationError as Error).message),
      },
    );
  }
  const visibleMembers = showAllUncollected
    ? primaryMembers
    : primaryMembers.filter(
        (member) => member.collected || uncollectedMembers.indexOf(member) < 30,
      );

  return (
    <div className="space-y-4">
      {data.protectedTitleCandidateCount ? <InlineNote tone="neutral">另有 {data.protectedTitleCandidateCount} 条历史候选受隐私保护，未展示；不代表无效或删除。</InlineNote> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>
          返回
        </Button>
        <div className="flex items-center gap-2">
          {data.franchise ? (
            <Link to={`/franchises/${encodeURIComponent(data.franchise.key)}`}>
              <Button size="sm" variant="ghost" icon={<Layers size={13} />}>
                所属家族：{data.franchise.title}
              </Button>
            </Link>
          ) : null}
          <Link to={`/library?seriesKey=${encodeURIComponent(data.key)}`}>
            <Button size="sm">在收藏库中筛选该系列</Button>
          </Link>
        </div>
      </div>

      <ManualFranchiseControls seriesKey={data.key} />
      <VisibilityContextBar
        hidden={analysis.hidden}
        visibility={analysis.visibility}
        onToggle={(next) => setVisibility(next)}
      />

      <div className="card-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-title">{data.title}</h1>
              <Badge tone={TITLE_STATE_TONE[data.titleState]}>
                {TITLE_STATE_LABEL[data.titleState]}
              </Badge>
              <Badge tone={data.state === 'provisional' ? 'warning' : 'success'}>
                {SERIES_STATE_LABEL[data.state]}
              </Badge>
            </div>
            <p className="mt-1 text-note text-muted">
              {/* 整页单口径：结构规模跟随 analysis（可见 Series 恒等于 Real，仍显式同源） */}
              已知成员 {analysis.coverage.knownMembers} 部 · 我的收藏{' '}
              {analysis.coverage.localCollected} 部
              {analysis.coverage.relationOnly > 0
                ? `（其中 ${analysis.coverage.relationOnly} 部仅由关系数据得知）`
                : ''}{' '}
              · {formatNumber(data.totalEpisodes)} 集
            </p>
            <p className="mt-0.5 text-caption text-subtle">
              名称来源 {data.titleSource} · {COVERAGE_LABEL[data.evidenceCoverage]}
            </p>
          </div>
        </div>

        {data.titleCandidates.length > 0 ? (
          <InlineNote
            tone={
              data.titleState === 'resolved' ||
              (data.titleState === 'manual' && conflictingAutoProposals.length === 0)
                ? 'neutral'
                : 'warning'
            }
            className="mt-4"
          >
            名称候选：
            {activeTitleCandidates
              .map(
                (candidate) =>
                  `「${candidate.title}」（${TITLE_SOURCE_LABEL[candidate.source] ?? candidate.source}${visibleEvidenceText(candidate.evidence) ? ` · ${candidate.evidence}` : ''}）`,
              )
              .join('；')}
            {rejectedTitleCandidates.length > 0
              ? `；已排除：${rejectedTitleCandidates
                  .map((candidate) => {
                    const reason = visibleEvidenceText(candidate.rejectReason ?? '结构异常');
                    return `「${candidate.title}」${reason ? `（${reason}）` : ''}`;
                  })
                  .join('；')}`
              : ''}
            。
            {data.titleState === 'manual'
              ? conflictingAutoProposals.length > 0
                ? `当前使用你的人工确认名称（同步不会自动覆盖）；系统另有自动建议「${conflictingAutoProposals[0]!.title}」，如需调整可随时选择候选或恢复自动解析。`
                : '已由你人工确认并锁定，后续同步不会自动覆盖。'
              : data.titleState === 'resolved'
                ? '系统已根据当前证据自动确定此标题（无需人工审批）；如认为有误，可随时在下方修改并锁定。'
                : data.titleState === 'contested'
                  ? '当前候选存在实质性证据冲突，建议在下方核对并手动确认最终标题。'
                  : '当前证据不足，暂定展示名会随更强证据自动更新，你也可以随时人工确认。'}
          </InlineNote>
        ) : null}

        {/* Title Review：低干扰的人工确认入口；默认只显示一行操作 */}
        <div className="mt-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {data.titleState === 'manual' ? (
              <>
                <Badge tone="accent">人工确认</Badge>
                {data.titleConfirmedAt ? (
                  <span className="text-caption text-subtle">
                    确认于{' '}
                    {new Date(data.titleConfirmedAt).toLocaleString('zh-CN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReviewOpen((open) => !open);
                    setCustomOpen(false);
                  }}
                >
                  {reviewOpen ? '收起候选' : '查看候选'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={resetTitle.isPending}
                  onClick={() => {
                    setReviewError(null);
                    resetTitle.mutate(data.key, {
                      onError: (mutationError) =>
                        setReviewError((mutationError as Error).message),
                    });
                  }}
                >
                  恢复自动解析
                </Button>
              </>
            ) : (
              <>
                <span className="text-caption text-subtle">
                  {data.titleState === 'resolved' ? '已自动确定 · 需要微调？' : '名称有误或需要确认？'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={setTitle.isPending}
                  onClick={() => applyTitle({ mode: 'confirm-current' })}
                >
                  {data.titleState === 'resolved' ? '锁定当前名称' : '确认当前名称'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReviewOpen((open) => !open);
                    setCustomOpen(false);
                  }}
                >
                  {reviewOpen ? '收起候选' : '选择候选'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCustomOpen((open) => !open);
                    setReviewOpen(false);
                    setCustomTitle(data.title);
                  }}
                >
                  自定义名称
                </Button>
              </>
            )}
          </div>

          {reviewOpen ? (
            <div className="mt-2 space-y-1.5">
              {activeTitleCandidates.map((candidate) => (
                <div
                  key={`${candidate.source}-${candidate.title}`}
                  data-testid="title-candidate-row"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border bg-surface px-3 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-note">{candidate.title}</p>
                    <p className="text-caption text-subtle">
                      {TITLE_SOURCE_LABEL[candidate.source] ?? candidate.source}
                      {visibleEvidenceText(candidate.evidence) ? ` · ${candidate.evidence}` : ''}
                    </p>
                  </div>
                  {/* 两个操作属于同一组，保持相邻；不要被 justify-between 拆到行两端 */}
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={setTitle.isPending}
                      onClick={() => applyTitle({ mode: 'candidate', title: candidate.title })}
                    >
                      采用
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={rejectCandidate.isPending}
                      title="否决这个候选：它会退出展示竞争与搜索别名，但保留在列表里用于解释"
                      onClick={() => {
                        setReviewError(null);
                        rejectCandidate.mutate(
                          { key: seriesKey, title: candidate.title },
                          {
                            onError: (mutationError) =>
                              setReviewError((mutationError as Error).message),
                          },
                        );
                      }}
                    >
                      否决
                    </Button>
                  </div>
                </div>
              ))}
              {rejectedTitleCandidates.length > 0 ? (
                <div className="mt-1 space-y-1.5 border-t border-border pt-2">
                  <p className="text-caption text-subtle">
                    未参与竞争的候选（{rejectedTitleCandidates.length}）——保留用于解释，不会成为展示标题或搜索别名
                  </p>
                  {rejectedTitleCandidates.map((candidate) => (
                    <div
                      key={`rejected-${candidate.source}-${candidate.title}`}
                      data-testid="title-candidate-rejected-row"
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-dashed border-border px-3 py-1.5 opacity-80"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-note text-muted line-through">{candidate.title}</p>
                        <p className="text-caption text-subtle">
                          {candidate.rejected ? '人工否决' : '结构校验未通过'}
                          {candidate.rejectedAt ? ` · ${formatDateTime(candidate.rejectedAt)}` : ''}
                          {visibleEvidenceText(candidate.rejectReason) ? ` · ${candidate.rejectReason}` : ''}
                        </p>
                      </div>
                    {candidate.rejected ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={reopenCandidate.isPending}
                          title="把这个候选放回展示竞争；旧的否决记录会保留为历史，展示名仍由当前证据决定"
                          onClick={() => {
                            setReviewError(null);
                            reopenCandidate.mutate(
                              { key: seriesKey, title: candidate.title },
                              {
                                onError: (mutationError) =>
                                  setReviewError((mutationError as Error).message),
                              },
                            );
                          }}
                        >
                          重新进入评估
                        </Button>
                      </div>
                    ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {customOpen ? (
            <form
              className="mt-2 flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                applyTitle({ mode: 'custom', title: customTitle });
              }}
            >
              <Input
                aria-label="自定义系列名称"
                className="h-8 w-full min-w-0 flex-1 sm:w-auto sm:min-w-[240px]"
                maxLength={120}
                placeholder="输入正确的系列名称"
                value={customTitle}
                onChange={(event) => setCustomTitle(event.target.value)}
              />
              <Button
                size="sm"
                type="submit"
                disabled={setTitle.isPending || customTitle.trim().length === 0}
              >
                保存为人工确认
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setCustomOpen(false)}>
                取消
              </Button>
            </form>
          ) : null}

          {reviewError ? <p className="mt-2 text-caption text-danger">{reviewError}</p> : null}
        </div>

        {data.state === 'provisional' ? (
          <InlineNote tone="warning" className="mt-4">
            该系列由标题相近推测得到（缺少官方关系证据），可能与实际归属不同。
          </InlineNote>
        ) : null}
      </div>

      <PersonalOverviewSection analysis={analysis} scope="series" />
      <RatingProfileSection
        analysis={analysis}
        samples={ratingSamples}
        onMemberClick={onMemberLinkClick}
      />
      <AirTimelineSection analysis={analysis} />
      <ConsumptionEvidenceSection analysis={analysis} />

      <Card>
        <CardHeader
          title={`系列成员（${primaryMembers.length} 部，其中收藏 ${collectedMembers.length} 部）`}
          description="证据层：每个成员都附带归属理由与来源状态（收藏 / 未收藏 / 仅关系数据）"
        />
        <CardBody className="space-y-1.5 pt-2">
          {analysis.hidden.members > 0 ? (
            <InlineNote tone="neutral">
              另有 {analysis.hidden.members} 个成员按当前可见性策略隐藏（hidden），不参与当前口径的统计；
              数据仍然存在，可在页面顶部切换完整数据口径。
            </InlineNote>
          ) : null}
          {visibleMembers.map((member) =>
            member.item ? (
              <div key={member.subjectId} id={`member-${member.subjectId}`} className="space-y-1">
                <SubjectRow item={member.item} />
                <p className="text-caption text-subtle">
                  {visibleEvidenceText(member.reason) ? `归属理由：${member.reason} · ` : ''}
                  {MEMBERSHIP_STATE_LABEL[member.state]}
                </p>
              </div>
            ) : (
              <div
                key={member.subjectId}
                id={`member-${member.subjectId}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-dashed border-border bg-surface-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-note">{member.title || `条目 ${member.subjectId}`}</p>
                  <p className="text-caption text-subtle">
                    {visibleEvidenceText(member.reason) ? `${member.reason} · ` : ''}{member.year ?? '年份未知'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone="neutral">{member.relationOnly ? '仅关系数据' : '未收藏'}</Badge>
                  <a
                    href={`https://bgm.tv/subject/${member.subjectId}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-subtle transition-colors hover:text-text"
                    title="在 Bangumi 打开"
                  >
                    <ExternalLink size={12} />
                  </a>
                </div>
              </div>
            ),
          )}
          {!showAllUncollected && uncollectedMembers.length > 30 ? (
            <div className="flex items-center justify-between gap-2 rounded-[10px] border border-dashed border-border px-3 py-2">
              <span className="text-caption text-subtle">
                还有 {uncollectedMembers.length - 30} 部未收藏成员未显示（不参与统计）
              </span>
              <Button size="sm" variant="ghost" onClick={() => setShowAllUncollected(true)}>
                展开全部
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {candidateMembers.length > 0 ? (
        <Card>
          <CardHeader
            title={`候选成员（${candidateMembers.length} 部）`}
            description="关系指向多个系列，归属尚未确定，不计入任何统计"
          />
          <CardBody className="space-y-1.5 pt-2">
            {candidateMembers.map((member) => (
              <div
                key={member.subjectId}
                className="flex items-center justify-between gap-2 rounded-[10px] border border-dashed border-warning/50 bg-surface-2 px-3 py-2"
              >
                <p className="truncate text-note">{member.title || `条目 ${member.subjectId}`}</p>
                {visibleEvidenceText(member.reason) ? <span className="text-caption text-subtle">{member.reason}</span> : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {data.mergeCandidates.length > 0 ? (
        <Card>
          <CardHeader
            title="疑似更紧密的系列"
            description="衍生类关系连接到另一个已成型系列；系统没有自动合并，等待人工确认"
          />
          <CardBody className="space-y-1.5 pt-2">
            {data.mergeCandidates.map((candidate) => (
              <div
                key={candidate.seriesKey}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2"
              >
                <Link
                  to={`/series/${encodeURIComponent(candidate.seriesKey)}`}
                  className="text-note text-accent hover:underline"
                >
                  {candidate.title}
                </Link>
                <span className="text-caption text-subtle">
                  证据：{candidate.relations.filter(isVisibleText).join('、') || '衍生关系'}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {data.related.length > 0 ? (
        <Card>
          <CardHeader
            title={`相关但未纳入的条目（${data.related.length}）`}
            description="弱关联 / 跨媒体 / 未识别关系都不会进入系列成员"
          />
          <CardBody className="space-y-1.5 pt-2">
            {data.related.map((entry) => (
              <div
                key={`${entry.subjectId}-${entry.relation}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-note">{entry.title || `条目 ${entry.subjectId}`}</p>
                  {visibleEvidenceText(entry.reason) ? <p className="text-caption text-subtle">{entry.reason}</p> : null}
                </div>
                <a
                  href={`https://bgm.tv/subject/${entry.subjectId}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="shrink-0 text-subtle hover:text-text"
                  title="在 Bangumi 查看"
                >
                  <ExternalLink size={12} />
                </a>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
