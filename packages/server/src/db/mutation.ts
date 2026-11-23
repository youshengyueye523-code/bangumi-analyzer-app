/**
 * 统一 Mutation Contract（v1.6.1）。
 *
 * 任何改变 Analyzer 数据语义的写操作都必须经过这里：
 *
 *   mutation（真实写入）
 *     ↓
 *   recordMutation(scope)
 *     ↓
 *   bumpDataVersion()            —— 所有以数据版本为键的缓存（stats / diagnostics）自动失效
 *     ↓
 *   invalidateStatsCache()       —— 统计派生缓存
 *   invalidateDiagnosticsReport()—— 数据中枢报告缓存
 *     ↓
 *   记录 last_mutation_*（meta） —— 诊断页可以如实说明「最近一次数据变更来自哪里」
 *
 * 这样新增写入口时不再需要开发者自己记住「这里要不要 bumpDataVersion」：
 * 调用 recordMutation 即可，诊断状态不会继续停留在旧报告上。
 */
import { bumpDataVersion, getMeta, setMeta } from './index.js';
import { invalidateStatsCache } from '../stats/cache.js';
import { invalidateDiagnosticsReport } from '../diagnostics/report.js';
import { nowIso } from '../util.js';

export type MutationScope =
  | 'sync'
  | 'import'
  | 'governance'
  | 'repair'
  | 'cover'
  | 'translation'
  | 'maintenance';

export interface MutationResult {
  scope: MutationScope;
  dataVersion: number;
  invalidated: string[];
  at: string;
}

/** 记录一次真实数据变更：推进数据版本并失效所有以数据版本为键的派生缓存。 */
export function recordMutation(scope: MutationScope, detail = ''): MutationResult {
  const version = bumpDataVersion();
  invalidateStatsCache();
  invalidateDiagnosticsReport();
  const at = nowIso();
  try {
    setMeta('last_mutation_scope', scope);
    setMeta('last_mutation_at', at);
    if (detail) setMeta('last_mutation_detail', detail.slice(0, 240));
  } catch {
    // meta 写入失败不影响数据本身；缓存已经失效，诊断仍会重新检测
  }
  return {
    scope,
    dataVersion: version,
    invalidated: ['stats-cache', 'diagnostics-report', 'data-version'],
    at,
  };
}

/** 读取最近一次数据变更（诊断报告用于解释数据新鲜度）。 */
export function lastMutation(): { scope: string | null; at: string | null; detail: string | null } {
  return {
    scope: (getMeta('last_mutation_scope') as string | null) ?? null,
    at: (getMeta('last_mutation_at') as string | null) ?? null,
    detail: (getMeta('last_mutation_detail') as string | null) ?? null,
  };
}
