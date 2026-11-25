/**
 * Mock driver —— 明确的模拟实现，不启动任何进程、不监听任何端口、不打开浏览器。
 * 模拟对齐 Codex Runtime protocolVersion 1 生命周期：
 *   stopped -> checking (SHA-256 校验模拟) -> starting -> running -> stopping -> stopped
 * 行为由模拟控制台的 driver 场景决定：
 *   ok           正常校验、启动、打开与安全停止
 *   start-fail   启动时报 PORT_IN_USE（开启「重试即恢复」时第二次成功）
 *   crash        启动成功约 8 秒后进程意外退出（SERVICE_EXITED）
 *   stop-timeout 停止超时，ownsProcess 保持 true，提示重试安全停止
 *   open-fail    服务保持 running，但 openAnalyzer 返回 OPEN_FAILED
 */
import { scenario, wait, jitter } from '../mock/scenario';
import {
  describeRuntimeError,
  type AnalyzerRoute,
  type AnalyzerStatus,
  type CompanionDriver,
  type OpenResult,
  type RuntimeLogEntry,
} from './types';

const MOCK_VERSION = '2.0.0';

export function createMockDriver(dataDir = 'D:\\Analyzer'): CompanionDriver {
  let seq = 1;
  const appendLog = (logs: RuntimeLogEntry[] | undefined, level: 'info' | 'error', event: string): RuntimeLogEntry[] => [
    ...(logs ?? []).slice(-99),
    { seq: seq++, at: new Date().toISOString(), level, event },
  ];

  let status: AnalyzerStatus = {
    protocolVersion: 1,
    state: 'stopped',
    rawState: 'idle',
    package: { state: 'unknown', version: MOCK_VERSION, distributionRevision: 2 },
    ownsProcess: false,
    url: null,
    port: null,
    pid: null,
    version: MOCK_VERSION,
    startedAt: null,
    dataDir,
    error: null,
    logs: [],
  };
  const listeners = new Set<(s: AnalyzerStatus) => void>();
  let crashTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = (patch: Partial<AnalyzerStatus>) => {
    status = { ...status, ...patch };
    listeners.forEach((l) => l(status));
    return status;
  };

  return {
    kind: 'mock',

    async getStatus() {
      await wait(jitter(100));
      return status;
    },

    async startAnalyzer() {
      if (status.state === 'running' || status.state === 'starting' || status.state === 'checking') {
        return status;
      }
      emit({
        state: 'checking',
        rawState: 'checking',
        package: { state: 'checking', version: MOCK_VERSION, distributionRevision: 2 },
        error: null,
        logs: appendLog(status.logs, 'info', 'package.verify.start'),
      });
      await wait(jitter(520));
      emit({
        state: 'starting',
        rawState: 'starting',
        package: {
          state: 'valid',
          version: MOCK_VERSION,
          distributionRevision: 2,
          files: 3249,
          checksumsSha256: 'ef8ea8cb083fb0b5e7b3091fa07eae06',
        },
        ownsProcess: true,
        logs: appendLog(status.logs, 'info', 'service.spawn.start'),
      });
      await wait(jitter(950));
      const s = scenario.get();
      if (scenario.shouldFail('driver.start', s.driver === 'start-fail')) {
        return emit({
          state: 'error',
          rawState: 'failed',
          ownsProcess: false,
          url: null,
          port: null,
          pid: null,
          error: describeRuntimeError(
            'PORT_IN_USE',
            '端口 5173 已被其他程序占用，Analyzer 未能启动。',
            'Companion 不会结束占用方。可重试（将自动选择空闲端口）或关闭占用该端口的程序。',
          ),
          logs: appendLog(status.logs, 'error', 'service.start.PORT_IN_USE'),
        });
      }
      const port = status.error?.code === 'PORT_IN_USE' ? 5174 : 5173;
      const next = emit({
        state: 'running',
        rawState: 'ready',
        ownsProcess: true,
        port,
        url: `http://127.0.0.1:${port}/`,
        pid: 10000 + Math.floor(Math.random() * 50000),
        startedAt: Date.now(),
        error: null,
        logs: appendLog(status.logs, 'info', `service.ready port=${port}`),
      });
      clearTimeout(crashTimer);
      if (s.driver === 'crash' && scenario.shouldFail('driver.crash', true)) {
        crashTimer = setTimeout(() => {
          emit({
            state: 'error',
            rawState: 'failed',
            ownsProcess: false,
            pid: null,
            url: null,
            error: describeRuntimeError('SERVICE_EXITED', 'Analyzer 子进程意外退出（模拟退出码 1）。'),
            logs: appendLog(status.logs, 'error', 'service.exited code=1'),
          });
        }, 8000 / s.speed);
      }
      return next;
    },

    async stopAnalyzer() {
      if (status.state === 'stopped') return status;
      clearTimeout(crashTimer);
      emit({
        state: 'stopping',
        rawState: 'stopping',
        logs: appendLog(status.logs, 'info', 'service.stop.requested'),
      });
      await wait(jitter(950));
      const s = scenario.get();
      if (scenario.shouldFail('driver.stop', s.driver === 'stop-timeout')) {
        return emit({
          state: 'error',
          rawState: 'failed',
          ownsProcess: true,
          error: describeRuntimeError('STOP_TIMEOUT', '等待后台任务与数据库安全退出超时。'),
          logs: appendLog(status.logs, 'error', 'service.stop.STOP_TIMEOUT ownsProcess=true'),
        });
      }
      return emit({
        state: 'stopped',
        rawState: 'stopped',
        ownsProcess: false,
        url: null,
        port: null,
        pid: null,
        startedAt: null,
        error: null,
        logs: appendLog(status.logs, 'info', 'service.stopped'),
      });
    },

    async openAnalyzer(route: AnalyzerRoute = '/'): Promise<OpenResult> {
      await wait(jitter(260));
      const base = status.url ?? 'http://127.0.0.1:5173/';
      const url = new URL(route, base).toString();
      const s = scenario.get();
      if (status.state !== 'running') {
        return {
          opened: false,
          url: '',
          status,
          error: describeRuntimeError('NOT_READY', 'Analyzer 尚未就绪，无法打开网页端。'),
        };
      }
      if (scenario.shouldFail('driver.open', s.driver === 'open-fail')) {
        return {
          opened: false,
          url,
          status,
          error: describeRuntimeError('OPEN_FAILED', '模拟：系统默认浏览器启动失败（服务仍在正常运行）。'),
        };
      }
      // 模拟：不调用 window.open，避免原型误打开外部页面
      return { opened: true, url, status, error: null };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
