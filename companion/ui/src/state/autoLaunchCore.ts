import type { AnalyzerError, AnalyzerStatus, CompanionDriver } from '../driver/types';

export type AutoLaunchScreen =
  | 'intro'
  | 'env'
  | 'dir'
  | 'account'
  | 'ai'
  | 'init'
  | 'ready'
  | 'launch'
  | 'splash'
  | 'home';

export interface AutoLaunchSnapshot {
  coldAutoStartHandled: boolean;
  autoOpenArmed: boolean;
  openingInFlight: boolean;
  runGeneration: number;
  openedGeneration: number;
  lastError: AnalyzerError | null;
}

export interface AutoLaunchHooks {
  log?: (level: 'info' | 'ok' | 'warn' | 'error', text: string) => void;
  toast?: (tone: 'info' | 'success' | 'warning' | 'danger', title: string, body?: string) => void;
  playChime?: (kind: 'tap' | 'ok' | 'warn') => void;
  startAndAwaitReady?: (driver: CompanionDriver) => Promise<AnalyzerStatus>;
}

type Listener = () => void;

export interface AutoLaunchController {
  getSnapshot: () => AutoLaunchSnapshot;
  subscribe: (fn: Listener) => () => void;
  armAutoOpenForNextReady: () => void;
  disarmAutoOpen: () => void;
  markColdAutoStartHandled: () => void;
  clearError: () => void;
  resetForTest: () => void;
  sync: (params: {
    enabled: boolean;
    allowColdAutoStart?: boolean;
    screen: AutoLaunchScreen;
    autoStart: boolean;
    autoOpen: boolean;
    firstRunCompleted: boolean;
    driver: CompanionDriver;
    status: AnalyzerStatus;
  }) => Promise<void>;
}

function defaultSnapshot(): AutoLaunchSnapshot {
  return {
    coldAutoStartHandled: false,
    autoOpenArmed: false,
    openingInFlight: false,
    runGeneration: 0,
    openedGeneration: 0,
    lastError: null,
  };
}

async function fallbackStartAndAwaitReady(driver: CompanionDriver): Promise<AnalyzerStatus> {
  let st = await driver.startAnalyzer();
  const deadline = Date.now() + 60_000;
  while ((st.state === 'checking' || st.state === 'starting' || st.state === 'stopping') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 350));
    st = await driver.getStatus();
  }
  return st;
}

export function createAutoLaunchController(hooks: AutoLaunchHooks = {}): AutoLaunchController {
  const emitLog = hooks.log ?? (() => {});
  const emitToast = hooks.toast ?? (() => {});
  const emitChime = hooks.playChime ?? (() => {});
  const awaitReady = hooks.startAndAwaitReady ?? fallbackStartAndAwaitReady;

  let state: AutoLaunchSnapshot = defaultSnapshot();
  let prevAnalyzerState: AnalyzerStatus['state'] = 'unknown';
  let startInFlight = false;
  const listeners = new Set<Listener>();

  const emit = () => {
    listeners.forEach((fn) => fn());
  };

  const update = (patch: Partial<AutoLaunchSnapshot>) => {
    state = { ...state, ...patch };
    emit();
  };

  const armAutoOpenForNextReady = () => {
    if (!state.autoOpenArmed || state.lastError) {
      update({ autoOpenArmed: true, lastError: null });
    }
  };

  const disarmAutoOpen = () => {
    if (state.autoOpenArmed) {
      update({ autoOpenArmed: false });
    }
  };

  const markColdAutoStartHandled = () => {
    if (!state.coldAutoStartHandled) {
      update({ coldAutoStartHandled: true });
    }
  };

  const clearError = () => {
    if (state.lastError) {
      update({ lastError: null });
    }
  };

  const resetForTest = () => {
    state = defaultSnapshot();
    prevAnalyzerState = 'unknown';
    startInFlight = false;
    emit();
  };

  const triggerAutoOpenIfReady = async (driver: CompanionDriver, autoOpen: boolean) => {
    if (!autoOpen || !state.autoOpenArmed) return;
    if (state.openingInFlight) return;
    if (state.runGeneration <= 0 || state.openedGeneration === state.runGeneration) return;

    const targetGeneration = state.runGeneration;
    update({
      openingInFlight: true,
      autoOpenArmed: false,
      openedGeneration: targetGeneration,
      lastError: null,
    });

    try {
      const res = await driver.openAnalyzer('/');
      if (res.opened) {
        emitLog('ok', `服务就绪，已自动打开网页端：${res.url}`);
        update({ openingInFlight: false, lastError: null });
      } else {
        const err: AnalyzerError = res.error ?? {
          code: 'OPEN_FAILED',
          message: '服务已就绪，但未能自动打开系统默认浏览器',
          hint: '可点击「打开 Analyzer 网页端」或复制本机地址手动访问。',
        };
        emitLog('warn', `自动打开网页端失败：${err.code} (${err.message})`);
        emitChime('warn');
        emitToast('warning', '未能自动打开网页端', err.hint ?? err.message);
        update({ openingInFlight: false, lastError: err });
      }
    } catch (e) {
      const err: AnalyzerError = {
        code: 'OPEN_FAILED',
        message: e instanceof Error ? e.message : '自动打开网页端发生异常',
        hint: '请尝试手动点击「打开 Analyzer 网页端」。',
      };
      emitLog('warn', `自动打开网页端异常：${err.message}`);
      emitChime('warn');
      emitToast('warning', '未能自动打开网页端', err.message);
      update({ openingInFlight: false, lastError: err });
    }
  };

  const sync: AutoLaunchController['sync'] = async ({
    enabled,
    allowColdAutoStart = enabled,
    screen,
    autoStart,
    autoOpen,
    firstRunCompleted,
    driver,
    status,
  }) => {
    if (status.state === 'running' && prevAnalyzerState !== 'running') {
      prevAnalyzerState = 'running';
      update({ runGeneration: state.runGeneration + 1 });
    } else if (status.state !== 'running') {
      if (prevAnalyzerState === 'running') {
        prevAnalyzerState = status.state;
        update({ autoOpenArmed: false, lastError: null });
      } else {
        prevAnalyzerState = status.state;
        if (state.lastError && status.state !== 'starting' && status.state !== 'checking') {
          update({ lastError: null });
        }
      }
    }

    if (!enabled) return;

    if (!autoOpen && state.autoOpenArmed) {
      update({ autoOpenArmed: false });
    }

    const onAutoStartScreen = screen === 'home' || screen === 'splash';
    if (allowColdAutoStart && firstRunCompleted && autoStart && onAutoStartScreen && !state.coldAutoStartHandled) {
      update({
        coldAutoStartHandled: true,
        autoOpenArmed: autoOpen ? true : state.autoOpenArmed,
        lastError: null,
      });

      if ((status.state === 'stopped' || status.state === 'unknown') && !startInFlight) {
        startInFlight = true;
        emitLog('info', '自动启动已开启：正在启动 Analyzer 服务');
        try {
          const settled = await awaitReady(driver);
          if (settled.state !== 'running') {
            if (state.autoOpenArmed) update({ autoOpenArmed: false });
            emitLog('error', `自动启动 Analyzer 失败：${settled.error?.code ?? settled.state} ${settled.error?.message ?? ''}`);
          } else {
            emitLog('ok', `Analyzer 自动启动就绪 · ${settled.url ?? ''}`);
            if (prevAnalyzerState !== 'running') {
              prevAnalyzerState = 'running';
              update({ runGeneration: state.runGeneration + 1 });
            }
          }
        } finally {
          startInFlight = false;
        }
      }
    }

    if (onAutoStartScreen && status.state === 'running') {
      await triggerAutoOpenIfReady(driver, autoOpen);
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    armAutoOpenForNextReady,
    disarmAutoOpen,
    markColdAutoStartHandled,
    clearError,
    resetForTest,
    sync,
  };
}
