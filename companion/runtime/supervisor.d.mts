export type RuntimeState = 'idle' | 'checking' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
export type AllowedAnalyzerRoute = '/' | '/library' | '/analysis' | '/series' | '/profile' | '/diagnostics';
export interface RuntimeErrorInfo { code: string; message: string }
export interface RuntimeStatus {
  protocolVersion: 1;
  state: RuntimeState;
  package: { state: 'unknown' | 'checking' | 'valid' | 'invalid'; version?: string; distributionRevision?: number; files?: number; checksumsSha256?: string };
  ownsProcess: boolean;
  url: string | null;
  error: RuntimeErrorInfo | null;
  logs: Array<{ seq: number; at: string; level: 'info' | 'error'; event: string }>;
}
export interface RuntimeResult { ok: boolean; status: RuntimeStatus; error?: RuntimeErrorInfo; openedUrl?: string }
export class AnalyzerSupervisor {
  constructor(options: {
    packageRoot: string; port?: number; startupTimeoutMs?: number; stopTimeoutMs?: number;
    /** Test/host adapter only; never accepted from JSONL or an untrusted web page. */
    openBrowser?: (url: string) => Promise<void>;
  });
  getStatus(): RuntimeStatus;
  startAnalyzer(): Promise<RuntimeResult>;
  stopAnalyzer(): Promise<RuntimeResult>;
  openAnalyzer(route?: AllowedAnalyzerRoute): Promise<RuntimeResult>;
}
export function openDefaultBrowser(url: string): Promise<void>;
