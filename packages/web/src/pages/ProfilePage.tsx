import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AiPanel } from '../components/profile/AiPanel.js';
import { ClaimCard } from '../components/profile/ClaimsList.js';
import { SnapshotPanel } from '../components/profile/SnapshotPanel.js';
import { StructurePanel } from '../components/profile/StructurePanel.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { SectionTitle } from '../components/ui/card.js';
import { EmptyState, ErrorState, InlineNote, Skeleton } from '../components/ui/feedback.js';
import { api } from '../lib/api.js';
import { formatDateTime, formatNumber, formatPercent } from '../lib/format.js';
import {
  useConfig,
  queryKeys,
  useProfileAiStatus,
  useProfileDataset,
  useProfileSnapshots,
} from '../lib/queries.js';

/**
 * 「我的画像」= 本地统计（数据集 + 确定性结论）+ 阶段对比 + 可选的 AI 总结。
 * 三者相互独立：没有配置 AI 时前两部分完全可用。
 */
export function ProfilePage() {
  const datasetQuery = useProfileDataset();
  const snapshotsQuery = useProfileSnapshots();
  const [aiReportId, setAiReportId] = useState<number>();
  const aiStatusQuery = useProfileAiStatus(aiReportId);
  const config = useConfig();
  const hideNsfw = config.data?.hideNsfw === true;
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState<unknown>(null);
  const aiRequest = useRef<AbortController | null>(null);

  const compareQuery = useQuery({
    queryKey: ['profileCompare', snapshotsQuery.data?.snapshots.length ?? 0],
    queryFn: () => api.profileCompare(),
  });

  const dataset = datasetQuery.data;
  const dataClaims = useMemo(
    () => (dataset?.claims ?? []).filter((claim) => claim.kind === 'data'),
    [dataset],
  );
  const inferenceClaims = useMemo(
    () => (dataset?.claims ?? []).filter((claim) => claim.kind === 'inference'),
    [dataset],
  );

  if (datasetQuery.error) {
    return <ErrorState error={datasetQuery.error} onRetry={() => void datasetQuery.refetch()} />;
  }

  if (datasetQuery.isLoading || !dataset) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24" />
        <div className="grid gap-3 lg:grid-cols-safe-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-[160px]" />
          ))}
        </div>
      </div>
    );
  }

  if (dataset.sample.total === 0) {
    return (
      <div className="space-y-4">
        <SectionTitle title="我的动画画像" />
        <EmptyState
          title="还没有足够的数据"
          description="完成一次同步后，这里会基于你的真实收藏数据生成审美画像。"
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SectionTitle
        title="我的动画画像"
        description={`基于 ${formatNumber(dataset.sample.total)} 部收藏（已评分 ${dataset.sample.rated} 部、高分 ${dataset.sample.highRated} 部）· 生成于 ${formatDateTime(dataset.generatedAt)}`}
        actions={
          <Link to="/analysis">
            <Button size="sm">查看完整统计</Button>
          </Link>
        }
      />

      <InlineNote tone="neutral">
        画像是「数据先行」的：每个模块都附带它使用的具体数字，可以自己核对。
        <strong className="font-medium">数据结论</strong>由收藏数据直接计算；
        <strong className="font-medium">推测</strong>是基于行为的推断，不是事实；
        证据不足时程序会明确写出「当前数据不足」，不会编造结论。
      </InlineNote>

      {hideNsfw ? (
        <InlineNote tone="neutral">
          当前可见口径：已隐藏的 NSFW 内容不计入本页统计（数据未被删除，可在「设置」中恢复）。
        </InlineNote>
      ) : null}

      <div className="grid grid-cols-safe-2 gap-3 sm:grid-cols-safe-3 lg:grid-cols-safe-6">
        {[
          { label: '收藏总数', value: formatNumber(dataset.sample.total) },
          { label: '已评分', value: formatNumber(dataset.sample.rated) },
          { label: '高分（≥8）', value: formatNumber(dataset.sample.highRated) },
          { label: '平均我的评分', value: dataset.basics.averageRate?.toFixed(2) ?? '—' },
          { label: '完成率', value: formatPercent(dataset.basics.completionRate) },
          { label: '不同标签', value: formatNumber(dataset.breadth.distinctTags) },
        ].map((item) => (
          <div key={item.label} className="card-surface px-4 py-3">
            <p className="text-caption text-subtle">{item.label}</p>
            <p className="mt-1 text-title font-semibold numeric">{item.value}</p>
          </div>
        ))}
      </div>

      <SnapshotPanel
        snapshots={snapshotsQuery.data?.snapshots ?? []}
        snapshotsLoading={snapshotsQuery.isLoading}
        snapshotsError={snapshotsQuery.error}
        onRetrySnapshots={() => void snapshotsQuery.refetch()}
        compare={compareQuery.data?.available ? (compareQuery.data.comparison ?? null) : null}
        compareReason={compareQuery.data?.reason ?? '正在读取阶段数据…'}
        compareError={compareQuery.error}
        onRetryCompare={() => void compareQuery.refetch()}
        creating={creating}
        onCreate={async (input) => {
          setCreating(true);
          try {
            const candidateIds = input.candidates
              ? input.candidates
                  .split(/[\s,，、;；]+/)
                  .map((value) => Number(value.trim()))
                  .filter((value) => Number.isInteger(value) && value > 0)
              : undefined;
            await api.createProfileSnapshot({
              stageLabel: input.stageLabel,
              note: input.note,
              source: input.source,
              ...(input.rankFrom !== undefined ? { rankFrom: input.rankFrom } : {}),
              ...(input.rankTo !== undefined ? { rankTo: input.rankTo } : {}),
              ...(candidateIds && candidateIds.length > 0 ? { candidateIds } : {}),
            });
            await queryClient.invalidateQueries({ queryKey: ['profileSnapshots'] });
            await compareQuery.refetch();
          } finally {
            setCreating(false);
          }
        }}
        onDelete={async (id) => {
          await api.deleteProfileSnapshot(id);
          await queryClient.invalidateQueries({ queryKey: ['profileSnapshots'] });
          await compareQuery.refetch();
        }}
      />

      <section className="space-y-3">
        <div className="section-title-copy flex w-fit max-w-full flex-wrap items-center gap-2">
          <h2 className="text-section font-semibold">数据结论</h2>
          <Badge tone="accent">由收藏数据直接计算</Badge>
        </div>
        <div className="grid gap-3 lg:grid-cols-safe-2">
          {dataClaims.map((claim) => (
            <ClaimCard key={claim.id} claim={claim} />
          ))}
        </div>
      </section>

      {inferenceClaims.length > 0 ? (
        <section className="space-y-3">
          <div className="section-title-copy flex w-fit max-w-full flex-wrap items-center gap-2">
            <h2 className="text-section font-semibold">基于行为的推测</h2>
            <Badge tone="warning">不是事实，是推断</Badge>
          </div>
          <div className="grid gap-3 lg:grid-cols-safe-2">
            {inferenceClaims.map((claim) => (
              <ClaimCard key={claim.id} claim={claim} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="section-title-copy flex w-fit max-w-full flex-wrap items-center gap-2">
          <h2 className="text-section font-semibold">结构明细</h2>
          <span className="text-note text-subtle">每个结论背后的原始统计</span>
        </div>
        <StructurePanel dataset={dataset} />
      </section>

      <AiPanel
        status={aiStatusQuery.data}
        statusLoading={aiStatusQuery.isFetching}
        statusError={aiStatusQuery.error}
        onStatusRetry={() => void aiStatusQuery.refetch()}
        onSelectReport={setAiReportId}
        error={aiError}
        generating={generating}
        onCancel={() => aiRequest.current?.abort()}
        onGenerate={async (force) => {
          if (aiStatusQuery.isFetching || aiStatusQuery.error || !aiStatusQuery.data?.configured
            || aiStatusQuery.data.generating || aiRequest.current) return;
          const controller = new AbortController();
          aiRequest.current = controller;
          setGenerating(true);
          setAiError(null);
          try {
            const result = await api.generateProfileAi(force, controller.signal);
            setAiReportId(result.report?.id);
            await queryClient.invalidateQueries({ queryKey: queryKeys.profileAi });
          } catch (error) {
            setAiError(error);
          } finally {
            aiRequest.current = null;
            setGenerating(false);
          }
        }}
      />
    </div>
  );
}
