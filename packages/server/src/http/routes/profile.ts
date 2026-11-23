import { createHash } from 'node:crypto';
import { ApiError, type ProfileAiStatus, type ProfileSnapshotSummary } from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AiError, aiCompletionUrl, buildProfileSummaryRequest, generateProfileSummary } from '../../ai/provider.js';
import { aiAvailability, type AiConfig, type AppConfig } from '../../config.js';
import {
  createSnapshot,
  currentMembers,
  deleteSnapshot,
  getSnapshot,
  listSnapshots,
} from '../../db/profileSnapshots.js';
import { latestReport, reportByHash, reportById, reportHistory, saveReport } from '../../db/profileReports.js';
import { buildProfileDataset, profileFranchiseStats } from '../../stats/profile.js';
import { compareSnapshots } from '../../stats/profileCompare.js';
import { personalHidesActive } from '../../db/visibility.js';

const hiddenReason = '存在主动隐藏作品，无法证明安全的历史画像内容暂不显示。';
function safeSnapshot(snapshot: ProfileSnapshotSummary): ProfileSnapshotSummary {
  return personalHidesActive() ? {...snapshot, stageLabel:'受保护快照', note:'', source:''} : snapshot;
}

const snapshotInputSchema = z.object({
  stageLabel: z.string().nullish(),
  note: z.string().nullish(),
  source: z.string().nullish(),
  rankFrom: z.number().finite().nullish(),
  rankTo: z.number().finite().nullish(),
  candidateIds: z.array(z.unknown()).nullish(),
});

function profileReportInput(config: AiConfig) {
  const body = buildProfileSummaryRequest(config.model, buildProfileDataset('real'), profileFranchiseStats());
  let endpoint: string | null = null;
  try { endpoint = aiCompletionUrl(config.baseUrl); }
  catch (error) { if (!(error instanceof AiError)) throw error; }
  // Hash the exact analysis request and generation conditions, not UI visibility,
  // dataVersion, or the key. Older formats stay readable but are not current.
  const hash = 'profile-real-v1:' + createHash('sha256')
    .update(JSON.stringify([config.provider, endpoint, body])).digest('hex');
  return { body, hash, endpoint };
}

export interface ProfileRouteDeps {
  getConfig: () => AppConfig;
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileRouteDeps): void {
  let generating = false;
  /** 结构化画像数据集（不依赖 AI，永远可用）。 */
  app.get('/api/profile/dataset', async () => buildProfileDataset());

  /** AI 可用性 + 最近一次总结。 */
  app.get('/api/profile/ai', async (request): Promise<ProfileAiStatus> => {
    const { reportId } = z.object({ reportId: z.coerce.number().int().positive().optional() }).parse(request.query);
    const config = deps.getConfig();
    const availability = aiAvailability(config.ai);
    const { hash, endpoint } = profileReportInput(config.ai);
    const report = reportId === undefined ? reportByHash(hash) ?? latestReport(hash) : reportById(reportId, hash);
    if (reportId !== undefined && !report) throw new ApiError('指定的 AI 总结不存在', { code: 'profile_ai_report_not_found', status: 404 });
    return {
      configured: availability.configured && endpoint !== null,
      enabled: config.ai.enabled,
      provider: config.ai.provider,
      model: config.ai.model,
      reason: availability.reason || (endpoint === null ? 'AI 接口地址格式无效' : ''),
      generating,
      reports: reportHistory(hash),
      report,
    };
  });

  /** 生成（或复用）AI 审美总结。 */
  app.post('/api/profile/ai', async (request, reply) => {
    const { force } = z.object({ force: z.boolean().optional() }).parse(request.body ?? {});
    const config = deps.getConfig();
    const availability = aiAvailability(config.ai);
    if (!availability.configured) {
      throw new ApiError('AI 总结当前不可用', {
        code: 'ai_not_configured',
        status: 400,
        hint: `${availability.reason}。画像的统计部分不受影响，可以继续使用。`,
      });
    }

    const { body, hash, endpoint } = profileReportInput(config.ai);
    if (!endpoint) throw new ApiError('AI 接口地址格式无效', { code: 'ai_configuration', status: 400 });
    if (!force) {
      const existing = reportByHash(hash);
      if (existing) return { report: existing, reused: true };
    }
    if (generating) throw new ApiError('已有 AI 总结正在生成，未重复发送请求', {
      code: 'profile_ai_in_progress', status: 409, hint: '请稍后读取 AI 状态。',
    });
    generating = true;
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once('close', onClose);
    let upstreamCompleted = false;
    try {
      const result = await generateProfileSummary({ config: config.ai, body, signal: controller.signal });
      upstreamCompleted = true;
      if (controller.signal.aborted) throw new AiError('cancelled', '已停止等待 AI 响应');
      // A completed result remains valuable even if business data changed in flight.
      const currentHash = profileReportInput(deps.getConfig().ai).hash;
      const id = saveReport({
        snapshotId: null, provider: result.provider, model: result.model, datasetHash: hash,
        output: result.output, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens,
      });
      return { report: reportById(id, currentHash), reused: false };
    } catch (error) {
      if (error instanceof AiError) {
        const resultUnknown = !['configuration', 'disabled', 'auth', 'rate_limit'].includes(error.kind);
        const status = error.kind === 'timeout' ? 504 : error.kind === 'rate_limit' ? 429
          : error.kind === 'cancelled' ? 499 : error.kind === 'configuration' || error.kind === 'disabled' ? 400 : 502;
        throw new ApiError(`AI 总结生成失败：${error.message}`, {
          code: `ai_${error.kind}`,
          status, resultUnknown,
          hint: [error.hint, resultUnknown ? '上游可能已接收请求或计费；不会自动重试。再次生成前请先读取报告状态。' : '已有报告不受影响。'].filter(Boolean).join(' '),
        });
      }
      if (upstreamCompleted) throw new ApiError('AI 已响应，但本机未能确认保存结果', {
        code: 'profile_ai_save_unknown', status: 500, resultUnknown: true,
        hint: '请求可能已经计费。请先读取报告状态，不会自动重试。',
      });
      throw error;
    } finally {
      reply.raw.off('close', onClose);
      generating = false;
    }
  });

  app.get('/api/profile/snapshots', async () => ({ snapshots: listSnapshots().map(safeSnapshot) }));

  app.post('/api/profile/snapshots', async (request, reply) => {
    const parsed = snapshotInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('快照字段类型不合法', { code: 'invalid_snapshot_input', status: 400 });
    }
    const body = parsed.data;
    const label = (body.stageLabel ?? '').trim();
    if (!label) {
      throw new ApiError('阶段名称不能为空', {
        code: 'invalid_stage_label',
        status: 400,
        hint: '例如「2026 秋 · 第一轮复盘」。',
      });
    }
    const dataset = buildProfileDataset('real');
    if (dataset.sample.total === 0) {
      throw new ApiError('当前没有收藏数据，无法创建快照', {
        code: 'empty_dataset',
        status: 400,
        hint: '先完成一次同步再创建阶段快照。',
      });
    }
    const candidateIds = Array.isArray(body.candidateIds)
      ? body.candidateIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0)
      : null;
    const summary = createSnapshot({
      stageLabel: label,
      note: (body.note ?? '').slice(0, 500),
      source: (body.source ?? '').slice(0, 120),
      rankFrom: Number.isFinite(body.rankFrom) ? Number(body.rankFrom) : null,
      rankTo: Number.isFinite(body.rankTo) ? Number(body.rankTo) : null,
      candidateIds,
      dataset,
      members: currentMembers(),
    });
    return reply.status(201).send({ snapshot: safeSnapshot(summary), snapshots: listSnapshots().map(safeSnapshot) });
  });

  app.delete('/api/profile/snapshots/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    if (!Number.isInteger(id)) {
      throw new ApiError('快照 ID 不合法', { code: 'invalid_snapshot_id', status: 400 });
    }
    const removed = deleteSnapshot(id);
    if (!removed) {
      throw new ApiError('快照不存在', { code: 'snapshot_not_found', status: 404 });
    }
    return reply.status(200).send({ removed: true, snapshots: listSnapshots().map(safeSnapshot) });
  });

  /** 阶段对比：默认对比最近两次快照。 */
  app.get('/api/profile/compare', async (request) => {
    if (personalHidesActive()) return {available:false, reason:hiddenReason, comparison:null};
    const query = request.query as { from?: string; to?: string };
    const snapshots: ProfileSnapshotSummary[] = listSnapshots();
    if (snapshots.length < 2 && (!query.from || !query.to)) {
      return {
        available: false,
        reason:
          snapshots.length === 0
            ? '还没有保存过任何阶段快照。保存第一个阶段快照后，下次复盘就能进行对比。'
            : '目前只有 1 个阶段快照，无法进行阶段对比；等下一阶段复盘时保存第二个快照即可。',
        comparison: null,
      };
    }
    const toId = query.to ? Number(query.to) : snapshots[0]!.id;
    const fromId = query.from ? Number(query.from) : snapshots[1]!.id;
    if (!getSnapshot(fromId) || !getSnapshot(toId)) {
      throw new ApiError('指定的快照不存在', { code: 'snapshot_not_found', status: 404 });
    }
    const comparison = compareSnapshots(fromId, toId);
    if (!comparison) return {
      available: false,
      reason: '历史快照口径未确认、评分口径不同、不是完整 Real 数据或保存的统计/成员结构异常，不能进行阶段对比；历史记录仍可浏览和删除。',
      comparison: null,
    };
    return { available: true, reason: '', comparison };
  });
}
