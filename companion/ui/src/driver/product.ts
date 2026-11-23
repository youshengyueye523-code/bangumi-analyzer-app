/** Typed bridge to Electron Main Process M2 (Setup) & M3 (Maintenance) services */

export interface CompanionPersistedState {
  firstRunCompleted: boolean;
  installDir: string | null;
  nickname: string;
  username: string;
  uid: number | null;
  collections: number;
  aiConfigured: boolean;
  aiModel: string;
  skipIntro: boolean;
  autoStart: boolean;
  autoOpen: boolean;
  desktopShortcut: boolean;
  gpuMode?: 'auto' | 'gl' | 'd3d11' | 'off';
  live2dFpsMode?: 'auto' | '30' | '60' | '120';
  updateFeedUrl?: string;
  installedAt: string | null;
  lastSyncAt: string | null;
}

export interface ProductStateResponse {
  ok: boolean;
  mode: 'product' | 'direct';
  state: CompanionPersistedState;
  r2ZipHash: string;
  engineBound: boolean;
  error?: string;
}

export interface RealEnvCheckResult {
  state: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export interface DirValidationResult {
  level: 'ok' | 'warn' | 'error';
  title: string;
  reasons: string[];
  freeGb: number | null;
}

export interface VerifyAccountResponse {
  ok: boolean;
  code?: string;
  message?: string;
  hint?: string;
  profile?: {
    username: string;
    uid: number;
    nickname: string;
    sign: string;
    collections: number;
    privateVisible: boolean;
    hue: number;
  };
}

export interface TestAiResponse {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  code?: string;
  message?: string;
  hint?: string;
}

export interface SyncStatusResponse {
  ok: boolean;
  running: boolean;
  progress: {
    runId?: number;
    phase: string;
    message: string;
    current: number;
    total: number;
    percent: number;
    etaSeconds: number | null;
    counters: { fetched: number; added: number; updated: number; detailsFetched: number; failures: number };
    issues?: string[];
  } | null;
  lastRun: {
    id?: number;
    status: string;
    phase: string;
    durationMs: number | null;
    error: string | null;
    counters?: { fetched: number; detailsFetched: number };
  } | null;
  lastSuccessfulSyncAt?: string | null;
  error?: string;
}

export interface BackupEntry {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  reason?: string;
  dbSizeBytes?: number;
}

export interface IntegrityReport {
  ok: boolean;
  checks: {
    id: string;
    label: string;
    ok: boolean;
    detail: string;
  }[];
  error?: string;
}

export interface MaintenanceOverview {
  installed: boolean;
  version: string;
  distributionRevision: number;
  installDir: string | null;
  dataDir: string | null;
  dbSizeBytes: number;
  backupCount: number;
  running: boolean;
  error?: string;
}

export interface UpdateCheckResult {
  ok?: boolean;
  configured?: boolean;
  source?: string;
  updateAvailable: boolean;
  current: { version: string; distributionRevision: number };
  latest?: {
    version: string;
    distributionRevision: number;
    sha256?: string;
    packageUrl?: string;
    zipPath?: string;
    notes?: string;
    publishedAt?: string;
  };
  message?: string;
  error?: string;
}

export interface ApplyUpdateResult {
  ok: boolean;
  rolledBack: boolean;
  downloadFailed?: boolean;
  reason?: string;
  backupFile?: string | null;
  error?: string;
}

export interface CompanionProductBridge {
  version: number;
  getCompanionState(): Promise<ProductStateResponse>;
  savePreferences(patch: Partial<Pick<CompanionPersistedState, 'skipIntro' | 'autoStart' | 'autoOpen' | 'desktopShortcut' | 'updateFeedUrl' | 'gpuMode' | 'live2dFpsMode'>>): Promise<{ ok: boolean; state?: CompanionPersistedState; error?: string }>;
  runEnvCheck(args: { id: string; targetDir?: string }): Promise<RealEnvCheckResult>;
  validateInstallDir(args: { rawPath: string }): Promise<DirValidationResult>;
  pickInstallDir(): Promise<{ canceled: boolean; path: string | null }>;
  verifyBangumiAccount(args: { username: string; token?: string }): Promise<VerifyAccountResponse>;
  testAiConnection(args: { baseUrl: string; model: string; key: string }): Promise<TestAiResponse>;
  installAndExtract(args: { installDir: string }): Promise<{ ok: boolean; installDir?: string; state?: CompanionPersistedState; code?: string; error?: string; hint?: string }>;
  configureAndStartAnalyzer(args: {
    username?: string;
    token?: string;
    nickname?: string;
    uid?: number;
    collections?: number;
    ai?: { enabled: boolean; baseUrl?: string; model?: string; key?: string } | null;
    desktopShortcut?: boolean;
    autoStart?: boolean;
    autoOpen?: boolean;
    skipIntro?: boolean;
  }): Promise<{ ok: boolean; url?: string; port?: number; state?: CompanionPersistedState; code?: string; error?: string; hint?: string }>;
  startAnalyzerSync(args: { mode?: 'full' | 'incremental' | 'enrich'; depth?: 1 | 2 }): Promise<{ ok: boolean; started?: boolean; runId?: number | null; alreadyRunning?: boolean; error?: string }>;
  getSyncStatus(): Promise<SyncStatusResponse>;
  cancelSync(): Promise<{ ok: boolean; error?: string }>;
  finishFirstRun(args: { collections?: number; desktopShortcut?: boolean; skipIntro?: boolean; autoStart?: boolean; autoOpen?: boolean }): Promise<{ ok: boolean; state?: CompanionPersistedState; error?: string }>;
  getMaintenanceOverview(): Promise<MaintenanceOverview>;
  listBackups(): Promise<{ backups: BackupEntry[]; error?: string }>;
  createBackup(): Promise<{ ok?: boolean; backup?: BackupEntry; error?: string }>;
  restoreBackup(args: { fileName: string }): Promise<{ ok?: boolean; preRestoreBackup?: string; restoredFrom?: string; error?: string }>;
  runIntegrityCheck(): Promise<IntegrityReport>;
  pickUpdateZip(): Promise<{ canceled: boolean; path: string | null }>;
  checkUpdate(args?: { manifestPath?: string }): Promise<UpdateCheckResult>;
  applySafeUpdate(args: { packageUrl?: string; zipPath?: string; expectedSha256?: string }): Promise<ApplyUpdateResult>;
  exportDiagnostics(): Promise<{ canceled?: boolean; exported?: boolean; error?: string }>;
  uninstallCompanion(args: { removeProgramFiles: boolean; removeUserData: boolean }): Promise<{ ok?: boolean; userDataPreserved?: boolean; error?: string }>;
  onProductEvent(listener: (ev: { type: string; payload: unknown }) => void): () => void;
}

declare global {
  interface Window {
    companionProduct?: CompanionProductBridge;
  }
}

export function isProductMode(): boolean {
  if (typeof window === 'undefined' || !window.companionProduct) return false;
  const mode = new URLSearchParams(window.location.search).get('mode');
  return mode === 'product';
}

export function getProductBridge(): CompanionProductBridge | null {
  return isProductMode() ? (window.companionProduct ?? null) : null;
}
