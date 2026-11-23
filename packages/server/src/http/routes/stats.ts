import type { DashboardPayload } from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { listSubjects } from '../../db/query.js';
import { hideNsfwEnabled } from '../../db/visibility.js';
import {
  directors,
  distributions,
  habits,
  overview,
  ratingBias,
  studios,
  timeline,
} from '../../stats/queries.js';
import { nowIso } from '../../util.js';

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.round(parsed)));
}

export function registerStatsRoutes(app: FastifyInstance): void {
  // Analysis reads the real collection, regardless of UI display settings.
  app.get('/api/stats/overview', async () => overview('real'));

  app.get('/api/stats/distributions', async () => distributions('real'));

  app.get('/api/stats/timeline', async (request) => {
    const query = request.query as { granularity?: string };
    const granularity =
      query.granularity === 'month' || query.granularity === 'quarter'
        ? query.granularity
        : 'year';
    return timeline(granularity, 'real');
  });

  app.get('/api/stats/bias', async (request) => {
    const query = request.query as { limit?: string };
    return ratingBias(clampLimit(query.limit, 12, 100), 'real');
  });

  app.get('/api/stats/studios', async (request) => {
    const query = request.query as { limit?: string };
    return studios(clampLimit(query.limit, 20, 200), 'real');
  });

  app.get('/api/stats/directors', async (request) => {
    const query = request.query as { limit?: string };
    return directors(clampLimit(query.limit, 20, 200), 'real');
  });

  app.get('/api/stats/habits', async () => habits('real'));

  /**
   * 首页聚合接口：一次请求返回 Dashboard 所需的全部数据。
   * 统计结果按数据版本缓存，因此重复访问不会重复计算。
   */
  app.get('/api/stats/dashboard', async (): Promise<DashboardPayload> => {
    return {
      generatedAt: nowIso(),
      hideNsfw: hideNsfwEnabled(),
      overview: overview('visible'),
      distributions: distributions('visible'),
      timeline: timeline('year', 'visible'),
      bias: ratingBias(8, 'visible'),
      recentlyUpdated: listSubjects({ sort: 'updated', order: 'desc', pageSize: 8 }).items,
      recentlyAdded: listSubjects({ sort: 'added', order: 'desc', pageSize: 8 }).items,
      inProgress: listSubjects({ status: [3], sort: 'progress', order: 'desc', pageSize: 8 }).items,
    };
  });
}
