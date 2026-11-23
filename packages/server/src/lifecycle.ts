import type { AppDependencies } from './app.js';

const stopping = new WeakMap<AppDependencies, Promise<void>>();

/** 立即停止所有生产者；某一资源失败不能跳过其它资源，也不能提前关闭 DB。 */
export function stopAppResources(deps: AppDependencies): Promise<void> {
  const existing = stopping.get(deps);
  if (existing) return existing;
  const cancelAndDrain = async (resource: AppDependencies['engine'] | AppDependencies['coverCache']) => {
    let cancellationError: unknown;
    let cancellationFailed = false;
    try { resource.cancel(); } catch (error) { cancellationFailed = true; cancellationError = error; }
    await resource.whenIdle();
    if (cancellationFailed) throw cancellationError;
  };
  const pending = Promise.allSettled([
    cancelAndDrain(deps.engine), cancelAndDrain(deps.coverCache),
    Promise.resolve().then(() => deps.translationWorker?.stop()),
  ]).then((results) => {
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, '资源停止失败，数据库保持打开');
  }).finally(() => { stopping.delete(deps); });
  stopping.set(deps, pending);
  return pending;
}

interface ShutdownDependencies {
  closeServer: () => Promise<unknown>;
  stopResources: () => Promise<unknown>;
  closeDatabase: () => void;
  onStart: () => void;
  onError: (error: unknown) => void;
  exit: (code: number) => void;
  timeoutMs?: number;
}

/** 重复信号共享一次尝试；超时不丢弃仍进行中的屏障，失败可重试。 */
export function createServiceShutdown(deps: ShutdownDependencies): (code?: number) => Promise<boolean> {
  let attempt: Promise<boolean> | null = null;
  let barrier: Promise<void> | null = null;
  let complete = false;
  let exitCode = 0;
  return (code = 0) => {
    exitCode = Math.max(exitCode, code);
    if (complete) return Promise.resolve(true);
    if (attempt) return attempt;
    deps.onStart();
    if (!barrier) {
      const pending = Promise.allSettled([
        Promise.resolve().then(deps.closeServer), Promise.resolve().then(deps.stopResources),
      ]).then((results) => {
        const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, '服务关闭失败');
      }).catch((error: unknown) => {
        if (barrier === pending) barrier = null;
        throw error;
      });
      barrier = pending;
    }
    const current = barrier;
    let timer: ReturnType<typeof setTimeout>;
    attempt = (async () => {
      try {
        await Promise.race([current, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('服务关闭超时，数据库保持打开；任务结束后可再次请求退出')), deps.timeoutMs ?? 30_000);
        })]);
        deps.closeDatabase();
        complete = true;
        deps.exit(exitCode);
        return true;
      } catch (error) {
        deps.onError(error);
        return false;
      } finally {
        clearTimeout(timer!);
        attempt = null;
      }
    })();
    return attempt;
  };
}
