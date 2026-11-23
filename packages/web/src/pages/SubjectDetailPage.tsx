import { ArrowLeft, ExternalLink, Info, Layers, RefreshCw, Star } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { hideWork, privacyChanged } from '../lib/userGovernance.js';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { SubjectDetail } from '@bangumi-analyzer/shared';
import { CategoryBar } from '../components/charts/generic.js';
import { CoverImage, ProgressMeter, RatePill, StatusBadge, TagList } from '../components/subject/atoms.js';
import { SummarySection } from '../components/subject/SummarySection.js';
import { Button } from '../components/ui/button.js';
import { Card, CardBody, CardHeader } from '../components/ui/card.js';
import { ErrorState, HiddenState, InlineNote, Skeleton } from '../components/ui/feedback.js';
import { useToast } from '../components/ui/toast.js';
import { ApiRequestError } from '../lib/api.js';
import {
  bangumiSubjectUrl,
  formatDate,
  formatDateTime,
  formatLabel,
  formatNumber,
  formatPercent,
  formatRate,
  primaryTitle,
  seasonLabel,
  statusLabel,
} from '../lib/format.js';
import { useSubject } from '../lib/queries.js';
import { buildEntitySearchHref, buildLibraryHrefFromParams } from '../lib/libraryLinks.js';

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-border py-2 last:border-b-0">
      <span className="w-20 shrink-0 text-caption text-subtle sm:w-24">{label}</span>
      <span className="min-w-0 flex-1 break-words text-note">{children}</span>
    </div>
  );
}

function StaffSection({ detail }: { detail: SubjectDetail }) {
  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of detail.staff) {
      const list = map.get(entry.relation) ?? [];
      if (!list.includes(entry.name)) list.push(entry.name);
      map.set(entry.relation, list);
    }
    const order = ['导演', '动画制作', '脚本', '人物设定', '音乐', '其他'];
    return [...map.entries()].sort(
      (a, b) => (order.indexOf(a[0]) + 99) % 99 - ((order.indexOf(b[0]) + 99) % 99),
    );
  }, [detail.staff]);

  if (grouped.length === 0) {
    return (
      <InlineNote tone="neutral">
        暂无制作人员数据。可以在「设置」中执行「深度同步」以抓取官方人员数据。
      </InlineNote>
    );
  }

  return (
    <div className="space-y-2.5">
      {grouped.map(([relation, names]) => (
        <div key={relation} className="flex flex-col gap-1.5 sm:flex-row sm:gap-3">
          <span className="shrink-0 text-caption text-subtle sm:w-20 sm:pt-0.5">{relation}</span>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {names.map((name) => (
              <Link
                key={name}
                // 以该人员为主检索（替换式）：不继承上一页的搜索词与筛选条件，
                // 只带上来源作品作为上下文，避免「第二次检索被上一次结果绑住」。
                to={buildEntitySearchHref({
                  kind: 'staff',
                  value: name,
                  fromSubject: detail.id,
                  sourceRelation: relation,
                })}
                className="max-w-full truncate-line rounded border border-border bg-surface-2 px-1.5 py-0.5 text-caption text-muted transition-colors hover:border-accent/40 hover:text-accent"
                title={`在收藏库中筛选「${name}」参与的作品（可继续查看这些作品的标签）`}
              >
                {name}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SubjectDetailPage() {
  const [hideConfirm,setHideConfirm]=useState(false);
  const [hidePending,setHidePending]=useState(false);
  const [hideError,setHideError]=useState('');
  async function applyHide(subjectId:number) {
    setHidePending(true); setHideError('');
    try { const result=await hideWork(subjectId); privacyChanged(result.dataVersion,'/library'); }
    catch(e) { setHideError((e as Error).message); setHidePending(false); }
  }
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 从收藏库跳转过来时带着当时的筛选条件（`?from=...`），反向检索要把它继续带下去
  const incomingQuery = useMemo(
    () => new URLSearchParams(searchParams.get('from') ?? ''),
    [searchParams],
  );
  const hasIncomingContext = incomingQuery.toString().length > 0;
  const id = Number(params.id);
  const { data, isLoading, error, refetch, isFetching } = useSubject(id);
  const toast = useToast();
  const refreshing = useRef(false);

  async function refreshLocal(): Promise<void> {
    if (isFetching || refreshing.current) return;
    refreshing.current = true;
    try {
      const result = await refetch({ throwOnError: true, cancelRefetch: false });
      toast.push({
        tone: 'success',
        title: JSON.stringify(result.data) === JSON.stringify(data) ? '本地数据没有变化' : '已读取最新本地数据',
        description: '仅重新读取本地数据库；没有请求 Bangumi，也没有启动同步或修改收藏。',
      });
    } catch (refreshError) {
      toast.push({ tone: 'error', title: '无法刷新本地数据', description: refreshError instanceof Error ? refreshError.message : String(refreshError) });
    } finally {
      refreshing.current = false;
    }
  }

  if (Number.isNaN(id)) {
    return <ErrorState error={new Error('无效的条目 ID')} />;
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-[300px] w-full" />
        <div className="grid gap-4 lg:grid-cols-safe-2">
          <Skeleton className="h-[260px]" />
          <Skeleton className="h-[260px]" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    // v1.5.3：被隐私设置隐藏时不渲染任何条目内容，只提示当前状态
    if (error instanceof ApiRequestError && error.code === 'subject_hidden') {
      return (
        <div className="space-y-4">
          <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>
            返回
          </Button>
          <HiddenState hint={error.hint} />
          <Link to="/settings?tab=appearance">管理隐藏设置</Link>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>
          返回
        </Button>
        <ErrorState error={error ?? new Error('未找到条目')} onRetry={() => void refetch()} />
      </div>
    );
  }

  if (hidePending) return <p role="status">正在保存主动隐藏…</p>;
  const title = primaryTitle(data);
  const ratingBuckets = Object.entries(data.ratingDistribution)
    .map(([score, count]) => ({ score, count }))
    .sort((a, b) => Number(a.score) - Number(b.score));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>
            返回
          </Button>
          {hasIncomingContext ? (
            <Link to={buildLibraryHrefFromParams(incomingQuery)}>
              <Button size="sm" variant="ghost">
                返回筛选结果（保留 {incomingQuery.size} 个条件）
              </Button>
            </Link>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={13} />}
            loading={isFetching}
            title="重新读取本地数据库，不请求 Bangumi，不启动同步或修改收藏"
            onClick={() => void refreshLocal()}
          >
            刷新本地数据
          </Button>
          {data.series ? (
            <Link to={`/series/${encodeURIComponent(data.series.key)}`}>
              <Button size="sm" icon={<Layers size={13} />}>
                系列：{data.series.title}
              </Button>
            </Link>
          ) : null}
          {data.franchise ? (
            <Link to={`/franchises/${encodeURIComponent(data.franchise.key)}`}>
              <Button size="sm" variant="ghost" icon={<Layers size={13} />}>
                家族：{data.franchise.title}
              </Button>
            </Link>
          ) : null}
          <a href={bangumiSubjectUrl(data.id)} target="_blank" rel="noreferrer noopener">
            <Button size="sm" variant="primary" icon={<ExternalLink size={13} />}>
              打开 Bangumi 页面
            </Button>
          </a>
        </div>
      </div>

      <section className="flex flex-wrap items-center gap-2" aria-label="作品隐私">
        {!hideConfirm ? <Button size="sm" variant="secondary" onClick={()=>setHideConfirm(true)}>隐藏此作品</Button> : <>
          <span>作品将从可见结果中隐藏，可在设置中解除。原始数据不会删除。</span>
          <Button size="sm" onClick={()=>void applyHide(data.id)}>确认隐藏</Button>
          <Button size="sm" variant="ghost" onClick={()=>{setHideConfirm(false);setHideError('');}}>取消</Button>
        </>}
        {hideError && <p role="alert">{hideError}</p>}
      </section>
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-5 p-5 sm:flex-row">
          <CoverImage
            id={data.id}
            title={title}
            className="aspect-[5/7] w-[132px] shrink-0 self-start sm:h-[280px] sm:w-[200px]"
            rounded="rounded-[14px]"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge type={data.collectionType} />
              <span className="text-caption text-subtle">Bangumi #{data.id}</span>
              {data.nsfw ? <span className="text-caption text-warning">NSFW</span> : null}
            </div>
            <h1 className="mt-2 text-title">{title}</h1>
            {data.name && data.name !== title ? (
              <p className="mt-0.5 text-body text-muted">{data.name}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <RatePill value={data.rate} label="我的评分" tone="accent" />
              <RatePill value={data.bgmScore} label="Bangumi 平均分" tone="muted" />
              {data.delta !== null ? (
                <span
                  className={
                    data.delta > 0
                      ? 'text-note numeric text-success'
                      : data.delta < 0
                        ? 'text-note numeric text-danger'
                        : 'text-note text-subtle'
                  }
                >
                  {data.delta > 0 ? '高于' : data.delta < 0 ? '低于' : '持平于'}大众{' '}
                  {Math.abs(data.delta).toFixed(2)} 分
                </span>
              ) : null}
              {data.bgmRank ? (
                <span className="text-caption text-subtle">Bangumi 排名 #{data.bgmRank}</span>
              ) : null}
            </div>

            <div className="mt-4 max-w-[420px]">
              <ProgressMeter
                value={data.progress}
                watched={data.watchedEpisodes}
                total={data.totalEpisodes}
              />
              <p className="mt-1 text-caption text-subtle">
                观看进度 {formatPercent(data.progress)}（{statusLabel(data.collectionType)}）
              </p>
            </div>

            {data.tags.length > 0 ? (
              <div className="mt-4">
                <TagList
                  tags={data.tags}
                  max={16}
                  onSelect={(tag) =>
                    navigate(
                      // 点击标签 = 以该标签为主检索（替换式，重新计算结果集）
                      buildEntitySearchHref({
                        kind: 'tag',
                        value: tag,
                        fromSubject: data.id,
                        sourceRelation: '标签',
                      }),
                    )
                  }
                />
                <p className="mt-1 text-caption text-subtle">
                  点击标签 = 以该标签为主检索（会重新计算结果集，不继承之前的搜索词与筛选条件）
                </p>
              </div>
            ) : null}

            <SummarySection state={data.summaryState} />
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-safe-3">
        <Card>
          <CardHeader title="基本信息" />
          <CardBody className="pt-1">
            <InfoRow label="放送形态">{formatLabel(data.format)}</InfoRow>
            <InfoRow label="放送日期">{formatDate(data.date)}</InfoRow>
            <InfoRow label="年份 / 季度">
              {data.year ?? '—'} · {seasonLabel(data.season)}
            </InfoRow>
            <InfoRow label="集数">
              {data.totalEpisodes > 0 ? `${data.totalEpisodes} 集` : '—'}
              {data.epStatus > 0 ? ` （已看 ${data.epStatus} 集）` : ''}
            </InfoRow>
            <InfoRow label="我的评分">
              {data.rate > 0 ? `${data.rate} 分` : data.collectionType === 1 ? '想看 · 不计当前评分' : '未评分'}
            </InfoRow>
            {data.personalRatingHistory ? (
              <InfoRow label="历史个人评分">
                {data.personalRatingHistory.rate} 分（不计入当前统计）
              </InfoRow>
            ) : data.sourcePersonalRate ? (
              <InfoRow label="收藏来源评分">
                {data.sourcePersonalRate} 分（当前不计；未确认是历史评分）
              </InfoRow>
            ) : null}
            <InfoRow label="Bangumi 评分">
              {data.bgmScore ? `${formatRate(data.bgmScore, 1)} 分（${data.ratingTotal === null ? '评分人数未知' : `${formatNumber(data.ratingTotal)} 人评分`}）` : '暂无评分'}
            </InfoRow>
            <InfoRow label="收藏人数">{data.collectionTotal === null ? '人数未知' : formatNumber(data.collectionTotal)}</InfoRow>
            <InfoRow label="收藏状态">{statusLabel(data.collectionType)}</InfoRow>
            <InfoRow label="最后更新">{formatDateTime(data.collectionUpdatedAt)}</InfoRow>
            <InfoRow label="首次记录">{formatDateTime(data.firstSeenAt)}</InfoRow>
            <InfoRow label="详情同步">
              {data.detailSyncedAt ? formatDateTime(data.detailSyncedAt) : '尚未同步'}
            </InfoRow>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Bangumi 评分分布" description={data.ratingTotal === null ? '评分人数未知' : `共 ${formatNumber(data.ratingTotal)} 人评分`} />
          <CardBody className="pt-1">
            {ratingBuckets.length > 0 ? (
              <CategoryBar
                categories={ratingBuckets.map((bucket) => `${bucket.score} 分`)}
                values={ratingBuckets.map((bucket) => bucket.count)}
                height={220}
                unit="人"
                color="var(--chart-6)"
              />
            ) : (
              <InlineNote tone="neutral">该条目暂无评分分布数据。</InlineNote>
            )}
            {data.metaTags.length > 0 ? (
              <div className="mt-3">
                <p className="mb-1.5 text-caption text-subtle">元标签（Wiki 维护）</p>
                <TagList tags={data.metaTags} max={12} />
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="观看与收藏结构" />
          <CardBody className="pt-2">
            {Object.keys(data.collectionBreakdown).length > 0 ? (
              <div className="space-y-1.5">
                {Object.entries(data.collectionBreakdown).map(([key, value]) => {
                  const labels: Record<string, string> = {
                    wish: '想看',
                    collect: '看过',
                    doing: '在看',
                    on_hold: '搁置',
                    dropped: '抛弃',
                  };
                  const label = labels[key] ?? key;
                  return (
                    <InfoRow key={key} label={label}>
                      <span className="numeric">{formatNumber(value)} 人</span>
                    </InfoRow>
                  );
                })}
              </div>
            ) : (
              <InlineNote tone="neutral">暂无全站收藏结构数据。</InlineNote>
            )}
            {data.comment ? (
              <div className="mt-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
                <p className="text-caption text-subtle">我的短评</p>
                <p className="mt-1 whitespace-pre-line text-note">{data.comment}</p>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-safe-2">
        <Card>
          <CardHeader
            title="制作人员"
            description={`来源：${data.personsSyncedAt ? 'Bangumi 官方人员接口' : '条目 infobox 解析'}`}
          />
          <CardBody className="pt-2">
            <StaffSection detail={data} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="系列关系"
            description={
              data.relationsSyncedAt
                ? '来源：Bangumi 官方条目关系'
                : '尚未同步，可以在设置中执行深度同步'
            }
          />
          <CardBody className="pt-2">
            {data.relations.length > 0 ? (
              <div className="space-y-1.5">
                {data.relations.map((relation) => {
                  const name = relation.nameCn || relation.name || `#${relation.id}`;
                  const content = (
                    <div className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-surface-2 px-3 py-2 transition-colors hover:border-border-strong">
                      <div className="min-w-0">
                        <p className="truncate text-note">{name}</p>
                        <p className="truncate text-caption text-subtle">
                          {relation.relation || '关联条目'}
                          {relation.inCollection
                            ? ` · 本地已收藏（${statusLabel(relation.collectionType ?? undefined)}）`
                            : ' · 未收藏'}
                        </p>
                      </div>
                      <span className="shrink-0 text-caption text-subtle">#{relation.id}</span>
                    </div>
                  );
                  return relation.inCollection ? (
                    <Link key={relation.id} to={`/subjects/${relation.id}`} className="block">
                      {content}
                    </Link>
                  ) : (
                    <a
                      key={relation.id}
                      href={bangumiSubjectUrl(relation.id)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block"
                    >
                      {content}
                    </a>
                  );
                })}
              </div>
            ) : (
              <InlineNote tone="neutral">没有记录到官方系列关系，该条目可能是独立作品。</InlineNote>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="原始数据"
          description="完整的 Bangumi 返回内容会被保存下来，避免为了未来功能重复请求接口"
          actions={<Info size={14} className="text-subtle" />}
        />
        <CardBody className="pt-2">
          <details className="group">
            <summary className="cursor-pointer list-none text-note text-muted transition-colors hover:text-text">
              展开条目原始 JSON / 收藏原始 JSON
            </summary>
            <div className="mt-3 grid gap-3 lg:grid-cols-safe-2">
              <div>
                <p className="mb-1 text-caption text-subtle">subject</p>
                <pre className="max-h-[320px] overflow-auto rounded-[10px] border border-border bg-surface-2 p-3 text-caption leading-5">
                  {JSON.stringify(data.rawSubject ?? null, null, 2)}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-caption text-subtle">collection</p>
                <pre className="max-h-[320px] overflow-auto rounded-[10px] border border-border bg-surface-2 p-3 text-caption leading-5">
                  {JSON.stringify(data.rawCollection ?? null, null, 2)}
                </pre>
              </div>
            </div>
          </details>
        </CardBody>
      </Card>

      <p className="flex items-center gap-1.5 text-caption text-subtle">
        <Star size={11} /> 数据来源：Bangumi 官方 API（api.bgm.tv），本地保存于 SQLite。
      </p>
    </div>
  );
}
