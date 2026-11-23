import {
  ApiError,
  seriesTitleCandidateSchema,
  seriesTitleOverrideSchema,
  subjectQuerySchema,
  franchiseDecisionSchema,
  franchiseGovernanceRequestSchema,
} from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { transactionWithoutIndirectWrites } from '../../db/index.js';
import { diagnosticsReportPage } from '../../diagnostics/report.js';
import {
  aggregateTags,
  getFranchiseDetail,
  getFilterFacets,
  getRelationAudit,
  getSeriesDetail,
  getSubjectDetail,
  isFranchiseHidden,
  isSeriesHidden,
  isSubjectHidden,
  listFranchises,
  listSeries,
  listSubjects,
  searchEntities,
  searchStaff,
  type FranchiseSort,
  type SeriesSort,
} from '../../db/query.js';
import {
  applySeriesTitleOverride,
  confirmFranchise,
  rejectFranchiseCandidate,
  rejectSeriesTitleCandidate,
  reopenFranchiseCandidate,
  reopenSeriesTitleCandidate,
  resetSeriesTitleOverride,
} from '../../db/series.js';
import {
  buildFranchiseGovernancePreview,
  runFranchiseGovernance,
} from '../../diagnostics/franchiseGovernance.js';
import { searchFranchiseEntities, searchSeriesEntities } from '../../db/ipSearch.js';
import { personalHidesActive, type Visibility } from '../../db/visibility.js';

function directGovernanceWrite<T>(write: () => T): T {
  return transactionWithoutIndirectWrites(write, () => {
    throw new ApiError('治理操作触发了未授权的数据库写入，本次变更已回滚', {
      code: 'direct_governance_write_violation',
      status: 409,
      dataIntact: true,
      hint: '请刷新后检查当前状态；若问题仍在，请报告此错误。',
    });
  });
}

export function registerSubjectRoutes(app: FastifyInstance): void {
  app.addHook('preValidation', async request=>{
    const route=request.routeOptions.url ?? '';
    const match=/^\/api\/(series|franchises)\/:key\//.exec(route);
    if(!match || (request.method==='GET' && !route.endsWith('/governance/preview')) || !personalHidesActive())return;
    const key=decodeURIComponent((request.params as {key:string}).key);
    const series=(request.method==='GET' ? request.query : request.body) as {series?:string}|undefined;
    if ((match[1]==='series' ? isSeriesHidden(key) : isFranchiseHidden(key))
      || (typeof series?.series==='string' && isSeriesHidden(series.series))) {
      throw new ApiError('对象不在当前可见范围。',{code:'protected_governance_target',status:404,dataIntact:true});
    }
  });
  /** v1.8 Entity Analysis：整页口径，未提供时按当前 hideNsfw 设置解析。 */
  const parseVisibility = (value: unknown): Visibility | undefined =>
    value === 'real' || value === 'visible' ? value : undefined;

  app.get('/api/subjects', async (request) => {
    const query = subjectQuerySchema.parse(request.query ?? {});
    return listSubjects(query);
  });

  app.get('/api/subjects/facets', async () => getFilterFacets());

  /**
   * 标签反向追溯：对「当前筛选条件命中的作品」聚合标签。
   * 例如 staff=某制作人员 → 返回其作品涉及的全部标签及出现次数。
   */
  app.get('/api/subjects/tags', async (request) => {
    const query = subjectQuerySchema.parse(request.query ?? {});
    return aggregateTags(query);
  });

  /**
   * 制作人员 / 公司检索：覆盖 subject_staff 里的全部姓名（含只出现一次的人员）。
   * 不返回全量列表（数万人），而是提供搜索 + 热门排序，保证「搜得到」。
   */
  app.get('/api/staff/search', async (request) => {
    const raw = request.query as { q?: string; limit?: string };
    const limit = Number(raw.limit ?? 60);
    return searchStaff({
      ...(raw.q ? { q: raw.q } : {}),
      limit: Number.isFinite(limit) ? limit : 60,
    });
  });

  /**
   * 主搜索栏的全局实体检索：返回分类结果（作品 / 标签 / 人员 / 公司 / 导演）
   * 以及「相关作品数」，让用户知道每个实体在收藏库里对应多少部作品。
   */
  app.get('/api/search/entities', async (request) => {
    const raw = request.query as { q?: string; limit?: string };
    const limit = Number(raw.limit ?? 8);
    return searchEntities(raw.q ?? '', Number.isFinite(limit) ? limit : 8);
  });

  app.get('/api/subjects/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError('条目 ID 不合法', { code: 'invalid_subject_id', status: 400 });
    }
    const detail = getSubjectDetail(id);
    if (!detail) {
      if (isSubjectHidden(id)) {
        return reply.status(404).send({
          error: {
            code: 'subject_hidden',
            message: '内容已被当前隐私设置隐藏',
            hint: '请在设置中检查「主动隐藏」与「隐藏 NSFW 内容」。',
            dataIntact: true,
          },
        });
      }
      return reply.status(404).send({
        error: {
          code: 'subject_not_found',
          message: `本地数据库中没有条目 ${id} 的收藏记录`,
          hint: '它可能已被取消收藏，或尚未同步。可以到「设置」页面执行一次同步。',
          dataIntact: true,
        },
      });
    }
    return detail;
  });

  app.get('/api/series', async (request) => {
    const query = request.query as {
      sort?: string;
      includeSingletons?: string;
      limit?: string;
    };
    const sort = ['size', 'rate', 'year', 'title', 'coverage', 'completion'].includes(query.sort ?? '')
      ? (query.sort as SeriesSort)
      : 'size';
    const limit = Number(query.limit ?? 1000);
    return {
      series: listSeries({
        sort,
        includeSingletons: query.includeSingletons === '1' || query.includeSingletons === 'true',
        limit: Number.isFinite(limit) ? limit : 1000,
      }),
    };
  });

  /**
   * Series 域内搜索：范围是完整 Series 实体表（含单成员、含当前列表未显示的部分），
   * 结果固定为 Series；成员作品 / 别名只作为命中来源。
   */
  app.get('/api/series/search', async (request) => {
    const raw = request.query as { q?: string; limit?: string };
    const limit = Number(raw.limit ?? 40);
    return searchSeriesEntities(raw.q ?? '', { limit: Number.isFinite(limit) ? limit : 40 });
  });

  app.get('/api/series/:key', async (request, reply) => {
    const params = request.params as { key: string };
    const query = request.query as { visibility?: string };
    const key = decodeURIComponent(params.key);
    const detail = getSeriesDetail(key, { visibility: parseVisibility(query.visibility) });
    if (!detail) {
      if (isSeriesHidden(key)) {
        return reply.status(404).send({
          error: {
            code: 'series_hidden',
            message: '该系列已被当前隐私设置隐藏',
            hint: '系列中存在被隐藏的主要成员；请在设置中检查主动隐藏与 NSFW 设置。',
            dataIntact: true,
          },
        });
      }
      return reply.status(404).send({
        error: {
          code: 'series_not_found',
          message: '未找到该系列分组',
          hint: '系列分组会在每次同步后重新计算；可执行一次同步后再试。',
          dataIntact: true,
        },
      });
    }
    return detail;
  });

  /**
   * Title Review：把候选 / 自定义名称 / 当前名称确认为 manual canonical title。
   * manual 之后自动 resolver 只能生成 proposal，不会覆盖。
   */
  app.post('/api/series/:key/title', async (request, reply) => {
    const params = request.params as { key: string };
    const parsed = seriesTitleOverrideSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('标题参数不合法', {
        code: 'invalid_title_override',
        status: 400,
        hint: parsed.error.issues[0]?.message ?? '请检查 mode 与 title',
      });
    }
    const result = directGovernanceWrite(() => applySeriesTitleOverride(decodeURIComponent(params.key), parsed.data));
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : 400;
      throw new ApiError(result.message, { code: result.code, status, dataIntact: true });
    }
    return { ok: true, title: result.title, series: getSeriesDetail(result.key) };
  });

  /** 恢复自动解析：清除人工确认并按当前证据重新推导（仅用于纠正误操作）。 */
  app.post('/api/series/:key/title/reset', async (request, reply) => {
    const params = request.params as { key: string };
    const result = directGovernanceWrite(() => resetSeriesTitleOverride(decodeURIComponent(params.key)));
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : 400;
      throw new ApiError(result.message, { code: result.code, status, dataIntact: true });
    }
    return { ok: true, title: result.title, series: getSeriesDetail(result.key) };
  });

  /**
   * 候选治理：否决某个标题候选（v1.6.1）。
   *
   * Analyzer 可以推断，但不拥有最终裁决权：否决会写入真实的治理状态，
   * 候选保留在列表里用于解释，但退出展示竞争与搜索别名。
   */
  app.post('/api/series/:key/title/candidates/reject', async (request, reply) => {
    const params = request.params as { key: string };
    const parsed = seriesTitleCandidateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('候选参数不合法', {
        code: 'invalid_candidate',
        status: 400,
        dataIntact: true,
        hint: parsed.error.issues[0]?.message ?? '请检查 title',
      });
    }
    const result = directGovernanceWrite(() => rejectSeriesTitleCandidate(
      decodeURIComponent(params.key),
      parsed.data.title,
      parsed.data.reason ?? '',
    ));
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : 400;
      throw new ApiError(result.message ?? '无法否决该候选', {
        code: result.code ?? 'reject_failed',
        status,
        dataIntact: true,
      });
    }
    return {
      ok: true,
      rejected: parsed.data.title,
      titleChanged: result.titleChanged ?? false,
      newTitle: result.newTitle ?? null,
      series: getSeriesDetail(result.key!),
    };
  });

  /** 候选治理：重新进入评估某个被否决的标题候选（v1.6.2，与家族对称）。 */
  app.post('/api/series/:key/title/candidates/reopen', async (request, reply) => {
    const params = request.params as { key: string };
    const parsed = seriesTitleCandidateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('候选参数不合法', {
        code: 'invalid_candidate',
        status: 400,
        dataIntact: true,
        hint: parsed.error.issues[0]?.message ?? '请检查 title',
      });
    }
    const result = directGovernanceWrite(() => reopenSeriesTitleCandidate(
      decodeURIComponent(params.key),
      parsed.data.title,
      parsed.data.reason ?? '',
    ));
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : 400;
      throw new ApiError(result.message ?? '无法重新进入评估', {
        code: result.code ?? 'reopen_failed',
        status,
        dataIntact: true,
      });
    }
    return {
      ok: true,
      reopened: parsed.data.title,
      titleChanged: result.titleChanged ?? false,
      newTitle: result.newTitle ?? null,
      series: getSeriesDetail(result.key!),
    };
  });

  app.get('/api/franchises', async (request) => {
    const query = request.query as { sort?: string; state?: string; limit?: string };
    const sort = ['size', 'collected', 'year', 'title', 'coverage', 'completion', 'rate'].includes(
      query.sort ?? '',
    )
      ? (query.sort as FranchiseSort)
      : 'size';
    const state = ['all', 'candidate', 'provisional', 'confirmed', 'contested', 'rejected'].includes(
      query.state ?? '',
    )
      ? (query.state as string)
      : 'all';
    const limit = Number(query.limit ?? 500);
    return {
      franchises: listFranchises({
        sort,
        state,
        limit: Number.isFinite(limit) ? limit : 500,
      }),
    };
  });

  /** Franchise 域内搜索：Subject / Series 命中最终聚合成 Franchise。 */
  app.get('/api/franchises/search', async (request) => {
    const raw = request.query as { q?: string; limit?: string };
    const limit = Number(raw.limit ?? 40);
    return searchFranchiseEntities(raw.q ?? '', { limit: Number.isFinite(limit) ? limit : 40 });
  });

  app.get('/api/franchises/:key', async (request, reply) => {
    const params = request.params as { key: string };
    const query = request.query as { visibility?: string };
    const key = decodeURIComponent(params.key);
    const detail = getFranchiseDetail(key, { visibility: parseVisibility(query.visibility) });
    if (!detail) {
      if (isFranchiseHidden(key)) {
        return reply.status(404).send({
          error: {
            code: 'franchise_hidden',
            message: '该家族已被当前隐私设置隐藏',
            hint: '家族暂无可见成员；请在设置中检查主动隐藏与 NSFW 设置。',
            dataIntact: true,
          },
        });
      }
      return reply.status(404).send({
        error: {
          code: 'franchise_not_found',
          message: '未找到该作品家族',
          hint: '家族候选会在每次同步后重新计算；可执行一次同步后再试。',
          dataIntact: true,
        },
      });
    }
    return detail;
  });

  /**
   * 人工确认家族：confirmed 之后，自动 resolver 只能提出冲突/新候选，
   * 不得静默覆盖已确认结果。
   */
  app.post('/api/franchises/:key/confirm', async (request, reply) => {
    const params = request.params as { key: string };
    const ok = directGovernanceWrite(() => confirmFranchise(decodeURIComponent(params.key)));
    if (!ok) {
      return reply.status(404).send({
        error: {
          code: 'franchise_not_found',
          message: '未找到该作品家族，无法确认',
          dataIntact: true,
        },
      });
    }
    const detail = getFranchiseDetail(decodeURIComponent(params.key));
    return { confirmed: true, franchise: detail };
  });

  /**
   * 候选治理：否决家族候选（v1.6.1）。
   *
   * 否决是真实治理状态：下次重建不会静默改回候选；家族实体、成员链接与
   * 原始关系证据全部保留，只是不再作为待处理候选出现。
   */
  app.post('/api/franchises/:key/reject', async (request, reply) => {
    const params = request.params as { key: string };
    const parsed = franchiseDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('否决参数不合法', {
        code: 'invalid_candidate',
        status: 400,
        dataIntact: true,
      });
    }
    const result = directGovernanceWrite(() => rejectFranchiseCandidate(
      decodeURIComponent(params.key),
      parsed.data.reason ?? '',
    ));
    if (!result.ok) {
      return reply.status(404).send({
        error: {
          code: result.code ?? 'franchise_not_found',
          message: result.message ?? '未找到该作品家族，无法否决',
          dataIntact: true,
        },
      });
    }
    const detail = getFranchiseDetail(result.key!);
    return { rejected: true, previousState: result.previousState ?? null, franchise: detail };
  });

  /** 否决可逆：把已否决的家族放回候选状态，重新参与评估。 */
  app.post('/api/franchises/:key/reopen', async (request, reply) => {
    const params = request.params as { key: string };
    const result = directGovernanceWrite(() => reopenFranchiseCandidate(decodeURIComponent(params.key)));
    if (!result.ok) {
      return reply.status(400).send({
        error: {
          code: result.code ?? 'reopen_failed',
          message: result.message ?? '无法重新评估该家族',
          dataIntact: true,
        },
      });
    }
    const detail = getFranchiseDetail(result.key!);
    return { reopened: true, franchise: detail };
  });

  /**
   * Franchise 成员 / 名称治理（v1.7.0）：执行前的 Repair Preview。
   *
   * 与执行共用同一套判定，允许的动作 / 原因 / 影响链在这里先展示给用户。
   */
  app.get('/api/franchises/:key/governance/preview', async (request, reply) => {
    const params = request.params as { key: string };
    const query = request.query as { kind?: string; series?: string; title?: string };
    const parsed = franchiseGovernanceRequestSchema.safeParse({
      kind: query.kind,
      ...(query.series ? { series: query.series } : {}),
      ...(query.title ? { title: query.title } : {}),
    });
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'invalid_governance_action',
          message: '治理动作参数不合法',
          dataIntact: true,
        },
      });
    }
    return buildFranchiseGovernancePreview({
      kind: parsed.data.kind,
      franchiseKey: decodeURIComponent(params.key),
      seriesKey: parsed.data.series,
      title: parsed.data.title,
    });
  });

  /**
   * Franchise 成员 / 名称治理执行：Preview → Execute → Verify。
   *
   * 执行只修改合法的 source-of-truth（成员排除治理记录 / 家族名称），
   * 随后重新计算派生投影并逐层验证；任何一层未通过都会如实标记为部分成功。
   */
  app.post('/api/franchises/:key/governance', async (request) => {
    const params = request.params as { key: string };
    const parsed = franchiseGovernanceRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('治理动作参数不合法', {
        code: 'invalid_governance_action',
        status: 400,
        dataIntact: true,
      });
    }
    const result = runFranchiseGovernance({
      kind: parsed.data.kind,
      franchiseKey: decodeURIComponent(params.key),
      seriesKey: parsed.data.series,
      title: parsed.data.title,
      reason: parsed.data.reason,
    });
    return { ...result, report: diagnosticsReportPage(result.report) };
  });

  /** 关系类型审计：数据库里出现的全部 relation 及其分类，unknown 永不静默合并。 */
  app.get('/api/relations/audit', async () => getRelationAudit());
}
