export type Live2dFpsMode = 'auto' | '30' | '60' | '120';

export interface CompanionGpuStatus {
  policyMode: 'auto' | 'gl' | 'd3d11' | 'off';
  activeBackend: string;
  webglAllowed: boolean;
  hybridMultiGpu: boolean;
  adapterCount: number;
  crashCount: number;
  displayRefreshHz?: number;
  reason: string;
}

export interface CompanionModelStatus {
  ok: boolean;
  modelAssetsReady: boolean;
  hasCubismCore: boolean;
  gpuStatus?: CompanionGpuStatus;
  error?: string;
}

export interface ArmRigHandMeta {
  x: number;
  y: number;
  w: number;
  h: number;
  pivotLocal: [number, number];
  worldWidthPx: number;
  worldHeightPx: number;
}

export interface ArmRigMeta {
  version: number;
  atlasWidth: number;
  atlasHeight: number;
  sleeve: {
    x: number;
    y: number;
    w: number;
    h: number;
    vShoulder: number;
    vElbow: number;
    vWrist: number;
    worldHalfWidthPx: number;
  };
  cuffFront: {
    x: number;
    y: number;
    w: number;
    h: number;
    vMin: number;
    vMax: number;
  };
  hands: Record<'rest' | 'chin' | 'heart' | 'wave', ArmRigHandMeta>;
}

export interface PinkSakuraModelBundle {
  ok: boolean;
  model3: {
    Version: number;
    FileReferences: {
      Moc: string;
      Textures: string[];
      Physics?: string;
      DisplayInfo?: string;
      Motions?: Record<string, { File: string }[]>;
      Expressions?: { Name: string; File: string }[];
    };
    Groups?: unknown[];
  };
  mocBase64: string;
  physics: unknown | null;
  display: unknown | null;
  textures: string[];
  motions: Record<string, unknown[]>;
  expressions: Record<string, unknown>;
  armRigAtlas?: string | null;
  armRigMeta?: ArmRigMeta | null;
  error?: string;
}

export interface CompanionModelBridge {
  version: number;
  getStatus(): Promise<CompanionModelStatus>;
  importCubismCore(): Promise<{ ok: boolean; canceled?: boolean; hasCubismCore?: boolean; error?: string }>;
  loadPinkSakuraBundle(): Promise<PinkSakuraModelBundle>;
}

declare global {
  interface Window {
    companionModel?: CompanionModelBridge;
    Live2DCubismCore?: {
      Version?: { csmGetVersion?: () => number };
    };
  }
}

export function getModelBridge(): CompanionModelBridge | null {
  return typeof window !== 'undefined' ? (window.companionModel ?? null) : null;
}
