import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, screen, session } from 'electron';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeEngine } from './engine.mjs';
import { allowedRequest, CHANNEL, errorInfo, failureView, idle, toUi, UI_URL } from './contract.mjs';
import { CSP, serveAsset, snapshotUi } from './assets.mjs';
import {
  createDesktopShortcut,
  DEFAULT_R2_ZIP,
  extractVerifiedPackage,
  inspectSessionLock,
  pickInstallDir,
  R2_ZIP_HASH,
  readCompanionState,
  reconnectExistingInstall,
  removeDesktopShortcut,
  resolveCompanionHome,
  runRealEnvCheck,
  SetupError,
  testRealAiConnection,
  validateInstallDir,
  verifyRealBangumiAccount,
  writeCompanionState,
} from './setup-service.mjs';
import {
  GPU_MODES,
  markGpuHealthy,
  recordGpuCrash,
  resolveGpuStartupPolicy,
} from './gpu-policy.mjs';
import {
  checkUpdateManifest,
  createBackup,
  exportDiagnosticReport,
  getMaintenanceOverview,
  listBackups,
  performUpdateFromSource,
  restoreBackup,
  runFullIntegrityCheck,
  uninstallCompanion as runUninstallCompanion,
} from './maintenance-service.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PRODUCT_UI_URL = 'companion://ui/index.html?driver=codex&mode=product';
const WINDOW_STATE_FILE = join(here, '.work', 'window-state.json');
let activeWindowStateFile = WINDOW_STATE_FILE;
const WINDOW_CHANNEL = 'companion:v1:window';
const PRODUCT_CHANNEL = 'companion:v1:product';
const PRODUCT_EVENT_CHANNEL = 'companion:v1:product-event';
const MODEL_CHANNEL = 'companion:v1:model';
const MODEL_METHODS = new Set(['getStatus', 'importCubismCore', 'loadPinkSakuraBundle']);
const FPS_MODES = new Set(['auto', '30', '60', '120']);
const WINDOW_ACTIONS = new Set(['getState', 'minimize', 'toggleMaximize', 'toggleFullscreen', 'exitFullscreen', 'close']);
const PRODUCT_METHODS = new Set([
  'getCompanionState',
  'savePreferences',
  'runEnvCheck',
  'validateInstallDir',
  'pickInstallDir',
  'reconnectExistingInstall',
  'verifyBangumiAccount',
  'testAiConnection',
  'installAndExtract',
  'configureAndStartAnalyzer',
  'startAnalyzerSync',
  'getSyncStatus',
  'cancelSync',
  'finishFirstRun',
  'getMaintenanceOverview',
  'listBackups',
  'createBackup',
  'restoreBackup',
  'runIntegrityCheck',
  'pickUpdateZip',
  'checkUpdate',
  'applySafeUpdate',
  'exportDiagnostics',
  'uninstallCompanion',
]);
const MIN_WIDTH = 920;
const MIN_HEIGHT = 600;

let win, engine = null, closing = false, mayQuit = false;
let entryUrl = UI_URL;
let lastNormalBounds = null;
let saveBoundsTimer = null;
let trackBounds = false;

protocol.registerSchemesAsPrivileged([{ scheme: 'companion', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
for (const name of ['disable-background-networking', 'disable-component-update', 'no-default-browser-check']) app.commandLine.appendSwitch(name);
if (process.argv.includes('--allow-unsafe-swiftshader')) {
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

function resolveDefaultProductHome(explicitHome) {
  if (explicitHome) return resolveCompanionHome(explicitHome);
  const rootDir = resolve(here, '..');
  if (existsSync(join(rootDir, '.companion-portable')) && !existsSync(join(rootDir, '.companion-installed'))) {
    return join(rootDir, 'companion-data');
  }
  return resolveCompanionHome(null);
}

function readEarlyCompanionHome() {
  const pkgIdx = process.argv.indexOf('--packageRoot');
  if (pkgIdx >= 0) return null;
  const homeIdx = process.argv.indexOf('--companionHome');
  const raw = homeIdx >= 0 && isAbsolute(process.argv[homeIdx + 1] ?? '') ? process.argv[homeIdx + 1] : null;
  return resolveDefaultProductHome(raw);
}
function readEarlyGpuMode(companionHome) {
  if (!companionHome) return 'auto';
  try {
    const raw = JSON.parse(readFileSync(join(companionHome, 'companion.json'), 'utf8'));
    return typeof raw?.gpuMode === 'string' ? raw.gpuMode : 'auto';
  } catch {
    return 'auto';
  }
}
const earlyCompanionHome = readEarlyCompanionHome();
const gpuPolicy = resolveGpuStartupPolicy({
  companionHome: earlyCompanionHome,
  argv: process.argv,
  stateGpuMode: readEarlyGpuMode(earlyCompanionHome),
});
for (const [k, v] of gpuPolicy.switches) app.commandLine.appendSwitch(k, v);
let sessionGpuCrashes = 0;
let runtimeGpuCrashed = false;
app.on('child-process-gone', (_event, details) => {
  if (details?.type === 'GPU') {
    sessionGpuCrashes += 1;
    // Chromium permanently disables hardware GPU/WebGL after 3 GPU process crashes in a session.
    if (sessionGpuCrashes >= 3) {
      runtimeGpuCrashed = true;
      recordGpuCrash(earlyCompanionHome, gpuPolicy, details);
    }
    if (win && !win.isDestroyed()) {
      emitProductEvent(win.webContents, 'gpu-status', {
        crashed: runtimeGpuCrashed,
        sessionCrashes: sessionGpuCrashes,
        reason: details.reason ?? 'crashed',
      });
    }
  }
});

function resolveBundledR2Zip(explicitPath) {
  if (explicitPath) return explicitPath;
  const bundledR3 = join(here, '../bundle/Bangumi-Analyzer-2.0.0-windows-x64-r3.zip');
  if (existsSync(bundledR3)) return bundledR3;
  const bundledR2 = join(here, '../bundle/Bangumi-Analyzer-2.0.0-windows-x64-r2.zip');
  return existsSync(bundledR2) ? bundledR2 : DEFAULT_R2_ZIP;
}

function argumentsFrom(argv) {
  const pkgIdx = argv.indexOf('--packageRoot');
  if (pkgIdx >= 0) {
    if (!isAbsolute(argv[pkgIdx + 1] ?? '')) throw new Error('INVALID_ARGUMENTS');
    const rest = argv.slice(pkgIdx);
    if (rest.length !== 2 && rest.length !== 4) throw new Error('INVALID_ARGUMENTS');
    if (rest.length === 4 && (rest[2] !== '--port' || !/^\d+$/.test(rest[3]))) throw new Error('INVALID_ARGUMENTS');
    return { mode: 'direct', packageRoot: rest[1], port: rest.length === 4 ? Number(rest[3]) : 0 };
  }
  let companionHome = null;
  let port = 0;
  let r2Zip = null;
  const homeIdx = argv.indexOf('--companionHome');
  if (homeIdx >= 0) {
    if (!isAbsolute(argv[homeIdx + 1] ?? '')) throw new Error('INVALID_ARGUMENTS');
    companionHome = argv[homeIdx + 1];
  }
  const portIdx = argv.indexOf('--port');
  if (portIdx >= 0) {
    if (!/^\d+$/.test(argv[portIdx + 1] ?? '')) throw new Error('INVALID_ARGUMENTS');
    port = Number(argv[portIdx + 1]);
  }
  const zipIdx = argv.indexOf('--r2Zip');
  if (zipIdx >= 0) {
    if (!isAbsolute(argv[zipIdx + 1] ?? '')) throw new Error('INVALID_ARGUMENTS');
    r2Zip = argv[zipIdx + 1];
  }
  return {
    mode: 'product',
    companionHome: resolveDefaultProductHome(companionHome),
    port,
    r2Zip: resolveBundledR2Zip(r2Zip),
  };
}

function isAllowedDoc(event, contents) {
  try {
    return !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === entryUrl;
  } catch {
    return false;
  }
}

function loadWindowBounds() {
  const primary = screen.getPrimaryDisplay().workArea;
  const fallbackW = Math.max(MIN_WIDTH, Math.min(1280, primary.width - 32));
  const fallbackH = Math.max(MIN_HEIGHT, Math.min(820, primary.height - 24));
  const fallback = {
    x: primary.x + Math.max(0, Math.floor((primary.width - fallbackW) / 2)),
    y: primary.y + Math.max(0, Math.floor((primary.height - fallbackH) / 2)),
    width: fallbackW,
    height: fallbackH,
    isMaximized: false,
  };
  try {
    const raw = JSON.parse(readFileSync(activeWindowStateFile, 'utf8'));
    if (!raw || typeof raw !== 'object') return fallback;
    const width = Number.isFinite(raw.width) ? Math.round(raw.width) : fallback.width;
    const height = Number.isFinite(raw.height) ? Math.round(raw.height) : fallback.height;
    const x = Number.isFinite(raw.x) ? Math.round(raw.x) : fallback.x;
    const y = Number.isFinite(raw.y) ? Math.round(raw.y) : fallback.y;
    const matched = screen.getAllDisplays().find(d => {
      const a = d.workArea;
      const overlapW = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
      const overlapH = Math.min(y + height, a.y + a.height) - Math.max(y, a.y);
      return overlapW >= 160 && overlapH >= 100;
    });
    const area = (matched ?? screen.getPrimaryDisplay()).workArea;
    const clampedW = Math.max(Math.min(MIN_WIDTH, area.width - 12), Math.min(width, area.width - 12));
    const clampedH = Math.max(Math.min(MIN_HEIGHT, area.height - 12), Math.min(height, area.height - 12));
    const clampedX = Math.max(area.x, Math.min(x, area.x + area.width - clampedW - 8));
    const clampedY = Math.max(area.y, Math.min(y, area.y + area.height - clampedH - 8));
    return { x: clampedX, y: clampedY, width: clampedW, height: clampedH, isMaximized: Boolean(raw.isMaximized) };
  } catch {
    return fallback;
  }
}

function saveWindowBoundsNow() {
  if (!win || win.isDestroyed()) return;
  try {
    if (trackBounds && !win.isMaximized() && !win.isFullScreen() && !win.isMinimized()) {
      const cur = win.getBounds();
      if (
        !lastNormalBounds ||
        Math.abs(cur.width - lastNormalBounds.width) > 6 ||
        Math.abs(cur.height - lastNormalBounds.height) > 6 ||
        Math.abs(cur.x - lastNormalBounds.x) > 4 ||
        Math.abs(cur.y - lastNormalBounds.y) > 4
      ) {
        lastNormalBounds = cur;
      }
    }
    const base = lastNormalBounds ?? win.getBounds();
    mkdirSync(dirname(activeWindowStateFile), { recursive: true });
    // Never persist isFullScreen=true across cold starts so user is never locked in fullscreen.
    writeFileSync(activeWindowStateFile, JSON.stringify({
      x: base.x,
      y: base.y,
      width: base.width,
      height: base.height,
      isMaximized: win.isMaximized(),
    }, null, 2));
  } catch { /* non-fatal persistence */ }
}

function scheduleSaveBounds() {
  if (!trackBounds) return;
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(saveWindowBoundsNow, 250);
}

function getWindowState() {
  if (!win || win.isDestroyed()) return { isMaximized: false, isFullScreen: false, isMinimized: false };
  return { isMaximized: win.isMaximized(), isFullScreen: win.isFullScreen(), isMinimized: win.isMinimized() };
}

function emitWindowState(wc) {
  if (wc && !wc.isDestroyed() && wc.mainFrame.url === entryUrl) {
    wc.send('companion:v1:window-state', getWindowState());
  }
}

function emitProductEvent(wc, type, payload) {
  if (wc && !wc.isDestroyed() && wc.mainFrame.url === entryUrl) {
    wc.send(PRODUCT_EVENT_CHANNEL, { type, payload });
  }
}

async function closeWindow() {
  if (closing || mayQuit) return;
  closing = true;
  saveWindowBoundsNow();
  let timer;
  const ok = engine
    ? await Promise.race([engine.close(), new Promise(resolve => { timer = setTimeout(() => resolve(false), 65000); })]).finally(() => clearTimeout(timer))
    : true;
  if (ok) {
    if (!runtimeGpuCrashed) markGpuHealthy(earlyCompanionHome, gpuPolicy);
    mayQuit = true;
    win?.destroy();
    app.quit();
    return;
  }
  closing = false;
  if (win && !win.isDestroyed()) await dialog.showMessageBox(win, { type: 'warning', title: '尚未安全退出',
    message: '当前服务尚未确认安全停止，窗口保持打开。', detail: '没有强杀或接管任何进程。请等待收尾，或再次使用窗口关闭按钮重试。', buttons: ['保持窗口'] });
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 8000), ...opts });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Do not top-level-await app.whenReady(): Electron waits for ESM evaluation before completing readiness.
async function main() {
try {
  const options = argumentsFrom(process.argv);
  entryUrl = options.mode === 'product' ? PRODUCT_UI_URL : UI_URL;
  activeWindowStateFile = options.mode === 'product' ? join(options.companionHome, 'window-state.json') : WINDOW_STATE_FILE;
  const workBase = options.mode === 'product' ? join(options.companionHome, 'work') : join(here, '.work');
  mkdirSync(workBase, { recursive: true });
  const work = mkdtempSync(join(workBase, 'session-'));
  mkdirSync(join(work, 'profile')); mkdirSync(join(work, 'crashes'));
  app.setPath('userData', join(work, 'profile'));
  app.setPath('sessionData', join(work, 'profile'));
  app.setPath('crashDumps', join(work, 'crashes'));
  const inventory = await snapshotUi(join(here, '../ui/dist'), join(work, 'ui'));
  await writeFile(join(work, 'ui-inputs.json'), JSON.stringify(inventory, null, 2), { flag: 'wx' });

  let initialState = null;
  if (options.mode === 'direct') {
    engine = new BridgeEngine({ packageRoot: options.packageRoot, port: options.port });
  } else {
    initialState = await readCompanionState(options.companionHome);
    if (initialState.installDir) {
      try {
        await access(join(initialState.installDir, 'service.mjs'));
        engine = new BridgeEngine({ packageRoot: initialState.installDir, port: options.port });
      } catch { /* installDir incomplete or moved; allow re-install */ }
    }
  }

  if (process.platform === 'win32') {
    app.setAppUserModelId('com.bangumianalyzer.companion');
  }
  await app.whenReady();
  const iconFile = existsSync(join(here, 'assets/companion-icon.ico'))
    ? join(here, 'assets/companion-icon.ico')
    : join(here, 'assets/companion-icon-256.png');
  const loadedIcon = existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : null;
  const appIcon = loadedIcon && !loadedIcon.isEmpty() ? loadedIcon : undefined;
  const initial = loadWindowBounds();
  lastNormalBounds = { x: initial.x, y: initial.y, width: initial.width, height: initial.height };
  const ses = session.fromPartition('m1-' + work.split(/[\\/]/).pop());
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
  await ses.protocol.handle('companion', async request => {
    try {
      const parsed = new URL(request.url);
      if (parsed.protocol === 'companion:' && parsed.hostname === 'ui' && parsed.pathname === '/vendor/live2dcubismcore.min.js' && request.method === 'GET') {
        const candidates = [
          options.mode === 'product' ? join(options.companionHome, 'vendor', 'live2dcubismcore.min.js') : null,
          join(here, '../models/vendor/live2dcubismcore.min.js'),
        ].filter(Boolean);
        for (const cand of candidates) {
          if (existsSync(cand)) {
            return new Response(await readFile(cand), {
              headers: {
                'Content-Type': 'text/javascript; charset=utf-8',
                'Content-Security-Policy': CSP,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-store',
                'Cross-Origin-Resource-Policy': 'same-origin',
              },
            });
          }
        }
        return new Response('Cubism Core SDK not supplied', { status: 404 });
      }
    } catch { /* fall through to standard asset check */ }
    return serveAsset(request, join(work, 'ui'));
  });
  win = new BrowserWindow({
    title: options.mode === 'product' ? 'Bangumi Analyzer Companion · 小番' : 'Bangumi Companion M1 · 小番',
    ...(appIcon ? { icon: appIcon } : {}),
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    show: false,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      session: ses,
      navigateOnDragDrop: false,
    },
  });
  win.setMenu(null);
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', event => event.preventDefault());
  wc.on('will-navigate', event => { if (event.url !== entryUrl) event.preventDefault(); });
  wc.on('will-frame-navigate', event => { if (event.url !== entryUrl) event.preventDefault(); });
  wc.on('render-process-gone', () => void closeWindow());
  wc.on('page-title-updated', event => event.preventDefault());

  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'minimize', 'restore', 'hide', 'show']) {
    win.on(ev, () => { scheduleSaveBounds(); emitWindowState(wc); });
  }
  win.on('resize', scheduleSaveBounds);
  win.on('move', scheduleSaveBounds);
  win.on('close', event => { saveWindowBoundsNow(); if (!mayQuit) { event.preventDefault(); void closeWindow(); } });
  app.on('before-quit', event => { saveWindowBoundsNow(); if (!mayQuit) { event.preventDefault(); void closeWindow(); } });

  function bindEngine(nextEngine) {
    if (engine && engine !== nextEngine) {
      engine.removeAllListeners();
    }
    engine = nextEngine;
    if (!engine) return;
    engine.on('status', status => { if (engine === nextEngine && !wc.isDestroyed() && wc.mainFrame.url === entryUrl) wc.send('companion:v1:status', status); });
    engine.on('logs', logs => { if (engine === nextEngine && !wc.isDestroyed() && wc.mainFrame.url === entryUrl) wc.send('companion:v1:logs', logs); });
    if (!wc.isDestroyed() && wc.mainFrame.url === entryUrl) {
      wc.send('companion:v1:status', engine.status());
      wc.send('companion:v1:logs', engine.logs());
    }
  }
  if (engine) bindEngine(engine);

  let pending = 0;
  ipcMain.handle(CHANNEL, async (event, payload) => {
    const curStatus = engine ? engine.status() : toUi(idle(), 0);
    if (!isAllowedDoc(event, wc) || !allowedRequest(payload)) return failureView(curStatus, 'IPC_DENIED');
    const method = payload.method;
    if (!engine) {
      if (method === 'getStatus') return toUi(idle(), 0);
      if (method === 'getLogs') return [];
      if (method === 'openAnalyzer') return { opened: false, url: '', error: errorInfo('NOT_READY') };
      return failureView(toUi(idle(), 0), 'HOST_UNAVAILABLE');
    }
    const blockedCode = closing ? 'HOST_CLOSING' : 'BUSY';
    if (pending >= 8 || closing) return method === 'getLogs' ? engine.logs() : method === 'openAnalyzer'
      ? { opened: false, url: '', error: errorInfo(blockedCode) } : failureView(engine.status(), blockedCode);
    pending++;
    let timer;
    try {
      const task = method === 'getLogs' ? Promise.resolve(engine.logs()) : engine[method]();
      const timeout = method === 'startAnalyzer' ? 90000 : method === 'stopAnalyzer' ? 65000 : method === 'openAnalyzer' ? 12000 : 10000;
      return await Promise.race([task, new Promise(resolve => {
        timer = setTimeout(() => resolve(method === 'openAnalyzer' ? { opened: false, url: '', error: errorInfo('HOST_TIMEOUT') }
          : failureView(engine.status(), 'HOST_TIMEOUT')), timeout);
      })]);
    } catch { return method === 'getLogs' ? engine.logs() : method === 'openAnalyzer' ? { opened: false, url: '', error: errorInfo('HOST_UNAVAILABLE') }
      : failureView(engine.status(), 'HOST_UNAVAILABLE'); }
    finally { clearTimeout(timer); pending--; }
  });

  ipcMain.handle(WINDOW_CHANNEL, (event, payload) => {
    if (!isAllowedDoc(event, wc) || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !WINDOW_ACTIONS.has(payload.action)) {
      return getWindowState();
    }
    switch (payload.action) {
      case 'minimize':
        win.minimize();
        break;
      case 'toggleMaximize':
        if (win.isFullScreen()) win.setFullScreen(false);
        else if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        break;
      case 'toggleFullscreen':
        win.setFullScreen(!win.isFullScreen());
        break;
      case 'exitFullscreen':
        if (win.isFullScreen()) win.setFullScreen(false);
        break;
      case 'close':
        win.close();
        break;
      default:
        break;
    }
    return getWindowState();
  });

  let installInFlight = false;
  ipcMain.handle(PRODUCT_CHANNEL, async (event, payload) => {
    if (!isAllowedDoc(event, wc) || options.mode !== 'product') {
      return { ok: false, error: 'PRODUCT_MODE_DISABLED' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !PRODUCT_METHODS.has(payload.method)) {
      return { ok: false, error: 'IPC_DENIED' };
    }
    const args = payload.args ?? {};
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: 'INVALID_ARGS' };
    }

    try {
      const state = await readCompanionState(options.companionHome);
      switch (payload.method) {
        case 'getCompanionState':
          return {
            ok: true,
            mode: options.mode,
            state,
            r2ZipHash: R2_ZIP_HASH,
            engineBound: Boolean(engine),
          };
        case 'savePreferences': {
          const patch = {};
          if (typeof args.skipIntro === 'boolean') patch.skipIntro = args.skipIntro;
          if (typeof args.autoStart === 'boolean') patch.autoStart = args.autoStart;
          if (typeof args.autoOpen === 'boolean') patch.autoOpen = args.autoOpen;
          if (typeof args.updateFeedUrl === 'string') patch.updateFeedUrl = args.updateFeedUrl.trim();
          if (typeof args.gpuMode === 'string' && GPU_MODES.has(args.gpuMode)) patch.gpuMode = args.gpuMode;
          if (typeof args.live2dFpsMode === 'string' && FPS_MODES.has(args.live2dFpsMode)) patch.live2dFpsMode = args.live2dFpsMode;
          if (typeof args.desktopShortcut === 'boolean') {
            patch.desktopShortcut = args.desktopShortcut;
            if (args.desktopShortcut) {
              createDesktopShortcut({
                electronExe: process.execPath,
                mainScript: join(here, 'main.mjs'),
                companionHome: options.companionHome,
              });
            } else {
              removeDesktopShortcut({ mainScript: join(here, 'main.mjs') });
            }
          }
          const next = await writeCompanionState(options.companionHome, patch);
          return { ok: true, state: next };
        }
        case 'runEnvCheck':
          return await runRealEnvCheck(String(args.id ?? ''), options.companionHome, args.targetDir || state.installDir, options.r2Zip);
        case 'validateInstallDir':
          return await validateInstallDir(args.rawPath, state.installDir);
        case 'pickInstallDir':
          return await pickInstallDir(win);
        case 'reconnectExistingInstall': {
          const res = await reconnectExistingInstall(args.installDir, options.companionHome);
          if (res.ok && res.installDir) {
            bindEngine(new BridgeEngine({ packageRoot: res.installDir, port: options.port }));
          }
          return res;
        }
        case 'verifyBangumiAccount':
          return await verifyRealBangumiAccount({ username: args.username, token: args.token });
        case 'testAiConnection':
          return await testRealAiConnection({ baseUrl: args.baseUrl, model: args.model, key: args.key });
        case 'installAndExtract': {
          if (installInFlight) {
            return {
              ok: false,
              code: 'INSTALL_BUSY',
              error: '正在执行安装与校验，请等待当前步骤完成。',
              hint: '无需重复点击，待当前步骤结束后即可继续。',
            };
          }
          installInFlight = true;
          try {
            const requestedDir = resolve(String(args.installDir ?? ''));
            // 若当前 Companion 自身正持有运行中的 Analyzer（例如从首页重播首次引导），先安全停机释放自身会话锁
            const lock = await inspectSessionLock(requestedDir);
            if (engine && (engine.status().ownsProcess || lock.kind === 'owned_by_self')) {
              const closed = await engine.close();
              if (!closed) {
                return {
                  ok: false,
                  code: 'STOP_TIMEOUT',
                  error: '当前运行中的 Analyzer 服务尚未安全停止，暂不能重新初始化该目录。',
                  hint: '请稍等片刻后重试，或点击「更换安装目录」选择新的空白文件夹。',
                };
              }
              engine.removeAllListeners();
              engine = null;
            }
            const targetDir = await extractVerifiedPackage(args.installDir, options.r2Zip);
            const next = await writeCompanionState(options.companionHome, {
              installDir: targetDir,
              installedAt: state.installedAt ?? new Date().toISOString(),
            });
            bindEngine(new BridgeEngine({ packageRoot: targetDir, port: options.port }));
            return { ok: true, installDir: targetDir, state: next };
          } finally {
            installInFlight = false;
          }
        }
        case 'configureAndStartAnalyzer': {
          if (!state.installDir) {
            return {
              ok: false,
              code: 'NOT_INSTALLED',
              error: '尚未安装本地 Analyzer 目录',
              hint: '请返回第 2 步选择安装位置后重新初始化。',
            };
          }
          if (!engine) bindEngine(new BridgeEngine({ packageRoot: state.installDir, port: options.port }));
          let st = engine.status();
          if (st.state !== 'running' || !st.url) {
            st = await engine.startAnalyzer();
          }
          if (st.state !== 'running' || !st.url) {
            return {
              ok: false,
              code: st.error?.runtimeCode ?? st.error?.code ?? 'SERVICE_FAILED',
              error: st.error?.message ?? 'Analyzer 启动失败',
              hint: st.error?.hint ?? '请确认没有其他实例占用该目录，或返回更换安装目录后重试。',
              status: st,
            };
          }
          const cfgPatch = { onboardingSeen: true };
          if (typeof args.username === 'string' && args.username.trim()) cfgPatch.username = args.username.trim();
          if (typeof args.token === 'string' && args.token.trim()) cfgPatch.token = args.token.trim();
          if (typeof args.nickname === 'string' && args.nickname.trim()) cfgPatch.nickname = args.nickname.trim();
          if (args.ai && typeof args.ai === 'object') {
            cfgPatch.ai = {
              enabled: Boolean(args.ai.enabled),
              ...(args.ai.baseUrl ? { baseUrl: String(args.ai.baseUrl).trim() } : {}),
              ...(args.ai.model ? { model: String(args.ai.model).trim() } : {}),
              ...(args.ai.key ? { apiKey: String(args.ai.key).trim() } : {}),
            };
          }
          const putRes = await fetchJson(`${st.url}api/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfgPatch),
            timeoutMs: 10000,
          });
          if (!putRes.ok) {
            return { ok: false, error: putRes.data?.error ?? `配置写入失败 (HTTP ${putRes.status})` };
          }
          let collections = state.collections ?? 0;
          try {
            const hl = await fetchJson(`${st.url}api/health`, { timeoutMs: 4000 });
            if (hl.ok && hl.data && typeof hl.data.collections === 'number') {
              collections = hl.data.collections;
            }
          } catch { /* non-fatal */ }
          const next = await writeCompanionState(options.companionHome, {
            username: typeof args.username === 'string' ? args.username.trim() : state.username,
            nickname: typeof args.nickname === 'string' ? args.nickname.trim() : state.nickname,
            ...(typeof args.uid === 'number' ? { uid: args.uid } : {}),
            collections: typeof args.collections === 'number' ? Math.max(collections, args.collections) : collections,
            aiConfigured: Boolean(args.ai?.enabled),
            aiModel: args.ai?.enabled ? String(args.ai?.model ?? '') : '',
            ...(typeof args.skipIntro === 'boolean' ? { skipIntro: args.skipIntro } : {}),
            ...(typeof args.autoStart === 'boolean' ? { autoStart: args.autoStart } : {}),
            ...(typeof args.autoOpen === 'boolean' ? { autoOpen: args.autoOpen } : {}),
            ...(typeof args.desktopShortcut === 'boolean' ? { desktopShortcut: args.desktopShortcut } : {}),
          });
          return { ok: true, url: st.url, port: st.port, state: next };
        }
        case 'startAnalyzerSync': {
          if (!engine) return { ok: false, started: false, error: 'Analyzer 未初始化' };
          let st = engine.status();
          if (st.state !== 'running' || !st.url) st = await engine.startAnalyzer();
          if (st.state !== 'running' || !st.url) return { ok: false, started: false, error: st.error?.message ?? 'Analyzer 未就绪' };
          const mode = ['full', 'incremental', 'enrich'].includes(args.mode) ? args.mode : 'full';
          const depth = args.depth === 2 ? 2 : 1;
          const res = await fetchJson(`${st.url}api/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, depth }),
            timeoutMs: 10000,
          });
          if (!res.ok && res.status !== 409) {
            return { ok: false, started: false, error: res.data?.error ?? `触发同步失败 (HTTP ${res.status})` };
          }
          const runObj = res.data?.run ?? null;
          const statusObj = res.data?.status ?? null;
          const runId = runObj?.id ?? statusObj?.progress?.runId ?? null;
          return {
            ok: true,
            started: Boolean(runId),
            runId,
            alreadyRunning: res.status === 409,
            status: statusObj,
          };
        }
        case 'getSyncStatus': {
          const st = engine?.status();
          if (!st || st.state !== 'running' || !st.url) {
            return { ok: false, running: false, progress: null, lastRun: null };
          }
          const res = await fetchJson(`${st.url}api/sync/status`, { timeoutMs: 6000 });
          if (!res.ok) return { ok: false, running: false, progress: null, lastRun: null, error: `HTTP ${res.status}` };
          const body = res.data ?? {};
          const runSummary = body.lastRun ?? body.latestRun ?? null;
          if (!body.running && runSummary?.status === 'success') {
            try {
              const hl = await fetchJson(`${st.url}api/health`, { timeoutMs: 4000 });
              if (hl.ok && hl.data) {
                await writeCompanionState(options.companionHome, {
                  collections: Number(hl.data.collections ?? state.collections ?? 0),
                  lastSyncAt: runSummary.finishedAt ?? new Date().toISOString(),
                });
              }
            } catch { /* non-fatal */ }
          }
          return {
            ok: true,
            running: Boolean(body.running),
            progress: body.progress ?? null,
            lastRun: runSummary,
            lastSuccessfulSyncAt: body.lastSuccessfulSyncAt ?? null,
          };
        }
        case 'cancelSync': {
          const st = engine?.status();
          if (!st || st.state !== 'running' || !st.url) return { ok: false, error: 'Analyzer 未运行' };
          const res = await fetchJson(`${st.url}api/sync/cancel`, { method: 'POST', timeoutMs: 6000 });
          return { ok: res.ok, data: res.data };
        }
        case 'finishFirstRun': {
          const patch = { firstRunCompleted: true };
          if (typeof args.collections === 'number') patch.collections = args.collections;
          if (typeof args.skipIntro === 'boolean') patch.skipIntro = args.skipIntro;
          if (typeof args.autoStart === 'boolean') patch.autoStart = args.autoStart;
          if (typeof args.autoOpen === 'boolean') patch.autoOpen = args.autoOpen;
          if (typeof args.updateFeedUrl === 'string') patch.updateFeedUrl = args.updateFeedUrl.trim();
          if (typeof args.gpuMode === 'string' && GPU_MODES.has(args.gpuMode)) patch.gpuMode = args.gpuMode;
          if (typeof args.live2dFpsMode === 'string' && FPS_MODES.has(args.live2dFpsMode)) patch.live2dFpsMode = args.live2dFpsMode;
          if (typeof args.desktopShortcut === 'boolean') {
            patch.desktopShortcut = args.desktopShortcut;
            if (args.desktopShortcut) {
              createDesktopShortcut({
                electronExe: process.execPath,
                mainScript: join(here, 'main.mjs'),
                companionHome: options.companionHome,
              });
            }
          }
          const next = await writeCompanionState(options.companionHome, patch);
          return { ok: true, state: next };
        }
        case 'getMaintenanceOverview':
          return await getMaintenanceOverview(state.installDir, engine);
        case 'listBackups':
          return { backups: await listBackups(state.installDir, engine) };
        case 'createBackup':
          return await createBackup(state.installDir, engine);
        case 'restoreBackup':
          return await restoreBackup(state.installDir, engine, args.fileName);
        case 'runIntegrityCheck':
          return await runFullIntegrityCheck(state.installDir, engine);
        case 'pickUpdateZip': {
          const picked = await dialog.showOpenDialog(win, {
            title: '选择 Analyzer 更新包 (.zip) 或更新清单 (.json)',
            filters: [{ name: '更新文件', extensions: ['zip', 'json'] }],
            properties: ['openFile'],
          });
          return picked.canceled || !picked.filePaths[0]
            ? { canceled: true, path: null }
            : { canceled: false, path: picked.filePaths[0] };
        }
        case 'checkUpdate': {
          const feed = args.manifestPath !== undefined ? args.manifestPath : (state.updateFeedUrl ?? '');
          if (typeof args.manifestPath === 'string' && /^[a-z]+:\/\//i.test(args.manifestPath.trim())) {
            await writeCompanionState(options.companionHome, { updateFeedUrl: args.manifestPath.trim() });
          }
          return await checkUpdateManifest(state.installDir, feed);
        }
        case 'applySafeUpdate': {
          const result = await performUpdateFromSource({
            installDir: state.installDir,
            engine,
            packageUrl: args.packageUrl,
            zipPath: args.zipPath,
            expectedSha256: args.expectedSha256,
            onStage: (stage, message) => emitProductEvent(wc, 'update-stage', { stage, message }),
            beforeSwap: async () => {
              if (engine) {
                const closed = await engine.close();
                if (!closed) throw new Error('ENGINE_STOP_FAILED_BEFORE_SWAP');
                engine.removeAllListeners();
                engine = null;
              }
            },
            afterSwap: async () => {
              const nextEngine = new BridgeEngine({ packageRoot: state.installDir, port: options.port });
              bindEngine(nextEngine);
              return nextEngine.startAnalyzer();
            },
          });
          if (!result.ok && result.rolledBack) {
            emitProductEvent(wc, 'update-stage', { stage: 'rolledback', message: `更新未通过校验（${result.reason ?? 'UNKNOWN'}），已自动回滚。` });
          } else if (!result.ok && result.downloadFailed) {
            emitProductEvent(wc, 'update-stage', { stage: 'download-failed', message: `下载或摘要核验失败（${result.reason ?? 'UNKNOWN'}），未改动已安装程序。` });
          } else if (result.ok) {
            emitProductEvent(wc, 'update-stage', { stage: 'done', message: '安全更新已验证完成，用户数据已完整保留。' });
          }
          return result;
        }
        case 'exportDiagnostics':
          return await exportDiagnosticReport(win, {
            companionHome: options.companionHome,
            installDir: state.installDir,
            engine,
          });
        case 'uninstallCompanion': {
          // Stop Analyzer AND terminate runtime/node.exe client BEFORE deleting installDir program files.
          if (engine) {
            const closed = await engine.close();
            if (!closed) {
              return { ok: false, error: '当前 Analyzer 服务尚未完全停止，未执行删除。请先安全停止后再试。' };
            }
            engine.removeAllListeners();
            engine = null;
          }
          const res = await runUninstallCompanion({
            companionHome: options.companionHome,
            installDir: state.installDir,
            engine: null,
            removeProgramFiles: Boolean(args.removeProgramFiles),
            removeUserData: Boolean(args.removeUserData),
          });
          if (!wc.isDestroyed() && wc.mainFrame.url === entryUrl) {
            wc.send('companion:v1:status', toUi(idle(), 0));
            wc.send('companion:v1:logs', []);
          }
          return res;
        }
        default:
          return { ok: false, error: 'UNKNOWN_METHOD' };
      }
    } catch (err) {
      if (err instanceof SetupError) {
        return { ok: false, code: err.code, error: err.message, hint: err.hint };
      }
      return {
        ok: false,
        ...(err && typeof err === 'object' && typeof err.code === 'string' ? { code: err.code } : {}),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(MODEL_CHANNEL, async (event, payload) => {
    if (!isAllowedDoc(event, wc) || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !MODEL_METHODS.has(payload.method)) {
      return { ok: false, error: 'IPC_DENIED' };
    }
    const modelDir = resolve(here, '../models/pink-sakura');
    const vendorCandidates = [
      options.mode === 'product' ? join(options.companionHome, 'vendor', 'live2dcubismcore.min.js') : null,
      join(here, '../models/vendor/live2dcubismcore.min.js'),
    ].filter(Boolean);
    const hasCore = vendorCandidates.some(p => existsSync(p));
    try {
      switch (payload.method) {
        case 'getStatus':
          return {
            ok: true,
            modelAssetsReady: existsSync(join(modelDir, 'PinkSakura.model3.json')) && existsSync(join(modelDir, 'PinkSakura.moc3')),
            hasCubismCore: hasCore,
            gpuStatus: {
              policyMode: gpuPolicy.policyMode,
              activeBackend: runtimeGpuCrashed ? 'crashed' : gpuPolicy.activeBackend,
              webglAllowed: gpuPolicy.webglAllowed && !runtimeGpuCrashed,
              hybridMultiGpu: gpuPolicy.hybridMultiGpu,
              adapterCount: gpuPolicy.adapterCount,
              crashCount: gpuPolicy.crashCount + sessionGpuCrashes,
              displayRefreshHz: Number(screen.getPrimaryDisplay()?.displayFrequency) || 60,
              reason: runtimeGpuCrashed ? 'GPU_PROCESS_CRASHED' : gpuPolicy.reason,
            },
          };
        case 'importCubismCore': {
          const picked = await dialog.showOpenDialog(win, {
            title: '选择官方 Live2D Cubism Core for Web (live2dcubismcore.min.js)',
            filters: [{ name: 'Live2D Cubism Core', extensions: ['js'] }],
            properties: ['openFile'],
          });
          if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
          const srcFile = picked.filePaths[0];
          const text = await readFile(srcFile, 'utf8');
          if (!text.includes('Live2DCubismCore')) {
            return { ok: false, error: '所选文件不包含 Live2DCubismCore 导出符号，请从 Live2D 官方 Cubism SDK for Web 获取。' };
          }
          const destDir = options.mode === 'product'
            ? join(options.companionHome, 'vendor')
            : join(here, '../models/vendor');
          await mkdir(destDir, { recursive: true });
          await copyFile(srcFile, join(destDir, 'live2dcubismcore.min.js'));
          return { ok: true, hasCubismCore: true };
        }
        case 'loadPinkSakuraBundle': {
          const readSafe = async (rel) => {
            const target = resolve(modelDir, rel);
            if (!target.startsWith(modelDir + sep)) throw new Error('UNSAFE_MODEL_PATH');
            return readFile(target);
          };
          const model3 = JSON.parse((await readSafe('PinkSakura.model3.json')).toString('utf8'));
          const refs = model3.FileReferences ?? {};
          const mocBase64 = (await readSafe(refs.Moc)).toString('base64');
          const physics = refs.Physics ? JSON.parse((await readSafe(refs.Physics)).toString('utf8')) : null;
          const display = refs.DisplayInfo ? JSON.parse((await readSafe(refs.DisplayInfo)).toString('utf8')) : null;
          const textures = [];
          for (const texRel of (refs.Textures ?? [])) {
            const buf = await readSafe(texRel);
            textures.push(`data:image/png;base64,${buf.toString('base64')}`);
          }
          const motions = {};
          for (const [group, items] of Object.entries(refs.Motions ?? {})) {
            motions[group] = [];
            for (const item of items) {
              motions[group].push(JSON.parse((await readSafe(item.File)).toString('utf8')));
            }
          }
          const expressions = {};
          for (const exp of (refs.Expressions ?? [])) {
            expressions[exp.Name] = JSON.parse((await readSafe(exp.File)).toString('utf8'));
          }
          let armRigAtlas = null;
          let armRigMeta = null;
          if (existsSync(join(modelDir, 'arm-rig-atlas.png')) && existsSync(join(modelDir, 'arm-rig-meta.json'))) {
            const atlasBuf = await readSafe('arm-rig-atlas.png');
            armRigAtlas = `data:image/png;base64,${atlasBuf.toString('base64')}`;
            armRigMeta = JSON.parse((await readSafe('arm-rig-meta.json')).toString('utf8'));
          }
          return { ok: true, model3, mocBase64, physics, display, textures, motions, expressions, armRigAtlas, armRigMeta };
        }
        default:
          return { ok: false, error: 'UNKNOWN_METHOD' };
      }
    } catch (err) {
      if (err instanceof SetupError) {
        return { ok: false, code: err.code, error: err.message, hint: err.hint };
      }
      return {
        ok: false,
        ...(err && typeof err === 'object' && typeof err.code === 'string' ? { code: err.code } : {}),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  await win.loadURL(entryUrl);
  if (initial.isMaximized) win.maximize();
  win.show();
  win.focus();
  setTimeout(() => { trackBounds = true; }, 350);
  emitWindowState(wc);
  if (win.isVisible()) process.stdout.write('COMPANION_WINDOW_VISIBLE\n');
} catch {
  process.stderr.write('COMPANION_HOST_FAILED\n');
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.bangumianalyzer.companion');
  }
  await app.whenReady();
  const iconFile = existsSync(join(here, 'assets/companion-icon.ico'))
    ? join(here, 'assets/companion-icon.ico')
    : join(here, 'assets/companion-icon-256.png');
  const loadedIcon = existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : null;
  const appIcon = loadedIcon && !loadedIcon.isEmpty() ? loadedIcon : undefined;
  await dialog.showMessageBox({ type: 'error', title: 'Companion M1', message: '宿主未能初始化。',
    detail: '请使用启动脚本与独立 r2 副本。未输出底层路径或敏感异常。', buttons: ['关闭'] });
  if (!engine || await engine.close()) { mayQuit = true; app.quit(); }
}
}
void main();
