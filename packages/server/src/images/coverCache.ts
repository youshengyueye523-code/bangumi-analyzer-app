import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { paths } from '../config.js';
import type { BangumiClient } from '../bangumi/client.js';
import { all, one, run } from '../db/index.js';
import { nowIso, sleep, writeFileAtomic } from '../util.js';
import { existingImagePath } from './files.js';
import { ApiError } from '@bangumi-analyzer/shared';

export interface CoverCacheStatus {
  running: boolean;
  total: number;
  cached: number;
  pending: number;
  processed: number;
  failed: number;
  lastError: string | null;
  sizeBytes: number;
}

const ALLOWED_HOSTS = ['lain.bgm.tv', 'api.bgm.tv', 'bgm.tv', 'www.bgm.tv'];

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function extensionFor(url: string, contentType: string | null): string {
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(fromUrl)) return fromUrl;
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('gif')) return '.gif';
  return '.jpg';
}

/**
 * 封面离线缓存。
 *
 * 封面来自 lain.bgm.tv，属于独立的 CDN，不与 API 共享限流；
 * 这里仍然保持低并发与小间隔，避免给对方造成压力。
 * 缓存失败不会影响任何主流程：前端会自动回退到远程图片地址。
 */
export class CoverCache {
  private running = false;
  private controller: AbortController | null = null;
  private processed = 0;
  private failed = 0;
  private lastError: string | null = null;
  private idlePromise: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  constructor(private readonly client: BangumiClient) {
    if (!existsSync(paths.coverDir)) mkdirSync(paths.coverDir, { recursive: true });
  }

  get coverDir(): string {
    return paths.coverDir;
  }

  status(): CoverCacheStatus {
    const counts = one<{ total: number; cached: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.cover_cached_at IS NOT NULL THEN 1 ELSE 0 END) AS cached
       FROM collections c JOIN subjects s ON s.id = c.subject_id
       WHERE s.cover_url IS NOT NULL AND s.cover_url <> ''`,
    );
    const total = Number(counts?.total ?? 0);
    const cached = Number(counts?.cached ?? 0);
    return {
      running: this.running,
      total,
      cached,
      pending: Math.max(0, total - cached),
      processed: this.processed,
      failed: this.failed,
      lastError: this.lastError,
      sizeBytes: this.directorySize(),
    };
  }

  private directorySize(): number {
    try {
      return readdirSync(paths.coverDir).reduce((sum, name) => {
        try {
          return sum + statSync(join(paths.coverDir, name)).size;
        } catch {
          return sum;
        }
      }, 0);
    } catch {
      return 0;
    }
  }

  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  async whenIdle(): Promise<void> {
    await this.idlePromise;
  }

  /** 查找本地缓存文件（返回文件名或 null）。 */
  localFile(subjectId: number): string | null {
    const row = one<{ cover_path: string | null; cover_cached_at: string | null }>(
      'SELECT cover_path, cover_cached_at FROM subjects WHERE id = :id',
      { id: subjectId },
    );
    if (!row?.cover_path || !row.cover_cached_at) return null;
    return existingImagePath(paths.coverDir, row.cover_path) ? row.cover_path : null;
  }

  removeAll(): number {
    // 已在等待网络的旧任务也必须失效，不能在清空后重新填回缓存。
    this.cancel();
    let removed = 0;
    try {
      for (const name of readdirSync(paths.coverDir)) {
        unlinkSync(join(paths.coverDir, name));
        removed += 1;
      }
    } catch {
      // 目录不存在时忽略
    }
    run(`UPDATE subjects SET cover_path = NULL, cover_cached_at = NULL`);
    return removed;
  }

  async start(options: { limit?: number; concurrency?: number } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.idlePromise = new Promise<void>((resolve) => { this.resolveIdle = resolve; });
    this.processed = 0;
    this.failed = 0;
    this.lastError = null;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    try {
      const limit = Math.max(1, Math.min(5000, options.limit ?? 2000));
      const queue = all<{ id: number; cover_url: string }>(
        `SELECT s.id, s.cover_url
         FROM collections c JOIN subjects s ON s.id = c.subject_id
         WHERE s.cover_url IS NOT NULL AND s.cover_url <> ''
           AND s.cover_cached_at IS NULL
         ORDER BY c.updated_at DESC NULLS LAST
         LIMIT :limit`,
        { limit },
      );

      const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 3));
      let cursor = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (!signal.aborted) {
          const index = cursor;
          cursor += 1;
          const item = queue[index];
          if (!item) break;
          await this.fetchOne(item.id, item.cover_url, signal);
          await sleep(120, signal).catch(() => undefined);
        }
      });
      await Promise.all(workers);
    } catch (error) {
      this.lastError = (error as Error).message;
    } finally {
      this.running = false;
      this.controller = null;
      this.resolveIdle?.();
      this.resolveIdle = null;
    }
  }

  private async fetchOne(subjectId: number, url: string, signal: AbortSignal): Promise<void> {
    if (!isAllowedUrl(url)) {
      this.failed += 1;
      this.lastError = '封面地址不在允许的域名范围内，已跳过。';
      return;
    }
    try {
      const { data, contentType } = await this.client.fetchImage(url, { signal });
      if (signal.aborted) return;
      // 同步/导入可能在下载期间更新或移除条目。写文件与 DB 之间不再 await。
      const current = one<{ cover_url: string | null }>('SELECT cover_url FROM subjects WHERE id = :id', { id: subjectId });
      if (current?.cover_url !== url) return;
      const buffer = Buffer.from(data);
      if (buffer.byteLength === 0) {
        this.failed += 1;
        return;
      }
      const fileName = `${subjectId}${extensionFor(url, contentType)}`;
      writeFileAtomic(join(paths.coverDir, fileName), buffer);
      run(
        `UPDATE subjects SET cover_path = :path, cover_cached_at = :ts WHERE id = :id`,
        { id: subjectId, path: fileName, ts: nowIso() },
      );
      this.processed += 1;
    } catch (error) {
      if (!signal.aborted) {
        this.failed += 1;
        this.lastError = (error as Error).message;
      }
    }
  }
}

export function createCoverStream(fileName: string): NodeJS.ReadableStream {
  const file = existingImagePath(paths.coverDir, fileName);
  if (!file) throw new ApiError('封面缓存文件不可用', { code: 'cover_unavailable', status: 404 });
  return createReadStream(file);
}

export function contentTypeForFile(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}
