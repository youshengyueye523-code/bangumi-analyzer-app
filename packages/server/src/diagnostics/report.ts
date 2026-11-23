import { supportsQualitySchema } from '../db/schema.js';
/**
 * 数据中枢报告：运行全部检测器并组装可缓存的报告。
 *
 * 缓存键 = 数据版本 + schema 版本 + NSFW 可见性开关：
 * - 同步 / 导入 / 修复会推进数据版本，缓存自动失效；
 * - 开关切换会改变可见性检查口径，同样自动失效；
 * - `refresh` 强制重新检测（诊断页的「重新检测」按钮与修复后的验证走这条路径）。
 */
import type {
  DiagnosticIssue,
  DiagnosticModule,
  DiagnosticSeverity,
  DiagnosticsReport,
  DiagnosticsScope,
  DiagnosticsSummary,
} from '@bangumi-analyzer/shared';
import { ApiError } from '@bangumi-analyzer/shared';
import { dataVersion, one, schemaVersion } from '../db/index.js';
import { lastMutation } from '../db/mutation.js';
import { hideNsfwEnabled } from '../db/visibility.js';
import { nowIso } from '../util.js';
import { DETECTORS } from './detectors.js';
import { bindGenericRecomputeActions } from './genericPlan.js';
import { observationRevision, reportFreshness } from './freshness.js';
import { inspectSourceSnapshots } from './sourceSnapshots.js';

const SEVERITY_ORDER: DiagnosticSeverity[] = [
  'error',
  'suspicious',
  'needs-review',
  'uncertain',
  'external',
  'info',
];

let cache: { key: string; report: DiagnosticsReport; observed: number; revision: string } | null = null;

export function invalidateDiagnosticsReport(): void {
  cache = null;
}

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

export function getDiagnosticsReport(options: { refresh?: boolean } = {}): DiagnosticsReport {
  // A failed explicit re-observation must never fall back to a formerly green cached report.
  if (options.refresh) cache = null;
  // Keep the existing unsupported-Schema failure contract; no new module may imply coverage.
  if (!supportsQualitySchema(schemaVersion())) inspectSourceSnapshots();
  const hideNsfw = hideNsfwEnabled();
  const version = dataVersion();
  const key = `${version}:${schemaVersion()}:${hideNsfw ? 'hidden' : 'all'}`;
  if (!options.refresh && cache && cache.key === key) {
    // Never turn ordinary reads into repeated full scans. Return explicit stale evidence instead.
    const freshness = reportFreshness(cache.observed, cache.revision);
    return freshness.status === cache.report.freshness?.status && freshness.reason === cache.report.freshness.reason
      ? cache.report : { ...cache.report, freshness };
  }

  const startedAt = Date.now();
  const revision = observationRevision();
  const modules: DiagnosticModule[] = [];
  const issues: DiagnosticIssue[] = [];
  for (const detector of DETECTORS) {
    const result = detector({ hideNsfw });
    modules.push(result.module);
    issues.push(...result.issues);
  }
  bindGenericRecomputeActions(issues);

  issues.sort((a, b) => {
    const severity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (severity !== 0) return severity;
    if (a.affectedCount !== b.affectedCount) return b.affectedCount - a.affectedCount;
    return a.id.localeCompare(b.id);
  });

  const summary: DiagnosticsSummary = {
    error: 0,
    suspicious: 0,
    'needs-review': 0,
    uncertain: 0,
    external: 0,
    info: 0,
    total: issues.length,
  };
  for (const issue of issues) summary[issue.severity] += 1;

  const scope: DiagnosticsScope = {
    subjects: toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM subjects')?.n),
    collections: toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM collections')?.n),
    relations: toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM subject_relations')?.n),
    series: toNumber(
      one<{ n: number }>(`SELECT COUNT(*) AS n FROM series_entities WHERE state <> 'stale'`)?.n,
    ),
    franchises: toNumber(
      one<{ n: number }>(`SELECT COUNT(*) AS n FROM franchise_entities WHERE state <> 'stale'`)?.n,
    ),
    staleSeries: toNumber(
      one<{ n: number }>(`SELECT COUNT(*) AS n FROM series_entities WHERE state = 'stale'`)?.n,
    ),
  };

  const report: DiagnosticsReport = {
    coverage: { status: 'complete', note: '已完成全部注册检测项的判定；证据样本仅用于展示，不代表受影响总数。' },
    generatedAt: nowIso(),
    durationMs: Date.now() - startedAt,
    dataVersion: version,
    hideNsfw,
    lastMutation: lastMutation(),
    scope,
    summary,
    modules,
    issues,
  };
  const observedReport = { ...report, freshness: reportFreshness(startedAt, revision) };
  cache = { key, report: observedReport, observed: startedAt, revision };
  return observedReport;
}

/** Bound the HTTP display, not the detector's scan or internal verification target set. */
export function diagnosticsReportPage(
  report: DiagnosticsReport,
  options: { offset?: string; limit?: string } = {},
): DiagnosticsReport {
  const offset = options.offset === undefined ? 0 : Number(options.offset);
  const requested = options.limit === undefined ? 100 : Number(options.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requested) || requested < 1) {
    throw new ApiError('诊断分页参数不合法', { code: 'invalid_diagnostics_page', status: 400, dataIntact: true });
  }
  const limit = Math.min(200, requested);
  return { ...report, issues: report.issues.slice(offset, offset + limit),
    issuePage: { offset, limit, total: report.issues.length, hasMore: offset + limit < report.issues.length } };
}
