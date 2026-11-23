/**
 * 数据中枢（v1.6.0）HTTP 接口。
 *
 * - GET  /api/diagnostics          读取诊断报告（默认走缓存，?refresh=1 强制重新检测）
 * - POST /api/diagnostics/repairs  执行修复（预览由报告内给出，这里只负责执行与验证）
 */
import { ApiError, diagnosticsRepairRequestSchema } from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { listGovernanceHistory } from '../../db/history.js';
import { diagnosticsReportPage, getDiagnosticsReport } from '../../diagnostics/report.js';
import { runDiagnosticsRepair } from '../../diagnostics/repair.js';

export function registerDiagnosticsRoutes(app: FastifyInstance): void {
  app.get('/api/diagnostics', async (request) => {
    const query = request.query as { refresh?: string; offset?: string; limit?: string };
    const refresh = query.refresh === '1' || query.refresh === 'true';
    const page = diagnosticsReportPage(getDiagnosticsReport({ refresh }), query);
    if (Buffer.byteLength(JSON.stringify(page)) > 2_000_000) {
      throw new ApiError('诊断证据响应超过安全展示大小，未返回不完整的成功报告', {
        code: 'diagnostics_response_too_large', status: 413, dataIntact: true,
        hint: '请减小分页大小；单项证据仍过大时需要开发排查，不能解释为没有问题。',
      });
    }
    return page;
  });

  /**
   * 治理 / 修复历史（v1.6.2，只读）。
   * 数据完全来自 entity_events 与 candidate_decisions；此接口不提供任何写入能力。
   */
  app.get('/api/diagnostics/history', async (request) => {
    const query = request.query as { entityKind?: string; actor?: string; limit?: string };
    const limit = Number(query.limit ?? 30);
    return listGovernanceHistory({
      ...(query.entityKind ? { entityKind: query.entityKind } : {}),
      ...(query.actor ? { actor: query.actor } : {}),
      limit: Number.isFinite(limit) ? limit : 30,
    });
  });

  app.post('/api/diagnostics/repairs', async (request) => {
    const parsed = diagnosticsRepairRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('修复参数不合法', {
        code: 'invalid_repair_request',
        status: 400,
        dataIntact: true,
        hint: parsed.error.issues[0]?.message ?? '请检查 issueId 与 kind',
      });
    }
    const result = runDiagnosticsRepair(parsed.data);
    return { ...result, report: diagnosticsReportPage(result.report) };
  });
}
