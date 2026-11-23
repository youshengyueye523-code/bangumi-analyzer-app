/**
 * 模拟场景控制中心（仅原型使用）
 *
 * 所有 mock 行为都从这里读取「此刻要成功还是失败」，
 * 评审时可以通过右下角「模拟控制台」实时切换，验证错误 / 恢复 / 重新检测等交互。
 */
import { useSyncExternalStore } from 'react';

export type EnvScenario = 'ok' | 'port-busy' | 'offline' | 'low-disk' | 'no-write';
export type AccountScenario = 'ok' | 'not-found' | 'token-invalid' | 'timeout';
export type AiScenario = 'ok' | 'unauthorized' | 'timeout';
export type SyncScenario = 'ok' | 'rate-limit' | 'network-drop' | 'db-locked';
export type DriverScenario = 'ok' | 'start-fail' | 'crash' | 'stop-timeout' | 'open-fail';

export interface Scenario {
  env: EnvScenario;
  account: AccountScenario;
  ai: AiScenario;
  sync: SyncScenario;
  driver: DriverScenario;
  /** 失败一次后，下一次重试自动恢复（模拟真实世界的瞬时故障） */
  recoverOnRetry: boolean;
  /** 时间倍率：2 = 两倍速 */
  speed: number;
}

const DEFAULT: Scenario = {
  env: 'ok',
  account: 'ok',
  ai: 'ok',
  sync: 'ok',
  driver: 'ok',
  recoverOnRetry: true,
  speed: 1,
};

const KEY = 'companion.m0.scenario';

function load(): Scenario {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return { ...DEFAULT, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  const q = new URLSearchParams(location.search);
  const s = { ...DEFAULT };
  const speed = Number(q.get('speed'));
  if (speed > 0) s.speed = speed;
  return s;
}

let state: Scenario = load();
const listeners = new Set<() => void>();
/** 每种操作已经失败过的次数（用于 recoverOnRetry） */
const failures = new Map<string, number>();

export const scenario = {
  get: () => state,
  set(patch: Partial<Scenario>) {
    state = { ...state, ...patch };
    failures.clear();
    try {
      sessionStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  },
  reset() {
    scenario.set(DEFAULT);
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /**
   * 判断某个操作这一次是否应当失败。
   * shouldFail('sync', s.sync !== 'ok')：首次失败；若开启 recoverOnRetry，之后成功。
   */
  shouldFail(op: string, configuredToFail: boolean): boolean {
    if (!configuredToFail) return false;
    const n = failures.get(op) ?? 0;
    if (state.recoverOnRetry && n >= 1) return false;
    failures.set(op, n + 1);
    return true;
  },
};

export function useScenario(): Scenario {
  return useSyncExternalStore(scenario.subscribe, scenario.get);
}

/** 按倍率缩放的等待；支持 AbortSignal */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms / Math.max(0.1, state.speed));
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

export const jitter = (base: number, spread = 0.35) => base * (1 - spread / 2 + Math.random() * spread);
