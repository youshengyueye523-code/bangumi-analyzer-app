import { dataVersion } from '../db/index.js';
import { currentVisibility, hideNsfwEnabled, type Visibility } from '../db/visibility.js';

interface CacheEntry {
  version: number;
  value: unknown;
}

const store = new Map<string, CacheEntry>();

/**
 * 以「数据版本号 + 可见性口径」为键的轻量缓存。
 *
 * 统计全部由 SQL 聚合得到，但把结果缓存下来可以避免切换页面时重复计算；
 * 任何同步/导入操作都会递增数据版本号，从而自动失效。
 *
 * v1.8：hideNsfw 切换改变的是投影口径而不是数据，因此：
 * - 不推进 dataVersion；
 * - 缓存键必须自带口径，调用方不可能「忘记失效」；
 * - compute 收到本次解析出的口径，保证键与计算使用同一个 token。
 */
export function cached<T>(
  key: string, compute: (visibility: Visibility) => T, visibility = currentVisibility(),
): T {
  const version = dataVersion();
  // Active personal hides keep both NSFW settings in "visible"; that alone
  // does not identify the projection. A personal-hide mutation bumps version.
  const scope = visibility === 'real' ? 'real' : hideNsfwEnabled() ? 'visible:nsfw-offscreen' : 'visible:nsfw-shown';
  const scopedKey = `${scope}:${key}`;
  const entry = store.get(scopedKey);
  if (entry && entry.version === version) return entry.value as T;
  const value = compute(visibility);
  store.set(scopedKey, { version, value });
  return value;
}

export function invalidateStatsCache(): void {
  store.clear();
}
