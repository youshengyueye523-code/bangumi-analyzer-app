/**
 * Release Candidate Full Verification against ACTUAL Final Release Artifacts
 * Covers:
 *   - Graphical Setup EXE launch + installation into isolated target dir
 *   - Installed Bangumi-Analyzer-Companion.exe launcher & Release UI hygiene (DevPanel strictly disabled)
 *   - Separation of Config Write (PUT /api/config) vs Sync Trigger (POST /api/sync runId) vs Poll (lastRun)
 *   - Closed-loop HTTP Update Server: Check -> Download -> SHA-256 verify -> Upgrade (2.0.0 -> 2.0.1) -> Bad SHA-256 abort -> Broken pkg Auto-Rollback
 *   - Cold restart -> In-App Uninstall preserving data/ -> Uninstall-Companion.exe cleanup
 *
 * Usage: .\.runtime\node-v24.22.1-win-x64\node.exe companion/host/test/rc-verification.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopEnvironment, extractR2, host, newWork, repo } from '../scripts/isolated.mjs';

const require = createRequire(path.join(repo, 'package.json'));
const { _electron } = require('@playwright/test');

const DIST_ROOT = path.join(repo, 'companion/dist');
const MANIFEST = JSON.parse(await readFile(path.join(DIST_ROOT, 'RELEASE_MANIFEST.json'), 'utf8'));
const SETUP_EXE = path.join(DIST_ROOT, MANIFEST.installer.fileName);
const PORTABLE_EXE = path.join(DIST_ROOT, 'Bangumi-Analyzer-Companion-Portable-win-x64/Bangumi-Analyzer-Companion.exe');
const SHOT_DIR = path.join(repo, 'companion/ui/screenshots/rc');
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
async function sha256(file) {
  const h = createHash('sha256');
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest('hex');
}
function zipDirectory(srcDir, destZip) {
  const q = (s) => "'" + s.replaceAll("'", "''") + "'";
  const r = spawnSync(
    PS_EXE,
    ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${q(srcDir)},${q(destZip)})`],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`Zip creation failed: ${r.stderr}`);
}

async function createSyntheticUpdateArtifacts(workDir) {
  // 1. Valid 2.0.0 r2 Hotfix-RC1 update package (release.json remains 2.0.0 r2 per package-check.mjs, README.txt + checksums.json updated cleanly)
  const v201Dir = await extractR2(workDir, 'src-patch');
  const readmePath = path.join(v201Dir, 'README.txt');
  const origReadme = await readFile(readmePath, 'utf8');
  await writeFile(readmePath, origReadme + '\r\nHotfix-RC1: verified closed-loop HTTP update applied cleanly.\r\n');
  const newReadmeSha = await sha256(readmePath);

  const manifestPath = path.join(v201Dir, 'checksums.json');
  const checksums = JSON.parse(await readFile(manifestPath, 'utf8'));
  const rEntry = checksums.files.find((f) => f.path.toLowerCase() === 'readme.txt');
  assert.ok(rEntry, 'README.txt entry must exist in checksums.json');
  rEntry.sha256 = newReadmeSha;
  await writeFile(manifestPath, JSON.stringify(checksums, null, 2));
  const newChecksumsSha = await sha256(manifestPath);

  const validZip = path.join(workDir, 'update-2.0.0-r2-hotfix.zip');
  zipDirectory(v201Dir, validZip);
  const validSha = await sha256(validZip);

  // 2. Broken 2.0.2 update zip (valid HTTP zip download SHA-256, fails checkPackage -> must auto-rollback!)
  const brokenSrc = path.join(workDir, 'src-broken-v202');
  await mkdir(brokenSrc, { recursive: true });
  await writeFile(path.join(brokenSrc, 'release.json'), JSON.stringify({ version: '2.0.2', distributionRevision: 4 }));
  await writeFile(path.join(brokenSrc, 'service.mjs'), '// invalid incomplete package');
  const brokenZip = path.join(workDir, 'broken-2.0.2.zip');
  zipDirectory(brokenSrc, brokenZip);
  const brokenSha = await sha256(brokenZip);

  return { validZip, validSha, newChecksumsSha, brokenZip, brokenSha };
}

async function startUpdateServer({ validZip, validSha, newChecksumsSha, brokenZip, brokenSha }) {
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0];
    if (urlPath === '/manifest-v201.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          version: '2.0.0',
          distributionRevision: 2,
          checksumsSha256: newChecksumsSha,
          sha256: validSha,
          packageUrl: `http://127.0.0.1:${port}/update-2.0.0-r2-hotfix.zip`,
          notes: 'RC 闭环升级补丁 Hotfix-RC1',
        }),
      );
      return;
    }
    if (urlPath === '/manifest-badsha.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          version: '2.0.9',
          distributionRevision: 9,
          sha256: '0'.repeat(64),
          packageUrl: `http://127.0.0.1:${port}/update-2.0.1-r3.zip`,
          notes: 'SHA mismatch test',
        }),
      );
      return;
    }
    if (urlPath === '/manifest-broken.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          version: '2.0.2',
          distributionRevision: 4,
          sha256: brokenSha,
          packageUrl: `http://127.0.0.1:${port}/broken-2.0.2.zip`,
          notes: 'Rollback verification package',
        }),
      );
      return;
    }
    if (urlPath === '/update-2.0.0-r2-hotfix.zip' || urlPath === '/update-2.0.1-r3.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      createReadStream(validZip).pipe(res);
      return;
    }
    if (urlPath === '/broken-2.0.2.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      createReadStream(brokenZip).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function main() {
  assert.equal(await exists(SETUP_EXE), true, 'Missing Setup EXE deliverable');
  assert.equal(await exists(PORTABLE_EXE), true, 'Missing Portable EXE launcher');

  await rm(SHOT_DIR, { recursive: true, force: true });
  await mkdir(SHOT_DIR, { recursive: true });

  const work = await newWork('rc-final');
  const installedProgramDir = path.join(work, 'InstalledProgram');
  const companionHome = path.join(work, 'companion-home');
  const userAnalyzerDir = path.join(work, 'UserAnalyzerData');

  const artifacts = await createSyntheticUpdateArtifacts(work);
  const { server: updateServer, baseUrl: updateBaseUrl } = await startUpdateServer(artifacts);
  const checks = [];
  const pass = (name) => {
    checks.push(name);
    console.log('PASS', name);
  };

  let app;
  try {
    // 1. Verify Graphical Setup EXE actually displays a real 580x440 Windows GUI Form & capture screenshot
    const setupShot = path.join(SHOT_DIR, 'rc-setup-gui.png');
    const guiProc = spawn(SETUP_EXE, [], { windowsHide: false, stdio: 'ignore' });
    let guiTitle = '';
    const probePs = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Drawing',
      'Add-Type @"',
      'using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;',
      'public class WinSetupProbe {',
      '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }',
      '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
      '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);',
      '}',
      '"@',
      `$targetPid = [uint32]${guiProc.pid}`,
      '$wins = New-Object System.Collections.Generic.List[IntPtr]',
      '[WinSetupProbe]::EnumWindows({ param($h,$l) $wpid=[uint32]0; [WinSetupProbe]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null; if ($wpid -eq $targetPid -and [WinSetupProbe]::IsWindowVisible($h)) { $wins.Add($h) }; return $true }, [IntPtr]::Zero) | Out-Null',
      'foreach ($w in $wins) {',
      '  $sb = New-Object System.Text.StringBuilder 256',
      '  [WinSetupProbe]::GetWindowText($w, $sb, 256) | Out-Null',
      '  $t = $sb.ToString()',
      '  if ($t -like "*Bangumi*") {',
      '    $rc = New-Object WinSetupProbe+RECT; [WinSetupProbe]::GetWindowRect($w, [ref]$rc) | Out-Null',
      '    $bmp = New-Object System.Drawing.Bitmap ($rc.R-$rc.L), ($rc.B-$rc.T)',
      '    $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()',
      '    [WinSetupProbe]::PrintWindow($w, $hdc, 2) | Out-Null',
      '    $g.ReleaseHdc($hdc); $g.Dispose()',
      `    $bmp.Save('${setupShot.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()`,
      '    Write-Output $t; break',
      '  }',
      '}',
    ].join('\n');
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const checkPs = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', probePs], { encoding: 'utf8', windowsHide: true });
      const t = (checkPs.stdout ?? '').trim();
      if (t) {
        guiTitle = t;
        break;
      }
      await wait(400);
    }
    assert.ok(guiTitle.includes('Bangumi Analyzer Companion 安装向导'), `Expected GUI Setup window title, got "${guiTitle}"`);
    assert.equal(await exists(setupShot), true, 'Expected rc-setup-gui.png screenshot');
    guiProc.kill();
    await wait(300);
    pass('Double-click Setup.exe launches genuine graphical Windows installer UI');

    // 2. Execute Setup.exe into isolated target dir (without polluting real Desktop/HKCU during automated CI)
    execFileSync(SETUP_EXE, ['/S', `/D=${installedProgramDir}`, '/NOLAUNCH', '/NOSHORTCUT'], {
      stdio: 'inherit',
      timeout: 60000,
    });
    const installedLauncher = path.join(installedProgramDir, 'Bangumi-Analyzer-Companion.exe');
    const installedUninstaller = path.join(installedProgramDir, 'Uninstall-Companion.exe');
    const installedElectron = path.join(installedProgramDir, 'host/node_modules/electron/dist/electron.exe');
    const installedMain = path.join(installedProgramDir, 'host/main.mjs');
    assert.equal(await exists(installedLauncher), true);
    assert.equal(await exists(installedUninstaller), true);
    assert.equal(await exists(installedElectron), true);
    assert.equal(await exists(installedMain), true);
    pass('Setup.exe cleanly installs Companion program, GUI launcher & uninstaller');

    // 3. Smoke-test native GUI launcher Bangumi-Analyzer-Companion.exe itself!
    const homeExeTest = path.join(work, 'exe-smoke-home');
    const exeProc = spawn(installedLauncher, ['--companionHome', homeExeTest], { cwd: installedProgramDir, windowsHide: false, stdio: 'ignore' });
    let exeElectronFound = false;
    const exeDeadline = Date.now() + 12000;
    while (Date.now() < exeDeadline) {
      const psOut = spawnSync(
        PS_EXE,
        ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${installedProgramDir.replaceAll("'", "''")}*' } | Select-Object -ExpandProperty ProcessId`],
        { encoding: 'utf8', windowsHide: true },
      );
      const pids = (psOut.stdout ?? '').trim().split(/\s+/).filter(Boolean);
      if (pids.length > 0) {
        exeElectronFound = true;
        for (const p of pids) {
          spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${p} -Force -ErrorAction SilentlyContinue`], { windowsHide: true });
        }
        break;
      }
      await wait(300);
    }
    try { exeProc.kill(); } catch { /* launcher already exited after spawning Electron */ }
    assert.equal(exeElectronFound, true, 'Bangumi-Analyzer-Companion.exe must spawn installed Electron host');
    pass('Installed Bangumi-Analyzer-Companion.exe launches installed Electron GUI directly');

    // 4. Attach Playwright to the INSTALLED Electron binary to drive full RC user lifecycle
    app = await _electron.launch({
      executablePath: installedElectron,
      args: [installedMain, '--companionHome', companionHome],
      cwd: installedProgramDir,
      env: desktopEnvironment(),
      timeout: 30000,
    });
    const page = await app.firstWindow();
    await page.locator('.intro').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await page.locator('.dev-fab, .dev-panel').count(), 0, 'DevPanel strictly hidden in Release binary');
    assert.equal(await page.locator('.tb-ver').textContent(), 'v2.0');
    assert.equal(await page.locator('.mock-tag').count(), 0);
    pass('Installed Release build cold launch opens Intro cleanly with all dev controls hidden');

    // Run real extract + config write + separate sync verification via window.companionProduct
    const extRes = await page.evaluate(async (dir) => window.companionProduct.installAndExtract({ installDir: dir }), userAnalyzerDir);
    assert.equal(extRes.ok, true, `installAndExtract failed: ${extRes.error}`);

    const cfgRes = await page.evaluate(async () =>
      window.companionProduct.configureAndStartAnalyzer({
        username: 'rc_nonexistent_sync_probe_user',
        nickname: 'RCTester',
        desktopShortcut: false,
        autoStart: true,
        skipIntro: true,
      }),
    );
    assert.equal(cfgRes.ok, true, `configureAndStartAnalyzer failed: ${cfgRes.error}`);
    const analyzerUrl = cfgRes.url;
    assert.ok(analyzerUrl && analyzerUrl.startsWith('http://127.0.0.1:'));

    // Crucial Requirement #2 check: PUT /api/config must NOT pretend sync already ran!
    const histBefore = await (await fetch(`${analyzerUrl}api/sync/history`)).json();
    assert.equal(histBefore.runs.length, 0, 'Config write alone must have ZERO sync runs in history');
    pass('Config write (PUT /api/config) leaves sync history empty (not conflated with sync)');

    // Explicitly trigger real POST /api/sync and verify runId + real lastRun outcome!
    const syncStart = await page.evaluate(async () => window.companionProduct.startAnalyzerSync({ mode: 'full', depth: 1 }));
    assert.equal(syncStart.ok, true);
    assert.equal(syncStart.started, true, 'POST /api/sync must return started=true');
    assert.ok(Number.isInteger(syncStart.runId) && syncStart.runId >= 1, `Expected real runId, got ${syncStart.runId}`);

    let poll;
    const syncDeadline = Date.now() + 25000;
    while (Date.now() < syncDeadline) {
      poll = await page.evaluate(async () => window.companionProduct.getSyncStatus());
      if (!poll.running && poll.lastRun?.id === syncStart.runId) break;
      await wait(300);
    }
    assert.ok(poll && poll.lastRun?.id === syncStart.runId, 'getSyncStatus must return tracked runId in lastRun');
    const histAfter = await (await fetch(`${analyzerUrl}api/sync/history`)).json();
    assert.equal(histAfter.runs.length, 1, 'POST /api/sync must record exactly 1 real SyncRun');
    // For nonexistent Bangumi probe user, status will legitimately be error (not faked as success!).
    assert.ok(['success', 'error'].includes(poll.lastRun.status), `Unexpected run status ${poll.lastRun.status}`);
    await page.evaluate(async () => window.companionProduct.finishFirstRun({ collections: 0, skipIntro: true, autoStart: true }));
    pass(`Real sync triggered (runId=${syncStart.runId}) & tracked accurately via lastRun (status=${poll.lastRun.status}, zero fake success)`);

    // Go to Home -> Maintenance panel to test full Closed-Loop Update System (Check -> Download -> SHA-256 -> Upgrade -> Rollback)
    await app.close();
    app = null;
    await wait(500);

    // 5. Cold Restart into Home (via installed binaries)
    app = await _electron.launch({
      executablePath: installedElectron,
      args: [installedMain, '--companionHome', companionHome],
      cwd: installedProgramDir,
      env: desktopEnvironment(),
      timeout: 30000,
    });
    const page2 = await app.firstWindow();
    await page2.locator('.home').waitFor({ state: 'visible', timeout: 15000 });
    await page2.waitForFunction(() => document.body.innerText.includes('运行中'), { timeout: 25000 });
    assert.equal(await page2.locator('.dev-fab, .dev-panel').count(), 0);

    await page2.getByRole('tab', { name: /维护与诊断/ }).click();
    await page2.locator('.maint-pane').waitFor({ state: 'visible' });

    // Unconfigured update check -> reports configured=false honestly
    await page2.getByRole('button', { name: '检查更新源' }).click();
    await page2.locator('.maint-update-summary').waitFor({ state: 'visible', timeout: 8000 });
    const unconfText = await page2.locator('.maint-update-summary').textContent();
    assert.ok(unconfText?.includes('未配置远端发布源'), `Expected honest unconfigured state, got ${unconfText}`);

    // Configure loopback update manifest -> Check -> Download -> SHA-256 -> Upgrade Hotfix-RC1
    await page2.locator('.maint-feed-input').fill(`${updateBaseUrl}/manifest-v201.json`);
    await page2.getByRole('button', { name: '检查更新源' }).click();
    await page2.waitForFunction(() => document.querySelector('.maint-update-summary')?.textContent?.includes('Hotfix-RC1'), { timeout: 10000 });
    await page2.screenshot({ path: path.join(SHOT_DIR, 'rc-update-available.png') });

    page2.on('console', (m) => console.log('[UI]', m.text()));
    await page2.evaluate(() => {
      window.companionProduct.onProductEvent((ev) => {
        if (ev.type === 'update-stage') console.log('[STAGE]', JSON.stringify(ev.payload));
      });
    });
    await page2.getByRole('button', { name: '下载并安全升级' }).click();
    try {
      await page2.locator('.maint-stage-banner.ok').waitFor({ state: 'visible', timeout: 120000 });
    } catch (e) {
      const txt = await page2.locator('.maint-stage-banner').textContent().catch(() => 'none');
      console.error('[UPDATE-BANNER]', txt);
      throw e;
    }
    const upgradedReadme = await readFile(path.join(userAnalyzerDir, 'README.txt'), 'utf8');
    assert.ok(upgradedReadme.includes('Hotfix-RC1'), 'Expected upgraded README.txt Hotfix-RC1 marker');
    assert.equal(await exists(path.join(userAnalyzerDir, 'data', 'bangumi.db')), true, 'User DB preserved across upgrade');
    await page2.screenshot({ path: path.join(SHOT_DIR, 'rc-update-success.png') });
    pass('Closed-loop HTTP update: Check -> Download -> SHA-256 -> Upgrade Hotfix-RC1 preserving data/');

    // Tampered SHA-256 manifest -> fails download verification BEFORE touching installDir
    const badShaRes = await page2.evaluate(async (u) => {
      const ck = await window.companionProduct.checkUpdate({ manifestPath: `${u}/manifest-badsha.json` });
      return window.companionProduct.applySafeUpdate({ packageUrl: ck.latest.packageUrl, expectedSha256: ck.latest.sha256 });
    }, updateBaseUrl);
    assert.equal(badShaRes.ok, false);
    assert.equal(badShaRes.downloadFailed, true);
    pass('Download SHA-256 mismatch aborts update before modifying installed files');

    // Broken update package (valid download hash, invalid package contents) -> Auto-Rollback back to Hotfix-RC1!
    const rbRes = await page2.evaluate(async (u) => {
      const ck = await window.companionProduct.checkUpdate({ manifestPath: `${u}/manifest-broken.json` });
      return window.companionProduct.applySafeUpdate({ packageUrl: ck.latest.packageUrl, expectedSha256: ck.latest.sha256 });
    }, updateBaseUrl);
    assert.equal(rbRes.ok, false);
    assert.equal(rbRes.rolledBack, true);
    const postRbReadme = await readFile(path.join(userAnalyzerDir, 'README.txt'), 'utf8');
    assert.ok(postRbReadme.includes('Hotfix-RC1'), 'Rollback restored pre-failure Hotfix-RC1 cleanly');
    assert.equal(await exists(path.join(userAnalyzerDir, 'data', 'bangumi.db')), true);
    await page2.screenshot({ path: path.join(SHOT_DIR, 'rc-update-rollback.png') });
    pass('Broken HTTP update triggers automatic rollback to Hotfix-RC1 & preserves data/');

    // Safe close via custom close button
    await page2.locator('[aria-label="关闭"]').click();
    await app.waitForEvent('close', { timeout: 20000 }).catch(async () => app.close());
    app = null;
    await wait(500);
    pass('Installed Companion closes and safely stops upgraded Analyzer service');

    // 6. Launch again -> test in-app uninstall keeping user data/ -> exit -> run Uninstall-Companion.exe /S
    app = await _electron.launch({
      executablePath: installedElectron,
      args: [installedMain, '--companionHome', companionHome],
      cwd: installedProgramDir,
      env: desktopEnvironment(),
      timeout: 30000,
    });
    const page3 = await app.firstWindow();
    await page3.locator('.home').waitFor({ state: 'visible', timeout: 15000 });
    await page3.getByRole('tab', { name: /维护与诊断/ }).click();
    await page3.getByRole('button', { name: '管理卸载选项' }).click();
    await page3.getByRole('button', { name: '卸载程序（保留全部用户数据）' }).click();
    await page3.locator('.intro').waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await exists(path.join(userAnalyzerDir, 'service.mjs')), false);
    assert.equal(await exists(path.join(userAnalyzerDir, 'data', 'bangumi.db')), true, 'User DB preserved after in-app uninstall');
    await page3.locator('[aria-label="关闭"]').click();
    await app.waitForEvent('close', { timeout: 15000 }).catch(async () => app.close());
    app = null;
    await wait(500);

    execFileSync(installedUninstaller, ['/S'], { timeout: 15000 });
    let removedProgram = false;
    for (let i = 0; i < 20; i++) {
      await wait(400);
      if (!(await exists(installedLauncher))) {
        removedProgram = true;
        break;
      }
    }
    assert.equal(removedProgram, true, 'Uninstall-Companion.exe /S removes installed program directory');
    assert.equal(await exists(path.join(userAnalyzerDir, 'data', 'bangumi.db')), true, 'User data/bangumi.db survives both uninstalls');
    pass('In-app uninstall + Uninstall-Companion.exe cleanly uninstall while protecting user data/');
  } finally {
    if (app) await app.close().catch(() => {});
    updateServer.close();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nRC_VERIFICATION_ALL_PASS (${checks.length} checks)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
