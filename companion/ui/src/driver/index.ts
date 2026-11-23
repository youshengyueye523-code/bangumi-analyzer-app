import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createMockDriver } from './mockDriver';
import { createCodexDriver } from './codexDriver';
import { EMPTY_STATUS, type AnalyzerStatus, type CompanionDriver } from './types';
import { wait } from '../mock/scenario';

export * from './types';

/**
 * 为任意 CompanionDriver 包装一层本地状态广播总线：
 *   - 无论是主动调用 start/stop/open/getStatus，还是底层 subscribe 推送，
 *     都会立即同步到所有订阅了 useAnalyzerStatus() 的组件（TitleBar / Home / Launch / Splash）。
 *   - 解决未提供 onStatus 推送的宿主桥接在动作发起后等待旧轮询周期才刷新 UI 的延迟问题。
 */
function withReactiveBus(inner: CompanionDriver): CompanionDriver & { hasNativePush: boolean } {
  const listeners = new Set<(s: AnalyzerStatus) => void>();
  const hasNativePush = Boolean(inner.subscribe);
  let unsubInner: (() => void) | null = null;
  let refCount = 0;

  const publish = (s: AnalyzerStatus) => {
    listeners.forEach((l) => l(s));
    return s;
  };

  return {
    kind: inner.kind,
    hasNativePush,

    async getStatus() {
      return publish(await inner.getStatus());
    },
    async startAnalyzer() {
      return publish(await inner.startAnalyzer());
    },
    async stopAnalyzer() {
      return publish(await inner.stopAnalyzer());
    },
    async openAnalyzer() {
      const res = await inner.openAnalyzer();
      if (res.status) publish(res.status);
      return res;
    },
    subscribe(listener) {
      listeners.add(listener);
      refCount += 1;
      if (refCount === 1 && inner.subscribe) {
        unsubInner = inner.subscribe(publish);
      }
      return () => {
        listeners.delete(listener);
        refCount = Math.max(0, refCount - 1);
        if (refCount === 0 && unsubInner) {
          unsubInner();
          unsubInner = null;
        }
      };
    },
  };
}

/**
 * 驱动选择规则：
 *   - ?driver=mock  强制使用模拟驱动
 *   - ?driver=codex 强制使用 Codex 宿主桥接（无桥接时明确报 BRIDGE_UNAVAILABLE）
 *   - 默认          若宿主已注入 window.companionBridge 则自动接入 Codex，否则使用 Mock
 */
export function selectDriver(): CompanionDriver {
  const q = new URLSearchParams(location.search);
  const mode = q.get('driver');
  if (mode === 'mock') return withReactiveBus(createMockDriver());
  if (mode === 'codex') return withReactiveBus(createCodexDriver());
  if (typeof window !== 'undefined' && window.companionBridge) {
    return withReactiveBus(createCodexDriver());
  }
  return withReactiveBus(createMockDriver());
}

export const DriverContext = createContext<CompanionDriver | null>(null);

export function useDriver(): CompanionDriver {
  const d = useContext(DriverContext);
  if (!d) throw new Error('DriverContext missing');
  return d;
}

const isTransitioning = (s: AnalyzerStatus['state']) =>
  s === 'checking' || s === 'starting' || s === 'stopping';

/**
 * 订阅 Analyzer 运行状态：
 *   - 通过总线接收任意主动调用与原生推送更新
 *   - 若底层未提供原生推送（hasNativePush=false），自动按 API.md 建议轮询 getStatus
 *     （过渡态 350ms，稳态 1500ms）
 */
export function useAnalyzerStatus(): AnalyzerStatus {
  const driver = useDriver();
  const [status, setStatus] = useState<AnalyzerStatus>(EMPTY_STATUS);
  const stateRef = useRef(status.state);
  stateRef.current = status.state;

  useEffect(() => {
    let alive = true;
    const off = driver.subscribe?.((s) => {
      if (alive) setStatus(s);
    });
    driver.getStatus().then((s) => alive && setStatus(s));

    const hasNativePush = (driver as CompanionDriver & { hasNativePush?: boolean }).hasNativePush;
    if (hasNativePush) {
      return () => {
        alive = false;
        off?.();
      };
    }

    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      try {
        const s = await driver.getStatus();
        if (!alive) return;
        setStatus(s);
      } finally {
        if (alive) {
          const delay = isTransitioning(stateRef.current) ? 350 : 1500;
          timer = setTimeout(loop, delay);
        }
      }
    };
    timer = setTimeout(loop, isTransitioning(stateRef.current) ? 350 : 1500);
    return () => {
      alive = false;
      clearTimeout(timer);
      off?.();
    };
  }, [driver]);

  return status;
}

/**
 * 等待 startAnalyzer() 完成校验与启动（对齐 API.md：startAnalyzer 返回 ok:true 不代表 ready，
 * 必须持续轮询 getStatus 直到 running 或 error）。
 */
export async function startAndAwaitReady(
  driver: CompanionDriver,
  onProgress?: (s: AnalyzerStatus) => void,
  signal?: AbortSignal,
): Promise<AnalyzerStatus> {
  let st = await driver.startAnalyzer();
  onProgress?.(st);
  const deadline = Date.now() + 60_000;
  while (isTransitioning(st.state) && Date.now() < deadline) {
    if (signal?.aborted) break;
    await wait(350, signal);
    st = await driver.getStatus();
    onProgress?.(st);
  }
  return st;
}
