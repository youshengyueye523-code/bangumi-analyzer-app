import fastifyStatic from '@fastify/static';
import { ApiError, type HealthResponse } from '@bangumi-analyzer/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION, PROJECT_ROOT, loadConfig, paths } from './config.js';
import { countRows, schemaVersion, expectedSchemaVersion } from './db/index.js';
import type { CoverCache } from './images/coverCache.js';
import { buildLoggerOptions } from './logger.js';
import { apiNotFoundPayload, registerErrorHandler } from './http/errors.js';
import { registerConfigRoutes } from './http/routes/config.js';
import { registerCoverRoutes } from './http/routes/covers.js';
import { registerDataRoutes } from './http/routes/data.js';
import { registerDiagnosticsRoutes } from './http/routes/diagnostics.js';
import { registerProfileRoutes } from './http/routes/profile.js';
import { registerStatsRoutes } from './http/routes/stats.js';
import { registerSubjectRoutes } from './http/routes/subjects.js';
import { registerSyncRoutes } from './http/routes/sync.js';
import { registerTranslateRoutes } from './http/routes/translate.js';
import { registerWallpaperRoutes } from './http/routes/wallpaper.js';
import type { BangumiClient } from './bangumi/client.js';
import type { SyncEngine } from './sync/engine.js';
import type { TranslationWorker } from './translate/worker.js';
import { stopAppResources } from './lifecycle.js';
import { registerEvidencePresentation } from './diagnostics/presentation.js';
import { registerUserGovernance } from './http/routes/userGovernance.js';

export interface AppDependencies {
  client: BangumiClient;
  engine: SyncEngine;
  coverCache: CoverCache;
  /** 简介翻译队列（可选：测试里可以只验证同步行为） */
  translationWorker?: TranslationWorker;
}

export interface BuildAppOptions {
  deps: AppDependencies;
  logger?: boolean;
}

const WEB_DIST = join(PROJECT_ROOT, 'packages', 'web', 'dist');

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : buildLoggerOptions(),
    bodyLimit: 64 * 1024 * 1024,
    // 本地个人工具：信任本机请求头，方便拿到真实 URL
    trustProxy: false,
  });

  registerErrorHandler(app, process.env.NODE_ENV !== 'production');
  registerEvidencePresentation(app);

  // Fastify 停止接收请求后收束全部生产者；DB 由 runtime 在完整屏障后关闭。
  app.addHook('onClose', () => stopAppResources(options.deps));

  // Local 服务没有账号认证：浏览器跨站的简单 POST 也可能触发副作用。
  // 在解析 body / 执行 route 之前拒绝；CLI 无 Origin 请求仍可用于本地自动化。
  app.addHook('onRequest', async (request) => {
    let host = '';
    try {
      const authority = new URL(`http://${request.headers.host ?? ''}`);
      if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) throw new Error('invalid host');
      host = authority.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    } catch { /* 非法 Host 与非本机 Host 一并拒绝 */ }
    const localAddress = (request.socket.localAddress ?? '').replace(/^::ffff:/, '').toLowerCase();
    const configuredHost = (process.env.HOST ?? '').toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
    const explicitlyBound = configuredHost && !['0.0.0.0', '::'].includes(configuredHost) && host === configuredHost;
    if (!host || (!loopback && host !== localAddress && !explicitlyBound)) {
      throw new ApiError('已拒绝非本机 Host 的访问', {
        code: 'invalid_local_host', status: 403, dataIntact: true,
        hint: '请使用 localhost、本机监听地址或明确配置的 HOST 访问 Analyzer。',
      });
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    let sameOrigin = origin === undefined;
    if (origin) {
      try {
        sameOrigin = new URL(origin).origin === new URL(`${request.protocol}://${request.headers.host}`).origin;
      } catch {
        sameOrigin = false;
      }
    }
    if (!sameOrigin || request.headers['sec-fetch-site'] === 'cross-site') {
      throw new ApiError('已拒绝来自其他网站的本地写入请求', {
        code: 'cross_origin_request', status: 403, dataIntact: true,
        hint: '请从 Analyzer 本地页面执行操作。',
      });
    }
  });

  app.get('/api/health', async (): Promise<HealthResponse> => {
    let subjects = 0;
    let collections = 0;
    let dbOk = true;
    try {
      subjects = countRows('subjects');
      collections = countRows('collections');
    } catch {
      dbOk = false;
    }
    return {
      ok: dbOk && schemaVersion() === expectedSchemaVersion(),
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      dataDir: paths.dataDir,
      dbPath: paths.dbFile,
      subjects,
      collections,
      syncRunning: options.deps.engine.running,
    };
  });

  app.get('/api/theme.js', async (_request, reply) => {
    let mode = 'system';
    try {
      mode = loadConfig().theme;
    } catch {
      mode = 'system';
    }
    reply.header('Cache-Control', 'no-store');
    reply.type('application/javascript; charset=utf-8');
    return `window.__BANGUMI_INITIAL_THEME__=${JSON.stringify(mode)};`;
  });

  app.addHook('onSend',async (request,reply,payload)=>{
    const url=request.routeOptions.url ?? '';
    if (url.startsWith('/api/') && !url.startsWith('/api/wallpaper/')) reply.header('Cache-Control','no-store');
    return payload;
  });
  registerConfigRoutes(app, { client: options.deps.client, engine: options.deps.engine });
  registerSyncRoutes(app, { engine: options.deps.engine });
  registerSubjectRoutes(app);
  registerUserGovernance(app);
  registerStatsRoutes(app);
  registerDataRoutes(app);
  registerDiagnosticsRoutes(app);
  registerProfileRoutes(app, { getConfig: () => loadConfig() });
  registerCoverRoutes(app, { coverCache: options.deps.coverCache });
  registerWallpaperRoutes(app);
  if (options.deps.translationWorker) {
    registerTranslateRoutes(app, {
      worker: options.deps.translationWorker,
      getConfig: () => loadConfig(),
    });
  }

  // 生产模式：直接托管构建好的前端（单端口访问，无需额外启动 Vite）
  const hasWebBuild = existsSync(join(WEB_DIST, 'index.html'));
  if (hasWebBuild) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: '/',
      index: ['index.html'],
      // 使用通配路由（默认行为）：重新构建前端后无需重启服务即可访问新的带哈希资源
      wildcard: true,
      setHeaders: (response, filePath) => {
        // 带哈希的静态资源可以长期缓存；入口 HTML 必须每次校验
        response.setHeader(
          'cache-control',
          filePath.endsWith('index.html')
            ? 'no-cache'
            : 'public, max-age=604800, immutable',
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send(apiNotFoundPayload(request.url));
    }
    // 带扩展名的路径视为静态资源：找不到就返回 404，
    // 绝不能返回 HTML，否则浏览器会把 index.html 当成 JS/CSS 执行。
    const pathname = request.url.split('?')[0] ?? '';
    const looksLikeAsset = /\.[A-Za-z0-9]+$/.test(pathname);
    if (hasWebBuild && !looksLikeAsset) {
      return reply.type('text/html; charset=utf-8').send(createReadStream(join(WEB_DIST, 'index.html')));
    }
    if (looksLikeAsset) {
      return reply.status(404).type('text/plain; charset=utf-8').send('资源不存在');
    }
    return reply.status(404).send(
      new ApiError('前端尚未构建', {
        code: 'web_not_built',
        status: 404,
        hint: '开发时请访问 Vite 服务地址（默认 http://localhost:5173）；部署时请先执行 pnpm build。',
      }).message,
    );
  });

  return app;
}
