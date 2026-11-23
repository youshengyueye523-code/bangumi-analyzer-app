/**
 * Deterministic generator for Pink Sakura's 2-bone anatomical arm & split-cuff atlas.
 * Reads ONLY upstream CC BY 4.0 artwork (arm-parts-v1.png + reference.png) and produces:
 *   - companion/models/pink-sakura/arm-rig-atlas.png  (1024x1024 RGBA)
 *   - companion/models/pink-sakura/arm-rig-meta.json  (exact UV rects, pivots, bone metrics)
 *
 * Root fixes baked into atlas:
 *   1. Splits ribbed sleeve cuff into Layer 1 (sleeve + shadowed inner hollow cavity)
 *      and Layer 3 (front ribbed knit rim with hollow opening cleanly cut out).
 *   2. Straightens high-res sleeve (615x1410) onto a clean vertical bone axis (v=0..1)
 *      so 2-bone elbow skinning preserves sleeve volume, bow shape, and cuff proportions.
 *   3. Normalizes all 4 hand sprites (rest / chin / heart / wave) to a unified upright
 *      wrist-centered frame so any hand sits cleanly INSIDE the split cuff at any arm angle.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopEnvironment } from '../host/scripts/isolated.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const MODEL_DIR = join(REPO, 'companion/models/pink-sakura');
const SRC_DIR = process.env.PINK_SAKURA_SOURCE_DIR || '';
const WORK_DIR = join(REPO, 'companion/host/.work/build-arm-atlas');

const require = createRequire(join(REPO, 'package.json'));
const { _electron: electron } = require('@playwright/test');

if (!SRC_DIR) {
  throw new Error(
    'Set PINK_SAKURA_SOURCE_DIR to the upstream Ariakage/live2d-agent-kit examples/pink-sakura/source directory before running build-arm-rig-assets.mjs.',
  );
}

const ARM_PARTS_PNG = join(SRC_DIR, 'arm-parts-v1.png');
const REF_PNG = join(SRC_DIR, 'reference.png');

if (!existsSync(ARM_PARTS_PNG) || !existsSync(REF_PNG)) {
  throw new Error(`Missing upstream CC BY 4.0 source images (${ARM_PARTS_PNG} / ${REF_PNG})`);
}

const OUT_PNG = join(MODEL_DIR, 'arm-rig-atlas.png');
const OUT_META = join(MODEL_DIR, 'arm-rig-meta.json');
const PREVIEW_PNG = process.env.ARM_RIG_PREVIEW_PNG || join(WORK_DIR, 'atlas-preview.png');

async function main() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const mainPath = join(WORK_DIR, 'gen-main.cjs');
  const htmlPath = join(WORK_DIR, 'gen.html');

  writeFileSync(
    mainPath,
    `
    const { app, BrowserWindow } = require('electron');
    app.disableHardwareAcceleration();
    app.whenReady().then(() => {
      const win = new BrowserWindow({
        width: 1040,
        height: 1040,
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false },
      });
      win.loadFile(${JSON.stringify(htmlPath)});
    });
    app.on('window-all-closed', () => app.quit());
  `,
  );

  writeFileSync(
    htmlPath,
    `<!doctype html><html><body><canvas id="out" width="1024" height="1024"></canvas><script>
      const fs = require('fs');

      function loadImg(p) {
        return new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = 'file:///' + p.replace(/\\\\/g, '/');
        });
      }

      function getImageData(im) {
        const c = document.createElement('canvas');
        c.width = im.width;
        c.height = im.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(im, 0, 0);
        return ctx.getImageData(0, 0, im.width, im.height);
      }

      function sampleBilinear(imgData, x, y, box) {
        const ix = Math.floor(x), iy = Math.floor(y);
        if (ix < box[0] || iy < box[1] || ix + 1 >= box[0] + box[2] || iy + 1 >= box[1] + box[3]) {
          return [0, 0, 0, 0];
        }
        const fx = x - ix, fy = y - iy;
        const w = imgData.width, d = imgData.data;
        let aSum = 0, rSum = 0, gSum = 0, bSum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const idx = ((iy + dy) * w + (ix + dx)) * 4;
            const a = d[idx + 3];
            if (a <= 2) continue;
            const wt = (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy) * a;
            aSum += wt;
            rSum += wt * d[idx];
            gSum += wt * d[idx + 1];
            bSum += wt * d[idx + 2];
          }
        }
        if (aSum < 0.5) return [0, 0, 0, 0];
        return [
          Math.round(rSum / aSum),
          Math.round(gSum / aSum),
          Math.round(bSum / aSum),
          Math.min(255, Math.round(aSum)),
        ];
      }

      // Signed distance to a piecewise curve y = curveY(x) for front cuff rim split
      // Front rim curve in arm-parts-v1.png separating ribbed front cuff (above) from hollow dark-pink interior (below)
      const CUFF_RIM_CURVE = [
        [60, 1326], [88, 1321], [112, 1314], [140, 1313], [168, 1318],
        [198, 1328], [228, 1343], [256, 1361], [282, 1382], [302, 1403],
        [314, 1421], [335, 1445],
      ];

      function cuffRimYAt(x) {
        if (x <= CUFF_RIM_CURVE[0][0]) return CUFF_RIM_CURVE[0][1];
        for (let i = 1; i < CUFF_RIM_CURVE.length; i++) {
          const [x0, y0] = CUFF_RIM_CURVE[i - 1];
          const [x1, y1] = CUFF_RIM_CURVE[i];
          if (x <= x1) {
            const t = (x - x0) / Math.max(1e-6, x1 - x0);
            return y0 + (y1 - y0) * t;
          }
        }
        return CUFF_RIM_CURVE[CUFF_RIM_CURVE.length - 1][1];
      }

      // Smooth centerline [sy, sx] of sleeve in arm-parts-v1.png (measured from grid-sleeve-full.png & dynamics-regions.json)
      const CENTERLINE = [
        [50, 492], [110, 470], [180, 450], [350, 446], [550, 418],
        [750, 376], [950, 316], [1150, 282], [1300, 245], [1380, 224], [1455, 206],
      ];

      function evalCenterX(sy) {
        if (sy <= CENTERLINE[0][0]) return CENTERLINE[0][1];
        for (let i = 1; i < CENTERLINE.length; i++) {
          const [y0, x0] = CENTERLINE[i - 1];
          const [y1, x1] = CENTERLINE[i];
          if (sy <= y1) {
            const t = (sy - y0) / (y1 - y0);
            return x0 + (x1 - x0) * t;
          }
        }
        return CENTERLINE[CENTERLINE.length - 1][1];
      }

      function pointInPoly(px, py, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i][0], yi = poly[i][1];
          const xj = poly[j][0], yj = poly[j][1];
          const intersect = ((yi > py) !== (yj > py)) &&
            (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi);
          if (intersect) inside = !inside;
        }
        return inside;
      }

      function distToPolyEdge(px, py, poly) {
        let minD = Infinity;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const ax = poly[j][0], ay = poly[j][1];
          const bx = poly[i][0], by = poly[i][1];
          const vx = bx - ax, vy = by - ay;
          const len2 = vx * vx + vy * vy || 1e-9;
          const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
          const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
          const d = Math.hypot(dx, dy);
          if (d < minD) minD = d;
        }
        return minD;
      }

      window.__buildAtlas = async () => {
        const armImg = await loadImg(${JSON.stringify(ARM_PARTS_PNG)});
        const refImg = await loadImg(${JSON.stringify(REF_PNG)});
        const armData = getImageData(armImg);
        const refData = getImageData(refImg);

        const outCanvas = document.getElementById('out');
        const outCtx = outCanvas.getContext('2d');
        outCtx.clearRect(0, 0, 1024, 1024);
        const outImg = outCtx.createImageData(1024, 1024);
        const od = outImg.data;

        const setPx = (x, y, rgba) => {
          if (x < 0 || y < 0 || x >= 1024 || y >= 1024 || rgba[3] <= 0) return;
          const i = (y * 1024 + x) * 4;
          od[i] = rgba[0];
          od[i + 1] = rgba[1];
          od[i + 2] = rgba[2];
          od[i + 3] = rgba[3];
        };

        // ─── 1. Straightened Full Sleeve (x: 0..384, y: 0..1024) ───
        // Vertical span in atlas: y in [16..1008] (height = 992 px) maps source sy in [55..1445] (1390 source px).
        // Horizontal span in atlas: x = 192 is sleeve centerline; 1 atlas px = 1.40 source px -> width 384 covers 537 source px.
        const SL_X0 = 0, SL_W = 384, SL_CX = 192;
        const SL_Y0 = 16, SL_H = 992;
        const SY_MIN = 55, SY_MAX = 1445;
        const PX_PER_ATLAS_X = 1.40;
        const SLEEVE_BOX = [0, 45, 615, 1410];

        // Notice in grid-cuff.png the cuff tilts down-right (~22 deg relative to horizontal) because the sleeve is angled.
        // We apply a gentle linear shear across the bottom cuff zone (sy > 1120) so the ribbed cuff band aligns cleanly perpendicular to the bone axis!
        for (let ay = SL_Y0; ay < SL_Y0 + SL_H; ay++) {
          const v = (ay - SL_Y0) / (SL_H - 1); // 0 = shoulder cap, 1 = cuff tip
          const syBase = SY_MIN + v * (SY_MAX - SY_MIN);
          const cx = evalCenterX(syBase);
          // Smoothly blend cuff tilt deskew from 0 at elbow (sy=800) to full 0.36 slope at cuff (sy>=1160)
          const deskewWeight = Math.max(0, Math.min(1, (syBase - 900) / 280));
          const cuffSlope = 0.36 * deskewWeight;

          for (let ax = SL_X0; ax < SL_X0 + SL_W; ax++) {
            const du = (ax - SL_CX) * PX_PER_ATLAS_X; // across sleeve in source px
            const sx = cx + du;
            const sy = syBase + du * cuffSlope;
            const rgba = sampleBilinear(armData, sx, sy, SLEEVE_BOX);
            if (rgba[3] > 0) setPx(ax, ay, rgba);
          }
        }

        // ─── 2. Front Ribbed Cuff Lip ONLY (x: 384..768, y: 0..288) ───
        // Exact same (u, v) coordinate mapping as sleeve's distal band v in [0.74, 1.00] (ay in [750..1008] -> 258 px tall, placed at y=16..274)!
        const CF_X0 = 384, CF_CX = 384 + 192;
        const CF_Y0 = 16, CF_H = 258;
        const CF_V_MIN = 0.74, CF_V_MAX = 1.0;

        for (let ly = 0; ly < CF_H; ly++) {
          const v = CF_V_MIN + (ly / (CF_H - 1)) * (CF_V_MAX - CF_V_MIN);
          const syBase = SY_MIN + v * (SY_MAX - SY_MIN);
          const cx = evalCenterX(syBase);
          const deskewWeight = Math.max(0, Math.min(1, (syBase - 900) / 280));
          const cuffSlope = 0.36 * deskewWeight;

          for (let lx = 0; lx < SL_W; lx++) {
            const du = (lx - 192) * PX_PER_ATLAS_X;
            const sx = cx + du;
            const sy = syBase + du * cuffSlope;

            // Mask out hollow cuff opening & back wall cleanly below CUFF_RIM_CURVE!
            const rimY = cuffRimYAt(sx);
            const distBelowRim = sy - rimY;
            if (distBelowRim > 2.0) continue; // Inside hollow cavity or back wall -> transparent!

            const rgba = sampleBilinear(armData, sx, sy, SLEEVE_BOX);
            if (rgba[3] <= 0) continue;

            // Smooth 3px AA feather along the mauve front rim line + soft top fade at v=[0.74..0.78] so it blends seamlessly with sleeve
            let alphaMul = 1.0;
            if (distBelowRim > -1.0) {
              alphaMul *= Math.max(0, Math.min(1, (2.0 - distBelowRim) / 3.0));
            }
            if (v < 0.78) {
              alphaMul *= Math.max(0, Math.min(1, (v - 0.74) / 0.04));
            }
            rgba[3] = Math.round(rgba[3] * alphaMul);
            if (rgba[3] > 0) setPx(CF_X0 + lx, CF_Y0 + ly, rgba);
          }
        }

        // ─── 3. Four Unified Upright Hands (wrist at bottom-center, fingers pointing UP -Y) ───
        // Each tile: 304 x 344 px
        //   rest:  [392, 312, 304, 344]
        //   chin:  [708, 312, 304, 344]
        //   heart: [392, 668, 304, 344]
        //   wave:  [708, 668, 304, 344]
        // All 4 tiles put wrist pivot at local (cx = 152, cy = 304) and scale 1 atlas px -> consistent anatomical palm width!

        function blitArmPartHand(tileX, tileY, tileW, tileH, srcBox, srcWrist, scaleToTile) {
          const pivotX = tileW * 0.5;
          const pivotY = tileH - 36;
          for (let ly = 0; ly < tileH; ly++) {
            for (let lx = 0; lx < tileW; lx++) {
              const sx = srcWrist[0] + (lx - pivotX) / scaleToTile;
              const sy = srcWrist[1] + (ly - pivotY) / scaleToTile;
              const rgba = sampleBilinear(armData, sx, sy, srcBox);
              if (rgba[3] > 0) setPx(tileX + lx, tileY + ly, rgba);
            }
          }
          return {
            x: tileX, y: tileY, w: tileW, h: tileH,
            pivotLocal: [pivotX / tileW, pivotY / tileH],
            // Real-world model pixels per atlas pixel (matches upstream arm-parts scale ~0.20 / 0.17!)
            worldWidthPx: (tileW / scaleToTile) * 0.215,
            worldHeightPx: (tileH / scaleToTile) * 0.185,
          };
        }

        const handsMeta = {};
        handsMeta.chin = blitArmPartHand(708, 312, 304, 344, [670, 70, 300, 395], [831, 430], 0.72);
        handsMeta.heart = blitArmPartHand(392, 668, 304, 344, [680, 510, 280, 415], [856, 888], 0.72);
        handsMeta.wave = blitArmPartHand(708, 668, 304, 344, [650, 935, 350, 490], [850, 1388], 0.64);

        // Extract relaxed rest hand cleanly from reference.png using tight outline-traced contour (measured on 3x grid-rest-hand.png)
        const REST_TIGHT = [
          [232,791],[224,800],[217,810],[211,821],[205,834],[198,847],[191,858],[191,861],
          [196,858],[204,849],[212,838],[215,834],[214,844],[211,856],[209,867],[211,869],
          [216,866],[220,858],[224,847],[229,837],[236,826],[243,816],[244,820],[240,831],
          [238,840],[240,844],[245,841],[252,832],[259,822],[266,811],[262,805],[251,797],[240,791],
        ];
        const restTileX = 392, restTileY = 312, restTileW = 304, restTileH = 344;
        const restPivotX = restTileW * 0.5, restPivotY = restTileH - 36;
        const restScale = 2.85;
        const rwx = 247, rwy = 800;
        const axX = -0.9436, axY = -0.3312;
        const ayX = +0.3312, ayY = -0.9436;

        for (let ly = 0; ly < restTileH; ly++) {
          for (let lx = 0; lx < restTileW; lx++) {
            const dx = (lx - restPivotX) / restScale;
            const dy = (ly - restPivotY) / restScale;
            const sx = rwx + dx * axX + dy * ayX;
            const sy = rwy + dx * axY + dy * ayY;
            const inside = pointInPoly(sx, sy, REST_TIGHT);
            const edgeD = distToPolyEdge(sx, sy, REST_TIGHT);
            let rgba = [0, 0, 0, 0];
            if (inside || edgeD <= 0.9) {
              const s = sampleBilinear(refData, sx, sy, [180, 780, 100, 100]);
              const aa = inside ? (edgeD < 0.7 ? 0.55 + 0.45 * (edgeD / 0.7) : 1.0) : Math.max(0, 0.55 * (1 - edgeD / 0.9));
              rgba = [s[0], s[1], s[2], Math.round(s[3] * aa)];
            }
            // Smooth wrist stub tucked cleanly behind cuffFront (zero seam when gently swaying wrist)
            if (dy >= -3 && dy <= 11 && Math.abs(dx) <= 13.5) {
              const edgeFade = Math.max(0, Math.min(1, (13.5 - Math.abs(dx)) / 2.2));
              const botFade = Math.max(0, Math.min(1, (11 - dy) / 2.5));
              const stubA = Math.round(255 * edgeFade * botFade);
              if (stubA > rgba[3]) rgba = [251, 217, 214, stubA];
            }
            if (rgba[3] > 0) setPx(restTileX + lx, restTileY + ly, rgba);
          }
        }
        handsMeta.rest = {
          x: restTileX, y: restTileY, w: restTileW, h: restTileH,
          pivotLocal: [restPivotX / restTileW, restPivotY / restTileH],
          worldWidthPx: restTileW / restScale,
          worldHeightPx: restTileH / restScale,
        };

        outCtx.putImageData(outImg, 0, 0);
        const pngB64 = outCanvas.toDataURL('image/png').split(',')[1];
        fs.writeFileSync(${JSON.stringify(OUT_PNG)}, Buffer.from(pngB64, 'base64'));

        // Also save a checker-backed preview so we can visually audit the split cuff + all 4 hands!
        const prev = document.createElement('canvas');
        prev.width = 1024; prev.height = 1024;
        const pctx = prev.getContext('2d');
        for (let y = 0; y < 1024; y += 16) {
          for (let x = 0; x < 1024; x += 16) {
            pctx.fillStyle = ((x / 16 + y / 16) % 2 === 0) ? '#1c2033' : '#262b42';
            pctx.fillRect(x, y, 16, 16);
          }
        }
        pctx.drawImage(outCanvas, 0, 0);
        // Draw red pivot crosshairs on preview ONLY
        pctx.strokeStyle = '#00ffaa';
        pctx.lineWidth = 2;
        for (const [k, h] of Object.entries(handsMeta)) {
          const px = h.x + h.w * h.pivotLocal[0];
          const py = h.y + h.h * h.pivotLocal[1];
          pctx.beginPath(); pctx.moveTo(px - 12, py); pctx.lineTo(px + 12, py); pctx.moveTo(px, py - 12); pctx.lineTo(px, py + 12); pctx.stroke();
        }
        fs.writeFileSync(${JSON.stringify(PREVIEW_PNG)}, Buffer.from(prev.toDataURL('image/png').split(',')[1], 'base64'));

        const meta = {
          version: 1,
          atlasWidth: 1024,
          atlasHeight: 1024,
          sleeve: {
            x: SL_X0, y: SL_Y0, w: SL_W, h: SL_H,
            vShoulder: (180 - SY_MIN) / (SY_MAX - SY_MIN),
            vElbow: (735 - SY_MIN) / (SY_MAX - SY_MIN),
            vWrist: (1325 - SY_MIN) / (SY_MAX - SY_MIN),
            // Model-space sleeve half-width corresponding to full 384px tile
            // Upstream scale[0] = 0.265 -> 537 source px * 0.265 = 142.3 model px total width -> halfWidth = 71.15 model px!
            worldHalfWidthPx: (SL_W * PX_PER_ATLAS_X * 0.265) * 0.5,
          },
          cuffFront: {
            x: CF_X0, y: CF_Y0, w: SL_W, h: CF_H,
            vMin: CF_V_MIN,
            vMax: CF_V_MAX,
          },
          hands: handsMeta,
        };
        fs.writeFileSync(${JSON.stringify(OUT_META)}, JSON.stringify(meta, null, 2) + '\\n');
        return meta;
      };
    </script></body></html>`,
  );

  const app = await electron.launch({
    executablePath: join(REPO, 'companion/host/node_modules/electron/dist/electron.exe'),
    args: [mainPath],
    env: desktopEnvironment(),
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('load');
    const meta = await win.evaluate(() => window.__buildAtlas());
    console.log('Generated arm-rig-atlas.png & arm-rig-meta.json:', JSON.stringify(meta.sleeve));
  } finally {
    await app.close().catch(() => {});
    rmSync(WORK_DIR, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
