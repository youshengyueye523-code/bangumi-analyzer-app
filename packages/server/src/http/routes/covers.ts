import { ApiError } from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { one } from '../../db/index.js';
import { subjectVisibilityClause } from '../../db/visibility.js';
import {
  contentTypeForFile,
  createCoverStream,
  type CoverCache,
} from '../../images/coverCache.js';

const ALLOWED_HOSTS = ['lain.bgm.tv', 'api.bgm.tv'];

function isAllowedRemote(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

export interface CoverRouteDeps {
  coverCache: CoverCache;
}

export function registerCoverRoutes(app: FastifyInstance, deps: CoverRouteDeps): void {
  app.get('/api/covers/status', async () => deps.coverCache.status());

  app.post('/api/covers/cache', async (request) => {
    const body = (request.body ?? {}) as { limit?: number };
    const limit = Number(body.limit ?? 2000);
    if (deps.coverCache.status().running) {
      throw new ApiError('封面缓存任务正在运行', { code: 'cover_job_running', status: 409 });
    }
    void deps.coverCache.start({ limit: Number.isFinite(limit) ? limit : 2000 });
    return { started: true, status: deps.coverCache.status() };
  });

  app.delete('/api/covers', async () => ({ removed: deps.coverCache.removeAll() }));

  /**
   * 封面访问入口：已缓存则直接返回本地文件（离线可用），
   * 未缓存则 302 跳转到 Bangumi 图床，前端无需关心具体来源。
   */
  app.get('/api/covers/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError('条目 ID 不合法', { code: 'invalid_subject_id', status: 400 });
    }
    // v1.5.3：隐藏状态下不得通过封面接口泄露 NSFW 内容（本地缓存文件同样拦截）
    {
      const hidden = one<{ nsfw: number }>(
        `SELECT nsfw FROM subjects s WHERE s.id = :id AND NOT (${subjectVisibilityClause('s')})`,
        { id },
      );
      if (hidden) {
        throw new ApiError('内容已被当前隐私设置隐藏', {
          code: 'cover_hidden',
          status: 404,
          dataIntact: true,
        });
      }
    }
    const cached = deps.coverCache.localFile(id);
    if (cached) {
      return reply
        .header('content-type', contentTypeForFile(cached))
        // URL 按条目 ID 寻址，同一地址可以在同步/清理后返回不同图片。
        .header('cache-control', 'no-cache')
        .send(createCoverStream(cached));
    }
    const row = one<{ cover_url: string | null }>(
      'SELECT cover_url FROM subjects WHERE id = :id',
      { id },
    );
    if (!row?.cover_url || !isAllowedRemote(row.cover_url)) {
      throw new ApiError('没有可用的封面地址', {
        code: 'cover_unavailable',
        status: 404,
        dataIntact: true,
      });
    }
    return reply.redirect(row.cover_url, 302);
  });
}
