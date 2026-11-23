import { APP_VERSION, ensureDataDirs, loadConfig, paths, saveConfig } from './config.js';
import { BangumiClient } from './bangumi/client.js';
import { closeDatabase, integrityCheck, openDatabase, schemaVersion } from './db/index.js';
import { ensureSeriesEngine } from './db/series.js';
import { cleanupStaging } from './db/syncRuns.js';
import { CoverCache } from './images/coverCache.js';
import { buildApp } from './app.js';
import { SyncEngine } from './sync/engine.js';
import { refreshSummaryQueue } from './db/summaries.js';
import { TranslationWorker } from './translate/worker.js';
import { createServiceShutdown, stopAppResources } from './lifecycle.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  ensureDataDirs();

  const config = loadConfig();
  openDatabase({
    verbose: (message) => console.log(`[db] ${message}`),
  });

  const integrity = integrityCheck();
  if (integrity !== 'ok') {
    console.error(
      `[db] 数据库自检未通过：${integrity}\n` +
        '      数据可能已损坏。现有文件仍然保留，可尝试使用「设置 → 备份」中的历史备份恢复。',
    );
  }

  const interrupted = SyncEngine.recoverInterruptedRuns();
  if (interrupted > 0) {
    console.log(`[sync] 检测到 ${interrupted} 次异常中断的同步，已标记为「已中断」，数据保持可用。`);
  }
  cleanupStaging();

  /*
   * v1.5.1 语义重构：实体表为空的库（刚完成 migration v9）用现有数据重建一次，
   * 保证升级后旧链接仍能通过 alias 解析，而不是等下一次同步才有系列页面。
   */
  try {
    if (ensureSeriesEngine()) {
      console.log('[series] 检测到 Series / Franchise 派生数据缺失或过期，已按现有收藏数据重建');
    }
  } catch (error) {
    console.error(`[series] 系列引擎初始化失败（不影响其它功能）：${(error as Error).message}`);
  }

  const client = new BangumiClient({
    token: config.token,
    userAgent: config.userAgent,
    requestIntervalMs: config.requestIntervalMs,
    httpProxy: config.httpProxy,
  });
  const coverCache = new CoverCache(client);
  /**
   * 简介翻译 worker：与同步完全解耦的后台任务。
   * 启动时会把上次异常退出遗留的 processing 任务复位为 pending（断点恢复）。
   */
  const translationWorker = new TranslationWorker({
    getConfig: () => loadConfig().ai,
    concurrency: () => loadConfig().summaryConcurrency,
    log: (message) => console.log(`[translate] ${message}`),
  });

  let coverJobStarted = false;
  let shuttingDown = false;
  const engine = new SyncEngine({
    client,
    getConfig: () => loadConfig(),
    saveUsername: (username) => {
      saveConfig({ username });
    },
    onChange: (progress) => {
      if (shuttingDown) return;
      if (progress.phase === 'done' && !coverJobStarted && loadConfig().cacheCovers) {
        coverJobStarted = true;
        void coverCache.start({ limit: 3000 });
      }
      // 同步过程中产生了新的翻译任务 → 立刻唤醒后台 worker（不阻塞同步）
      if (
        progress.phase === 'applying' ||
        progress.phase === 'enriching' ||
        progress.phase === 'done'
      ) {
        translationWorker.wakeUp();
      }
    },
  });

  const deps = { client, engine, coverCache, translationWorker };
  const app = await buildApp({ deps });

  /*
   * 历史数据回填：重新解析全部简介结构、识别语言，并把「可翻译但没有有效中文」
   * 的作品补进队列，同时把原文已变化的旧任务标记为历史失效。
   * 幂等：重复启动不会重复消耗 token。
   */
  try {
    const scan = refreshSummaryQueue(new Date().toISOString());
    console.log(
      `[translate] 简介扫描：收藏 ${scan.scanned} 条（官方中文 ${scan.chinese} / 双语 ${scan.bilingual} / ` +
        `可翻译外文 ${scan.translatable} / 语言无法识别 ${scan.unknown}），` +
        `新入队 ${scan.enqueued} 条，历史失效 ${scan.obsoleted} 条`,
    );
  } catch (error) {
    console.error(`[translate] 简介队列初始化失败（不影响其他功能）：${(error as Error).message}`);
  }
  translationWorker.start();

  const shutdown = createServiceShutdown({
    closeServer: () => app.close(), stopResources: () => stopAppResources(deps), closeDatabase,
    onStart: () => { shuttingDown = true; app.log.info('正在关闭服务…'); },
    onError: (error) => { app.log.error({ err: error }, '关闭失败；数据库保持打开，可重试退出'); process.exitCode = 1; },
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try { await app.listen({ port: PORT, host: HOST }); }
  catch (error) {
    app.log.error({ err: error }, '服务监听失败');
    await shutdown(1);
    return;
  }
  console.log(
    [
      '',
      `  Bangumi 个人动画数据库 v${APP_VERSION}`,
      `  ├─ 服务地址  http://${HOST}:${PORT}`,
      `  ├─ 数据目录  ${paths.dataDir}`,
      `  ├─ 数据库    ${paths.dbFile}（schema v${schemaVersion()}）`,
      `  ├─ 用户名    ${config.username || '（未配置）'}`,
      `  ├─ Token     ${config.token ? '已配置' : '未配置（仅可同步公开收藏）'}`,
      `  └─ 请求间隔  ${config.requestIntervalMs} ms`,
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error('[fatal] 服务启动失败：', error);
  closeDatabase();
  process.exit(1);
});
