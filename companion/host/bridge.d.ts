export type UiErrorCode = 'PORT_IN_USE'|'PROCESS_EXITED'|'DATA_LOCKED'|'INTEGRITY_FAILED'|'TIMEOUT'|'BRIDGE_UNAVAILABLE'|'UNKNOWN';
export interface BridgeError { code: UiErrorCode; runtimeCode: string; message: string; hint?: string }
export interface CompanionStatus {
  protocolVersion: 1;
  rawState: 'idle'|'checking'|'starting'|'ready'|'stopping'|'stopped'|'failed';
  package: { state: 'unknown'|'checking'|'valid'|'invalid'; version?: string };
  ownsProcess: boolean;
  logs: CompanionLog[];
  state: 'unknown'|'stopped'|'starting'|'running'|'stopping'|'error';
  url: string|null; port: number|null; pid: null; version: string|null; startedAt: null; dataDir: null;
  error: BridgeError|null;
  revision: number;
  runtime: { state: string; ownsProcess: boolean; packageState: string };
}
export interface CompanionLog { seq: number; at: string; level: 'info'|'error'; event: string }
export interface OpenResult { opened: boolean; url: string; error?: BridgeError }
export interface CompanionBridge {
  readonly bridgeVersion: 1;
  getStatus(): Promise<CompanionStatus>;
  startAnalyzer(): Promise<CompanionStatus>;
  stopAnalyzer(): Promise<CompanionStatus>;
  openAnalyzer(): Promise<OpenResult>;
  getLogs(): Promise<CompanionLog[]>;
  onStatus(listener: (status: CompanionStatus) => void): () => void;
  onLogs(listener: (logs: CompanionLog[]) => void): () => void;
}
