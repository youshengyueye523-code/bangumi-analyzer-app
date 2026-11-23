import { ApiError, decodeWallpaperDataUrl } from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config.js';
import {
  contentTypeForWallpaper,
  createWallpaperStream,
  pruneWallpapers,
  saveWallpaper,
  wallpaperFilePath,
} from '../../images/wallpaper.js';

export interface WallpaperUploadResult {
  image: string;
  bytes: number;
  mime: string;
}

/**
 * 背景图上传 / 读取。
 *
 * 上传只做「校验 + 落盘」，不会写入配置 —— 是否正式启用由
 * `PUT /api/config { wallpaper }` 决定，这样「取消预览」不会污染正式配置。
 * 安全校验沿用头像那一套（MIME 白名单 + 体积上限 + 文件头魔数）。
 */
export function registerWallpaperRoutes(app: FastifyInstance): void {
  app.post('/api/wallpaper', async (request): Promise<WallpaperUploadResult> => {
    const body = (request.body ?? {}) as { dataUrl?: unknown };
    const decoded = decodeWallpaperDataUrl(String(body.dataUrl ?? ''));
    if (!decoded.ok) {
      throw new ApiError('背景图无法保存', {
        code: 'invalid_wallpaper',
        status: 400,
        hint: decoded.reason,
      });
    }
    const saved = saveWallpaper(decoded.bytes, decoded.mime);
    // 近期上传可能正等待另一页面的配置保存；十分钟后才清理无引用上传。
    pruneWallpapers([saved.image, loadConfig().wallpaper.image], Date.now() - 10 * 60_000);
    return { image: saved.image, bytes: saved.bytes, mime: decoded.mime };
  });

  app.get('/api/wallpaper/:file', async (request, reply) => {
    const { file: name } = request.params as { file: string };
    const file = wallpaperFilePath(name);
    if (!file || !existsSync(file)) {
      throw new ApiError('背景图不存在', {
        code: 'wallpaper_not_found',
        status: 404,
        dataIntact: true,
      });
    }
    return reply
      .header('content-type', contentTypeForWallpaper(name))
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createWallpaperStream(file));
  });
}
