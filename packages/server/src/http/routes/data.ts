import { ApiError } from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { createBackup, listBackups, resolveBackupPath } from '../../data/backup.js';
import { buildCsv, buildExportPayload } from '../../data/export.js';
import { applyImport, previewImport } from '../../data/import.js';
import { getDatabase } from '../../db/index.js';
import { personalHidesActive } from '../../db/visibility.js';
import { requirePrivateIntent } from '../privateIntent.js';

export function registerDataRoutes(app: FastifyInstance): void {
  app.get('/api/data/export/json', async (request, reply) => {
    if (personalHidesActive()) requirePrivateIntent(request, 'full-data');
    const payload = buildExportPayload();
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="bangumi-analyzer-${stamp}.json"`)
      .send(JSON.stringify(payload, null, 2));
  });

  app.get('/api/data/export/csv', async (_request, reply) => {
    const csv = buildCsv(personalHidesActive() ? 'visible' : 'real');
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="bangumi-collection-${stamp}.csv"`)
      .send(csv);
  });

  app.post('/api/data/import', async (request) => {
    const query = request.query as { dryRun?: string };
    const dryRun = query.dryRun === 'true' || query.dryRun === '1';
    const payload = request.body;
    if (payload === undefined || payload === null) {
      throw new ApiError('导入内容为空', {
        code: 'empty_import',
        status: 400,
        hint: '请选择由本工具导出的 JSON 文件，或 Bangumi 收藏接口返回的 JSON。',
      });
    }
    if (dryRun) return previewImport(payload);
    return applyImport(payload);
  });

  app.get('/api/data/backups', async () => ({ backups: listBackups() }));

  app.post('/api/data/backups', async () => ({ backup: createBackup(), backups: listBackups() }));

  app.get('/api/data/backups/:fileName', async (request, reply) => {
    const params = request.params as { fileName: string };
    if (personalHidesActive()) requirePrivateIntent(request, 'full-data');
    const path = resolveBackupPath(params.fileName);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${params.fileName}"`)
      .send(createReadStream(path));
  });

  /** 数据库自检：用于排查本地数据文件是否损坏。 */
  app.get('/api/data/integrity', async () => {
    const row = getDatabase().prepare('PRAGMA quick_check').get() as
      | { quick_check?: string }
      | undefined;
    const result = String(row?.quick_check ?? 'unknown');
    return { ok: result === 'ok', result };
  });
}
