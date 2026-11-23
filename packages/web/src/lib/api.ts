import type {
  ApiErrorPayload,
  AppConfigPublic,
  AppConfigUpdate,
  BackupInfo,
  CredentialCheckResult,
  DashboardPayload,
  DiagnosticsHistoryResponse,
  DiagnosticsRepairRequest,
  DiagnosticsRepairResult,
  DiagnosticsReport,
  DistributionStats,
  EntitySearchResult,
  FilterFacets,
  FranchiseDetail,
  FranchiseGovernanceKind,
  FranchiseGovernancePreviewResponse,
  FranchiseGovernanceRequest,
  FranchiseGovernanceResult,
  FranchiseSearchHit,
  FranchiseSummary,
  HabitsStats,
  HealthResponse,
  IpSearchResponse,
  ImportPreview,
  ImportResult,
  OverviewStats,
  Page,
  OnboardingState,
  ProfileAiStatus,
  ProfileComparison,
  ProfileDataset,
  ProfileSnapshotSummary,
  RatingBiasStats,
  RelationAudit,
  SeriesDetail,
  SeriesGroupSummary,
  SeriesSearchHit,
  SeriesTitleOverrideInput,
  SubjectDetail,
  SubjectListItem,
  SubjectQuery,
  StudioStats,
  StaffSearchResult,
  TagCountList,
  SyncRunSummary,
  SyncStatus,
  TimelineStats,
  TranslationQueueStatus,
  SubjectSummaryState,
} from '@bangumi-analyzer/shared';
import { queryToSearchParams } from './filters.js';

export type EvidenceMode = 'visible' | 'real';
function evidenceRequest<T>(path: string, mode: EvidenceMode = 'visible', init: RequestInit = {}): Promise<T> {
  return request<T>(mode === 'real' ? path + (path.includes('?') ? '&' : '?') + 'evidence=real' : path,
    {...init, headers: {...init.headers, ...(mode === 'real' ? {'X-Analyzer-Evidence':'real'} : {})}});
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly status: number;
  readonly dataIntact: boolean;
  readonly resultUnknown: boolean;

  constructor(
    message: string,
    options: { code?: string; hint?: string; status?: number; dataIntact?: boolean; resultUnknown?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiRequestError';
    this.code = options.code ?? 'unknown_error';
    this.hint = options.hint;
    this.status = options.status ?? 0;
    this.dataIntact = options.dataIntact ?? true;
    this.resultUnknown = options.resultUnknown ?? false;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  readOnly = ['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase()),
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new ApiRequestError('无法连接到本地服务', {
      code: 'network_error',
      hint: '请确认后台服务正在运行（pnpm dev 或 pnpm start）。已经保存到本地的数据不会丢失。',
      dataIntact: readOnly,
      resultUnknown: !readOnly,
      cause,
    });
  }

  if (!response.ok) {
    let payload: ApiErrorPayload | null = null;
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      payload = null;
    }
    throw new ApiRequestError(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`, {
      code: payload?.error?.code ?? `http_${response.status}`,
      hint: payload?.error?.hint,
      status: response.status,
      dataIntact: payload?.error?.dataIntact ?? true,
      resultUnknown: !readOnly && (payload?.error?.resultUnknown === true || payload?.error?.code === 'evidence_projection_failed'),
    });
  }

  if (response.status === 204) return undefined as T;
  try {
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ApiRequestError('无法读取服务返回结果', {
      code: 'response_unreadable', status: response.status,
      dataIntact: readOnly, resultUnknown: !readOnly, cause,
      hint: readOnly ? '请重试读取状态。' : '服务已响应，但操作可能已经提交；请先读取当前状态并核对记录。',
    });
  }
}

export interface CoverCacheStatus {
  running: boolean;
  total: number;
  cached: number;
  pending: number;
  processed: number;
  failed: number;
  lastError: string | null;
  sizeBytes: number;
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  config: () => request<AppConfigPublic>('/api/config'),
  disconnectBangumi: () => request<AppConfigPublic>('/api/config/disconnect', { method: 'POST', body: '{}' }),
  updateConfig: (patch: AppConfigUpdate) =>
    request<AppConfigPublic>('/api/config', { method: 'PUT', body: JSON.stringify(patch) }),
  localProfile: () => request<OnboardingState>('/api/profile/local'),

  /** 上传背景图（只落盘，写入配置由 updateConfig 决定，取消预览不会留下引用） */
  uploadWallpaper: (dataUrl: string) =>
    request<{ image: string; bytes: number; mime: string }>('/api/wallpaper', {
      method: 'POST',
      body: JSON.stringify({ dataUrl }),
    }),

  /* ------------------------------------------------- 简介翻译（v1.4.0） */
  translationStatus: () => request<TranslationQueueStatus>('/api/translate/summary'),
  translationJobs: (limit = 100) =>
    request<{ jobs: Array<Record<string, unknown>> }>(`/api/translate/jobs?limit=${limit}`),
  translationQueueAction: (action: 'retry-all' | 'cancel-all' | 'backfill' | 'wake') =>
    request<Record<string, unknown>>('/api/translate/queue', {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  /** 立即翻译 / 重新翻译（只重新生成中文，原文只读） */
  translateSubject: (id: number) =>
    request<{ queued: boolean; state: SubjectSummaryState | null }>(`/api/translate/subjects/${id}`, {
      method: 'POST',
    }),
  cancelSubjectTranslation: (id: number) =>
    request<{ cancelled: boolean; state: SubjectSummaryState | null }>(
      `/api/translate/subjects/${id}`,
      { method: 'DELETE' },
    ),

  verifyCredentials: () =>
    request<CredentialCheckResult>('/api/config/verify', { method: 'POST' }),

  syncStatus: () => request<SyncStatus>('/api/sync/status'),
  startSync: (body: { mode: 'full' | 'incremental' | 'enrich'; depth?: 1 | 2; forceDetail?: boolean }) =>
    request<{ run: SyncRunSummary; status: SyncStatus }>('/api/sync', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancelSync: () =>
    request<{ cancelled: boolean; status: SyncStatus }>('/api/sync/cancel', { method: 'POST' }),
  syncHistory: (limit = 20) =>
    request<{ runs: SyncRunSummary[] }>(`/api/sync/history?limit=${limit}`),

  subjects: (query: SubjectQuery) =>
    request<Page<SubjectListItem>>(`/api/subjects?${queryToSearchParams(query).toString()}`),
  subjectTags: (query: SubjectQuery) =>
    request<TagCountList>(`/api/subjects/tags?${queryToSearchParams(query).toString()}`),
  /** 主搜索栏的全局实体检索（作品 / 标签 / 人员 / 公司 / 导演） */
  searchEntities: (query: string, limit = 8) => {
    const params = new URLSearchParams();
    params.set('q', query.trim());
    params.set('limit', String(limit));
    return request<EntitySearchResult>(`/api/search/entities?${params.toString()}`);
  },
  /** 制作人员 / 公司检索（全量可搜索，含只出现一次的人员） */
  staffSearch: (query: string, limit = 60) => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    params.set('limit', String(limit));
    return request<StaffSearchResult>(`/api/staff/search?${params.toString()}`);
  },
  subject: (id: number) => request<SubjectDetail>(`/api/subjects/${id}`),
  facets: () => request<FilterFacets>('/api/subjects/facets'),
  series: (options: { sort?: string; includeSingletons?: boolean; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.sort) params.set('sort', options.sort);
    if (options.includeSingletons) params.set('includeSingletons', '1');
    if (options.limit) params.set('limit', String(options.limit));
    return request<{ series: SeriesGroupSummary[] }>(`/api/series?${params.toString()}`);
  },
  seriesDetail: (key: string, visibility?: 'visible' | 'real', evidence: EvidenceMode = 'visible') =>
    evidenceRequest<SeriesDetail>(
      `/api/series/${encodeURIComponent(key)}${visibility ? `?visibility=${visibility}` : ''}`, evidence,
    ),
  setSeriesTitle: (key: string, input: SeriesTitleOverrideInput) =>
    request<{ ok: boolean; title: string; series: SeriesDetail | null }>(
      `/api/series/${encodeURIComponent(key)}/title`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  resetSeriesTitle: (key: string) =>
    request<{ ok: boolean; title: string; series: SeriesDetail | null }>(
      `/api/series/${encodeURIComponent(key)}/title/reset`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** 候选治理：否决某个标题候选（v1.6.1） */
  rejectSeriesTitleCandidate: (key: string, title: string, reason?: string) =>
    request<{
      ok: boolean;
      rejected: string;
      titleChanged: boolean;
      newTitle: string | null;
      series: SeriesDetail | null;
    }>(`/api/series/${encodeURIComponent(key)}/title/candidates/reject`, {
      method: 'POST',
      body: JSON.stringify({ title, ...(reason ? { reason } : {}) }),
    }),
  /** 候选治理：重新进入评估被否决的标题候选（v1.6.2） */
  reopenSeriesTitleCandidate: (key: string, title: string, reason?: string) =>
    request<{
      ok: boolean;
      reopened: string;
      titleChanged: boolean;
      newTitle: string | null;
      series: SeriesDetail | null;
    }>(`/api/series/${encodeURIComponent(key)}/title/candidates/reopen`, {
      method: 'POST',
      body: JSON.stringify({ title, ...(reason ? { reason } : {}) }),
    }),
  searchSeries: (q: string, limit = 40) =>
    request<IpSearchResponse<SeriesSearchHit>>(
      `/api/series/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  searchFranchises: (q: string, limit = 40) =>
    request<IpSearchResponse<FranchiseSearchHit>>(
      `/api/franchises/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  franchises: (options: { sort?: string; state?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.sort) params.set('sort', options.sort);
    if (options.state && options.state !== 'all') params.set('state', options.state);
    if (options.limit) params.set('limit', String(options.limit));
    return request<{ franchises: FranchiseSummary[] }>(`/api/franchises?${params.toString()}`);
  },
  franchiseDetail: (key: string, visibility?: 'visible' | 'real', evidence: EvidenceMode = 'visible') =>
    evidenceRequest<FranchiseDetail>(
      `/api/franchises/${encodeURIComponent(key)}${visibility ? `?visibility=${visibility}` : ''}`, evidence,
    ),
  confirmFranchise: (key: string) =>
    request<{ confirmed: boolean; franchise: FranchiseDetail | null }>(
      `/api/franchises/${encodeURIComponent(key)}/confirm`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** 候选治理：否决家族候选（v1.6.1） */
  rejectFranchise: (key: string, reason?: string) =>
    request<{ rejected: boolean; previousState: string | null; franchise: FranchiseDetail | null }>(
      `/api/franchises/${encodeURIComponent(key)}/reject`,
      { method: 'POST', body: JSON.stringify({ ...(reason ? { reason } : {}) }) },
    ),
  /** 否决可逆：把已否决的家族放回候选状态。 */
  reopenFranchise: (key: string) =>
    request<{ reopened: boolean; franchise: FranchiseDetail | null }>(
      `/api/franchises/${encodeURIComponent(key)}/reopen`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** Franchise 成员 / 名称治理（v1.7.0）：执行前的影响预览。 */
  franchiseGovernancePreview: (
    key: string,
    query: { kind: FranchiseGovernanceKind; series?: string; title?: string },
    evidence: EvidenceMode = 'visible',
  ) => {
    const params = new URLSearchParams({ kind: query.kind });
    if (query.series) params.set('series', query.series);
    if (query.title) params.set('title', query.title);
    return evidenceRequest<FranchiseGovernancePreviewResponse>(
      `/api/franchises/${encodeURIComponent(key)}/governance/preview?${params.toString()}`, evidence,
    );
  },
  /** Franchise 成员 / 名称治理（v1.7.0）：Preview → Execute → Verify。 */
  runFranchiseGovernance: (key: string, payload: FranchiseGovernanceRequest, evidence: EvidenceMode = 'visible') =>
    evidenceRequest<FranchiseGovernanceResult>(
      `/api/franchises/${encodeURIComponent(key)}/governance`, evidence,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  relationAudit: () => request<RelationAudit>('/api/relations/audit'),

  /** 数据中枢：读取诊断报告（refresh=true 强制重新检测）。 */
  diagnostics: (refresh = false, page: { offset?: number } = {}, evidence: EvidenceMode = 'visible') => {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    if (page.offset) params.set('offset', String(page.offset));
    return evidenceRequest<DiagnosticsReport>(`/api/diagnostics${params.size ? `?${params}` : ''}`, evidence);
  },
  /** 数据中枢：治理 / 修复历史（只读，来自 entity_events + candidate_decisions）。 */
  diagnosticsHistory: (options: { entityKind?: string; actor?: string; limit?: number } = {}, evidence: EvidenceMode = 'visible') => {
    const params = new URLSearchParams();
    if (options.entityKind && options.entityKind !== 'all') params.set('entityKind', options.entityKind);
    if (options.actor && options.actor !== 'all') params.set('actor', options.actor);
    if (options.limit) params.set('limit', String(options.limit));
    return evidenceRequest<DiagnosticsHistoryResponse>(`/api/diagnostics/history?${params.toString()}`, evidence);
  },
  /** 数据中枢：执行修复（预览由报告给出，返回结果内包含重新检测后的报告）。 */
  runDiagnosticsRepair: (payload: DiagnosticsRepairRequest, evidence: EvidenceMode = 'visible') =>
    evidenceRequest<DiagnosticsRepairResult>('/api/diagnostics/repairs', evidence, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  dashboard: (signal?: AbortSignal) => request<DashboardPayload>('/api/stats/dashboard', { signal }),
  overview: () => request<OverviewStats>('/api/stats/overview'),
  distributions: () => request<DistributionStats>('/api/stats/distributions'),
  timeline: (granularity: 'year' | 'quarter' | 'month') =>
    request<TimelineStats>(`/api/stats/timeline?granularity=${granularity}`),
  bias: (limit = 12) => request<RatingBiasStats>(`/api/stats/bias?limit=${limit}`),
  studios: (limit = 20) => request<StudioStats>(`/api/stats/studios?limit=${limit}`),
  directors: (limit = 20) => request<StudioStats>(`/api/stats/directors?limit=${limit}`),
  habits: () => request<HabitsStats>('/api/stats/habits'),
  /** 结构化画像数据（不依赖 AI） */
  profileDataset: () => request<ProfileDataset>('/api/profile/dataset'),
  profileAiStatus: (signal?: AbortSignal, reportId?: number) =>
    request<ProfileAiStatus>(reportId === undefined ? '/api/profile/ai' : `/api/profile/ai?reportId=${reportId}`, { signal }),
  generateProfileAi: async (force = false, signal?: AbortSignal) => {
    try {
      return await request<{ report: ProfileAiStatus['report']; reused: boolean }>('/api/profile/ai', {
        method: 'POST', body: JSON.stringify({ force }), signal,
      });
    } catch (error) {
      if (signal?.aborted || error instanceof ApiRequestError && ['network_error', 'response_unreadable'].includes(error.code)) {
        throw new ApiRequestError(signal?.aborted ? '已停止等待 AI 总结' : '未能确认本地服务的生成结果', {
          code: signal?.aborted ? 'ai_cancelled' : 'ai_result_unknown', resultUnknown: true, cause: error,
          hint: '上游可能已经接收请求或计费；不会自动重试。再次生成前请先读取报告状态。',
        });
      }
      throw error;
    }
  },
  profileSnapshots: () =>
    request<{ snapshots: ProfileSnapshotSummary[] }>('/api/profile/snapshots'),
  createProfileSnapshot: (input: {
    stageLabel: string;
    note?: string;
    source?: string;
    rankFrom?: number;
    rankTo?: number;
    candidateIds?: number[];
  }) =>
    request<{ snapshot: ProfileSnapshotSummary; snapshots: ProfileSnapshotSummary[] }>(
      '/api/profile/snapshots',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  deleteProfileSnapshot: (id: number) =>
    request<{ removed: boolean; snapshots: ProfileSnapshotSummary[] }>(
      `/api/profile/snapshots/${id}`,
      { method: 'DELETE' },
    ),
  profileCompare: (options: { from?: number; to?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.from) params.set('from', String(options.from));
    if (options.to) params.set('to', String(options.to));
    return request<{
      available: boolean;
      reason: string;
      comparison: ProfileComparison | null;
    }>(`/api/profile/compare?${params.toString()}`);
  },

  importPreview: (payload: unknown) =>
    request<ImportPreview>('/api/data/import?dryRun=true', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, true),
  importApply: (payload: unknown) =>
    request<ImportResult>('/api/data/import', { method: 'POST', body: JSON.stringify(payload) }),
  backups: () => request<{ backups: BackupInfo[] }>('/api/data/backups'),
  createBackup: () =>
    request<{ backup: BackupInfo; backups: BackupInfo[] }>('/api/data/backups', { method: 'POST' }),
  integrity: () => request<{ ok: boolean; result: string }>('/api/data/integrity'),

  coverStatus: () => request<CoverCacheStatus>('/api/covers/status'),
  cacheCovers: (limit = 2000) =>
    request<{ started: boolean }>('/api/covers/cache', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  clearCovers: () => request<{ removed: number }>('/api/covers', { method: 'DELETE' }),

  exportJsonUrl: () => '/api/data/export/json',
  exportCsvUrl: () => '/api/data/export/csv',
  backupUrl: (fileName: string) => `/api/data/backups/${encodeURIComponent(fileName)}`,
  coverUrl: (id: number) => `/api/covers/${id}`,
};
