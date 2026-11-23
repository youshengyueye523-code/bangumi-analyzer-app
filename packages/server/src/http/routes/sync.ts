import { syncRequestSchema } from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { listSyncRuns } from '../../db/syncRuns.js';
import type { SyncEngine } from '../../sync/engine.js';

export interface SyncRouteDeps {
  engine: SyncEngine;
}

export function registerSyncRoutes(app: FastifyInstance, deps: SyncRouteDeps): void {
  app.get('/api/sync/status', async () => deps.engine.getStatus());

  app.get('/api/sync/history', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number(query.limit ?? 20);
    return { runs: listSyncRuns(Number.isFinite(limit) ? limit : 20) };
  });

  app.post('/api/sync', async (request, reply) => {
    const body = syncRequestSchema.parse(request.body ?? { mode: 'incremental' });
    const run = deps.engine.start(body);
    return reply.status(202).send({ run, status: deps.engine.getStatus() });
  });

  app.post('/api/sync/cancel', async () => {
    const cancelled = deps.engine.cancel();
    return { cancelled, status: deps.engine.getStatus() };
  });
}
