import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 原子写入：先写临时文件再重命名，避免进程中断留下半截文件。 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return safeJsonParse(value, fallback);
}

/** 旧 JSON 列的只读字符串数组投影；合法字符串保留，源文本不改写。 */
export function parseStringArrayColumn(value: unknown): string[] {
  const parsed = parseJsonColumn<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/** `setTimeout` 版本的重试等待，带抖动，避免全体请求同时重发。 */
export function backoffDelay(attempt: number, baseMs = 800, maxMs = 30_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.7 + Math.random() * 0.6));
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes('已取消'))
  );
}

/**
 * 从对象中挑选指定字段。
 * node:sqlite 对命名参数做严格校验（多传字段会直接报错），
 * 因此写库前统一用这个函数裁剪出语句真正需要的参数。
 */
export function pick<T extends object>(source: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (key in record) out[key] = record[key];
  }
  return out;
}
