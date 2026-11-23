import { useIsMutating, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppConfigPublic,
  DiagnosticsRepairRequest,
  FranchiseGovernanceKind,
  FranchiseGovernanceRequest,
  SeriesTitleOverrideInput,
  SubjectQuery,
  SyncStatus,
} from '@bangumi-analyzer/shared';
import { api, type EvidenceMode } from './api.js';
export const diagnosticEvidenceKey = (mode: EvidenceMode, offset = 0) => mode === 'real' ? ['diagnostics', 'evidence-real', offset] : offset ? [...queryKeys.diagnostics, offset] : queryKeys.diagnostics;

export const queryKeys = {
  health: ['health'] as const,
  config: ['config'] as const,
  syncStatus: ['syncStatus'] as const,
  syncHistory: (limit: number) => ['syncHistory', limit] as const,
  dashboard: ['dashboard'] as const,
  overview: ['overview'] as const,
  distributions: ['distributions'] as const,
  timeline: (granularity: string) => ['timeline', granularity] as const,
  bias: (limit: number) => ['bias', limit] as const,
  studios: (limit: number) => ['studios', limit] as const,
  directors: (limit: number) => ['directors', limit] as const,
  habits: ['habits'] as const,
  profile: ['profile'] as const,
  profileDataset: ['profileDataset'] as const,
  profileAi: ['profileAi'] as const,
  profileSnapshots: ['profileSnapshots'] as const,
  localProfile: ['localProfile'] as const,
  translationStatus: ['translationStatus'] as const,
  subjectTags: (query: SubjectQuery) => ['subjectTags', query] as const,
  staffSearch: (query: string) => ['staffSearch', query] as const,
  entitySearch: (query: string) => ['entitySearch', query] as const,
  facets: ['facets'] as const,
  subjects: (query: SubjectQuery) => ['subjects', query] as const,
  subject: (id: number) => ['subject', id] as const,
  series: (sort: string, includeSingletons: boolean) => ['series', sort, includeSingletons] as const,
  seriesDetail: (key: string) => ['seriesDetail', key] as const,
  franchises: (sort: string, state: string) => ['franchises', sort, state] as const,
  franchiseDetail: (key: string) => ['franchiseDetail', key] as const,
  franchiseGovernance: (
    key: string,
    query: { kind: string; series?: string; title?: string },
  ) => ['franchiseGovernance', key, query] as const,
  relationAudit: ['relationAudit'] as const,
  diagnostics: ['diagnostics'] as const,
  diagnosticsHistory: (entityKind: string, actor: string, limit: number) =>
    ['diagnosticsHistory', entityKind, actor, limit] as const,
  seriesSearch: (q: string) => ['seriesSearch', q] as const,
  franchiseSearch: (q: string) => ['franchiseSearch', q] as const,
  backups: ['backups'] as const,
  coverStatus: ['coverStatus'] as const,
};

type QueryOptions<T> = Omit<UseQueryOptions<T, Error, T, readonly unknown[]>, 'queryKey' | 'queryFn'>;

export function useHealth(options?: QueryOptions<Awaited<ReturnType<typeof api.health>>>) {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: api.health,
    retry: 1,
    ...options,
  });
}

export function useConfig(options?: QueryOptions<Awaited<ReturnType<typeof api.config>>>) {
  return useQuery({ queryKey: queryKeys.config, queryFn: api.config, ...options });
}

export function useDashboard(hideNsfw: boolean | undefined) {
  return useQuery({
    queryKey: [...queryKeys.dashboard, hideNsfw],
    queryFn: ({ signal }) => api.dashboard(signal),
    enabled: hideNsfw !== undefined,
    refetchOnMount: 'always',
  });
}

export function useDistributions() {
  return useQuery({ queryKey: queryKeys.distributions, queryFn: api.distributions });
}

export function useTimeline(granularity: 'year' | 'quarter' | 'month') {
  return useQuery({
    queryKey: queryKeys.timeline(granularity),
    queryFn: () => api.timeline(granularity),
    // Refresh the calendar anchor across month boundaries even when dataVersion is unchanged.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useBias(limit = 12) {
  return useQuery({ queryKey: queryKeys.bias(limit), queryFn: () => api.bias(limit) });
}

export function useStudios(limit = 20) {
  return useQuery({ queryKey: queryKeys.studios(limit), queryFn: () => api.studios(limit) });
}

export function useDirectors(limit = 20) {
  return useQuery({ queryKey: queryKeys.directors(limit), queryFn: () => api.directors(limit) });
}

export function useHabits() {
  return useQuery({ queryKey: queryKeys.habits, queryFn: api.habits });
}

/** 结构化画像（无 AI 也能完整展示） */
export function useProfileDataset() {
  return useQuery({ queryKey: queryKeys.profileDataset, queryFn: api.profileDataset });
}

export function useProfileAiStatus(reportId?: number) {
  return useQuery({
    queryKey: [...queryKeys.profileAi, reportId ?? null],
    queryFn: ({ signal }) => api.profileAiStatus(signal, reportId),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
}

export function useProfileSnapshots() {
  return useQuery({ queryKey: queryKeys.profileSnapshots, queryFn: api.profileSnapshots });
}

/** 本地资料 + 首次使用引导状态（纯本地查询，不触发任何 Bangumi 请求）。 */
export function useLocalProfile() {
  return useQuery({ queryKey: queryKeys.localProfile, queryFn: api.localProfile });
}

/** 简介翻译队列总览：队列非空时自动轮询，方便看到进度。 */
export function useTranslationStatus() {
  return useQuery({
    queryKey: queryKeys.translationStatus,
    queryFn: api.translationStatus,
    refetchInterval: (query) => {
      const status = query.state.data;
      if (!status) return 15_000;
      const busy = status.counts.pending + status.counts.processing > 0;
      return busy ? 2_500 : false;
    },
  });
}

/** 标签反向追溯：当前筛选结果内的标签分布 */
export function useSubjectTags(query: SubjectQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.subjectTags(query),
    queryFn: () => api.subjectTags(query),
    enabled,
    staleTime: 15_000,
  });
}

/** 制作人员 / 公司检索（关键词为空时返回参与作品最多的前 N 位）。 */
export function useStaffSearch(query: string, limit = 60, enabled = true) {
  return useQuery({
    queryKey: queryKeys.staffSearch(`${query}|${limit}`),
    queryFn: () => api.staffSearch(query, limit),
    enabled,
    staleTime: 30_000,
  });
}

/** 主搜索栏的实体检索（输入时调用，按关键词缓存）。 */
export function useEntitySearch(query: string, enabled = true) {
  const keyword = query.trim();
  return useQuery({
    queryKey: queryKeys.entitySearch(keyword),
    queryFn: () => api.searchEntities(keyword, 8),
    enabled: enabled && keyword.length > 0,
    staleTime: 60_000,
  });
}

export function useFacets() {
  return useQuery({ queryKey: queryKeys.facets, queryFn: api.facets, staleTime: 5 * 60_000 });
}

export function useSubjects(query: SubjectQuery) {
  return useQuery({
    queryKey: queryKeys.subjects(query),
    queryFn: () => api.subjects(query),
    placeholderData: (previous) => previous,
  });
}

export function useSubject(id: number) {
  return useQuery({
    queryKey: queryKeys.subject(id),
    queryFn: () => api.subject(id),
    enabled: Number.isFinite(id) && id > 0,
    // 简介正在翻译时自动轮询，翻译完成后自行停止（详情页无需手动刷新）
    refetchInterval: (query) => {
      const state = query.state.data?.summaryState;
      if (!state) return false;
      return state.status === 'pending' || state.status === 'processing' ? 3_000 : false;
    },
  });
}

export function useSeries(sort: string, includeSingletons = false) {
  return useQuery({
    queryKey: queryKeys.series(sort, includeSingletons),
    queryFn: () => api.series({ sort, includeSingletons, limit: 1000 }),
  });
}

export function useSeriesDetail(key: string, visibility?: 'visible' | 'real', evidence: EvidenceMode = 'visible') {
  return useQuery({
    queryKey: [...queryKeys.seriesDetail(key), visibility ?? 'default', evidence],
    queryFn: () => api.seriesDetail(key, visibility, evidence),
    enabled: key.length > 0,
  });
}

export function useFranchises(sort: string, state: string) {
  return useQuery({
    queryKey: queryKeys.franchises(sort, state),
    queryFn: () => api.franchises({ sort, state, limit: 500 }),
  });
}

export function useFranchiseDetail(key: string, visibility?: 'visible' | 'real', evidence: EvidenceMode = 'visible') {
  return useQuery({
    queryKey: [...queryKeys.franchiseDetail(key), visibility ?? 'default', evidence],
    queryFn: () => api.franchiseDetail(key, visibility, evidence),
    enabled: key.length > 0,
  });
}

export function useConfirmFranchise() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.confirmFranchise(key),
    onSuccess: (_data, key) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.franchiseDetail(key) });
      void queryClient.invalidateQueries({ queryKey: ['franchises'] });
    },
  });
}

/** Title Review：确认当前名称 / 采用候选 / 自定义标题。 */
export function useSetSeriesTitle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; override: SeriesTitleOverrideInput }) =>
      api.setSeriesTitle(input.key, input.override),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.seriesDetail(variables.key) });
      void queryClient.invalidateQueries({ queryKey: ['series'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics });
      void queryClient.invalidateQueries({ queryKey: ['diagnosticsHistory'] });
    },
  });
}

/** 恢复自动解析（仅用于纠正误确认）。 */
export function useResetSeriesTitle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.resetSeriesTitle(key),
    onSuccess: (_data, key) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.seriesDetail(key) });
      void queryClient.invalidateQueries({ queryKey: ['series'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics });
      void queryClient.invalidateQueries({ queryKey: ['diagnosticsHistory'] });
    },
  });
}

/** 候选治理：否决标题候选（v1.6.1）。否决是真实治理状态，不是 UI 隐藏。 */
export function useRejectSeriesTitleCandidate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; title: string; reason?: string }) =>
      api.rejectSeriesTitleCandidate(input.key, input.title, input.reason),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.seriesDetail(variables.key) });
      void queryClient.invalidateQueries({ queryKey: ['series'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics });
    },
  });
}

/** 候选治理：否决家族候选（v1.6.1）。 */
export function useRejectFranchise() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; reason?: string }) =>
      api.rejectFranchise(input.key, input.reason),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.franchiseDetail(variables.key) });
      void queryClient.invalidateQueries({ queryKey: ['franchises'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics });
    },
  });
}

/** 候选治理：重新进入评估被否决的标题候选（v1.6.2）。 */
export function useReopenSeriesTitleCandidate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; title: string; reason?: string }) =>
      api.reopenSeriesTitleCandidate(input.key, input.title, input.reason),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.seriesDetail(variables.key) });
      void queryClient.invalidateQueries({ queryKey: ['series'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics });
      void queryClient.invalidateQueries({ queryKey: ['diagnosticsHistory'] });
    },
  });
}

/** 否决可逆：把已否决的家族放回候选状态。 */
export function useReopenFranchise() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string }) => api.reopenFranchise(input.key),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.franchiseDetail(variables.key) });
      void queryClient.invalidateQueries({ queryKey: ['franchises'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics });
    },
  });
}

/**
 * Franchise 成员 / 名称治理（v1.7.0）：执行前的影响预览。
 *
 * 与执行共用服务端同一套判定：不允许的动作会返回 allowed=false + 原因。
 */
export function useFranchiseGovernancePreview(
  key: string,
  query: { kind: FranchiseGovernanceKind; series?: string; title?: string } | null,
  evidence: EvidenceMode = 'visible',
) {
  return useQuery({
    queryKey: [...queryKeys.franchiseGovernance(key, query ?? { kind: 'none' }), evidence],
    queryFn: () => api.franchiseGovernancePreview(key, query!, evidence),
    enabled: key.length > 0 && query !== null,
    staleTime: 0,
  });
}

/**
 * 执行 Franchise 治理动作：Preview → Execute → Verify。
 *
 * 执行会修改真实 source-of-truth（成员排除治理记录 / 家族名称）并重算派生投影，
 * 成功后面向全站失效缓存，保证离开家族页面后各处读到的是同一个事实。
 */
export function useFranchiseGovernance(evidence: EvidenceMode = 'visible') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; payload: FranchiseGovernanceRequest }) =>
      api.runFranchiseGovernance(input.key, input.payload, evidence),
    onSuccess: (result, variables) => {
      if (!(queryClient.getQueryData<AppConfigPublic>(queryKeys.config)?.hideNsfw && !result.report.hideNsfw)) {
        queryClient.setQueryData(diagnosticEvidenceKey(result.report.presentation?.mode ?? 'visible'), result.report);
      }
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'diagnostics' && query.queryKey.length > 1 });
      void queryClient.invalidateQueries({ queryKey: queryKeys.franchiseDetail(variables.key) });
      void queryClient.invalidateQueries({ queryKey: ['franchises'] });
      void queryClient.invalidateQueries({ queryKey: ['franchiseGovernance'] });
      void queryClient.invalidateQueries({ queryKey: ['series'] });
      void queryClient.invalidateQueries({ queryKey: ['seriesDetail'] });
      void queryClient.invalidateQueries({ queryKey: ['subjects'] });
      void queryClient.invalidateQueries({ queryKey: ['diagnosticsHistory'] });
    },
  });
}

export function useRelationAudit() {
  return useQuery({ queryKey: queryKeys.relationAudit, queryFn: api.relationAudit });
}

export function useDiagnostics(offset = 0, evidence: EvidenceMode = 'visible') {
  return useQuery({
    queryKey: diagnosticEvidenceKey(evidence, offset),
    queryFn: () => api.diagnostics(false, { offset }, evidence),
    staleTime: 30_000,
  });
}

/** 治理 / 修复历史（只读）。 */
export function useDiagnosticsHistory(entityKind: string, actor: string, limit: number, evidence: EvidenceMode = 'visible') {
  return useQuery({
    queryKey: [...queryKeys.diagnosticsHistory(entityKind, actor, limit), evidence],
    queryFn: () => api.diagnosticsHistory({ entityKind, actor, limit }, evidence),
    staleTime: 30_000,
    /*
     * limit / 筛选进入查询键：如果不保留上一份数据，切换瞬间列表会被清空（骨架屏），
     * 页面高度塌陷会让浏览器把滚动位置夹回顶部——表现就是「点显示更多后跳回列表顶部」。
     * 保留上一份数据可以保证滚动位置与已读记录都稳定，新的一页到达后再追加。
     */
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey.at(-1) === evidence ? previous : undefined,
  });
}

/**
 * 执行数据中枢修复。
 *
 * 修复会改动 Series / Franchise 等派生数据与治理状态，成功后面向全站失效缓存，
 * 保证用户离开数据中枢后各处页面读到的都是修复后的真实状态。
 */
export function useDiagnosticsRepair(evidence: EvidenceMode = 'visible') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: DiagnosticsRepairRequest) => api.runDiagnosticsRepair(payload, evidence),
    onSuccess: (result) => {
      if (!(queryClient.getQueryData<AppConfigPublic>(queryKeys.config)?.hideNsfw && !result.report.hideNsfw)) {
        queryClient.setQueryData(diagnosticEvidenceKey(result.report.presentation?.mode ?? 'visible'), result.report);
      }
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'diagnostics' && query.queryKey.length > 1 });
      void queryClient.invalidateQueries({ queryKey: ['series'] });
      void queryClient.invalidateQueries({ queryKey: ['franchises'] });
      void queryClient.invalidateQueries({ queryKey: ['franchiseDetail'] });
      void queryClient.invalidateQueries({ queryKey: ['seriesDetail'] });
      void queryClient.invalidateQueries({ queryKey: ['subjects'] });
      void queryClient.invalidateQueries({ queryKey: ['facets'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Series / IP 域内搜索：查询的是完整 Series 实体域，与列表筛选 / 单成员开关无关。 */
export function useSeriesSearch(query: string) {
  const keyword = query.trim();
  return useQuery({
    queryKey: queryKeys.seriesSearch(keyword),
    queryFn: () => api.searchSeries(keyword),
    enabled: keyword.length > 0,
  });
}

export function useFranchiseSearch(query: string) {
  const keyword = query.trim();
  return useQuery({
    queryKey: queryKeys.franchiseSearch(keyword),
    queryFn: () => api.searchFranchises(keyword),
    enabled: keyword.length > 0,
  });
}

export function useBackups() {
  return useQuery({ queryKey: queryKeys.backups, queryFn: api.backups });
}

export function useCoverStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.coverStatus,
    queryFn: api.coverStatus,
    enabled,
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  });
}

/**
 * 同步控制器：负责启动/取消同步，并在同步进行时轮询进度。
 * 同步完成后自动刷新所有派生数据（统计、列表、详情）。
 */
export function useSyncController(): {
  status: SyncStatus | undefined;
  running: boolean;
  lastCompleted: SyncStatus['lastRun'];
  isLoading: boolean;
  starting: boolean;
  cancelling: boolean;
  statusError: Error | null;
  refreshStatus: () => void;
  error: Error | null;
  start: (options: {
    mode: 'full' | 'incremental' | 'enrich';
    depth?: 1 | 2;
    forceDetail?: boolean;
  }) => Promise<void>;
  cancel: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const [error, setError] = useState<Error | null>(null);
  const wasRunning = useRef(false);
  const starting = useIsMutating({ mutationKey: ['syncStart'] }) > 0;
  const cancelling = useIsMutating({ mutationKey: ['syncCancel'] }) > 0;

  const statusQuery = useQuery({
    queryKey: queryKeys.syncStatus,
    queryFn: api.syncStatus,
    refetchInterval: (query) => (query.state.data?.running ? 1200 : 30_000),
    refetchOnWindowFocus: true,
  });

  const running = statusQuery.data?.running ?? false;

  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries();
    }
    wasRunning.current = running;
  }, [running, queryClient]);

  const startMutation = useMutation({
    mutationKey: ['syncStart'],
    mutationFn: api.startSync,
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.syncStatus, data.status);
      setError(null);
    },
    onError: (mutationError: Error) => setError(mutationError),
  });

  const cancelMutation = useMutation({
    mutationKey: ['syncCancel'],
    mutationFn: api.cancelSync,
    onSuccess: (data) => queryClient.setQueryData(queryKeys.syncStatus, data.status),
  });

  const start = useCallback(
    async (options: {
      mode: 'full' | 'incremental' | 'enrich';
      depth?: 1 | 2;
      forceDetail?: boolean;
    }) => {
      if (queryClient.isMutating({ mutationKey: ['syncStart'] })) return;
      setError(null);
      await startMutation.mutateAsync(options);
    },
    [startMutation, queryClient],
  );

  const cancel = useCallback(async () => {
    if (queryClient.isMutating({ mutationKey: ['syncCancel'] })) return;
    await cancelMutation.mutateAsync();
  }, [cancelMutation, queryClient]);

  return {
    status: statusQuery.data,
    running,
    lastCompleted: statusQuery.data?.lastRun ?? null,
    isLoading: statusQuery.isLoading,
    starting,
    cancelling,
    statusError: statusQuery.error,
    refreshStatus: () => { void statusQuery.refetch(); },
    error,
    start,
    cancel,
  };
}
