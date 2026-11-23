import { useEffect, useRef } from 'react';
import type * as PixiNS from 'pixi.js';
import type { Live2DModel as Live2DModelType } from 'pixi-live2d-display/cubism4';
import type { MascotState, MascotVariant } from './Mascot';
import { PerformanceDirector, type CoreParamSink, type InteractionVariantSpec } from '../assets/xiaofan/PerformanceDirector';
import { ArmRigRenderer } from '../assets/xiaofan/ArmRigRenderer';
import { getModelBridge, type PinkSakuraModelBundle } from '../driver/model';
import { PINK_SAKURA_DRAWING, PINK_SAKURA_REGIONS, PINK_SAKURA_STATE_MAP } from '../assets/xiaofan/pinkSakuraConfig';
import {
  applyPixiCspAdapter,
  destroyLive2dResources,
  patchCubism5ModelProto,
  probeCanvasWebglSupport,
  resolveLive2dFpsTarget,
  type FpsPolicyMode,
} from '../assets/xiaofan/cubism5Compat';
import { usePrefs } from '../state/prefs';

export type Live2DStageReason =
  | 'ok'
  | 'bridge_unavailable'
  | 'core_missing'
  | 'csp_wasm_blocked'
  | 'gpu_disabled'
  | 'webgl_unavailable'
  | 'gpu_context_lost'
  | 'load_error';

let coreLoadPromise: Promise<void> | null = null;
let cachedBundlePromise: Promise<PinkSakuraModelBundle> | null = null;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function ensureCubismCoreScript(): Promise<void> {
  if (window.Live2DCubismCore) return;
  if (!coreLoadPromise) {
    coreLoadPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './vendor/live2dcubismcore.min.js';
      s.onload = async () => {
        const deadline = performance.now() + 10000;
        while (performance.now() < deadline) {
          try {
            if (window.Live2DCubismCore?.Version?.csmGetVersion?.()) {
              resolve();
              return;
            }
          } catch {
            /* WASM initializing */
          }
          await new Promise<void>((r) => setTimeout(r, 25));
        }
        reject(new Error('Cubism Core initialized without csmGetVersion'));
      };
      s.onerror = () => reject(new Error('Failed to load ./vendor/live2dcubismcore.min.js'));
      document.head.appendChild(s);
    }).catch((err) => {
      coreLoadPromise = null;
      throw err;
    });
  }
  await coreLoadPromise;
}

function registerBundleMiddleware(
  Live2DLoader: typeof import('pixi-live2d-display/cubism4').Live2DLoader,
  bundle: PinkSakuraModelBundle,
) {
  const virtualBase = 'companion://pink-sakura/';
  const lookup = new Map<string, unknown>();
  lookup.set(`${virtualBase}PinkSakura.model3.json`, {
    ...bundle.model3,
    FileReferences: {
      ...bundle.model3.FileReferences,
      Textures: bundle.textures,
    },
  });
  lookup.set(`${virtualBase}${bundle.model3.FileReferences.Moc}`, base64ToArrayBuffer(bundle.mocBase64));
  if (bundle.model3.FileReferences.Physics && bundle.physics) {
    lookup.set(`${virtualBase}${bundle.model3.FileReferences.Physics}`, bundle.physics);
  }
  if (bundle.model3.FileReferences.DisplayInfo && bundle.display) {
    lookup.set(`${virtualBase}${bundle.model3.FileReferences.DisplayInfo}`, bundle.display);
  }
  for (const [group, files] of Object.entries(bundle.model3.FileReferences.Motions ?? {})) {
    files.forEach((f, idx) => {
      const data = bundle.motions[group]?.[idx];
      if (data) lookup.set(`${virtualBase}${f.File}`, data);
    });
  }
  for (const exp of bundle.model3.FileReferences.Expressions ?? []) {
    if (bundle.expressions[exp.Name]) lookup.set(`${virtualBase}${exp.File}`, bundle.expressions[exp.Name]);
  }

  // Register once in Live2DLoader middleware chain so XHR/fetch is never invoked for local model bundles.
  const tag = '__companionPinkSakuraMiddleware';
  if (!(Live2DLoader as unknown as Record<string, boolean>)[tag]) {
    (Live2DLoader as unknown as Record<string, boolean>)[tag] = true;
    Live2DLoader.middlewares.unshift(async (context, next) => {
      const target = context.settings ? context.settings.resolveURL(context.url) : context.url;
      if (lookup.has(target)) {
        context.result = lookup.get(target);
        return;
      }
      return next();
    });
  }
  return `${virtualBase}PinkSakura.model3.json`;
}

export function Live2DStage({
  state,
  variant,
  interactNonce = 0,
  onReady,
  onFallback,
  onInteraction,
}: {
  state: MascotState;
  variant: MascotVariant;
  interactNonce?: number;
  onReady?: () => void;
  onFallback?: (reason: Live2DStageReason, detail?: string) => void;
  onInteraction?: (spec: InteractionVariantSpec) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<Live2DModelType | null>(null);
  const appRef = useRef<PixiNS.Application | null>(null);
  const directorRef = useRef(new PerformanceDirector());
  const stateRef = useRef<MascotState>(state);
  const onInteractionRef = useRef(onInteraction);
  onInteractionRef.current = onInteraction;
  const lastDtSecRef = useRef<number>(1 / 60);
  const lastInteractNonceRef = useRef<number>(interactNonce);
  const reduceMotionRef = useRef(false);
  const fpsModeRef = useRef<FpsPolicyMode>('auto');
  const displayHzRef = useRef<number>(60);
  const backpressureRef = useRef<number>(0);
  const targetFpsCapRef = useRef<number>(60);
  const p = usePrefs();
  stateRef.current = state;
  reduceMotionRef.current = p.reduceMotion;
  fpsModeRef.current = p.live2dFpsMode;

  useEffect(() => {
    let disposed = false;
    let app: PixiNS.Application | null = null;
    let pixiMod: typeof PixiNS | null = null;
    let resizeObs: ResizeObserver | null = null;
    let bundleTextures: string[] = [];
    let winMinimized = false;
    let unsubWinState: (() => void) | undefined;
    let internalEventTarget: { off?: (evt: string, fn: () => void) => void } | null = null;
    let onAfterMotionRef: (() => void) | null = null;
    let onBeforeCommitRef: (() => void) | null = null;
    let armRig: ArmRigRenderer | null = null;
    const canvasEl = canvasRef.current;

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      if (disposed) return;
      disposed = true;
      app?.ticker?.stop();
      destroyLive2dResources({ model: modelRef.current, app, pixi: pixiMod, textureUrls: bundleTextures });
      modelRef.current = null;
      appRef.current = null;
      app = null;
      onFallback?.('gpu_context_lost', 'WebGL context lost');
    };

    const syncTickerPaused = () => {
      if (!app || disposed) return;
      const paused = document.hidden || winMinimized || reduceMotionRef.current;
      if (paused) app.ticker.stop();
      else if (!app.ticker.started) app.ticker.start();
      if (canvasRef.current) {
        canvasRef.current.dataset.tickerPaused = paused ? 'true' : 'false';
      }
    };

    if (canvasEl) canvasEl.addEventListener('webglcontextlost', handleContextLost, false);
    document.addEventListener('visibilitychange', syncTickerPaused);
    if (window.companionWindow?.onState) {
      unsubWinState = window.companionWindow.onState((ws) => {
        winMinimized = Boolean(ws.isMinimized);
        syncTickerPaused();
      });
    }

    async function boot() {
      const mb = getModelBridge();
      if (!mb) {
        onFallback?.('bridge_unavailable');
        return;
      }
      const st = await mb.getStatus();
      if (disposed) return;
      if (st.gpuStatus && !st.gpuStatus.webglAllowed) {
        onFallback?.('gpu_disabled', st.gpuStatus.reason);
        return;
      }
      if (!st.ok || !st.modelAssetsReady || !st.hasCubismCore) {
        onFallback?.('core_missing');
        return;
      }
      if (!probeCanvasWebglSupport(document.createElement('canvas'))) {
        onFallback?.('webgl_unavailable', 'WEBGL_CONTEXT_UNAVAILABLE');
        return;
      }

      try {
        await ensureCubismCoreScript();
      } catch (err) {
        if (!disposed) {
          const msg = err instanceof Error ? err.message : String(err);
          onFallback?.(msg.includes('Content Security') ? 'csp_wasm_blocked' : 'load_error', msg);
        }
        return;
      }
      if (disposed || !canvasRef.current) return;

      try {
        if (!cachedBundlePromise) cachedBundlePromise = mb.loadPinkSakuraBundle();
        const bundle = await cachedBundlePromise;
        if (!bundle.ok || disposed || !canvasRef.current) {
          onFallback?.('load_error', bundle.error);
          return;
        }
        bundleTextures = bundle.textures;

        const [PIXI, { install: installUnsafeEval }, cubism4Mod] = await Promise.all([
          import('pixi.js'),
          import('@pixi/unsafe-eval'),
          import('pixi-live2d-display/cubism4'),
        ]);
        const { Live2DLoader, Live2DModel } = cubism4Mod;
        pixiMod = PIXI;
        if (disposed || !canvasRef.current) return;

        patchCubism5ModelProto(cubism4Mod);
        applyPixiCspAdapter(PIXI, installUnsafeEval);
        Live2DModel.registerTicker(PIXI.Ticker);
        app = new PIXI.Application({
          view: canvasRef.current,
          width: canvasRef.current.clientWidth || 320,
          height: canvasRef.current.clientHeight || 420,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          autoStart: false,
          preserveDrawingBuffer: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          powerPreference: 'high-performance',
        });
        // Remove Pixi's default unpaced render callback; our phase accumulator triggers render strictly at targetCapFps.
        app.ticker.remove(app.render, app);
        displayHzRef.current = st.gpuStatus?.displayRefreshHz ?? 60;
        const initialFpsTarget = resolveLive2dFpsTarget({
          mode: fpsModeRef.current,
          displayRefreshHz: displayHzRef.current,
          backpressureStep: backpressureRef.current,
        });
        targetFpsCapRef.current = initialFpsTarget.capFps;
        appRef.current = app;

        const virtualModelUrl = registerBundleMiddleware(Live2DLoader, bundle);
        // Disable PIXI.Ticker.shared autoUpdate & Pixi auto idle motion so PerformanceDirector owns motion cleanly.
        const model = await Live2DModel.from(virtualModelUrl, {
          autoInteract: false,
          autoUpdate: false,
          idleMotionGroup: '__director__',
        });
        if (disposed || !app) {
          model.destroy();
          return;
        }
        modelRef.current = model;
        app.stage.addChild(model as unknown as PixiNS.DisplayObject);

        const internal = model.internalModel as unknown as {
          renderer?: { setClippingMaskBufferSize?: (n: number) => void };
          eyeBlink?: unknown;
          breath?: unknown;
          on?: (evt: string, fn: () => void) => void;
          off?: (evt: string, fn: () => void) => void;
          coreModel?: CoreParamSink & {
            _model?: { drawables?: { count?: number }; parameters?: { count?: number } };
            getModel?: () => { drawables?: { count?: number }; parameters?: { count?: number } };
          };
          motionManager?: { definitions?: Record<string, unknown[]> };
        };
        internal.eyeBlink = null;
        internal.breath = null;

        const director = directorRef.current;
        director.setExpressionHandler((exp) => {
          if (disposed || !modelRef.current) return;
          if (canvasRef.current) canvasRef.current.dataset.directorExpression = exp;
          void modelRef.current.expression(exp).catch(() => {});
        });
        director.setState(stateRef.current);

        const onAfterMotion = () => {
          director.applyAfterMotion(internal.coreModel, lastDtSecRef.current);
        };
        const onBeforeCommit = () => {
          director.applyBeforeCommit(internal.coreModel, lastDtSecRef.current);
        };
        internalEventTarget = internal;
        onAfterMotionRef = onAfterMotion;
        onBeforeCommitRef = onBeforeCommit;
        internal.on?.('afterMotionUpdate', onAfterMotion);
        internal.on?.('beforeModelUpdate', onBeforeCommit);

        const gl = (app.renderer as unknown as { gl?: WebGLRenderingContext }).gl;
        if (gl && internal?.renderer?.setClippingMaskBufferSize) {
          const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
          internal.renderer.setClippingMaskBufferSize(Math.min(1024, maxTex));
        }

        // Attach 2-bone anatomical arm & split-cuff WebGL renderer when atlas bundle is present
        if (gl && internal?.renderer && bundle.armRigAtlas && bundle.armRigMeta) {
          armRig = await ArmRigRenderer.attach(
            internal.renderer,
            gl,
            bundle.armRigAtlas,
            bundle.armRigMeta,
            director.armRig,
          );
          if (disposed) {
            armRig.dispose();
            armRig = null;
            return;
          }
          if (canvasRef.current) canvasRef.current.dataset.armRigActive = 'true';
        }

        let lastFittedW = 0;
        let lastFittedH = 0;
        const containerEl = canvasRef.current.parentElement ?? canvasRef.current;
        const fitModel = (force = false) => {
          if (!app || !model || !canvasRef.current) return;
          const hostBox = canvasRef.current.parentElement ?? canvasRef.current;
          const w = Math.max(120, hostBox.clientWidth);
          const h = Math.max(160, hostBox.clientHeight);
          if (!force && w === lastFittedW && h === lastFittedH) return;
          lastFittedW = w;
          lastFittedH = h;
          app.renderer.resize(w, h);
          canvasRef.current.style.width = '100%';
          canvasRef.current.style.height = '100%';

          model.scale.set(1);
          const baseW = model.width || PINK_SAKURA_DRAWING.width;
          const baseH = model.height || PINK_SAKURA_DRAWING.height;
          const region = variant === 'full' ? PINK_SAKURA_REGIONS.full : PINK_SAKURA_REGIONS.half;
          const scaleX = w / (baseW * (region.w / PINK_SAKURA_DRAWING.width));
          const scaleY = h / (baseH * (region.h / PINK_SAKURA_DRAWING.height));
          const scale = Math.min(scaleX, scaleY) * 0.97;

          model.scale.set(scale);
          model.anchor.set(0.5, 0);
          model.x = w * 0.5;
          model.y = variant === 'half' ? h * 0.012 : h * 0.02;
        };

        fitModel(true);
        resizeObs = new ResizeObserver(() => fitModel(false));
        resizeObs.observe(containerEl);

        // Expose honest runtime telemetry on canvas element
        if (canvasRef.current) {
          const c = canvasRef.current;
          c.dataset.live2dActive = 'true';
          c.dataset.variant = variant;
          c.dataset.fpsMode = fpsModeRef.current;
          c.dataset.maxFps = String(initialFpsTarget.capFps);
          c.dataset.displayHz = String(initialFpsTarget.displayRefreshHz);
          c.dataset.gpuBackend = st.gpuStatus?.activeBackend ?? 'unknown';
          c.dataset.tickerPaused = (document.hidden || reduceMotionRef.current) ? 'true' : 'false';
          c.dataset.coreVersion = String(window.Live2DCubismCore?.Version?.csmGetVersion?.() ?? 'unknown');
          c.dataset.motionGroups = String(Object.keys(internal?.motionManager?.definitions ?? {}).length);
          const raw = internal?.coreModel?.getModel?.() ?? internal?.coreModel?._model;
          if (raw?.drawables?.count) c.dataset.drawables = String(raw.drawables.count);
          if (raw?.parameters?.count) c.dataset.params = String(raw.parameters.count);
        }

        // Phase-accurate FPS scheduler + wall-clock time-based Live2D update (1.0x speed across 30/60/120 FPS)
        let frameCount = 0;
        let lastVsyncTs = performance.now();
        let lastRenderedTs = lastVsyncTs;
        let renderAccumMs = 1000; // Render immediately on first frame
        let fpsWinStart = lastVsyncTs;
        let fpsWinFrames = 0;
        let lastTelemetryTs = lastVsyncTs;
        let slowFrameStreak = 0;
        app.ticker.add(() => {
          const now = performance.now();
          if (reduceMotionRef.current || document.hidden) {
            lastVsyncTs = now;
            lastRenderedTs = now;
            fpsWinStart = now;
            fpsWinFrames = 0;
            return;
          }
          const vsyncDt = Math.min(100, Math.max(0, now - lastVsyncTs));
          lastVsyncTs = now;
          const intervalMs = 1000 / Math.max(15, targetFpsCapRef.current);
          renderAccumMs += vsyncDt;
          if (renderAccumMs + 0.75 < intervalMs) return;
          renderAccumMs = Math.min(intervalMs * 0.85, Math.max(0, renderAccumMs - intervalMs));

          const dtMS = Math.min(100, Math.max(0, now - lastRenderedTs));
          lastRenderedTs = now;
          lastDtSecRef.current = Math.max(0.001, dtMS / 1000);
          frameCount += 1;
          fpsWinFrames += 1;

          // Advance Live2D animations & physics strictly by real elapsed ms via internalModel lifecycle hooks.
          const workStart = performance.now();
          model.update(dtMS);
          app?.render();

          const frameWorkMs = performance.now() - workStart;
          if (fpsModeRef.current === 'auto') {
            if (frameWorkMs > 18) slowFrameStreak += 1;
            else slowFrameStreak = Math.max(0, slowFrameStreak - 1);
            if (slowFrameStreak >= 24 && backpressureRef.current < 2) {
              backpressureRef.current += 1;
              slowFrameStreak = 0;
              const throttled = resolveLive2dFpsTarget({
                mode: 'auto',
                displayRefreshHz: displayHzRef.current,
                backpressureStep: backpressureRef.current,
              });
              targetFpsCapRef.current = throttled.capFps;
              if (canvasRef.current) canvasRef.current.dataset.maxFps = String(throttled.capFps);
            }
          }

          const winElapsed = now - fpsWinStart;
          if (canvasRef.current && (frameCount === 1 || frameCount === 5 || now - lastTelemetryTs >= 45 || winElapsed >= 500)) {
            lastTelemetryTs = now;
            const tel = director.getTelemetry();
            canvasRef.current.dataset.frames = String(frameCount);
            canvasRef.current.dataset.motionElapsedMs = String(Math.round(model.elapsedTime));
            canvasRef.current.dataset.directorState = tel.state;
            canvasRef.current.dataset.armLift = String(tel.armLift);
            canvasRef.current.dataset.armPose = String(tel.armPose);
            canvasRef.current.dataset.handForm = String(tel.handForm);
            canvasRef.current.dataset.armPhase = tel.armPhase;
            canvasRef.current.dataset.directorExpression = tel.expression;
            canvasRef.current.dataset.shoulderDeg = String(tel.shoulderDeg);
            canvasRef.current.dataset.elbowFlexDeg = String(tel.elbowFlexDeg);
            canvasRef.current.dataset.wristDeg = String(tel.wristDeg);
            canvasRef.current.dataset.handName = tel.handName;
            canvasRef.current.dataset.forearmInFront = String(tel.forearmInFront);
            canvasRef.current.dataset.activeInteraction = tel.activeInteraction ?? '';
            canvasRef.current.dataset.lastInteraction = tel.lastInteraction ?? '';
            canvasRef.current.dataset.interactionCount = String(tel.interactionCount);
            if (armRig) {
              canvasRef.current.dataset.minTriRatio = String(armRig.lastTelemetry.minTriRatio);
            }
            if (frameCount === 5 || winElapsed >= 500) {
              const measured = winElapsed > 0 ? Math.round((fpsWinFrames * 1000) / winElapsed) : targetFpsCapRef.current;
              canvasRef.current.dataset.fps = String(measured);
              if (winElapsed >= 500) {
                fpsWinStart = now;
                fpsWinFrames = 0;
              }
            }
          }
        });
        if (document.hidden || winMinimized || reduceMotionRef.current) {
          app.ticker.stop();
          lastDtSecRef.current = 0.016;
          model.update(16);
          app.render();
          if (canvasRef.current) canvasRef.current.dataset.tickerPaused = 'true';
        } else {
          app.ticker.start();
        }
        onReady?.();
      } catch (err) {
        if (!disposed) {
          onFallback?.('load_error', err instanceof Error ? err.message : String(err));
        }
      }
    }

    void boot();
    return () => {
      disposed = true;
      unsubWinState?.();
      document.removeEventListener('visibilitychange', syncTickerPaused);
      if (canvasEl) canvasEl.removeEventListener('webglcontextlost', handleContextLost, false);
      resizeObs?.disconnect();
      if (internalEventTarget?.off) {
        if (onAfterMotionRef) internalEventTarget.off('afterMotionUpdate', onAfterMotionRef);
        if (onBeforeCommitRef) internalEventTarget.off('beforeModelUpdate', onBeforeCommitRef);
      }
      directorRef.current.setExpressionHandler(() => {});
      armRig?.dispose();
      armRig = null;
      destroyLive2dResources({
        model: modelRef.current,
        app,
        pixi: pixiMod,
        textureUrls: bundleTextures,
      });
      modelRef.current = null;
      appRef.current = null;
    };
  }, [variant, onReady, onFallback]);

  // Apply 8-state PerformanceDirector state & expressions cleanly + honor reduceMotion & live2dFpsMode
  useEffect(() => {
    const model = modelRef.current;
    const app = appRef.current;
    if (!model) return;
    const mapping = PINK_SAKURA_STATE_MAP[state];
    const director = directorRef.current;
    director.setState(state);

    const fpsRes = resolveLive2dFpsTarget({
      mode: p.live2dFpsMode,
      displayRefreshHz: displayHzRef.current,
      backpressureStep: p.live2dFpsMode === 'auto' ? backpressureRef.current : 0,
    });

    const tel = director.getTelemetry();
    if (canvasRef.current) {
      canvasRef.current.dataset.motionGroup = mapping.motionGroup;
      canvasRef.current.dataset.expression = mapping.expression;
      canvasRef.current.dataset.directorState = tel.state;
      canvasRef.current.dataset.armLift = String(tel.armLift);
      canvasRef.current.dataset.armPose = String(tel.armPose);
      canvasRef.current.dataset.handForm = String(tel.handForm);
      canvasRef.current.dataset.armPhase = tel.armPhase;
      canvasRef.current.dataset.directorExpression = tel.expression;
      canvasRef.current.dataset.motionInitialized = 'true';
      canvasRef.current.dataset.fpsMode = p.live2dFpsMode;
      canvasRef.current.dataset.maxFps = String(fpsRes.capFps);
      canvasRef.current.dataset.tickerPaused = p.reduceMotion ? 'true' : 'false';
    }

    targetFpsCapRef.current = fpsRes.capFps;
    if (app) {
      if (p.reduceMotion) {
        app.ticker.stop();
        lastDtSecRef.current = 0.016;
        model.update(16);
        app.render();
      } else if (!app.ticker.started && !document.hidden) {
        app.ticker.start();
      }
    }
  }, [state, p.reduceMotion, p.live2dFpsMode]);

  useEffect(() => {
    if (interactNonce !== lastInteractNonceRef.current) {
      lastInteractNonceRef.current = interactNonce;
      const spec = directorRef.current.triggerInteract();
      if (spec) {
        onInteractionRef.current?.(spec);
        if (canvasRef.current) {
          const tel = directorRef.current.getTelemetry();
          canvasRef.current.dataset.activeInteraction = tel.activeInteraction ?? '';
          canvasRef.current.dataset.lastInteraction = tel.lastInteraction ?? '';
          canvasRef.current.dataset.interactionCount = String(tel.interactionCount);
          canvasRef.current.dataset.directorExpression = tel.expression;
        }
      }
      if (reduceMotionRef.current && modelRef.current && appRef.current) {
        lastDtSecRef.current = 0.016;
        modelRef.current.update(16);
        appRef.current.render();
      }
    }
  }, [interactNonce]);

  return <canvas ref={canvasRef} className="mascot-live2d-canvas" aria-label="小番 Live2D 角色画布" />;
}
