import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isWallpaperFileName, ApiError } from '@bangumi-analyzer/shared';
import { existingImagePath } from './files.js';
import { ensureDataDirs, paths } from '../config.js';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * 背景图落盘位置：data/wallpapers/wp-<内容 hash>.<ext>。
 *
 * 与封面缓存（data/covers）同一套思路：图片以文件形式保存，
 * 配置里只记录文件名，避免把多 MB 的 base64 塞进 /api/config。
 * 文件名按内容寻址，因此同一张图重复上传不会产生新文件、也可以长期缓存。
 */
export function wallpaperFilePath(name: string): string | null {
  if (!isWallpaperFileName(name)) return null;
  return existingImagePath(paths.wallpaperDir, name);
}

export function contentTypeForWallpaper(name: string): string {
  if (name.endsWith('.jpg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

export function saveWallpaper(
  bytes: Uint8Array,
  mime: string,
): { image: string; bytes: number } {
  ensureDataDirs();
  const extension = EXTENSION_BY_MIME[mime] ?? 'png';
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const image = `wp-${hash}.${extension}`;
  const file = join(paths.wallpaperDir, image);
  if (existsSync(file) && !existingImagePath(paths.wallpaperDir, image)) {
    throw new ApiError('背景图存储位置异常', { code: 'invalid_wallpaper_file', status: 409 });
  }
  if (!existsSync(file)) writeFileSync(file, bytes);
  else {
    const uploadedAt = new Date();
    utimesSync(file, uploadedAt, uploadedAt);
  }
  return { image, bytes: bytes.length };
}

export function deleteWallpaper(name: string): boolean {
  const file = wallpaperFilePath(name);
  if (!file || !existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/**
 * 清理不再被引用的背景图文件。
 *
 * 上传即预览：用户换图后如果点了「取消」，那张图不会被写入配置，
 * 上传与应用是两个请求；近期上传可能属于另一页面尚未完成的保存。
 * 调用方可指定清理截止时间，保留交接窗口中的文件；显式清空仍可删除全部。
 */
export function pruneWallpapers(keep: string[], olderThan = Infinity): number {
  const keepSet = new Set(keep.filter((name) => isWallpaperFileName(name)));
  let removed = 0;
  for (const entry of readdirSync(paths.wallpaperDir)) {
    if (!isWallpaperFileName(entry) || keepSet.has(entry)) continue;
    if (statSync(join(paths.wallpaperDir, entry)).mtimeMs >= olderThan) continue;
    unlinkSync(join(paths.wallpaperDir, entry));
    removed += 1;
  }
  return removed;
}

export function createWallpaperStream(file: string) {
  return createReadStream(file);
}
