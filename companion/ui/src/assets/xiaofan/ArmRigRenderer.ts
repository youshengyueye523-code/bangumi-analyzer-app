import type { ArmRigMeta } from '../../driver/model';

export type ArmHandForm = 'rest' | 'chin' | 'heart' | 'wave';

export interface ArmJointTarget {
  /** Shoulder abduction outward from straight down (+Y), in degrees. Rest = 19.3° */
  abductDeg: number;
  /** Shoulder forward flexion toward viewer (+Z), in degrees. Rest = 0° */
  shoulderFlexDeg: number;
  /** Anatomical elbow flexion hinge (0° = straight hanging, 90° = pointing forward, 145° = raised up) */
  elbowFlexDeg: number;
  /** Forearm swing plane yaw (+ = outward viewer-left for wave, - = inward viewer-right for chin) */
  planeYawDeg: number;
  /** Wrist bend/wave rotation around wrist pivot, in degrees */
  wristDeg: number;
  /** Desired hand sprite */
  hand: ArmHandForm;
  /** Optional subtle wrist wave oscillation */
  waveAmpDeg?: number;
  waveHz?: number;
  /** Optional subtle forearm elbow sway synchronized with wave */
  forearmWaveDeg?: number;
}

export const ARM_POSE_REST: ArmJointTarget = {
  abductDeg: 19.3,
  shoulderFlexDeg: 0,
  elbowFlexDeg: 0,
  planeYawDeg: 14,
  wristDeg: 0,
  hand: 'rest',
};

export interface ArmRigTelemetry {
  shoulderDeg: number;
  elbowFlexDeg: number;
  wristDeg: number;
  handForm: ArmHandForm;
  forearmInFront: boolean;
  liftProgress: number;
  minTriRatio: number;
}

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);

/**
 * Smooth, anatomical 3D joint-angle controller for Xiaofan's right arm.
 * Interpolates joint angles via smooth exponential damping (zero lag from rest, clean mid-motion reversal)
 * and tucks the hand briefly inside the ribbed cuff whenever switching hand sprites (never two hands visible).
 */
export class ArmKinematicsController {
  public abductDeg = ARM_POSE_REST.abductDeg;
  public shoulderFlexDeg = ARM_POSE_REST.shoulderFlexDeg;
  public elbowFlexDeg = ARM_POSE_REST.elbowFlexDeg;
  public planeYawDeg = ARM_POSE_REST.planeYawDeg;
  public wristDeg = 0;

  public activeHand: ArmHandForm = 'rest';
  public handTuck = 0; // 0 = normal position, 1 = tucked inside cuff during hand swap
  public handOpacity = 1;

  private target: ArmJointTarget = { ...ARM_POSE_REST };
  private swapPhase: 'none' | 'tucking' | 'emerging' = 'none';
  private swapTimer = 0;
  private pendingHand: ArmHandForm | null = null;
  private waveClock = 0;

  setTarget(next: ArmJointTarget) {
    this.target = { ...next };
    if (next.hand !== this.activeHand && next.hand !== this.pendingHand) {
      this.pendingHand = next.hand;
      if (this.swapPhase === 'none') {
        this.swapPhase = 'tucking';
        this.swapTimer = 0;
      }
    }
  }

  step(dtSec: number) {
    const dt = clamp(dtSec, 0, 0.08);
    this.waveClock += dt;

    // Smooth critically-damped feel: responsive start, gentle deceleration
    const rate = this.target.elbowFlexDeg > this.elbowFlexDeg ? 6.8 : 6.2;
    const a = 1 - Math.exp(-rate * dt);

    const waveAmp = this.target.waveAmpDeg ?? 0;
    const waveHz = this.target.waveHz ?? 1.35;
    const forearmAmp = this.target.forearmWaveDeg ?? 0;
    const waveWeight = clamp((this.elbowFlexDeg - 85) / 50, 0, 1);

    const forearmOsc = forearmAmp * waveWeight * Math.sin(this.waveClock * Math.PI * 2 * waveHz);
    // Natural Disney follow-through: wrist lags forearm wave by ~0.55 rad
    const wristOsc = waveAmp * waveWeight * Math.sin(this.waveClock * Math.PI * 2 * waveHz - 0.55);

    this.abductDeg = lerp(this.abductDeg, this.target.abductDeg, a);
    this.shoulderFlexDeg = lerp(this.shoulderFlexDeg, this.target.shoulderFlexDeg, a);
    this.elbowFlexDeg = lerp(this.elbowFlexDeg, this.target.elbowFlexDeg, a);
    this.planeYawDeg = lerp(this.planeYawDeg, this.target.planeYawDeg + forearmOsc, a);
    this.wristDeg = lerp(this.wristDeg, this.target.wristDeg + wristOsc, clamp(1 - Math.exp(-10 * dt), 0, 1));

    // Clean single-hand tuck/swap inside ribbed cuff (0.09s tuck -> swap at opacity=0 -> 0.11s emerge)
    if (this.swapPhase === 'tucking') {
      this.swapTimer += dt;
      const p = clamp(this.swapTimer / 0.09, 0, 1);
      this.handTuck = p;
      this.handOpacity = 1 - p;
      if (p >= 1) {
        if (this.pendingHand) {
          this.activeHand = this.pendingHand;
          this.pendingHand = null;
        }
        this.swapPhase = 'emerging';
        this.swapTimer = 0;
      }
    } else if (this.swapPhase === 'emerging') {
      this.swapTimer += dt;
      const p = clamp(this.swapTimer / 0.11, 0, 1);
      this.handTuck = 1 - p;
      this.handOpacity = p;
      if (p >= 1) {
        this.handTuck = 0;
        this.handOpacity = 1;
        this.swapPhase = 'none';
        if (this.target.hand !== this.activeHand) {
          this.pendingHand = this.target.hand;
          this.swapPhase = 'tucking';
          this.swapTimer = 0;
        }
      }
    } else {
      this.handTuck = 0;
      this.handOpacity = 1;
    }
  }

  /**
   * Solve 3D-projected 2-bone arm positions (in 1024x1536 pixel space) from shoulder S.
   * Upper arm L1 = 212px, Forearm L2 = 222px.
   */
  solveBones(shoulderPxX: number, shoulderPxY: number) {
    const L1 = 212;
    const L2 = 222;

    const abd = this.abductDeg * DEG;
    const sfl = this.shoulderFlexDeg * DEG;
    const efl = clamp(this.elbowFlexDeg, 0, 158) * DEG;
    const yaw = this.planeYawDeg * DEG;

    // 1. Upper arm 3D unit vector (+X = viewer-right, -X = viewer-left/outward, +Y = down, +Z = toward viewer)
    const u1x = -Math.sin(abd) * Math.cos(sfl);
    const u1y = Math.cos(abd) * Math.cos(sfl);
    const u1z = Math.sin(sfl);

    // Subtle anatomical clavicle elevation when arm abducts or lifts forward
    const shoulderLiftY = -clamp((this.abductDeg - 19.3) * 0.25 + this.shoulderFlexDeg * 0.16, -2, 8);
    const sx = shoulderPxX;
    const sy = shoulderPxY + shoulderLiftY;

    const ex = sx + u1x * L1;
    const ey = sy + u1y * L1;

    // 2. Forearm 3D unit vector rotated around true anatomical elbow hinge forward into +Z & steered by planeYaw
    // Forward bend guide vector (tilted slightly upward & steered left/right by yaw)
    const fx0 = -Math.sin(yaw);
    const fy0 = -0.14;
    const fz0 = Math.cos(yaw);
    const fLen0 = Math.hypot(fx0, fy0, fz0) || 1;
    const fx = fx0 / fLen0;
    const fy = fy0 / fLen0;
    const fz = fz0 / fLen0;

    // Orthogonalize forward guide against u1 so elbow flexion is a pure rigid 3D rotation
    const dot = fx * u1x + fy * u1y + fz * u1z;
    let px = fx - dot * u1x;
    let py = fy - dot * u1y;
    let pz = fz - dot * u1z;
    const pLen = Math.hypot(px, py, pz) || 1;
    px /= pLen;
    py /= pLen;
    pz /= pLen;

    const u2x = u1x * Math.cos(efl) + px * Math.sin(efl);
    const u2y = u1y * Math.cos(efl) + py * Math.sin(efl);
    const u2z = u1z * Math.cos(efl) + pz * Math.sin(efl);

    // Keep 2D projected forearm smoothly readable (~0.56..1.0 * L2) even at mid-lift pointing toward viewer
    const raw2dLen = Math.hypot(u2x, u2y);
    const smooth2dScale = Math.max(0.56, raw2dLen);
    const t2x = raw2dLen > 1e-4 ? u2x / raw2dLen : -Math.sin(yaw);
    const t2y = raw2dLen > 1e-4 ? u2y / raw2dLen : -1;

    const wx = ex + t2x * L2 * smooth2dScale;
    const wy = ey + t2y * L2 * smooth2dScale;

    const u1Len2d = Math.hypot(u1x, u1y) || 1;
    const t1x = u1x / u1Len2d;
    const t1y = u1y / u1Len2d;

    return {
      sx,
      sy,
      ex,
      ey,
      wx,
      wy,
      t1x,
      t1y,
      l1Proj: L1 * u1Len2d,
      t2x,
      t2y,
      l2Proj: L2 * smooth2dScale,
      u2z,
      forearmInFront: this.elbowFlexDeg >= 24,
      liftProgress: clamp(this.elbowFlexDeg / 145, 0, 1),
    };
  }
}

interface CubismRendererInternal {
  gl: WebGLRenderingContext;
  _textures: Record<number, WebGLTexture>;
  _sortedDrawableIndexList: Int32Array;
  _clippingManager?: {
    setupClippingContext: (model: unknown, renderer: unknown) => void;
    getClippingContextListForDraw: () => unknown[];
  } | null;
  preDraw: () => void;
  getModel: () => {
    _model: {
      canvasinfo?: {
        CanvasWidth: number;
        CanvasHeight: number;
        CanvasOriginX: number;
        CanvasOriginY: number;
        PixelsPerUnit: number;
      };
      drawables: {
        count: number;
        ids: string[];
        vertexPositions: Float32Array[];
      };
    };
    getDrawableCount: () => number;
    getDrawableRenderOrders: () => Int32Array;
    getDrawableDynamicFlagIsVisible: (idx: number) => boolean;
    getDrawableCulling: (idx: number) => boolean;
    getDrawableTextureIndices: (idx: number) => number;
    getDrawableVertexIndexCount: (idx: number) => number;
    getDrawableVertexCount: (idx: number) => number;
    getDrawableVertexIndices: (idx: number) => Uint16Array;
    getDrawableVertices: (idx: number) => Float32Array;
    getDrawableVertexUvs: (idx: number) => Float32Array;
    getDrawableOpacity: (idx: number) => number;
    getDrawableBlendMode: (idx: number) => number;
    getDrawableInvertedMaskBit: (idx: number) => boolean;
  };
  setClippingContextBufferForDraw: (buf: unknown) => void;
  setIsCulling: (cull: boolean) => void;
  drawMesh: (
    textureNo: number,
    indexCount: number,
    vertexCount: number,
    indexArray: Uint16Array,
    vertexArray: Float32Array,
    uvArray: Float32Array,
    opacity: number,
    colorBlendMode: number,
    invertedMask: boolean,
  ) => void;
  doDrawModel: () => void;
}

const REPLACED_ARM_IDS = new Set([
  'ArtMeshLayerR',  // gesture-cuff-r
  'ArtMeshLayerR2', // gesture-sleeve-r
  'ArtMeshLayerR3', // gesture-hand-wave-r
  'ArtMeshLayerR4', // gesture-hand-heart-r
  'ArtMeshLayerR5', // gesture-hand-chin-r
  'ArtMeshLayerR6', // gesture-hand-rest-r
]);

const REST_SHOULDER_PX = { x: 392, y: 382 };
const ARM_TEX_SLOT = 7; // Unused Cubism texture slot (Pink Sakura uses only slot 0)

function buildGridIndices(rows: number, cols: number): Uint16Array {
  const out = new Uint16Array(rows * cols * 6);
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = a + (cols + 1);
      const e = d + 1;
      out[k++] = a;
      out[k++] = b;
      out[k++] = d;
      out[k++] = b;
      out[k++] = e;
      out[k++] = d;
    }
  }
  return out;
}

const QUAD_INDICES = new Uint16Array([0, 1, 2, 1, 3, 2]);

/**
 * Attaches a 2-bone skinned anatomical arm + split-cuff WebGL renderer directly inside
 * Pink Sakura's CubismRenderer_WebGL pass, guaranteeing:
 *   - Sub-pixel alignment with live cardigan shoulder (ArtMeshTopwear)
 *   - Exact anatomical Z-order: BackHair -> Topwear -> UpperArm -> FrontHair & Face -> Raised (Forearm+CuffBack -> Hand -> CuffFront)
 *   - Zero cuff-over-hand clipping (hollow cuff back behind wrist, ribbed front lip over wrist root)
 *   - Volume-preserving elbow bend with zero triangle inversion
 */
export class ArmRigRenderer {
  private gl: WebGLRenderingContext;
  private renderer: CubismRendererInternal;
  private meta: ArmRigMeta;
  private controller: ArmKinematicsController;
  private glTexture: WebGLTexture | null = null;
  private originalDoDrawModel: () => void;
  private disposed = false;

  // Live shoulder tracking on ArtMeshTopwear
  private topwearIdx = -1;
  private shoulderAnchors: { vertIdx: number; baseX: number; baseY: number }[] = [];

  // Reusable typed mesh buffers (zero per-frame GC churn!)
  private upperRows = 12;
  private upperCols = 4;
  private upperIndices: Uint16Array;
  private upperVerts: Float32Array;
  private upperUvs: Float32Array;

  private foreRows = 14;
  private foreCols = 4;
  private foreIndices: Uint16Array;
  private foreVerts: Float32Array;
  private foreUvs: Float32Array;

  private cuffRows = 6;
  private cuffCols = 4;
  private cuffIndices: Uint16Array;
  private cuffVerts: Float32Array;
  private cuffUvs: Float32Array;

  private handVerts = new Float32Array(8);
  private handUvs = new Float32Array(8);

  public lastTelemetry: ArmRigTelemetry = {
    shoulderDeg: ARM_POSE_REST.abductDeg,
    elbowFlexDeg: 0,
    wristDeg: 0,
    handForm: 'rest',
    forearmInFront: false,
    liftProgress: 0,
    minTriRatio: 1,
  };

  private constructor(
    renderer: CubismRendererInternal,
    gl: WebGLRenderingContext,
    meta: ArmRigMeta,
    controller: ArmKinematicsController,
    image: HTMLImageElement,
  ) {
    this.renderer = renderer;
    this.gl = gl;
    this.meta = meta;
    this.controller = controller;
    this.originalDoDrawModel = renderer.doDrawModel.bind(renderer);

    this.upperIndices = buildGridIndices(this.upperRows, this.upperCols);
    this.upperVerts = new Float32Array((this.upperRows + 1) * (this.upperCols + 1) * 2);
    this.upperUvs = new Float32Array((this.upperRows + 1) * (this.upperCols + 1) * 2);

    this.foreIndices = buildGridIndices(this.foreRows, this.foreCols);
    this.foreVerts = new Float32Array((this.foreRows + 1) * (this.foreCols + 1) * 2);
    this.foreUvs = new Float32Array((this.foreRows + 1) * (this.foreCols + 1) * 2);

    this.cuffIndices = buildGridIndices(this.cuffRows, this.cuffCols);
    this.cuffVerts = new Float32Array((this.cuffRows + 1) * (this.cuffCols + 1) * 2);
    this.cuffUvs = new Float32Array((this.cuffRows + 1) * (this.cuffCols + 1) * 2);

    this.initStaticUvs();
    this.uploadTexture(image);
    this.captureShoulderAnchors();

    // Hook into CubismRenderer_WebGL.doDrawModel cleanly
    const self = this;
    renderer.doDrawModel = function hookedDoDrawModel() {
      self.renderModelWithArm();
    };
  }

  static async attach(
    renderer: unknown,
    gl: WebGLRenderingContext,
    atlasDataUrl: string,
    meta: ArmRigMeta,
    controller: ArmKinematicsController,
  ): Promise<ArmRigRenderer> {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode arm-rig-atlas.png'));
      el.src = atlasDataUrl;
    });
    return new ArmRigRenderer(renderer as CubismRendererInternal, gl, meta, controller, img);
  }

  private initStaticUvs() {
    const aw = this.meta.atlasWidth;
    const ah = this.meta.atlasHeight;
    const sl = this.meta.sleeve;
    const cf = this.meta.cuffFront;

    // Upper arm sleeve UVs: v in [0.00, 0.53]
    this.fillGridUvs(this.upperUvs, this.upperRows, this.upperCols, sl.x, sl.y, sl.w, sl.h, 0.0, 0.53, aw, ah);
    // Forearm sleeve UVs: v in [0.46, 1.00] (overlaps smoothly over elbow joint!)
    this.fillGridUvs(this.foreUvs, this.foreRows, this.foreCols, sl.x, sl.y, sl.w, sl.h, 0.46, 1.0, aw, ah);
    // Cuff Front Lip ONLY UVs: maps identically to forearm distal band v in [cf.vMin, cf.vMax]
    this.fillGridUvs(this.cuffUvs, this.cuffRows, this.cuffCols, cf.x, cf.y, cf.w, cf.h, 0.0, 1.0, aw, ah);
  }

  private fillGridUvs(
    out: Float32Array,
    rows: number,
    cols: number,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    v0: number,
    v1: number,
    aw: number,
    ah: number,
  ) {
    let p = 0;
    for (let r = 0; r <= rows; r++) {
      const tv = v0 + (r / rows) * (v1 - v0);
      const py = ry + tv * rh;
      // Cubism vertex shader flips v_texCoord.y = 1.0 - a_texCoord.y
      const uvY = 1.0 - py / ah;
      for (let c = 0; c <= cols; c++) {
        const tu = c / cols;
        const px = rx + tu * rw;
        out[p++] = px / aw;
        out[p++] = uvY;
      }
    }
  }

  private uploadTexture(image: HTMLImageElement) {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('WebGL createTexture failed for arm rig');

    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const prevFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    const prevPremul = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevPremul);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);

    this.glTexture = tex;
    this.renderer._textures[ARM_TEX_SLOT] = tex;
  }

  private getCanvasMapping() {
    const raw = this.renderer.getModel()._model;
    const ci = raw.canvasinfo;
    return {
      ppu: ci?.PixelsPerUnit || 1024,
      ox: ci?.CanvasOriginX || 512,
      oy: ci?.CanvasOriginY || 768,
    };
  }

  private captureShoulderAnchors() {
    const raw = this.renderer.getModel()._model;
    const idx = raw.drawables.ids.indexOf('ArtMeshTopwear');
    if (idx < 0) return;
    this.topwearIdx = idx;
    const verts = raw.drawables.vertexPositions[idx];
    const { ppu, ox, oy } = this.getCanvasMapping();
    const targetMx = (REST_SHOULDER_PX.x - ox) / ppu;
    const targetMy = (oy - REST_SHOULDER_PX.y) / ppu;

    const scored: { vertIdx: number; baseX: number; baseY: number; d2: number }[] = [];
    for (let i = 0; i < verts.length; i += 2) {
      const vx = verts[i];
      const vy = verts[i + 1];
      const d2 = (vx - targetMx) ** 2 + (vy - targetMy) ** 2;
      scored.push({ vertIdx: i, baseX: vx, baseY: vy, d2 });
    }
    scored.sort((a, b) => a.d2 - b.d2);
    this.shoulderAnchors = scored.slice(0, 6).map(({ vertIdx, baseX, baseY }) => ({ vertIdx, baseX, baseY }));
  }

  private measureLiveShoulderPx(): { x: number; y: number } {
    if (this.topwearIdx < 0 || this.shoulderAnchors.length === 0) {
      return { x: REST_SHOULDER_PX.x, y: REST_SHOULDER_PX.y };
    }
    const raw = this.renderer.getModel()._model;
    const verts = raw.drawables.vertexPositions[this.topwearIdx];
    const { ppu } = this.getCanvasMapping();
    let dx = 0;
    let dy = 0;
    for (const a of this.shoulderAnchors) {
      dx += verts[a.vertIdx] - a.baseX;
      dy += verts[a.vertIdx + 1] - a.baseY;
    }
    dx /= this.shoulderAnchors.length;
    dy /= this.shoulderAnchors.length;
    return {
      x: REST_SHOULDER_PX.x + dx * ppu,
      y: REST_SHOULDER_PX.y - dy * ppu, // Cubism +Y up -> pixel -Y
    };
  }

  private updateArmMeshes() {
    const liveS = this.measureLiveShoulderPx();
    const bones = this.controller.solveBones(liveS.x, liveS.y);
    const { ppu, ox, oy } = this.getCanvasMapping();
    const sl = this.meta.sleeve;
    const cf = this.meta.cuffFront;
    const hw = sl.worldHalfWidthPx;

    const toMx = (px: number) => (px - ox) / ppu;
    const toMy = (py: number) => (oy - py) / ppu;

    // ─── 1. Upper Arm Mesh (v in [0.00, 0.54]) skinned strictly on Bone 1 (S -> E) ───
    const r1x = bones.t1y;
    const r1y = -bones.t1x;
    const upperSpanV = sl.vElbow - sl.vShoulder;
    const raiseWidthScale = lerp(1.0, 0.92, bones.liftProgress);
    let p = 0;
    for (let r = 0; r <= this.upperRows; r++) {
      const v = (r / this.upperRows) * 0.54;
      const baseAlong = ((v - sl.vShoulder) / upperSpanV) * bones.l1Proj;
      const elbowCapT = v > sl.vElbow ? clamp((v - sl.vElbow) / (0.54 - sl.vElbow), 0, 1) : 0;
      const elbowCapTaper = 1 - elbowCapT * elbowCapT * 0.22;
      for (let c = 0; c <= this.upperCols; c++) {
        const u = (c / this.upperCols) * 2 - 1; // -1 (left) .. +1 (right)
        // Round the distal elbow silhouette smoothly so upper arm forms a natural curved sleeve shoulder-to-elbow tube
        const domeOff = elbowCapT > 0 ? -(u * u) * 10 * elbowCapT : 0;
        const along = baseAlong + domeOff;
        const cx = bones.sx + bones.t1x * along;
        const cy = bones.sy + bones.t1y * along;
        const px = cx + r1x * u * hw * raiseWidthScale * elbowCapTaper;
        const py = cy + r1y * u * hw * raiseWidthScale * elbowCapTaper;
        this.upperVerts[p++] = toMx(px);
        this.upperVerts[p++] = toMy(py);
      }
    }

    // ─── 2. Forearm Mesh (v in [0.46, 1.00]) skinned strictly on Bone 2 (E -> W) ───
    // In pixel coords: when t2 points down (0, +1), right (+u) is (+t2y, -t2x) = (+1, 0).
    // When forearm lifts UP (t2 = (0, -1)), flipping sign smoothly or keeping (+t2y, -t2x) = (-1, 0) naturally keeps the outer bow on the outer forearm!
    // Check: at rest (t2 = (-0.33, +0.94)), +u = (+0.94, +0.33) -> right/inner side, -u -> left/outer side (where the bow is in atlas!).
    // When arm flexes forward & upward (t2 = (-0.15, -0.99)):
    //   If we rotate rigidly in 2D by +160° around elbow, the outer side (-u) moves to the viewer-right/inner side UNLESS we keep anatomical outer side facing outward!
    //   WAIT: when you flex your right elbow forward toward your face (palm facing viewer), the outer side of your forearm (thumb-side vs pinky-side):
    //   At rest (palm inward, back of sleeve outward): bow is on the viewer-LEFT (outer lateral side of forearm).
    //   When you lift your forearm UP with elbow bent: the lateral/outer side of your forearm STILL faces viewer-LEFT (outer side)!!
    //   Verify: at t2 = (-0.15, -0.99), viewer-RIGHT is (+0.99, -0.15) = (-t2y, +t2x), whereas viewer-LEFT is (+t2y, -t2x)!
    //   Let's check BOTH:
    //   - Rest (t2 = (-0.33, +0.94)): (+t2y, -t2x) = (+0.94, +0.33) [viewer-RIGHT] -> bow (-u) is on viewer-LEFT!
    //   - Wave (t2 = (-0.15, -0.99)): (-t2y, +t2x) = (+0.99, -0.15) [viewer-RIGHT] -> bow (-u) stays on viewer-LEFT (outer)!
    //   Wait: check continuity when forearm sweeps through horizontal!
    //   In 3D, flexing the elbow purely forward (+Z) NEVER rotates the forearm around its own axis — the lateral (-X, outer) side stays -X (viewer-left) the ENTIRE time!
    //   Let's compute the EXACT 3D lateral right-vector R2 = normalize(cross(u2, forward)) projected cleanly so u=-1 (bow/outer) ALWAYS stays on the anatomically true outer side without flipping!
    //   Even cleaner: in 2D, r2 = normalize( (+1, 0) - dot((+1,0), t2) * t2 ) -> wait: at rest (t2=(-0.33,0.94)), proj(+1,0) = (+0.89, +0.31) -> norm = (+0.94, +0.33) [EXACT MATCH!];
    //   at wave (t2=(-0.15,-0.99)), proj(+1,0) = (+0.98, -0.15) -> norm = (+0.99, -0.15) [bow STAYS on outer left!];
    //   at chin (t2=(+0.44,-0.89)), proj(+1,0) = (+0.81, +0.39) -> norm = (+0.89, +0.44) [bow STAYS on outer bottom-left of forearm, 100% continuous with zero sign flip!!]
    const dotRight = bones.t2x; // dot((1, 0), t2)
    let r2x = 1 - dotRight * bones.t2x;
    let r2y = -dotRight * bones.t2y;
    const r2Len = Math.hypot(r2x, r2y);
    if (r2Len > 1e-3) {
      r2x /= r2Len;
      r2y /= r2Len;
    } else {
      r2x = 0;
      r2y = 1;
    }

    const foreSpanV = sl.vWrist - sl.vElbow;
    const bendFactor = clamp(this.controller.elbowFlexDeg / 110, 0, 1);
    const writeForearmPoint = (v: number, u: number) => {
      const baseAlong = ((v - sl.vElbow) / foreSpanV) * bones.l2Proj;
      // Smooth rounded elbow dome at proximal end (v in [0.46..0.54]) when elbow bends so there is ZERO straight flat cut edge!
      const proxT = v < 0.54 ? clamp((0.54 - v) / 0.08, 0, 1) : 0;
      const domeBack = proxT > 0 ? -(1 - u * u) * 14 * proxT * bendFactor + (u * u) * 8 * proxT * bendFactor : 0;
      const proxTaper = 1 - proxT * proxT * (0.06 + 0.18 * bendFactor);
      const along = baseAlong + domeBack;
      const cx = bones.ex + bones.t2x * along;
      const cy = bones.ey + bones.t2y * along;
      return {
        mx: toMx(cx + r2x * u * hw * raiseWidthScale * proxTaper),
        my: toMy(cy + r2y * u * hw * raiseWidthScale * proxTaper),
      };
    };

    p = 0;
    for (let r = 0; r <= this.foreRows; r++) {
      const v = 0.46 + (r / this.foreRows) * (1.0 - 0.46);
      for (let c = 0; c <= this.foreCols; c++) {
        const u = (c / this.foreCols) * 2 - 1;
        const pt = writeForearmPoint(v, u);
        this.foreVerts[p++] = pt.mx;
        this.foreVerts[p++] = pt.my;
      }
    }

    // ─── 3. Cuff Front Ribbed Lip Mesh (exact same distal forearm surface v in [cf.vMin, cf.vMax]!) ───
    p = 0;
    for (let r = 0; r <= this.cuffRows; r++) {
      const v = cf.vMin + (r / this.cuffRows) * (cf.vMax - cf.vMin);
      for (let c = 0; c <= this.cuffCols; c++) {
        const u = (c / this.cuffCols) * 2 - 1;
        const pt = writeForearmPoint(v, u);
        this.cuffVerts[p++] = pt.mx;
        this.cuffVerts[p++] = pt.my;
      }
    }

    // ─── 4. Hand Quad (anchored INSIDE cuff opening between Forearm/CuffBack and CuffFront!) ───
    const handKey = this.controller.activeHand;
    const hm = this.meta.hands[handKey];
    const wristRad = this.controller.wristDeg * DEG;
    const cosW = Math.cos(wristRad);
    const sinW = Math.sin(wristRad);

    // Local hand axes: distal (+fingerDir = rotated t2), right (+handRight = rotated r2 for raised hands, or exact rotated rest basis!)
    const fDirX = bones.t2x * cosW - bones.t2y * sinW;
    const fDirY = bones.t2x * sinW + bones.t2y * cosW;
    // For rest hand, tile local +X corresponds to (-t2y, +t2x) (pointing left in pixel coords when t2 points down-left);
    // for upright raised hands (chin/heart/wave), tile local +X corresponds to viewer-right (+r2 rotated by wrist)!
    const baseRx = handKey === 'rest' ? -bones.t2y : r2x;
    const baseRy = handKey === 'rest' ? bones.t2x : r2y;
    const hRightX = baseRx * cosW - baseRy * sinW;
    const hRightY = baseRx * sinW + baseRy * cosW;

    // Position wrist pivot snugly inside the cuff front lip (and pull back 22px during hand-swap tuck!)
    const wristEmbedPx = (handKey === 'rest' ? -7 : handKey === 'chin' ? -12 : -14) - this.controller.handTuck * 22;
    const hpx = bones.wx + bones.t2x * wristEmbedPx;
    const hpy = bones.wy + bones.t2y * wristEmbedPx;

    const scaleFix = handKey === 'rest' ? 0.95 : 1.0;
    const wW = hm.worldWidthPx * scaleFix;
    const wH = hm.worldHeightPx * scaleFix;
    const pivU = hm.pivotLocal[0]; // ~0.5
    const pivV = hm.pivotLocal[1]; // ~0.895 (near bottom of tile; top of tile is fingertips!)

    const leftOff = -pivU * wW;
    const rightOff = (1 - pivU) * wW;
    const tipOff = pivV * wH;       // distance along +fDir (toward fingertips)
    const rootOff = -(1 - pivV) * wH; // distance along -fDir (tucked inside cuff)

    // 4 quad corners: 0=top-left (fingertips-left), 1=top-right, 2=bottom-left (wrist-left), 3=bottom-right
    const corners: [number, number][] = [
      [leftOff, tipOff],
      [rightOff, tipOff],
      [leftOff, rootOff],
      [rightOff, rootOff],
    ];
    for (let i = 0; i < 4; i++) {
      const [oxLocal, oyLocal] = corners[i];
      const cx = hpx + hRightX * oxLocal + fDirX * oyLocal;
      const cy = hpy + hRightY * oxLocal + fDirY * oyLocal;
      this.handVerts[i * 2] = toMx(cx);
      this.handVerts[i * 2 + 1] = toMy(cy);
    }

    const aw = this.meta.atlasWidth;
    const ah = this.meta.atlasHeight;
    const u0 = hm.x / aw;
    const u1 = (hm.x + hm.w) / aw;
    const vTop = 1.0 - hm.y / ah;
    const vBot = 1.0 - (hm.y + hm.h) / ah;
    this.handUvs[0] = u0; this.handUvs[1] = vTop;
    this.handUvs[2] = u1; this.handUvs[3] = vTop;
    this.handUvs[4] = u0; this.handUvs[5] = vBot;
    this.handUvs[6] = u1; this.handUvs[7] = vBot;

    // Update live telemetry
    this.lastTelemetry = {
      shoulderDeg: Number(this.controller.abductDeg.toFixed(1)),
      elbowFlexDeg: Number(this.controller.elbowFlexDeg.toFixed(1)),
      wristDeg: Number(this.controller.wristDeg.toFixed(1)),
      handForm: handKey,
      forearmInFront: bones.forearmInFront,
      liftProgress: Number(bones.liftProgress.toFixed(2)),
      minTriRatio: Number(Math.min(1, bones.l2Proj / 222).toFixed(2)),
    };
  }

  private drawMeshSafe(indices: Uint16Array, verts: Float32Array, uvs: Float32Array, opacity: number) {
    if (!this.glTexture || opacity <= 0.005) return;
    this.renderer._textures[ARM_TEX_SLOT] = this.glTexture;
    this.renderer.setClippingContextBufferForDraw(null);
    this.renderer.setIsCulling(false);
    this.renderer.drawMesh(
      ARM_TEX_SLOT,
      indices.length,
      verts.length / 2,
      indices,
      verts,
      uvs,
      opacity,
      0, // Normal blend mode
      false,
    );
  }

  private drawForearmAssembly() {
    // Layer 1: Forearm sleeve + shadowed hollow cuff interior back wall
    this.drawMeshSafe(this.foreIndices, this.foreVerts, this.foreUvs, 1.0);
    // Layer 2: Hand emerging OUT OF the hollow cuff interior
    this.drawMeshSafe(QUAD_INDICES, this.handVerts, this.handUvs, this.controller.handOpacity);
    // Layer 3: Ribbed front cuff lip wrapping cleanly OVER the wrist root (hollow opening cut out!)
    this.drawMeshSafe(this.cuffIndices, this.cuffVerts, this.cuffUvs, 1.0);
  }

  private renderModelWithArm() {
    if (this.disposed || !this.glTexture) {
      this.originalDoDrawModel();
      return;
    }

    const r = this.renderer;
    r.preDraw();
    if (r._clippingManager != null) {
      r._clippingManager.setupClippingContext(r.getModel(), r);
    }

    this.updateArmMeshes();

    const model = r.getModel();
    const rawIds = model._model.drawables.ids;
    const drawableCount = model.getDrawableCount();
    const renderOrder = model.getDrawableRenderOrders();
    for (let i = 0; i < drawableCount; ++i) {
      const order = renderOrder[i];
      r._sortedDrawableIndexList[order] = i;
    }

    const forearmInFront = this.lastTelemetry.forearmInFront;
    let upperArmDrawn = false;

    for (let i = 0; i < drawableCount; ++i) {
      const drawableIndex = r._sortedDrawableIndexList[i];
      const id = rawIds[drawableIndex];

      // Skip all 6 defective .moc3 right-arm drawables completely
      if (REPLACED_ARM_IDS.has(id)) continue;

      // Insert Upper Arm (and resting Forearm/Hand/Cuff) right BEFORE FrontHairR so front hair drapes naturally over shoulder!
      if (!upperArmDrawn && (id === 'ArtMeshFrontHairR' || id === 'ArtMeshFrontHairL' || id === 'ArtMeshFace')) {
        upperArmDrawn = true;
        this.drawMeshSafe(this.upperIndices, this.upperVerts, this.upperUvs, 1.0);
        if (!forearmInFront) {
          this.drawForearmAssembly();
        }
      }

      if (!model.getDrawableDynamicFlagIsVisible(drawableIndex)) {
        continue;
      }
      r.setClippingContextBufferForDraw(
        r._clippingManager != null ? r._clippingManager.getClippingContextListForDraw()[drawableIndex] : null,
      );
      r.setIsCulling(model.getDrawableCulling(drawableIndex));
      r.drawMesh(
        model.getDrawableTextureIndices(drawableIndex),
        model.getDrawableVertexIndexCount(drawableIndex),
        model.getDrawableVertexCount(drawableIndex),
        model.getDrawableVertexIndices(drawableIndex),
        model.getDrawableVertices(drawableIndex),
        model.getDrawableVertexUvs(drawableIndex),
        model.getDrawableOpacity(drawableIndex),
        model.getDrawableBlendMode(drawableIndex),
        model.getDrawableInvertedMaskBit(drawableIndex),
      );
    }

    if (!upperArmDrawn) {
      this.drawMeshSafe(this.upperIndices, this.upperVerts, this.upperUvs, 1.0);
    }
    if (forearmInFront) {
      this.drawForearmAssembly();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.renderer.doDrawModel = this.originalDoDrawModel;
      delete this.renderer._textures[ARM_TEX_SLOT];
      if (this.glTexture) {
        this.gl.deleteTexture(this.glTexture);
        this.glTexture = null;
      }
    } catch {
      /* ignore WebGL context lost during teardown */
    }
  }
}
