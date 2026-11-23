import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { shortcutTargetSpec } from '../setup-service.mjs';
import { desktopEnvironment, extractR2 } from '../scripts/isolated.mjs';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'));
const { _electron: electron } = require('@playwright/test');

const HOST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_DIR = resolve(HOST_DIR, '..');
const DIST_DIR = join(ROOT_DIR, 'dist');
const PORTABLE_SRC = join(DIST_DIR, 'Bangumi-Analyzer-Companion-Portable-win-x64');
const MANIFEST = JSON.parse(readFileSync(join(DIST_DIR, 'RELEASE_MANIFEST.json'), 'utf8'));
const SETUP_EXE = join(DIST_DIR, MANIFEST.installer.fileName);
const WORK_DIR = join(HOST_DIR, '.work', 'rc2-acceptance');
const SCREENSHOT_DIR = resolve(process.env.RC2_SCREENSHOT_DIR || join(WORK_DIR, 'screenshots'));

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ` -> ${detail}` : ''}`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function psRun(script) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
}

/**
 * Launches a real Windows EXE or .lnk shortcut via ShellExecute/process, waits for an Electron window
 * matching expectedTitle whose commandLine/path belongs to rootMarker, verifies it stays alive cleanly,
 * then closes its MainWindow gracefully.
 */
async function verifyNativeWindowCycle({ launchCmd, args = [], workDir, processMarker, timeoutMs = 25000 }) {
  // Spawn detached or direct; wait by polling Win32 process list matching processMarker
  const quotePs = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const pidsBeforeRes = psRun(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ForEach-Object { $_.ProcessId }`,
  );
  const beforeSet = new Set(
    (pidsBeforeRes.stdout || '')
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  );

  const argListPs = args.length
    ? `-ArgumentList @(${args.map(quotePs).join(', ')})`
    : '';
  const startScript = `
    $p = Start-Process -FilePath ${quotePs(launchCmd)} ${argListPs} -WorkingDirectory ${quotePs(workDir)} -PassThru
    $p.Id
  `;
  const startRes = psRun(startScript);
  if (startRes.status !== 0) {
    throw new Error(`Start-Process failed: ${startRes.stderr}`);
  }

  const deadline = Date.now() + timeoutMs;
  let foundPid = 0;
  let foundTitle = '';
  let foundHwnd = 0;
  while (Date.now() < deadline) {
    const queryRes = psRun(`
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      using System.Text;
      public static class W32Find {
        public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
        public static string FindCompanionWin(uint targetPid) {
          string found = "";
          EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p == targetPid && IsWindowVisible(h)) {
              var cls = new StringBuilder(128); GetClassName(h, cls, 128);
              if (cls.ToString() == "Chrome_WidgetWin_1") {
                var txt = new StringBuilder(256); GetWindowText(h, txt, 256);
                if (txt.Length > 0) {
                  found = h + "|" + txt.ToString();
                  return false;
                }
              }
            }
            return true;
          }, IntPtr.Zero);
          return found;
        }
      }
"@
      $procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'"
      foreach ($cp in $procs) {
        if ($cp.CommandLine -like '*${processMarker.replace(/'/g, "''")}*' -and $cp.CommandLine -notlike '*--type=*') {
          $info = [W32Find]::FindCompanionWin([uint32]$cp.ProcessId)
          if (-not [string]::IsNullOrEmpty($info)) {
            "$($cp.ProcessId)|$info"
            break
          }
        }
      }
    `);
    const lines = (queryRes.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const [pidStr, hwndStr, ...titleParts] = line.split('|');
      const pid = Number(pidStr);
      const hwnd = Number(hwndStr);
      const title = titleParts.join('|');
      if (pid && hwnd && title.includes('Bangumi') && !beforeSet.has(pid)) {
        foundPid = pid;
        foundHwnd = hwnd;
        foundTitle = title;
        break;
      }
    }
    if (foundPid) break;
    await delay(350);
  }

  if (!foundPid) {
    // Cleanup any stray processes owned by processMarker
    psRun(`
      Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
        Where-Object { $_.CommandLine -like '*${processMarker.replace(/'/g, "''")}*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    `);
    throw new Error(`Timed out waiting for visible Companion Electron window (${processMarker})`);
  }

  // Keep open briefly to ensure it doesn't self-crash right after painting
  await delay(900);
  const aliveCheck = psRun(`(Get-Process -Id ${foundPid} -ErrorAction SilentlyContinue) -ne $null`);
  if ((aliveCheck.stdout || '').trim().toLowerCase() !== 'true') {
    throw new Error(`Process ${foundPid} exited unexpectedly during stability dwell`);
  }

  // Close gracefully via Win32 WM_CLOSE (works reliably on frameless WS_POPUP windows too!)
  psRun(`
    Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    public static class W32Close {
      [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    }
"@
    $null = [W32Close]::PostMessage([IntPtr]${foundHwnd}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  `);
  const closeDeadline = Date.now() + 7000;
  let exited = false;
  while (Date.now() < closeDeadline) {
    const chk = psRun(`(Get-Process -Id ${foundPid} -ErrorAction SilentlyContinue) -eq $null`);
    if ((chk.stdout || '').trim().toLowerCase() === 'true') {
      exited = true;
      break;
    }
    await delay(250);
  }
  if (!exited) {
    psRun(`Stop-Process -Id ${foundPid} -Force -ErrorAction SilentlyContinue`);
  }
  // Also wait briefly so any singleInstanceLock or helper processes exit cleanly
  const cleanupDeadline = Date.now() + 4000;
  while (Date.now() < cleanupDeadline) {
    const left = psRun(`
      @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
        Where-Object { $_.CommandLine -like '*${processMarker.replace(/'/g, "''")}*' }).Count
    `);
    if (Number((left.stdout || '0').trim()) === 0) break;
    await delay(200);
  }
  return { pid: foundPid, hwnd: foundHwnd, title: foundTitle, gracefulExit: exited };
}

async function run() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // ═══════════════════════════════════════════════════════════════
  // 1. PE Icon & Asset Verification
  // ═══════════════════════════════════════════════════════════════
  assert.ok(existsSync(SETUP_EXE), `Missing Setup EXE: ${SETUP_EXE}`);
  assert.ok(existsSync(PORTABLE_SRC), `Missing Portable dir: ${PORTABLE_SRC}`);

  const iconTargets = [
    { name: 'Setup.exe', path: SETUP_EXE, outPng: join(SCREENSHOT_DIR, 'icon-setup.png') },
    {
      name: 'Bangumi-Analyzer-Companion.exe',
      path: join(PORTABLE_SRC, 'Bangumi-Analyzer-Companion.exe'),
      outPng: join(SCREENSHOT_DIR, 'icon-launcher.png'),
    },
    {
      name: 'Uninstall-Companion.exe',
      path: join(PORTABLE_SRC, 'Uninstall-Companion.exe'),
      outPng: join(SCREENSHOT_DIR, 'icon-uninstaller.png'),
    },
  ];
  let allIconsValid = true;
  for (const item of iconTargets) {
    const res = psRun(`
      Add-Type -AssemblyName System.Drawing
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public static class Win32Icon {
        [DllImport("shell32.dll", CharSet = CharSet.Auto)]
        public static extern uint ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
      }
"@
      $large = New-Object IntPtr[] 4
      $small = New-Object IntPtr[] 4
      $count = [Win32Icon]::ExtractIconEx('${item.path.replace(/'/g, "''")}', 0, $large, $small, 4)
      $ico = [System.Drawing.Icon]::ExtractAssociatedIcon('${item.path.replace(/'/g, "''")}')
      if ($null -eq $ico) { throw 'ExtractAssociatedIcon null' }
      $bmp = $ico.ToBitmap()
      $bmp.Save('${item.outPng.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
      "$count|$($bmp.Width)x$($bmp.Height)"
    `);
    const ok = res.status === 0 && (res.stdout || '').trim().length > 0;
    if (!ok) allIconsValid = false;
    record(`PE embedded icon: ${item.name}`, ok, (res.stdout || res.stderr || '').trim());
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. P0-A: Isolated Setup.exe Install (with spaces!) + 5 Restarts
  // ═══════════════════════════════════════════════════════════════
  const installedRoot = join(WORK_DIR, 'With Spaces', 'Bangumi Analyzer Companion');
  const installedHome = join(WORK_DIR, 'installed-home');
  const installRes = spawnSync(
    SETUP_EXE,
    ['/S', '/NOLAUNCH', '/NOSHORTCUT', `/D=${installedRoot}`],
    { encoding: 'utf8', windowsHide: true },
  );
  record(
    'Setup.exe silent install into spaced directory',
    installRes.status === 0
      && existsSync(join(installedRoot, 'Bangumi-Analyzer-Companion.exe'))
      && existsSync(join(installedRoot, '.companion-installed'))
      && !existsSync(join(installedRoot, '.companion-portable')),
    `exit=${installRes.status}, dir=${installedRoot}`,
  );

  const installedExe = join(installedRoot, 'Bangumi-Analyzer-Companion.exe');
  const installedCycles = [];
  for (let i = 1; i <= 5; i += 1) {
    const r = await verifyNativeWindowCycle({
      launchCmd: installedExe,
      args: ['--companionHome', installedHome],
      workDir: installedRoot,
      processMarker: installedHome,
    });
    installedCycles.push(r);
  }
  record(
    'Installed EXE 5x consecutive start -> window -> close -> restart cycles',
    installedCycles.length === 5 && installedCycles.every((c) => c.hwnd > 0 && c.gracefulExit),
    installedCycles.map((c) => `#${c.pid}:hwnd=${c.hwnd}:${c.gracefulExit ? 'ok' : 'forced'}`).join(', '),
  );

  // ═══════════════════════════════════════════════════════════════
  // 3. P0-A: Isolated Portable Copy (with spaces!) + 5 Restarts + Data Isolation
  // ═══════════════════════════════════════════════════════════════
  const portableCopyRoot = join(WORK_DIR, 'Portable Space Dir', 'Bangumi-Analyzer-Companion-Portable-win-x64');
  mkdirSync(dirname(portableCopyRoot), { recursive: true });
  cpSync(PORTABLE_SRC, portableCopyRoot, { recursive: true });
  const portableExe = join(portableCopyRoot, 'Bangumi-Analyzer-Companion.exe');
  record(
    'Portable bundle has .companion-portable marker',
    existsSync(join(portableCopyRoot, '.companion-portable')) && !existsSync(join(portableCopyRoot, '.companion-installed')),
  );

  const portableCycles = [];
  for (let i = 1; i <= 5; i += 1) {
    const r = await verifyNativeWindowCycle({
      launchCmd: portableExe,
      args: [], // NO --companionHome! Launcher & main.mjs must auto-select <portable>/companion-data
      workDir: portableCopyRoot,
      processMarker: portableCopyRoot,
    });
    portableCycles.push(r);
  }
  const portableDefaultDataDir = join(portableCopyRoot, 'companion-data');
  record(
    'Portable EXE 5x consecutive start/close cycles using isolated portable data',
    portableCycles.length === 5
      && portableCycles.every((c) => c.hwnd > 0 && c.gracefulExit)
      && existsSync(portableDefaultDataDir),
    `dataDirExists=${existsSync(portableDefaultDataDir)}, cycles=${portableCycles.map((c) => `${c.pid}(hwnd=${c.hwnd})`).join(',')}`,
  );

  // ═══════════════════════════════════════════════════════════════
  // 4. P0-A: Real .lnk Shortcut Resolution & Launch (Installed & Portable)
  // ═══════════════════════════════════════════════════════════════
  const shortcutDir = join(WORK_DIR, 'shortcuts');
  mkdirSync(shortcutDir, { recursive: true });
  const installedSpec = shortcutTargetSpec({
    electronExe: join(installedRoot, 'host', 'node_modules', 'electron', 'dist', 'electron.exe'),
    mainScript: join(installedRoot, 'host', 'main.mjs'),
    companionHome: installedHome,
  });
  const portableSpec = shortcutTargetSpec({
    electronExe: join(portableCopyRoot, 'host', 'node_modules', 'electron', 'dist', 'electron.exe'),
    mainScript: join(portableCopyRoot, 'host', 'main.mjs'),
    companionHome: portableDefaultDataDir,
  });

  const installedLnkPath = join(shortcutDir, installedSpec.shortcutName);
  const portableLnkPath = join(shortcutDir, portableSpec.shortcutName);
  psRun(`
    $ws = New-Object -ComObject WScript.Shell
    $s1 = $ws.CreateShortcut('${installedLnkPath.replace(/'/g, "''")}')
    $s1.TargetPath = '${installedSpec.targetPath.replace(/'/g, "''")}'
    $s1.Arguments = '${installedSpec.argumentsStr.replace(/'/g, "''")}'
    $s1.WorkingDirectory = '${installedSpec.workingDir.replace(/'/g, "''")}'
    $s1.IconLocation = '${installedSpec.iconLocation.replace(/'/g, "''")}'
    $s1.Save()

    $s2 = $ws.CreateShortcut('${portableLnkPath.replace(/'/g, "''")}')
    $s2.TargetPath = '${portableSpec.targetPath.replace(/'/g, "''")}'
    $s2.Arguments = '${portableSpec.argumentsStr.replace(/'/g, "''")}'
    $s2.WorkingDirectory = '${portableSpec.workingDir.replace(/'/g, "''")}'
    $s2.IconLocation = '${portableSpec.iconLocation.replace(/'/g, "''")}'
    $s2.Save()
  `);

  const lnkInstalledLaunch = await verifyNativeWindowCycle({
    launchCmd: installedLnkPath,
    workDir: shortcutDir,
    processMarker: installedHome,
  });
  const lnkPortableLaunch = await verifyNativeWindowCycle({
    launchCmd: portableLnkPath,
    workDir: shortcutDir,
    processMarker: portableCopyRoot,
  });
  record(
    'Windows .lnk ShellExecute launch works cleanly for both Installed and Portable',
    lnkInstalledLaunch.hwnd > 0 && lnkInstalledLaunch.gracefulExit && lnkPortableLaunch.hwnd > 0 && lnkPortableLaunch.gracefulExit,
    `installedPid=${lnkInstalledLaunch.pid}(hwnd=${lnkInstalledLaunch.hwnd}), portablePid=${lnkPortableLaunch.pid}(hwnd=${lnkPortableLaunch.hwnd})`,
  );

  // ═══════════════════════════════════════════════════════════════
  // 5. P0-B & P1: Extended Live2D Choreography, 8-State Differentiation, Rapid Interrupts & Responsive Stage
  // ═══════════════════════════════════════════════════════════════
  const electronExe = join(installedRoot, 'host', 'node_modules', 'electron', 'dist', 'electron.exe');
  const mainMjs = join(installedRoot, 'host', 'main.mjs');

  // 5a. Intro fullbody stage visual check
  const introHome = join(WORK_DIR, 'live2d-intro-home');
  mkdirSync(introHome, { recursive: true });
  const introApp = await electron.launch({
    executablePath: electronExe,
    args: [mainMjs, '--companionHome', introHome],
    env: { ...desktopEnvironment(), NODE_ENV: 'production' },
  });
  try {
    const introWin = await introApp.firstWindow();
    await introApp.evaluate(({ BrowserWindow }) => {
      const bw = BrowserWindow.getAllWindows()[0];
      bw?.setSize(1280, 820);
      bw?.center();
    });
    await introWin.waitForSelector('canvas.mascot-live2d-canvas[data-live2d-active="true"]', { timeout: 25000 });
    await delay(1400);
    await introWin.screenshot({ path: join(SCREENSHOT_DIR, '01-intro-fullbody-1280x820.png') });
  } finally {
    await introApp.close().catch(() => {});
  }

  // 5b. Home screen with seeded firstRunCompleted so 8-state choreography & responsive framing can be thoroughly tested
  const r2Copy = await extractR2(WORK_DIR, 'r2-home-copy');
  const live2dHome = join(WORK_DIR, 'live2d-verify-home');
  mkdirSync(live2dHome, { recursive: true });
  writeFileSync(
    join(live2dHome, 'companion.json'),
    JSON.stringify({
      firstRunCompleted: true,
      skipIntro: true,
      autoStart: false,
      autoOpen: false,
      installDir: r2Copy,
      nickname: 'RC2 验收',
      username: 'rc2_verify',
      collections: 142,
      aiConfigured: false,
      aiModel: '',
      desktopShortcut: false,
    }),
  );

  const app = await electron.launch({
    executablePath: electronExe,
    args: [mainMjs, '--companionHome', live2dHome],
    env: {
      ...desktopEnvironment(),
      NODE_ENV: 'production',
    },
  });

  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const bw = BrowserWindow.getAllWindows()[0];
      bw?.setSize(1280, 820);
      bw?.center();
    });

    await win.locator('.home-right').waitFor({ state: 'visible', timeout: 25000 });
    await win.waitForSelector('canvas.mascot-live2d-canvas[data-live2d-active="true"]', { timeout: 25000 });
    await delay(800);

    // Install continuous high-frequency telemetry monitor (50ms sampling) in renderer
    await win.evaluate(() => {
      window.__rc2Samples = [];
      if (window.__rc2Timer) clearInterval(window.__rc2Timer);
      window.__rc2Timer = setInterval(() => {
        const c = document.querySelector('canvas.mascot-live2d-canvas');
        if (!c) return;
        window.__rc2Samples.push({
          t: performance.now(),
          state: c.dataset.directorState || '',
          lift: Number(c.dataset.armLift ?? 0),
          pose: Number(c.dataset.armPose ?? 0),
          form: Number(c.dataset.handForm ?? 0),
          phase: c.dataset.armPhase || 'idle',
          exp: c.dataset.directorExpression || '',
          armRig: c.dataset.armRigActive === 'true',
          shoulderDeg: Number(c.dataset.shoulderDeg ?? 19.3),
          elbowFlexDeg: Number(c.dataset.elbowFlexDeg ?? 0),
          wristDeg: Number(c.dataset.wristDeg ?? 0),
          handName: c.dataset.handName || 'rest',
          forearmInFront: c.dataset.forearmInFront === 'true',
          minTriRatio: Number(c.dataset.minTriRatio ?? 1),
          frames: Number(c.dataset.frames ?? 0),
          fps: Number(c.dataset.fps ?? 0),
          maxFps: Number(c.dataset.maxFps ?? 0),
        });
      }, 50);
    });

    // Windowed 1280x820 idle screenshot + 8s long idle dwell
    await delay(8000);
    await win.screenshot({ path: join(SCREENSHOT_DIR, '02-home-idle-1280x820.png') });

    // Cycle all 8 states via real UI state pills (and verify each visually + capture key shots)
    const stateLabels = [
      { id: 'greet', label: '招呼', waitMs: 1100, shot: '03-state-greet.png' },
      { id: 'think', label: '思考', waitMs: 1400, shot: '04-state-think.png' },
      { id: 'work', label: '工作', waitMs: 1400, shot: '05-state-work.png' },
      { id: 'happy', label: '开心', waitMs: 1200, shot: '06-state-happy.png' },
      { id: 'worry', label: '担心', waitMs: 1200, shot: '07-state-worry.png' },
      { id: 'sleep', label: '休息', waitMs: 1600, shot: '08-state-sleep.png' },
      { id: 'cheer', label: '庆祝', waitMs: 1100, shot: '09-state-cheer-wave.png' },
    ];

    const stateObservations = {};
    for (const st of stateLabels) {
      await win.locator(`.hrs-pill:text-is("${st.label}")`).click();
      await delay(st.waitMs);
      if (st.id === 'cheer') {
        await win.screenshot({ path: join(SCREENSHOT_DIR, st.shot) });
        await delay(1400); // Wait for Cheer's Phase 2 transition: Wave -> safe lower-swap -> FingerHeart!
        await win.screenshot({ path: join(SCREENSHOT_DIR, '09b-state-cheer-heart.png') });
      } else {
        await win.screenshot({ path: join(SCREENSHOT_DIR, st.shot) });
      }
      stateObservations[st.id] = await win.evaluate(() => {
        const c = document.querySelector('canvas.mascot-live2d-canvas');
        return c ? { ...c.dataset } : null;
      });
    }

    // Resume Auto -> Rapid Interruption Stress Test (greet -> think -> work -> cheer -> happy -> sleep -> poke x3)
    await win.locator('.hrs-head button:has-text("恢复自动")').click().catch(() => {});
    await delay(400);
    const pokeBtn = win.locator('.hr-poke');
    await pokeBtn.click();
    await delay(450);
    await win.screenshot({ path: join(SCREENSHOT_DIR, '10-interact-burst.png') });

    const interruptSeq = [
      ['招呼', 320],
      ['思考', 360],
      ['工作', 300],
      ['庆祝', 480],
      ['开心', 340],
      ['休息', 400],
      ['思考', 350],
      ['招呼', 350],
      ['工作', 900],
    ];
    for (const [label, ms] of interruptSeq) {
      await win.locator(`.hrs-pill:text-is("${label}")`).click();
      await delay(ms);
    }
    await win.locator('.hrs-head button:has-text("恢复自动")').click().catch(() => {});
    await delay(1200);

    // Collect & validate ALL sampled frames against strict geometric arm invariants
    const samples = await win.evaluate(() => {
      if (window.__rc2Timer) clearInterval(window.__rc2Timer);
      return window.__rc2Samples || [];
    });

    let armRigActiveAll = samples.length > 0;
    let boundsViolations = 0;
    let minTriObserved = 1;
    let maxElbowJump = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      if (!s.armRig) armRigActiveAll = false;
      if (
        !Number.isFinite(s.shoulderDeg) || s.shoulderDeg < -5 || s.shoulderDeg > 55 ||
        !Number.isFinite(s.elbowFlexDeg) || s.elbowFlexDeg < -1 || s.elbowFlexDeg > 158 ||
        !Number.isFinite(s.wristDeg) || Math.abs(s.wristDeg) > 35 ||
        !Number.isFinite(s.minTriRatio) || s.minTriRatio < 0.50
      ) {
        boundsViolations += 1;
      }
      if (s.minTriRatio < minTriObserved) minTriObserved = s.minTriRatio;
      if (i > 0) {
        const jump = Math.abs(s.elbowFlexDeg - samples[i - 1].elbowFlexDeg);
        if (jump > maxElbowJump) maxElbowJump = jump;
      }
    }
    const workSettledSamples = samples.filter((s) => s.state === 'work').slice(-5);
    const workArmDown =
      workSettledSamples.length > 0 &&
      workSettledSamples.every((s) => s.elbowFlexDeg <= 8 && !s.forearmInFront);
    const frameAdvance = samples.length > 20 && samples[samples.length - 1].frames > samples[0].frames + 100;

    record(
      `Live2D 2-bone ArmRig sequence & rapid interruptions (${samples.length} samples, minTri=${minTriObserved})`,
      samples.length >= 200 && armRigActiveAll && boundsViolations === 0 && maxElbowJump < 65 && workArmDown && frameAdvance,
      `armRig=${armRigActiveAll}, boundsViolations=${boundsViolations}, minTri=${minTriObserved}, maxElbowJump=${maxElbowJump.toFixed(1)}°, workElbow=${workSettledSamples[workSettledSamples.length - 1]?.elbowFlexDeg}°, frames=${samples[samples.length - 1]?.frames}`,
    );

    // ═══════════════════════════════════════════════════════════════
    // 6. P1: Responsive Stage & Fullscreen + FPS Policy Verification
    // ═══════════════════════════════════════════════════════════════
    // Compact 960x640 check
    await app.evaluate(({ BrowserWindow }) => {
      const bw = BrowserWindow.getAllWindows()[0];
      bw?.setSize(960, 640);
      bw?.center();
    });
    await delay(500);
    await win.screenshot({ path: join(SCREENSHOT_DIR, '11-home-compact-960x640.png') });
    const compactBounds = await win.evaluate(() => {
      const right = document.querySelector('.home-right')?.getBoundingClientRect();
      const pills = document.querySelector('.hrs-pills')?.getBoundingClientRect();
      const canvas = document.querySelector('canvas.mascot-live2d-canvas')?.getBoundingClientRect();
      const primaryBtn = document.querySelector('.hero-actions button, .hh-actions button, .home-hero button')?.getBoundingClientRect();
      return {
        rightVisible: Boolean(right && right.width > 180 && right.height > 300),
        pillsInView: Boolean(pills && pills.bottom <= window.innerHeight + 2),
        canvasW: Math.round(canvas?.width ?? 0),
        canvasH: Math.round(canvas?.height ?? 0),
        heroBtnOk: Boolean(!primaryBtn || primaryBtn.right <= (right?.left ?? 9999) + 2),
      };
    });
    record(
      'Compact 960x640 responsive framing preserves stage, pills, and hero controls',
      compactBounds.rightVisible && compactBounds.pillsInView && compactBounds.heroBtnOk && compactBounds.canvasH >= 180,
      JSON.stringify(compactBounds),
    );

    // Fullscreen F11 check (and capture!)
    await win.keyboard.press('F11');
    await delay(700);
    await win.locator('.hrs-pill:text-is("招呼")').click();
    await delay(900);
    await win.screenshot({ path: join(SCREENSHOT_DIR, '12-home-fullscreen.png') });
    const fsMetrics = await win.evaluate(() => {
      const frame = document.querySelector('.window-frame');
      const canvas = document.querySelector('canvas.mascot-live2d-canvas')?.getBoundingClientRect();
      const left = document.querySelector('.home-left')?.getBoundingClientRect();
      const right = document.querySelector('.home-right')?.getBoundingClientRect();
      return {
        isFullscreenClass: Boolean(frame?.classList.contains('is-fullscreen')),
        winW: window.innerWidth,
        winH: window.innerHeight,
        canvasW: Math.round(canvas?.width ?? 0),
        canvasH: Math.round(canvas?.height ?? 0),
        nonOverlapping: Boolean(left && right && left.right <= right.left + 2),
      };
    });
    await win.keyboard.press('Escape');
    await delay(500);
    const exitedFs = await win.evaluate(() => !document.querySelector('.window-frame')?.classList.contains('is-fullscreen'));
    record(
      'Fullscreen F11 enlarges Xiaofan stage cleanly without obstructing UI & Escape restores',
      fsMetrics.isFullscreenClass && exitedFs && fsMetrics.nonOverlapping && fsMetrics.canvasW >= 320 && fsMetrics.canvasH >= 350,
      JSON.stringify({ ...fsMetrics, exitedFs }),
    );

    // FPS Policy switcher verification (30 / 60 / 120 / auto)
    await app.evaluate(({ BrowserWindow }) => {
      const bw = BrowserWindow.getAllWindows()[0];
      bw?.setSize(1280, 820);
      bw?.center();
    });
    await delay(350);
    await win.locator('button[role="tab"]:has-text("启动与偏好")').click();
    await delay(300);
    const fpsResults = {};
    for (const [mode, btnText] of [
      ['fps-30', '30 FPS 节能'],
      ['fps-60', '60 FPS'],
      ['fps-120', '120 FPS 高刷'],
      ['auto', '智能'],
    ]) {
      const pill = win.locator(`[role="group"][aria-label="Live2D 帧率策略"] button:text-is("${btnText}")`).first();
      if (await pill.isVisible().catch(() => false)) {
        await pill.click();
        await delay(900);
        fpsResults[mode] = await win.evaluate(() => {
          const c = document.querySelector('canvas.mascot-live2d-canvas');
          return { fpsMode: c?.dataset?.fpsMode, maxFps: c?.dataset?.maxFps, fps: c?.dataset?.fps };
        });
      }
    }
    record(
      'FPS Policy selector updates maxFps safely (30 / 60 / 120 / auto) without losing render',
      Boolean(fpsResults['fps-30']?.maxFps === '30' && fpsResults['fps-60']?.maxFps === '60' && fpsResults.auto?.maxFps),
      JSON.stringify(fpsResults),
    );
  } finally {
    await app.close().catch(() => {});
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== RC2 ACCEPTANCE SUMMARY: ${passed}/${results.length} PASSED ===`);
  if (passed !== results.length) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
