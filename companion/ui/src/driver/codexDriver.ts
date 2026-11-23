/**
 * Codex 运行时适配器（对齐 companion/host/CONTRACT.md + bridge.d.ts 与 companion/runtime/API.md）
 *
 * 兼容两层契约：
 *   1. companion/host Electron preload 注入的 window.companionBridge (bridgeVersion: 1)：
 *      getStatus(): Promise<CompanionStatus>
 *      startAnalyzer(): Promise<CompanionStatus>
 *      stopAnalyzer(): Promise<CompanionStatus>
 *      openAnalyzer(): Promise<OpenResult>
 *      getLogs(): Promise<CompanionLog[]>
 *      onStatus(cb): () => void
 *      onLogs(cb): () => void
 *   2. 直接映射 companion/runtime supervisor.d.mts 的 RuntimeResult / RuntimeStatus
 *
 * 严格约束：
 *   - 未检测到 window.companionBridge 时绝不伪装成功，返回 BRIDGE_UNAVAILABLE
 *   - startAnalyzer 返回 checking/starting 时保持真实过渡态，由 UI 等待/轮询直到 ready/failed
 *   - openAnalyzer 失败（如 OPEN_FAILED）不覆盖服务 running 状态
 *   - stopAnalyzer 超时且 ownsProcess=true 时保留故障状态与归属提示
 */
import { ingestRuntimeLogs } from '../state/feedback';
import {
  describeRuntimeError,
  EMPTY_STATUS,
  type AnalyzerRunState,
  type AnalyzerStatus,
  type CompanionDriver,
  type OpenResult,
  type RuntimeLogEntry,
  type RuntimePackageInfo,
  type RuntimePackageState,
  type RuntimeRawState,
} from './types';

interface RawRuntimeError {
  code?: string;
  runtimeCode?: string;
  message?: string;
  hint?: string;
}

interface RawHostRuntimeMeta {
  state?: string;
  ownsProcess?: boolean;
  packageState?: string;
}

interface RawRuntimeStatus {
  protocolVersion?: number;
  revision?: number;
  state?: string;
  rawState?: string;
  runtime?: RawHostRuntimeMeta;
  package?: RuntimePackageInfo;
  ownsProcess?: boolean;
  url?: string | null;
  port?: number | null;
  pid?: number | null;
  version?: string | null;
  startedAt?: number | null;
  dataDir?: string | null;
  error?: RawRuntimeError | null;
  logs?: RuntimeLogEntry[];
}

interface RawRuntimeResult {
  ok?: boolean;
  status?: RawRuntimeStatus;
  error?: RawRuntimeError;
  opened?: boolean;
  url?: string;
}

interface CompanionBridge {
  readonly bridgeVersion?: number;
  getStatus(): RawRuntimeStatus | RawRuntimeResult | Promise<RawRuntimeStatus | RawRuntimeResult>;
  startAnalyzer(): Promise<RawRuntimeResult | RawRuntimeStatus>;
  stopAnalyzer(): Promise<RawRuntimeResult | RawRuntimeStatus>;
  openAnalyzer(): Promise<RawRuntimeResult | { opened: boolean; url: string; error?: RawRuntimeError }>;
  getLogs?(): Promise<RuntimeLogEntry[]>;
  onStatus?(cb: (s: RawRuntimeStatus | RawRuntimeResult) => void): () => void;
  onLogs?(cb: (logs: RuntimeLogEntry[]) => void): () => void;
}

declare global {
  interface Window {
    companionBridge?: CompanionBridge;
  }
}

const RAW_TO_UI_STATE: Record<string, AnalyzerRunState> = {
  idle: 'stopped',
  stopped: 'stopped',
  checking: 'checking',
  starting: 'starting',
  ready: 'running',
  running: 'running',
  stopping: 'stopping',
  failed: 'error',
  error: 'error',
  unknown: 'unknown',
};

function parsePort(url: string | null | undefined, explicitPort?: number | null): number | null {
  if (typeof explicitPort === 'number' && Number.isFinite(explicitPort)) return explicitPort;
  if (!url) return null;
  try {
    const p = Number(new URL(url).port);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

export function createCodexDriver(): CompanionDriver {
  const bridge = () => window.companionBridge;
  let observedRunningSince: number | null = null;

  const normalizeStatus = (
    input: RawRuntimeStatus | RawRuntimeResult | undefined,
    actionError?: RawRuntimeError,
  ): AnalyzerStatus => {
    const raw: RawRuntimeStatus =
      input && 'status' in input && input.status ? input.status : ((input as RawRuntimeStatus) ?? {});

    // 优先使用 runtime.state（如宿主把 checking/starting 都映射成 starting，runtime.state 仍保留 checking 细节）
    const rtState = raw.runtime?.state ?? raw.rawState ?? raw.state ?? 'unknown';
    const mappedState: AnalyzerRunState =
      RAW_TO_UI_STATE[rtState] ?? RAW_TO_UI_STATE[raw.state ?? 'unknown'] ?? 'unknown';

    if (mappedState === 'running') {
      if (!observedRunningSince) observedRunningSince = raw.startedAt ?? Date.now();
    } else if (mappedState === 'stopped' || mappedState === 'error') {
      observedRunningSince = null;
    }

    const errSrc = raw.error ?? actionError ?? null;
    const error =
      errSrc?.code || errSrc?.message
        ? describeRuntimeError(
            errSrc.code ?? 'UNKNOWN',
            errSrc.message ?? '运行时返回错误',
            errSrc.hint,
            errSrc.runtimeCode,
          )
        : null;

    if (raw.logs?.length) {
      ingestRuntimeLogs(raw.logs);
    }

    const pkgInfo: RuntimePackageInfo | undefined =
      raw.package ??
      (raw.runtime?.packageState
        ? {
            state: raw.runtime.packageState as RuntimePackageState,
            version: raw.version ?? undefined,
          }
        : undefined);

    const url = raw.url ?? null;
    return {
      protocolVersion: raw.protocolVersion ?? bridge()?.bridgeVersion ?? 1,
      state: actionError && mappedState !== 'running' ? 'error' : mappedState,
      rawState: (['idle', 'checking', 'starting', 'ready', 'stopping', 'stopped', 'failed'].includes(rtState)
        ? rtState
        : undefined) as RuntimeRawState | undefined,
      package: pkgInfo,
      ownsProcess: raw.ownsProcess ?? raw.runtime?.ownsProcess,
      url,
      port: parsePort(url, raw.port),
      pid: raw.pid ?? null,
      version: raw.version ?? raw.package?.version ?? null,
      startedAt: raw.startedAt ?? (mappedState === 'running' ? observedRunningSince : null),
      dataDir: raw.dataDir ?? null,
      error,
      logs: raw.logs ?? [],
    };
  };

  const unavailable = (): AnalyzerStatus => ({
    ...EMPTY_STATUS,
    state: 'error',
    ownsProcess: false,
    error: describeRuntimeError(
      'BRIDGE_UNAVAILABLE',
      '未检测到 Companion 运行时桥接（window.companionBridge）。',
    ),
  });

  const transportFailed = (err: unknown): AnalyzerStatus => ({
    ...EMPTY_STATUS,
    state: 'error',
    error: describeRuntimeError(
      'BRIDGE_UNAVAILABLE',
      err instanceof Error ? `运行时桥接调用失败：${err.message}` : '运行时桥接调用失败',
    ),
  });

  const unwrapAction = (res: RawRuntimeResult | RawRuntimeStatus): AnalyzerStatus => {
    if (res && 'ok' in res) {
      if (res.ok === false) {
        return normalizeStatus(res, res.error);
      }
      return normalizeStatus(res);
    }
    return normalizeStatus(res);
  };

  return {
    kind: 'codex',

    async getStatus() {
      const b = bridge();
      if (!b) return unavailable();
      try {
        const res = await b.getStatus();
        if (b.getLogs) {
          b.getLogs().then((entries) => ingestRuntimeLogs(entries)).catch(() => {});
        }
        return normalizeStatus(res);
      } catch (err) {
        return transportFailed(err);
      }
    },

    async startAnalyzer() {
      const b = bridge();
      if (!b) return unavailable();
      try {
        const res = await b.startAnalyzer();
        return unwrapAction(res);
      } catch (err) {
        return transportFailed(err);
      }
    },

    async stopAnalyzer() {
      const b = bridge();
      if (!b) return unavailable();
      try {
        const res = await b.stopAnalyzer();
        return unwrapAction(res);
      } catch (err) {
        return transportFailed(err);
      }
    },

    async openAnalyzer(): Promise<OpenResult> {
      const b = bridge();
      if (!b) {
        return {
          opened: false,
          url: '',
          error: describeRuntimeError('BRIDGE_UNAVAILABLE', '未检测到 Companion 运行时桥接（window.companionBridge）。'),
        };
      }
      try {
        const res = await b.openAnalyzer();
        if ('ok' in res) {
          const status = normalizeStatus(res);
          const url = status.url ?? res.url ?? '';
          if (!res.ok) {
            const err = res.error ?? status.error;
            return {
              opened: false,
              url,
              status,
              error: err
                ? describeRuntimeError(err.code ?? 'OPEN_FAILED', err.message ?? '打开浏览器失败', err.hint, err.runtimeCode)
                : describeRuntimeError('OPEN_FAILED', '未能通过系统默认浏览器打开 Analyzer'),
            };
          }
          return { opened: true, url, status, error: null };
        }
        const hostOpen = res as { opened?: boolean; url?: string; error?: RawRuntimeError };
        if (!hostOpen.opened) {
          const err = hostOpen.error;
          return {
            opened: false,
            url: hostOpen.url ?? '',
            error: err
              ? describeRuntimeError(err.code ?? 'OPEN_FAILED', err.message ?? '未能通过系统默认浏览器打开 Analyzer', err.hint, err.runtimeCode)
              : describeRuntimeError('OPEN_FAILED', '未能通过系统默认浏览器打开 Analyzer'),
          };
        }
        return { opened: true, url: hostOpen.url ?? '', error: null };
      } catch (err) {
        return {
          opened: false,
          url: '',
          error: describeRuntimeError(
            'OPEN_FAILED',
            err instanceof Error ? err.message : '调用 openAnalyzer 异常',
          ),
        };
      }
    },

    ...(bridge()?.onStatus
      ? {
          subscribe(listener: (status: AnalyzerStatus) => void) {
            const b = bridge();
            if (!b?.onStatus) return () => {};
            const offStatus = b.onStatus((s) => listener(normalizeStatus(s)));
            const offLogs = b.onLogs?.((entries) => ingestRuntimeLogs(entries));
            b.getLogs?.().then((entries) => ingestRuntimeLogs(entries)).catch(() => {});
            return () => {
              offStatus();
              offLogs?.();
            };
          },
        }
      : {}),
  };
}
