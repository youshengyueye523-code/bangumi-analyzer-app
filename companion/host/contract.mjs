export const UI_URL = 'companion://ui/index.html?driver=codex&screen=home';
export const CHANNEL = 'companion:v1:invoke';
export const METHODS = new Set(['getStatus', 'startAnalyzer', 'stopAnalyzer', 'openAnalyzer', 'getLogs']);
export const RUNTIME_CODES = new Set(['UNSAFE_PATH','PACKAGE_MISSING','PACKAGE_INVALID','PACKAGE_DAMAGED','PACKAGE_UNSUPPORTED','PACKAGE_ACCESS',
  'SESSION_LOCKED','LOCK_CHANGED','PLATFORM_UNSUPPORTED','INVALID_PORT','PORT_IN_USE','PORT_UNAVAILABLE','SPAWN_FAILED','SERVICE_EXITED',
  'START_TIMEOUT','HEALTH_FAILED','NOT_READY','STOP_TIMEOUT','STOP_FAILED','OPEN_FAILED','BUSY','INTERNAL']);
const HOST_CODES = new Set(['HOST_UNAVAILABLE','HOST_PROTOCOL','HOST_TIMEOUT','HOST_CLOSING','IPC_DENIED']);
const EVENTS = new Set([...RUNTIME_CODES,'CREATED','IDLE','CHECKING','STARTING','READY','STOPPING','STOPPED','FAILED','PACKAGE_VALID','BROWSER_HANDOFF']);
const states = new Set(['idle','checking','starting','ready','stopping','stopped','failed']);
const packages = new Set(['unknown','checking','valid','invalid']);
export class HostError extends Error { constructor(code) { super(code); this.code = code; } }
export function errorInfo(input) {
  const code = RUNTIME_CODES.has(input) || HOST_CODES.has(input) ? input : 'HOST_PROTOCOL';
  let ui = 'UNKNOWN', message = '操作未完成，请查看状态后重试。';
  if (/^PORT_|^INVALID_PORT$/.test(code)) { ui = 'PORT_IN_USE'; message = '独立端口不可用，未访问或停止占用方。'; }
  else if (code === 'SESSION_LOCKED') { ui = 'DATA_LOCKED'; message = '该副本已有会话；不会接管或结束它。'; }
  else if (/^PACKAGE_|UNSAFE_PATH|PLATFORM_UNSUPPORTED/.test(code)) { ui = 'INTEGRITY_FAILED'; message = '独立分发副本未通过完整性、路径或平台检查。'; }
  else if (/SPAWN_FAILED|SERVICE_EXITED/.test(code)) { ui = 'PROCESS_EXITED'; message = 'Analyzer 未能启动或已异常退出，数据保留。'; }
  else if (/TIMEOUT/.test(code)) { ui = 'TIMEOUT'; message = '操作超时，结果可能仍在收束；没有强制结束进程。'; }
  else if (HOST_CODES.has(code)) { ui = 'BRIDGE_UNAVAILABLE'; message = '可信宿主桥接不可用或正在关闭。'; }
  else if (code === 'NOT_READY' || code === 'HEALTH_FAILED') message = '尚未确认当前实例就绪，未打开浏览器。';
  else if (code === 'OPEN_FAILED') message = '系统浏览器交付失败；服务可能仍在运行。';
  else if (code === 'BUSY') message = '已有操作正在进行，请等待当前请求完成后重试。';
  return { code: ui, runtimeCode: code, message, hint: '先刷新状态；仍有归属进程时先安全停止，不要删除数据或强杀进程。' };
}
export const idle = () => ({ protocolVersion: 1, state: 'idle', package: { state: 'unknown' }, ownsProcess: false, url: null, error: null, logs: [] });
export function safeUrl(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[0-9]{4,5}\/$/.test(value)) return null;
  const p = Number(new URL(value).port);
  return p >= 1024 && p <= 65535 && p !== 8787 ? value : null;
}
export function validateStatus(raw) {
  if (!raw || raw.protocolVersion !== 1 || !states.has(raw.state) || typeof raw.ownsProcess !== 'boolean' || !packages.has(raw.package?.state) ||
      !Array.isArray(raw.logs) || raw.logs.length > 100 || (raw.error && !RUNTIME_CODES.has(raw.error.code))) throw new HostError('HOST_PROTOCOL');
  if (raw.state === 'ready' && (!raw.ownsProcess || !safeUrl(raw.url))) throw new HostError('HOST_PROTOCOL');
  const logs = raw.logs.map(e => {
    if (!e || !Number.isSafeInteger(e.seq) || e.seq < 1 || !['info','error'].includes(e.level) || !EVENTS.has(e.event) ||
      typeof e.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.at)) throw new HostError('HOST_PROTOCOL');
    return { seq: e.seq, at: e.at, level: e.level, event: e.event };
  });
  return { protocolVersion: 1, state: raw.state, ownsProcess: raw.ownsProcess, url: raw.state === 'ready' ? raw.url : null,
    package: { state: raw.package.state, version: raw.package.version === '2.0.0' ? '2.0.0' : null },
    error: raw.error ? { code: raw.error.code } : null, logs };
}
export function toUi(raw, revision, actionError = null) {
  const url = raw.state === 'ready' ? safeUrl(raw.url) : null;
  return { state: actionError ? 'error' : ({ idle:'unknown',checking:'starting',starting:'starting',ready:'running',stopping:'stopping',stopped:'stopped',failed:'error' })[raw.state],
    protocolVersion: 1, rawState: actionError ? 'failed' : raw.state,
    package: { state: raw.package.state, ...(raw.package.version ? { version: raw.package.version } : {}) },
    ownsProcess: raw.ownsProcess, logs: structuredClone(raw.logs),
    url: actionError ? null : url, port: !actionError && url ? Number(new URL(url).port) : null,
    pid: null, version: raw.package.version ?? null, startedAt: null, dataDir: null,
    error: actionError ? errorInfo(actionError) : raw.state === 'failed' ? errorInfo(raw.error?.code ?? 'INTERNAL') : null,
    revision, runtime: { state: actionError ? 'failed' : raw.state, ownsProcess: raw.ownsProcess, packageState: raw.package.state } };
}
export function allowedSender(event, contents) {
  try { return !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === UI_URL; }
  catch { return false; }
}
export function allowedRequest(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 1 && METHODS.has(payload.method);
}
export const failureView = (status, code) => ({ ...status, state: 'error', rawState: 'failed', runtime: { ...status.runtime, state: 'failed' }, url: null, port: null, error: errorInfo(code) });
