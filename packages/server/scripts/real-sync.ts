/**
 * 命令行同步工具（不启动 HTTP 服务）：
 *
 *   pnpm -C packages/server run sync:cli
 *
 * 读取的配置与网页端完全一致（data/config.json + 环境变量），
 * 常用于：首次全量同步、定时任务（Windows 计划任务 / cron）、CI 中验证真实 API。
 *
 * 环境变量：
 *   BANGUMI_USERNAME         Bangumi 用户名或 UID
 *   BANGUMI_ACCESS_TOKEN     Access Token（可选）
 *   BANGUMI_DATA_DIR         数据目录（默认 <repo>/data）
 *   SYNC_MODE                incremental | full | enrich（默认 incremental）
 *   SYNC_DEPTH               1 | 2（默认 1）
 *   SYNC_DETAIL_LIMIT        本次最多同步多少个条目的详情（用于受控验证）
 *   SYNC_RELATION_LIMIT      本次最多同步多少个条目的系列关系
 *   SYNC_PERSON_LIMIT        本次最多同步多少个条目的制作人员
 */

import { BangumiClient } from '../src/bangumi/client.js';
import { ensureDataDirs, loadConfig, paths } from '../src/config.js';
import { cleanupStaging } from '../src/db/syncRuns.js';
import { closeDatabase, integrityCheck, openDatabase } from '../src/db/index.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
  ensureDataDirs();
  const config = loadConfig();
  openDatabase();
  cleanupStaging();

  const integrity = integrityCheck();
  if (integrity !== 'ok') console.warn(`[warn] 数据库自检：${integrity}`);

  const mode = (process.env.SYNC_MODE ?? 'incremental') as 'incremental' | 'full' | 'enrich';
  const depth = (Number(process.env.SYNC_DEPTH ?? '1') === 2 ? 2 : 1) as 1 | 2;

  const client = new BangumiClient({
    token: config.token,
    userAgent: config.userAgent,
    requestIntervalMs: config.requestIntervalMs,
    httpProxy: config.httpProxy,
  });

  const engine = new SyncEngine({
    client,
    getConfig: () => loadConfig(),
    limits: {
      ...(numberFromEnv('SYNC_DETAIL_LIMIT') ? { details: numberFromEnv('SYNC_DETAIL_LIMIT')! } : {}),
      ...(numberFromEnv('SYNC_RELATION_LIMIT')
        ? { relations: numberFromEnv('SYNC_RELATION_LIMIT')! }
        : {}),
      ...(numberFromEnv('SYNC_PERSON_LIMIT') ? { persons: numberFromEnv('SYNC_PERSON_LIMIT')! } : {}),
    },
    onChange: (progress) => {
      const line = `[${progress.phase}] ${progress.percent.toFixed(1)}% ${progress.message}`;
      if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(120)}`);
      else console.log(line);
    },
  });

  console.log(
    `开始同步：用户=${config.username || '(未配置)'} 模式=${mode} 深度=${depth} 数据目录=${paths.dataDir}`,
  );
  engine.start({ mode, depth });
  await engine.whenIdle();

  const status = engine.getStatus();
  const run = status.lastRun;
  console.log('\n同步结束：', run?.status);
  console.log(
    `新增 ${run?.counters.added} · 更新 ${run?.counters.updated} · 未变化 ${run?.counters.unchanged} · ` +
      `移除 ${run?.counters.removed} · 详情 ${run?.counters.detailsFetched} · ` +
      `关系 ${run?.counters.relationsFetched} · 人员 ${run?.counters.personsFetched} · 请求 ${run?.counters.requests}`,
  );
  if (run?.error) console.error('错误：', run.error);
  for (const warning of run?.warnings ?? []) console.warn('警告：', warning);

  if (config.cacheCovers) {
    const coverCache = new CoverCache(client);
    if (numberFromEnv('SYNC_COVER_LIMIT')) {
      await coverCache.start({ limit: numberFromEnv('SYNC_COVER_LIMIT') });
      console.log('封面缓存：', coverCache.status());
    }
  }

  closeDatabase();
  process.exit(run?.status === 'success' ? 0 : 1);
}

main().catch((error) => {
  console.error('同步失败：', error);
  closeDatabase();
  process.exit(1);
});
