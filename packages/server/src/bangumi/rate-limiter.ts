import { sleep } from '../util.js';

/**
 * 串行请求限流器：保证两次请求之间的最小间隔。
 *
 * Bangumi 官方未公开限流阈值。实测连续请求不会返回 429，但服务端会拉长响应时间，
 * 因此这里采用「保守间隔 + 收到 429 时动态放大间隔」的策略，
 * 既不会触发封禁，也不会在得知真实阈值后仍然过慢。
 */
export class RateLimiter {
  private intervalMs: number;
  private readonly baseIntervalMs: number;
  private lastStartedAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private cooldownUntil = 0;

  constructor(intervalMs: number) {
    this.baseIntervalMs = Math.max(0, intervalMs);
    this.intervalMs = this.baseIntervalMs;
  }

  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  setInterval(intervalMs: number): void {
    this.intervalMs = Math.max(0, intervalMs);
  }

  /** 服务端明确返回 429 时调用：临时冷却，并把间隔放大一倍（上限 8 秒）。 */
  handleRateLimited(retryAfterMs?: number): void {
    const now = Date.now();
    this.cooldownUntil = Math.max(this.cooldownUntil, now + (retryAfterMs ?? 5000));
    this.intervalMs = Math.min(8000, Math.max(this.intervalMs * 2, 1000));
  }

  /** 请求成功后逐步恢复到基础间隔。 */
  handleSuccess(): void {
    if (this.intervalMs > this.baseIntervalMs) {
      this.intervalMs = Math.max(this.baseIntervalMs, Math.round(this.intervalMs * 0.9));
    }
  }

  /** 排队获取下一次请求许可。 */
  acquire(signal?: AbortSignal): Promise<void> {
    const task = this.queue.then(async () => {
      const now = Date.now();
      const earliest = Math.max(this.lastStartedAt + this.intervalMs, this.cooldownUntil);
      const waitMs = Math.max(0, earliest - now);
      if (waitMs > 0) await sleep(waitMs, signal);
      this.lastStartedAt = Date.now();
    });
    // 队列本身不能因为单次取消而中断
    this.queue = task.catch(() => undefined);
    return task;
  }
}
