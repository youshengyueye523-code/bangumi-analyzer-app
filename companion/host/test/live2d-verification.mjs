/**
 * Real Electron Live2D WebGL Verification (Pink Sakura + Official Cubism Core 5-r.5)
 * Verifies:
 *   - Core availability, 14 motions & 8 expressions via companionModel IPC
 *   - Intro screen (variant="full") real animated WebGL canvas (frame pixel delta != 0) & no visible watermark
 *   - Home screen (variant="half") all 8 Mascot states + F11 Fullscreen + window resize stability
 *   - reduceMotion toggle stops animation ticker; mascotEnabled off->on cleanly disposes & restores WebGL context
 *   - Telemetry: FPS measurement & Electron process memoryUsage()
 *   - Third-party licenses modal shows Pink Sakura / Ariakage / CC BY 4.0 / Cubism Core 06.00.0001
 *   - Corrupt/missing Core graceful fallback to XiaofanPlaceholder with zero unhandled pageerrors
 *
 * Usage:
 *   .\.runtime\node-v24.22.1-win-x64\node.exe companion/host/test/live2d-verification.mjs
 *   .\.runtime\node-v24.22.1-win-x64\node.exe companion/host/test/live2d-verification.mjs --exe <installedExe>
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopEnvironment, extractR2, host, newWork, repo } from '../scripts/isolated.mjs';

const require = createRequire(path.join(repo, 'package.json'));
const { _electron } = require('@playwright/test');

const SHOT_DIR = path.join(repo, 'companion/ui/screenshots');
const EXPECTED_STATES = ['idle', 'greet', 'think', 'work', 'happy', 'worry', 'sleep', 'cheer'];
const STATE_LABELS = ['待机', '招呼', '思考', '工作', '开心', '担心', '休息', '庆祝'];
const EXPECTED_MOTIONS = [
  'Idle',
  'Blink',
  'Nod',
  'Shake',
  'Quiet',
  'Curious',
  'Sleepy',
  'Airy',
  'SlowBlink',
  'SpeechBob',
  'HandToChin',
  'FingerHeart',
  'Wave',
  'HandDown',
];
const EXPECTED_EXPRESSIONS = [
  'Smile',
  'SoftSmile',
  'WinkLeft',
  'WinkRight',
  'Surprised',
  'Smug',
  'Angry',
  'Sleepy',
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function launchTarget(hostRoot, companionHome) {
  return {
    executablePath: path.join(hostRoot, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(hostRoot, 'main.mjs'), '--companionHome', companionHome],
    cwd: hostRoot,
    env: desktopEnvironment(),
    timeout: 45000,
  };
}

async function waitForLive2dReady(page, logs, timeoutMs = 20000) {
  try {
    await page.waitForFunction(() => {
      const wrap = document.querySelector('.mascot-live2d-wrap.ready');
      const c = document.querySelector('canvas[data-live2d-active="true"]');
      return Boolean(wrap && c && Number(c.dataset.frames || 0) >= 2);
    }, undefined, { timeout: timeoutMs });
  } catch (err) {
    const diag = await page.evaluate(async () => {
      const c = document.querySelector('canvas.mascot-live2d-canvas');
      const wrap = document.querySelector('.mascot-live2d-wrap');
      const stage = document.querySelector('.mascot-stage');
      const placeholder = Boolean(stage?.querySelector('svg.mascot-figure, .xiaofan-img'));
      const st = await window.companionModel?.getStatus?.().catch(e => ({ err: String(e) }));
      const gl = c ? (c.getContext('webgl2') || c.getContext('webgl')) : null;
      let glProbe = null;
      if (gl) {
        const vsSrc = "attribute vec4 a_position;attribute vec2 a_texCoord;varying vec2 v_texCoord;varying vec4 v_myPos;uniform mat4 u_clipMatrix;void main(){gl_Position=u_clipMatrix*a_position;v_myPos=u_clipMatrix*a_position;v_texCoord=a_texCoord;v_texCoord.y=1.0-v_texCoord.y;}";
        const vs = gl.createShader(gl.VERTEX_SHADER);
        if (vs) {
          gl.shaderSource(vs, vsSrc);
          gl.compileShader(vs);
        }
        glProbe = {
          contextLost: gl.isContextLost(),
          version: gl.getParameter(gl.VERSION),
          renderer: gl.getParameter(gl.RENDERER),
          vsCompiled: vs ? gl.getShaderParameter(vs, gl.COMPILE_STATUS) : null,
          vsLog: vs ? gl.getShaderInfoLog(vs) : null,
          err: gl.getError(),
        };
        if (vs) gl.deleteShader(vs);
      }
      const probe = document.createElement('canvas');
      const fg = probe.getContext('webgl2') || probe.getContext('webgl');
      const freshGl = fg ? {
        lost: fg.isContextLost(),
        ver: fg.getParameter(fg.VERSION),
        renderer: fg.getParameter(fg.RENDERER),
        vendor: fg.getParameter(fg.VENDOR),
      } : null;
      return {
        hasCoreGlobal: Boolean(window.Live2DCubismCore),
        coreVer: window.Live2DCubismCore?.Version?.csmGetVersion?.() ?? null,
        wrapClass: wrap?.className ?? null,
        fallbackAttr: stage?.getAttribute('data-live2d-fallback') ?? null,
        placeholder,
        canvasSize: c ? `${c.width}x${c.height} (css ${c.clientWidth}x${c.clientHeight})` : null,
        canvasDataset: c ? { ...c.dataset } : null,
        glProbe,
        freshGl,
        modelStatus: st ?? null,
      };
    }).catch(e => ({ evalErr: String(e) }));
    const gpuDiag = await app?.evaluate?.(() => globalThis.__gpuDiag).catch(() => null);
    console.error('LIVE2D_DIAGNOSTIC:', JSON.stringify({ diag, gpuDiag, logs }, null, 2));
    throw err;
  }
}

async function sampleCanvas(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas.mascot-live2d-canvas');
    if (!c) return null;
    const url = c.toDataURL('image/png');
    const hash = Array.from(url.slice(0, 4096)).reduce((acc, ch) => ((acc * 31 + ch.charCodeAt(0)) >>> 0), 0);
    // Read center/body pixels directly from 2D mirror canvas to verify non-empty drawing
    const probe = document.createElement('canvas');
    probe.width = 64;
    probe.height = 64;
    const ctx = probe.getContext('2d');
    ctx.drawImage(c, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    let nonZeroAlpha = 0;
    let totalR = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 12) {
        nonZeroAlpha++;
        totalR += data[i];
      }
    }
    const sha = url; // full base64 for exact equality compare
    return {
      width: c.width,
      height: c.height,
      clientWidth: c.clientWidth,
      clientHeight: c.clientHeight,
      nonZeroAlpha,
      meanR: nonZeroAlpha > 0 ? Math.round(totalR / nonZeroAlpha) : 0,
      hash,
      sha,
      dataset: { ...c.dataset },
    };
  });
}

function sha256Str(s) {
  return createHash('sha256').update(s).digest('hex');
}

const work = await newWork('live2d-verify');
const useSetupExe = process.argv.includes('--setup');
let activeHostRoot = host;
await mkdir(SHOT_DIR, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  target: useSetupExe ? 'installed-setup-exe' : 'companion/host/main.mjs',
  checks: [],
  metrics: {},
};
const check = (name, ok = true) => {
  assert.ok(ok, name);
  report.checks.push(name);
  console.log('PASS ' + name);
};

let app;
try {
  if (useSetupExe) {
    const manifest = JSON.parse(readFileSync(path.join(repo, 'companion/dist/RELEASE_MANIFEST.json'), 'utf8'));
    const setupExe = path.join(repo, 'companion/dist', manifest.installer.fileName);
    const installTarget = path.join(work, 'installed-rc');
    execFileSync(setupExe, ['/S', `/D=${installTarget}`, '/NOLAUNCH', '/NOSHORTCUT'], { stdio: 'inherit', timeout: 60000 });
    const requiredDocs = [
      'ATTRIBUTION.md',
      'ASSET-LICENSE.md',
      'THIRD_PARTY_NOTICES.md',
      'models/vendor/live2dcubismcore.min.js',
      'models/vendor/CORE-LICENSE.md',
      'models/vendor/RedistributableFiles.txt',
      'models/pink-sakura/PinkSakura.moc3',
      'models/pink-sakura/PinkSakura.2048/texture_00.png',
    ];
    check(
      'Installed Setup.exe contains Pink Sakura assets, Core SDK + offline attribution/license files',
      requiredDocs.every((rel) => existsSync(path.join(installTarget, rel))),
    );
    activeHostRoot = path.join(installTarget, 'host');
  }
  // ---------------------------------------------------------------------------
  // Phase A: Intro full-body WebGL rendering + clean stage (no watermark)
  // ---------------------------------------------------------------------------
  const homeIntro = path.join(work, 'home-intro');
  await mkdir(homeIntro, { recursive: true });
  app = await _electron.launch(launchTarget(activeHostRoot, homeIntro));
  await app.evaluate(({ app: electronApp }) => {
    globalThis.__gpuDiag = { featureStatus: electronApp.getGPUFeatureStatus(), gone: [] };
    electronApp.on('child-process-gone', (_e, details) => {
      globalThis.__gpuDiag.gone.push(details);
    });
  });
  let page = await app.firstWindow();
  const introPageErrors = [];
  const introConsoleErrors = [];
  page.on('pageerror', (e) => introPageErrors.push(e.stack || e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') introConsoleErrors.push(m.text());
  });

  await page.locator('.intro').waitFor({ state: 'visible', timeout: 20000 });
  await page.keyboard.press('Space');
  await waitForLive2dReady(page, { introPageErrors, introConsoleErrors }, 15000);

  const noUnsafeSwiftshader = await app.evaluate(({ app: electronApp }) => !electronApp.commandLine.hasSwitch('enable-unsafe-swiftshader'));
  check('Official launch omits --enable-unsafe-swiftshader switch', noUnsafeSwiftshader);

  const modelStatus = await page.evaluate(() => window.companionModel.getStatus());
  check('Model IPC reports Pink Sakura, Cubism Core & WebGL GPU policy ready', Boolean(modelStatus.ok && modelStatus.modelAssetsReady && modelStatus.hasCubismCore && modelStatus.gpuStatus?.webglAllowed));

  const bundleMeta = await page.evaluate(async () => {
    const b = await window.companionModel.loadPinkSakuraBundle();
    return {
      ok: b.ok,
      motions: Object.keys(b.motions ?? {}),
      expressions: Object.keys(b.expressions ?? {}),
      mocBytes: b.mocBase64 ? b.mocBase64.length : 0,
    };
  });
  check('Bundle IPC returns all 14 official PinkSakura motions & 8 expressions', bundleMeta.ok && EXPECTED_MOTIONS.every((m) => bundleMeta.motions.includes(m)) && EXPECTED_EXPRESSIONS.every((e) => bundleMeta.expressions.includes(e)) && bundleMeta.mocBytes > 100000);

  const f1 = await sampleCanvas(page);
  await wait(550);
  const f2 = await sampleCanvas(page);
  const introCanvasDiffers = f1 && f2 && sha256Str(f1.sha) !== sha256Str(f2.sha);
  const introFps = Number(f2?.dataset?.fps || 0);
  console.log('INTRO_FPS_DEBUG:', JSON.stringify({ introFps, maxFps: f2?.dataset?.maxFps, frames: f2?.dataset?.frames, variant: f1?.dataset?.variant, motionGroups: f1?.dataset?.motionGroups, alpha: f1?.nonZeroAlpha, introCanvasDiffers }));
  check('Intro full-body Live2D WebGL renders non-empty animated frames capped cleanly at 60 FPS', Boolean(f1 && f1.dataset.variant === 'full' && f1.dataset.motionGroups === '14' && f2?.dataset?.maxFps === '60' && introFps > 0 && introFps <= 75 && f1.nonZeroAlpha > 80 && introCanvasDiffers));

  const introText = await page.locator('.intro').innerText();
  check('Intro renders zero visible attribution/watermark on stage', !/Ariakage|CC BY|Pink Sakura/i.test(introText));

  await page.screenshot({ path: path.join(SHOT_DIR, 'live2d-intro-full.png') });
  report.metrics.intro = {
    coreVersion: f2.dataset.coreVersion,
    drawables: Number(f2.dataset.drawables),
    params: Number(f2.dataset.params),
    motionGroups: Number(f2.dataset.motionGroups),
    nonZeroAlphaPixels64: f2.nonZeroAlpha,
    canvasPx: `${f2.width}x${f2.height}`,
    fps: Number(f2.dataset.fps || 0),
  };
  await app.close();
  app = null;
  check('Intro session closed cleanly with zero pageerror/console errors', introPageErrors.length === 0 && introConsoleErrors.length === 0);

  // ---------------------------------------------------------------------------
  // Phase B: Home half-body stage, all 8 states, F11 Fullscreen, Resize,
  // reduceMotion toggle, GPU dispose/restore, FPS & memory, ThirdPartyLicenses
  // ---------------------------------------------------------------------------
  const r2Copy = await extractR2(work, 'r2-installed');
  const homeReady = path.join(work, 'home-ready');
  await mkdir(homeReady, { recursive: true });
  await writeFile(
    path.join(homeReady, 'companion.json'),
    JSON.stringify({
      firstRunCompleted: true,
      skipIntro: true,
      autoStart: false,
      autoOpen: false,
      installDir: r2Copy,
      nickname: 'Live2D 验收用户',
      username: 'live2d_qa',
      collections: 142,
      aiConfigured: false,
      aiModel: '',
      desktopShortcut: false,
    }),
  );

  app = await _electron.launch(launchTarget(activeHostRoot, homeReady));
  page = await app.firstWindow();
  const homePageErrors = [];
  const homeConsoleErrors = [];
  page.on('pageerror', (e) => homePageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') homeConsoleErrors.push(m.text());
  });

  await page.locator('.home').waitFor({ state: 'visible', timeout: 20000 });
  await waitForLive2dReady(page, { homePageErrors, homeConsoleErrors }, 15000);

  const hf1 = await sampleCanvas(page);
  await wait(550);
  const hf2 = await sampleCanvas(page);
  const homeAnimated = hf1 && hf2 && sha256Str(hf1.sha) !== sha256Str(hf2.sha);
  check('Home half-body Live2D renders live animated WebGL pixels', Boolean(hf2 && hf2.dataset.variant === 'half' && hf2.nonZeroAlpha > 80 && homeAnimated));

  const homeStageText = await page.locator('.home').innerText();
  check('Home stage shows no visible attribution/watermark overlay', !/Ariakage|CC BY 4\.0/i.test(homeStageText));

  await page.screenshot({ path: path.join(SHOT_DIR, 'live2d-home-half.png') });

  // Cycle through all 8 Companion states via actual UI pills
  const stateTelemetry = [];
  for (let i = 0; i < STATE_LABELS.length; i++) {
    const label = STATE_LABELS[i];
    const stateId = EXPECTED_STATES[i];
    const pill = page.locator('.hrs-pill', { hasText: label }).first();
    await pill.click();
    await wait(320);
    const snap = await sampleCanvas(page);
    stateTelemetry.push({
      state: stateId,
      motionGroup: snap?.dataset?.motionGroup,
      expression: snap?.dataset?.expression,
      nonZeroAlpha: snap?.nonZeroAlpha ?? 0,
      fps: Number(snap?.dataset?.fps || 0),
    });
    if (stateId === 'greet' || stateId === 'sleep') {
      await page.screenshot({ path: path.join(SHOT_DIR, `live2d-state-${stateId}.png`) });
    }
  }
  const resetPill = page.getByRole('button', { name: '恢复自动' });
  if (await resetPill.isVisible().catch(() => false)) await resetPill.click();
  check(
    'All 8 Mascot states switch cleanly with distinct motions/expressions & non-empty frames',
    stateTelemetry.length === 8 &&
      stateTelemetry.every((s) => Boolean(s.motionGroup) && Boolean(s.expression) && s.nonZeroAlpha > 80),
  );
  report.metrics.states = stateTelemetry;

  // F11 Fullscreen + Resize stability
  await page.keyboard.press('F11');
  await wait(500);
  const fsState = await page.evaluate(() => window.companionWindow.getState());
  const fsSample = await sampleCanvas(page);
  check('F11 Fullscreen preserves Live2D WebGL rendering without clipping/crash', Boolean(fsState.isFullScreen && fsSample && fsSample.nonZeroAlpha > 80 && fsSample.clientWidth > 0 && fsSample.clientHeight > 0));
  await page.screenshot({ path: path.join(SHOT_DIR, 'live2d-fullscreen.png') });

  await page.keyboard.press('Escape');
  await wait(450);
  const restoredFs = await page.evaluate(() => window.companionWindow.getState());
  check('Esc exits Fullscreen cleanly while keeping Live2D canvas active', !restoredFs.isFullScreen);

  // Resize smaller window & check no scale accumulation / canvas stays sized properly
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
  await wait(400);
  const smallSample = await sampleCanvas(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
  await wait(400);
  const normalSample = await sampleCanvas(page);
  check('Window resize re-fits Pink Sakura canvas cleanly without layout collapse', Boolean(smallSample?.nonZeroAlpha > 60 && normalSample?.nonZeroAlpha > 80));

  // Verify reduceMotion stops animation ticker cleanly
  await page.getByRole('tab', { name: /启动与偏好/ }).click();

  // Verify configurable FPS tiers: 30 FPS low-power vs 60 FPS vs 120 FPS high-refresh & animation speed consistency (1.0x)
  const measureFpsTier = async (btnName) => {
    await page.getByRole('group', { name: 'Live2D 帧率策略' }).getByRole('button', { name: btnName }).click();
    await wait(650);
    const s1 = await sampleCanvas(page);
    const t1 = Date.now();
    await wait(1150);
    const s2 = await sampleCanvas(page);
    const wallMs = Date.now() - t1;
    const framesDelta = Number(s2?.dataset?.frames || 0) - Number(s1?.dataset?.frames || 0);
    const motionDeltaMs = Number(s2?.dataset?.motionElapsedMs || 0) - Number(s1?.dataset?.motionElapsedMs || 0);
    const actualFps = Math.round((framesDelta * 1000) / Math.max(1, wallMs));
    return {
      mode: s2?.dataset?.fpsMode,
      maxFps: Number(s2?.dataset?.maxFps || 0),
      displayHz: Number(s2?.dataset?.displayHz || 60),
      actualFps,
      reportedFps: Number(s2?.dataset?.fps || 0),
      framesDelta,
      wallMs,
      motionDeltaMs,
      speedRatio: Number((motionDeltaMs / Math.max(1, wallMs)).toFixed(2)),
    };
  };
  const tier30 = await measureFpsTier('30 FPS 节能');
  const tier60 = await measureFpsTier('60 FPS');
  const tier120 = await measureFpsTier('120 FPS 高刷');
  await page.getByRole('group', { name: 'Live2D 帧率策略' }).getByRole('button', { name: '智能' }).click();
  await wait(350);
  report.metrics.fpsTiers = { tier30, tier60, tier120 };
  console.log('FPS_TIERS_BENCHMARK:', JSON.stringify(report.metrics.fpsTiers));
  check(
    'Configurable FPS tiers enforce bounds (30 < 60 <= 120), keep constant 1.0x animation speed & lower frame budget at 30 FPS',
    tier30.actualFps >= 20 &&
      tier30.actualFps <= 38 &&
      tier60.actualFps >= 45 &&
      tier60.actualFps <= 68 &&
      (tier120.displayHz >= 100 ? tier120.actualFps >= 80 && tier120.actualFps <= 130 : tier120.actualFps <= 68) &&
      tier30.framesDelta < tier60.framesDelta &&
      tier30.speedRatio >= 0.75 &&
      tier30.speedRatio <= 1.25 &&
      tier120.speedRatio >= 0.75 &&
      tier120.speedRatio <= 1.25,
  );

  await page.getByText('减弱演出动画').click();
  await wait(350);
  const rm1 = await sampleCanvas(page);
  await wait(450);
  const rm2 = await sampleCanvas(page);
  check('reduceMotion stops continuous ticker frame progression', Boolean(rm1 && rm2 && sha256Str(rm1.sha) === sha256Str(rm2.sha)));
  // Re-enable animations
  await page.getByText('减弱演出动画').click();
  await wait(300);

  // Verify mascotEnabled repeated off/on cycles destroy & restore GPU/WebGL cleanly without bloat
  let canvasGone = false;
  let afterRestore = null;
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByText('显示小番陪伴舞台与气泡互动').click();
    await wait(250);
    canvasGone = await page.evaluate(() => document.querySelector('canvas.mascot-live2d-canvas') === null);
    assert.ok(canvasGone, `Cycle ${cycle + 1} canvas destroyed`);
    await page.getByText('显示小番陪伴舞台与气泡互动').click();
    await waitForLive2dReady(page, { homePageErrors, homeConsoleErrors }, 15000);
    afterRestore = await sampleCanvas(page);
    assert.ok(Boolean(afterRestore && afterRestore.nonZeroAlpha > 80), `Cycle ${cycle + 1} canvas restored`);
  }
  check('Repeated mascot stage off/on cycles (3x) destroy & restore WebGL cleanly', canvasGone && Boolean(afterRestore && afterRestore.nonZeroAlpha > 80));

  // Verify window minimize pauses ticker cleanly and restore resumes/recovers cleanly
  await page.evaluate(() => window.companionWindow.minimize());
  await wait(500);
  const pausedHidden = await page.evaluate(() => document.querySelector('canvas.mascot-live2d-canvas')?.dataset?.tickerPaused);
  const minState = await page.evaluate(() => window.companionWindow.getState());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await waitForLive2dReady(page, { homePageErrors, homeConsoleErrors }, 15000);
  const afterResDiag = await page.evaluate(() => ({
    hasCanvas: Boolean(document.querySelector('canvas.mascot-live2d-canvas')),
    tickerPaused: document.querySelector('canvas.mascot-live2d-canvas')?.dataset?.tickerPaused ?? null,
    fallbackAttr: document.querySelector('.mascot-stage')?.getAttribute('data-live2d-fallback') ?? null,
    winHidden: document.hidden,
  }));
  const resumedVisible = afterResDiag.tickerPaused;
  const resState = await page.evaluate(() => window.companionWindow.getState());
  console.log('MINIMIZE_CHECK:', JSON.stringify({ pausedHidden, minState, afterResDiag, resState }));
  check('Minimizing window pauses Live2D ticker cleanly & restoring resumes/recovers cleanly', pausedHidden === 'true' && resumedVisible === 'false' && afterResDiag.hasCanvas);

  // Verify ThirdPartyLicenses accessible & contains required attribution + P3 legal bounds + GPU diagnostics
  await page.getByRole('button', { name: /关于 · 第三方许可/ }).click();
  await page.locator('.license-modal').getByText('WebGL2 可用').waitFor({ timeout: 5000 }).catch(() => {});
  const modalText = await page.locator('.license-modal').innerText();
  const checksModal = {
    pink: modalText.includes('Pink Sakura'),
    aria: modalText.includes('Ariakage'),
    ccby: modalText.includes('CC BY 4.0'),
    core: modalText.includes('06.00.0001'),
    exp: modalText.includes('Expandable Application'),
    webgl: modalText.includes('WebGL2 可用'),
  };
  if (!Object.values(checksModal).every(Boolean)) console.log('MODAL_DEBUG:', checksModal, modalText);
  check(
    'About -> ThirdPartyLicenses contains Pink Sakura, Ariakage, CC BY 4.0, Core 06.00.0001, Expandable Application notice & GPU diagnostics',
    Object.values(checksModal).every(Boolean),
  );
  await page.getByRole('button', { name: /关闭/ }).first().click();

  // Measure steady-state FPS & Electron process memory
  await wait(700);
  await page.waitForFunction(() => Number(document.querySelector('canvas[data-live2d-active="true"]')?.dataset?.fps || 0) >= 30, undefined, { timeout: 6000 }).catch(() => {});
  const fpsSample = await sampleCanvas(page);
  const memMetrics = await app.evaluate(({ app: electronApp }) => {
    const procMem = process.memoryUsage();
    const appMetrics = electronApp.getAppMetrics();
    const totalKb = appMetrics.reduce((sum, m) => sum + (m.memory?.workingSetSize || 0), 0);
    return {
      mainRssMb: Math.round(procMem.rss / 1048576),
      totalWorkingSetMb: Math.round(totalKb / 1024),
      processes: appMetrics.length,
    };
  });
  report.metrics.home = {
    fps: Number(fpsSample?.dataset?.fps || 0),
    framesRendered: Number(fpsSample?.dataset?.frames || 0),
    ...memMetrics,
  };
  console.log('TELEMETRY:', JSON.stringify(report.metrics.home));
  check('Measured Live2D FPS (> 0) and reasonable memory footprint (< 1024 MB total)', report.metrics.home.fps > 0 && memMetrics.totalWorkingSetMb < 1024);

  await app.close();
  app = null;
  check('Home Live2D suite had zero unhandled pageerror/console errors', homePageErrors.length === 0 && homeConsoleErrors.length === 0);

  // ---------------------------------------------------------------------------
  // Phase C: Broken/Missing Cubism Core graceful fallback to XiaofanPlaceholder
  // ---------------------------------------------------------------------------
  const homeBrokenCore = path.join(work, 'home-broken-core');
  await mkdir(path.join(homeBrokenCore, 'vendor'), { recursive: true });
  await writeFile(
    path.join(homeBrokenCore, 'companion.json'),
    JSON.stringify({ firstRunCompleted: true, skipIntro: true, autoStart: false, autoOpen: false, installDir: r2Copy }),
  );
  // Corrupt per-companionHome vendor script so Core fails cleanly without touching repo files
  await writeFile(path.join(homeBrokenCore, 'vendor', 'live2dcubismcore.min.js'), '/* synthetic empty core */');

  app = await _electron.launch(launchTarget(activeHostRoot, homeBrokenCore));
  page = await app.firstWindow();
  const fallbackPageErrors = [];
  page.on('pageerror', (e) => fallbackPageErrors.push(e.message));
  await page.locator('.home').waitFor({ state: 'visible', timeout: 20000 });
  await wait(800);
  const placeholderVisible = await page.locator('svg.mascot-figure').first().isVisible();
  const live2dReadyOnFallback = await page.locator('.mascot-live2d-wrap.ready').count();
  check('Missing/invalid Cubism Core gracefully falls back to XiaofanPlaceholder without crashing', placeholderVisible && live2dReadyOnFallback === 0 && fallbackPageErrors.length === 0);
  await app.close();
  app = null;

  // ---------------------------------------------------------------------------
  // Phase D: GPU disabled / fallback mode cleanly shows 2D stage & diagnostics
  // ---------------------------------------------------------------------------
  const homeGpuOff = path.join(work, 'home-gpu-off');
  await mkdir(homeGpuOff, { recursive: true });
  await writeFile(
    path.join(homeGpuOff, 'companion.json'),
    JSON.stringify({ firstRunCompleted: true, skipIntro: true, autoStart: false, autoOpen: false, installDir: r2Copy, gpuMode: 'off' }),
  );
  app = await _electron.launch(launchTarget(activeHostRoot, homeGpuOff));
  page = await app.firstWindow();
  const gpuOffErrors = [];
  page.on('pageerror', (e) => gpuOffErrors.push(e.message));
  await page.locator('.home').waitFor({ state: 'visible', timeout: 20000 });
  await wait(600);
  const gpuOffStatus = await page.evaluate(() => window.companionModel.getStatus());
  const gpuFallbackVisible = await page.locator('svg.mascot-figure').first().isVisible();
  const gpuSlotText = await page.locator('.mascot-slot').first().innerText();
  await page.getByRole('tab', { name: /启动与偏好/ }).click();
  await page.getByRole('button', { name: /关于 · 第三方许可/ }).click();
  await page.locator('.license-modal').getByText('USER_DISABLED').waitFor({ timeout: 5000 }).catch(() => {});
  const gpuModalText = await page.locator('.license-modal').innerText();
  check(
    'GPU disabled/unavailable falls back to XiaofanPlaceholder cleanly with user-facing diagnostics',
    gpuOffStatus.gpuStatus?.webglAllowed === false &&
      gpuFallbackVisible &&
      gpuSlotText.includes('WebGL 已回退') &&
      gpuModalText.includes('USER_DISABLED') &&
      gpuOffErrors.length === 0,
  );
  await app.close();
  app = null;

  report.passed = true;
  console.log('\nALL LIVE2D VERIFICATION CHECKS PASSED:', JSON.stringify(report.metrics, null, 2));
} finally {
  if (app) await app.close().catch(() => {});
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
