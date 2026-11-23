/**
 * Companion ⇄ Analyzer 运行时适配契约（M1-A）
 *
 * 对齐 companion/runtime/API.md 与 supervisor.d.mts（protocolVersion: 1）：
 *   getStatus / startAnalyzer / stopAnalyzer / openAnalyzer
 *
 * UI 只依赖本接口，不区分底层是 mock 还是 window.companionBridge（Codex Runtime）。
 * 真实模式下绝不伪造成功：未注入桥接时显式报 BRIDGE_UNAVAILABLE；
 * startAnalyzer 返回 checking/starting 时由 UI 轮询 getStatus 直到 ready/failed。
 */

export type AnalyzerRunState =
  | 'unknown'
  | 'stopped'
  | 'checking'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error';

export type RuntimeRawState =
  | 'idle'
  | 'checking'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type RuntimePackageState = 'unknown' | 'checking' | 'valid' | 'invalid';

export interface RuntimePackageInfo {
  state: RuntimePackageState;
  version?: string;
  distributionRevision?: number;
  files?: number;
  checksumsSha256?: string;
}

export interface RuntimeLogEntry {
  seq: number;
  at: string;
  level: 'info' | 'error';
  event: string;
}

export type AnalyzerErrorCode =
  | 'PACKAGE_MISSING'
  | 'PACKAGE_DAMAGED'
  | 'PACKAGE_INVALID'
  | 'PACKAGE_UNSUPPORTED'
  | 'PLATFORM_UNSUPPORTED'
  | 'UNSAFE_PATH'
  | 'PACKAGE_ACCESS'
  | 'SESSION_LOCKED'
  | 'PORT_IN_USE'
  | 'PORT_UNAVAILABLE'
  | 'INVALID_PORT'
  | 'SPAWN_FAILED'
  | 'SERVICE_EXITED'
  | 'START_TIMEOUT'
  | 'STOP_TIMEOUT'
  | 'STOP_FAILED'
  | 'NOT_READY'
  | 'HEALTH_FAILED'
  | 'OPEN_FAILED'
  | 'BUSY'
  | 'LOCK_CHANGED'
  | 'BRIDGE_UNAVAILABLE'
  | 'PROCESS_EXITED'
  | 'DATA_LOCKED'
  | 'INTEGRITY_FAILED'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface AnalyzerError {
  code: AnalyzerErrorCode | (string & {});
  /** 来自 companion/host 或 Runtime 的精确诊断码 */
  runtimeCode?: string;
  message: string;
  /** 根据 companion/runtime/API.md 错误码给出的恢复建议 */
  hint?: string;
}

export interface AnalyzerStatus {
  protocolVersion?: number;
  state: AnalyzerRunState;
  /** 来自 Codex Runtime 的原始状态名，便于诊断显示 */
  rawState?: RuntimeRawState;
  /** 分发包完整性校验元数据 */
  package?: RuntimePackageInfo;
  /** 本监督器当前是否仍持有子进程（STOP_TIMEOUT 时仍为 true） */
  ownsProcess?: boolean;
  /** 本机访问地址，仅在 running/ready 时存在 */
  url: string | null;
  port: number | null;
  pid: number | null;
  version: string | null;
  /** epoch ms（若由当前会话观测到就绪则记录） */
  startedAt: number | null;
  dataDir: string | null;
  error: AnalyzerError | null;
  /** 最近至多 100 条监督器事件快照（按 seq 递增） */
  logs?: RuntimeLogEntry[];
}

export interface OpenResult {
  opened: boolean;
  url: string;
  /** OPEN_FAILED 等动作错误通过这里返回，不代表主服务崩溃 */
  error?: AnalyzerError | null;
  status?: AnalyzerStatus;
}

export interface CompanionDriver {
  readonly kind: 'mock' | 'codex';
  getStatus(): Promise<AnalyzerStatus>;
  startAnalyzer(): Promise<AnalyzerStatus>;
  stopAnalyzer(): Promise<AnalyzerStatus>;
  openAnalyzer(): Promise<OpenResult>;
  subscribe?(listener: (status: AnalyzerStatus) => void): () => void;
}

export const EMPTY_STATUS: AnalyzerStatus = {
  state: 'unknown',
  url: null,
  port: null,
  pid: null,
  version: null,
  startedAt: null,
  dataDir: null,
  error: null,
  logs: [],
};

const ERROR_HINTS: Record<string, string> = {
  PACKAGE_MISSING: '找不到分发包目录。请重新选择或解压独立的 Analyzer r2 文件夹。',
  PACKAGE_DAMAGED: '分发包文件校验未通过（SHA-256 不匹配）。请重新解压干净的分发包到新目录，勿覆盖现有 data。',
  PACKAGE_INVALID: '分发包结构不完整或版本不匹配。请核对是否选择了同时包含 runtime、packages 与 checksums.json 的目录。',
  PACKAGE_UNSUPPORTED: '当前运行时仅支持 Analyzer 2.0.0 (r2) 分发包。',
  PLATFORM_UNSUPPORTED: '当前仅支持 Windows x64 与随包 Node 24 运行时。',
  UNSAFE_PATH: '禁止使用符号链接、网盘同步目录或正式开发路径，请改用可写的独立普通本地目录。',
  PACKAGE_ACCESS: '无法读取分发包目录，请检查文件夹权限或是否被安全软件拦截。',
  SESSION_LOCKED: '该目录已有另一个 Analyzer 实例在运行（.analyzer-session.json 锁定）。请回到原窗口关闭，M0 不自动清理锁。',
  PORT_IN_USE: '指定端口已被其他程序占用，Companion 不会结束占用方。可更换端口或重试自动分配空闲端口。',
  PORT_UNAVAILABLE: '未能分配可用的本机端口，请检查本机网络策略或防火墙。',
  INVALID_PORT: '端口号无效或被保留（例如 8787）。',
  SPAWN_FAILED: '无法拉起随包 Node 24 子进程，请确认 runtime/node.exe 未被拦截或损坏。',
  SERVICE_EXITED: 'Analyzer 子进程意外退出，本地数据已保留，下次启动会执行恢复检查。可查看日志后重新启动。',
  START_TIMEOUT: 'Analyzer 启动超过等待时限，已请求优雅退出。请稍后重试启动。',
  STOP_TIMEOUT: '安全停止超时，子进程仍在收束后台任务或 SQLite（ownsProcess=true）。请勿强行结束，点击重试安全停止。',
  STOP_FAILED: '安全停止未完成，请保持 Companion 打开并重试安全停止。',
  NOT_READY: 'Analyzer 尚未就绪，暂不能打开网页端。请等待状态转为「运行中」。',
  HEALTH_FAILED: '本地健康检查未通过，服务可能正在退出或出现异常。',
  OPEN_FAILED: '调用系统默认浏览器失败，但 Analyzer 服务仍在运行。可复制上方本机地址手动在浏览器中打开。',
  BUSY: '上一个运行时操作仍在进行中，请稍候再试。',
  LOCK_CHANGED: '会话锁文件发生了变化，已停止当前进程但未删除锁，请人工核查目录。',
  BRIDGE_UNAVAILABLE: '未检测到桌面宿主注入的 window.companionBridge。请在桌面宿主中运行，或切回 Mock 模式进行原型演示。',
  PROCESS_EXITED: 'Analyzer 进程意外退出，数据库将在下次启动时执行既有恢复检查。',
  DATA_LOCKED: '数据目录被占用，请关闭其他 Analyzer 实例后重试。',
  INTEGRITY_FAILED: '文件完整性校验未通过，请重新解压干净的分发包。',
  TIMEOUT: '操作超时，请稍后重试。',
};

export function describeRuntimeError(
  code: string,
  message: string,
  explicitHint?: string,
  runtimeCode?: string,
): AnalyzerError {
  const effective = runtimeCode ?? code;
  return {
    code,
    ...(runtimeCode ? { runtimeCode } : {}),
    message,
    hint: explicitHint ?? ERROR_HINTS[effective] ?? ERROR_HINTS[code] ?? '请查看运行日志，确认本地目录与端口状态后重试。',
  };
}
