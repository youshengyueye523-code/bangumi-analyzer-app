import type * as PixiNS from 'pixi.js';
import type { Live2DModel as Live2DModelType } from 'pixi-live2d-display/cubism4';

/**
 * Pinned Live2D WebGL runtime compatibility matrix verified in isolated Electron builds.
 */
export const LIVE2D_RUNTIME_VERSIONS = {
  pixiJs: '6.5.10',
  pixiUnsafeEval: '6.5.10',
  pixiLive2dDisplay: '0.4.0',
  cubismCoreTested: '06.00.0001 (CubismSdkForWeb-5-r.5)',
  minCubismCoreVersionNum: 0x05000000,
  defaultMaxFps: 60,
} as const;

export type FpsPolicyMode = 'auto' | '30' | '60' | '120';

export interface FpsTargetResolution {
  capFps: number;
  displayRefreshHz: number;
  reason: string;
}

/**
 * Compute bounded Live2D ticker frame-rate ceiling from user policy, detected display refresh rate,
 * and rolling render frame-time pressure. Never uncaps completely (always bounded).
 */
export function resolveLive2dFpsTarget({
  mode,
  displayRefreshHz,
  backpressureStep = 0,
}: {
  mode: FpsPolicyMode;
  displayRefreshHz?: number;
  backpressureStep?: number;
}): FpsTargetResolution {
  const rawHz = Number(displayRefreshHz);
  const safeHz = Number.isFinite(rawHz) && rawHz >= 30 ? Math.min(240, Math.round(rawHz)) : 60;

  if (mode === '30') {
    return { capFps: 30, displayRefreshHz: safeHz, reason: 'USER_LOW_POWER_30' };
  }
  if (mode === '60') {
    return { capFps: Math.min(60, safeHz), displayRefreshHz: safeHz, reason: 'USER_STANDARD_60' };
  }
  if (mode === '120') {
    // Allow 120 FPS on high-refresh displays; clamp to native panel rate on 60 Hz panels.
    return { capFps: Math.min(120, Math.max(60, safeHz)), displayRefreshHz: safeHz, reason: 'USER_HIGH_REFRESH_120' };
  }
  const baseAuto = Math.min(60, safeHz);
  if (backpressureStep >= 2) {
    return { capFps: 30, displayRefreshHz: safeHz, reason: 'AUTO_BACKPRESSURE_30' };
  }
  if (backpressureStep === 1) {
    return { capFps: Math.min(45, baseAuto), displayRefreshHz: safeHz, reason: 'AUTO_BACKPRESSURE_45' };
  }
  return { capFps: baseAuto, displayRefreshHz: safeHz, reason: 'AUTO_STABLE_DEFAULT' };
}

const installedShaderSystems = new WeakSet<object>();

export function applyPixiCspAdapter(
  pixi: typeof PixiNS,
  installUnsafeEval: (core: { ShaderSystem: typeof PixiNS.ShaderSystem }) => void,
) {
  if (!installedShaderSystems.has(pixi.ShaderSystem)) {
    installUnsafeEval(pixi);
    installedShaderSystems.add(pixi.ShaderSystem);
  }
}

/**
 * Cubism 5 Core (06.00.0001) relocated drawable render orders from `model.drawables.renderOrders`
 * to `model.getRenderOrders()` / `model.renderOrders`. Patch `CubismModel.prototype` idempotently
 * so `pixi-live2d-display@0.4.0` works cleanly with both Cubism 4 and Cubism 5 Core WASM.
 */
export function patchCubism5ModelProto(cubism4Mod: unknown) {
  const ctor = (cubism4Mod as {
    CubismModel?: {
      prototype?: Record<string, unknown> & {
        getDrawableRenderOrders?: (this: {
          _model?: {
            drawables?: { renderOrders?: Int32Array; drawOrders?: Int32Array };
            getRenderOrders?: () => Int32Array;
            renderOrders?: Int32Array;
          };
        }) => Int32Array;
      };
    };
  })?.CubismModel;

  const proto = ctor?.prototype;
  if (!proto || proto.__cubism5RenderOrdersPatched) return false;
  proto.__cubism5RenderOrdersPatched = true;
  proto.getDrawableRenderOrders = function () {
    const m = this._model;
    return (
      m?.drawables?.renderOrders ??
      m?.getRenderOrders?.() ??
      m?.renderOrders ??
      m?.drawables?.drawOrders ??
      new Int32Array(0)
    );
  };
  return true;
}

/**
 * Check whether the host WebGL2 / WebGL1 context can be created cleanly before handing off to PixiJS.
 */
export function probeCanvasWebglSupport(canvas: HTMLCanvasElement): boolean {
  try {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return Boolean(gl && !gl.isContextLost());
  } catch {
    return false;
  }
}

/**
 * Thoroughly destroy model, PixiJS Application, and cached inline texture URLs without detaching
 * React's `<canvas>` node, preventing VRAM / TextureCache buildup across repeated mount toggles.
 */
export function destroyLive2dResources({
  model,
  app,
  pixi,
  textureUrls = [],
}: {
  model: Live2DModelType | null;
  app: PixiNS.Application | null;
  pixi: typeof PixiNS | null;
  textureUrls?: string[];
}) {
  try {
    if (model) {
      model.destroy();
    }
  } catch {
    /* ignore teardown errors on lost context */
  }
  try {
    if (app) {
      app.ticker?.stop();
      app.destroy(false, { children: true, texture: true, baseTexture: true });
    }
  } catch {
    /* ignore teardown errors on lost context */
  }
  if (pixi?.utils) {
    for (const url of textureUrls) {
      try {
        const tex = pixi.utils.TextureCache[url];
        if (tex) tex.destroy(true);
        delete pixi.utils.TextureCache[url];
        const base = pixi.utils.BaseTextureCache[url];
        if (base) base.destroy();
        delete pixi.utils.BaseTextureCache[url];
      } catch {
        /* ignore cache cleanup */
      }
    }
    try {
      pixi.utils.clearTextureCache();
    } catch {
      /* ignore */
    }
  }
}
