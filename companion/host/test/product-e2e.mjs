/**
 * Companion M2 + M3 Product Mode End-to-End Verification (Electron + Real IPC + Real Runtime)
 * Usage: .\.runtime\node-v24.22.1-win-x64\node.exe companion/host/test/product-e2e.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopEnvironment, host, newWork, repo } from '../scripts/isolated.mjs';
import { readCompanionState, validateInstallDir } from '../setup-service.mjs';

const require = createRequire(path.join(repo, 'package.json'));
const { _electron } = require('@playwright/test');

const SHOT_DIR = path.join(repo, 'companion/ui/screenshots/product-e2e');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function createBrokenUpdateZip(workDir) {
  const brokenDir = path.join(workDir, 'broken-update-src');
  const brokenZip = path.join(workDir, 'broken-update.zip');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(path.join(brokenDir, 'release.json'), JSON.stringify({ version: '2.0.1', distributionRevision: 99 }));
  await writeFile(path.join(brokenDir, 'service.mjs'), '// intentionally invalid update package without runtime/checksums');
  const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
  const psExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const r = spawnSync(
    psExe,
    ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(brokenDir)},${quote(brokenZip)})`],
    { windowsHide: true, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error('Failed to create synthetic broken zip');
  return brokenZip;
}

async function launchProduct(companionHome) {
  const app = await _electron.launch({
    executablePath: path.join(host, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(host, 'main.mjs'), '--companionHome', companionHome],
    cwd: host,
    env: desktopEnvironment(),
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.companionProduct && window.companionBridge && window.companionWindow));
  return { app, page };
}

async function main() {
  await rm(SHOT_DIR, { recursive: true, force: true });
  await mkdir(SHOT_DIR, { recursive: true });

  const work = await newWork('product-e2e');
  const companionHome = path.join(work, 'companion-home');
  const installDir = path.join(work, 'Analyzer');
  const brokenZip = await createBrokenUpdateZip(work);

  const checks = [];
  const pass = (name) => {
    checks.push(name);
    console.log('PASS', name);
  };

  // 1. Validate dangerous paths are rejected
  for (const bad of ['C:\\Program Files\\Analyzer', 'C:\\Windows\\Analyzer', '\\\\server\\share\\Analyzer', 'C:\\Users\\Demo\\OneDrive\\Analyzer']) {
    const v = await validateInstallDir(bad);
    assert.equal(v.level, 'error', `Expected error for ${bad}, got ${v.level}`);
  }
  const okVal = await validateInstallDir(installDir);
  assert.notEqual(okVal.level, 'error', `Expected writable isolated path to pass, got: ${okVal.reasons.join(', ')}`);
  pass('installDir safety rules reject unsafe paths & accept isolated dir');

  // 2. Cold first launch -> M2 real setup flow
  let app;
  try {
    const first = await launchProduct(companionHome);
    app = first.app;
    const { page } = first;
    page.on('pageerror', (e) => console.error('[PAGEERROR]', e.message));

    try {
      await page.locator('.intro').waitFor({ state: 'visible', timeout: 15000 });
    } catch (waitErr) {
      const diag = await page.evaluate(async () => ({
        url: location.href,
        state: await window.companionProduct?.getCompanionState(),
        html: document.body.innerHTML.slice(0, 400),
      }));
      console.error('[DIAG]', JSON.stringify(diag));
      throw waitErr;
    }
    await page.screenshot({ path: path.join(SHOT_DIR, '01-first-run-intro.png') });
    pass('First launch opens Intro welcome stage');

    // Intro -> EnvCheck
    await page.getByRole('button', { name: '开始设置' }).click();
    const continueBtn = page.getByRole('button', { name: /继续/ });
    await continueBtn.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('继续'));
      return Boolean(btn && !btn.disabled);
    }, { timeout: 25000 });
    assert.equal(await page.locator('.mock-tag').count(), 0, 'Product Mode must hide MockTag on EnvCheck');
    await page.screenshot({ path: path.join(SHOT_DIR, '02-real-envcheck.png') });
    pass('Real 6-item environment check completed without MockTag');

    // EnvCheck -> InstallDir
    await continueBtn.click();
    await page.locator('.dir-field input').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.dir-field input').fill(installDir);
    await wait(300);
    // Turn off desktopShortcut toggle so test does not create shortcut on user desktop
    await page.locator('label', { hasText: '创建桌面快捷方式' }).click();
    await page.getByRole('button', { name: '使用此位置' }).click();

    // Account -> skip cleanly
    await page.locator('.step-title', { hasText: '连接 Bangumi 账号' }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('.mock-tag').count(), 0, 'Product Mode must hide MockTag on Account');
    await page.getByRole('button', { name: '稍后再绑定' }).click();

    // AI -> skip cleanly
    await page.locator('.step-title', { hasText: '配置 AI 助手' }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('.mock-tag').count(), 0, 'Product Mode must hide MockTag on AI');
    await page.getByRole('button', { name: '跳过，不使用 AI' }).click();

    // Init -> real extract + checkPackage + startAnalyzer + PUT /api/config + Ready
    await page.locator('.ready-page').waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await page.locator('.mock-tag').count(), 0, 'Product Mode must hide MockTag on Ready');
    await page.screenshot({ path: path.join(SHOT_DIR, '03-real-ready.png') });
    pass('Real install, SHA-256 verification, runtime start & config persistence reached Ready');

    // Check files on disk before clicking Home
    assert.equal(await exists(path.join(installDir, 'service.mjs')), true, 'Analyzer extracted cleanly');
    assert.equal(await exists(path.join(installDir, 'data', 'config.json')), true, 'Analyzer config created');
    const cState = await readCompanionState(companionHome);
    assert.equal(cState.firstRunCompleted, true);
    assert.equal(path.resolve(cState.installDir), path.resolve(installDir));
    const rawCompanionJson = await readFile(path.join(companionHome, 'companion.json'), 'utf8');
    assert.ok(!rawCompanionJson.includes('token') && !rawCompanionJson.includes('apiKey'), 'companion.json stores zero secrets');
    pass('Disk layout & companion.json zero-secret check passed');

    // Ready -> Home
    await page.getByRole('button', { name: '前往 Companion 首页' }).click();
    await page.locator('.home').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => document.body.innerText.includes('运行中'), { timeout: 20000 });

    // M3 Maintenance tab -> Backup, Integrity Check, Restore, Failed-Update Rollback
    await page.getByRole('tab', { name: /维护与诊断/ }).click();
    await page.locator('.maint-pane').waitFor({ state: 'visible', timeout: 10000 });

    await page.getByRole('button', { name: '立即备份' }).click();
    await page.locator('.maint-list .maint-item').first().waitFor({ state: 'visible', timeout: 15000 });

    await page.getByRole('button', { name: '运行自检' }).click();
    await page.locator('.maint-checks .mc-check.ok').first().waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await page.locator('.maint-checks .mc-check.fail').count(), 0, 'All integrity checks must be ok');
    await page.screenshot({ path: path.join(SHOT_DIR, '04-real-maintenance.png') });
    pass('M3 backup creation + SQLite & SHA-256 integrity self-check passed');

    // Test restore with confirmation modal + automatic pre-restore snapshot
    await page.locator('.maint-list .maint-item').first().getByRole('button', { name: '恢复' }).click();
    await page.locator('.maint-confirm').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByRole('button', { name: '确认安全恢复' }).click();
    await page.locator('.maint-confirm').waitFor({ state: 'hidden', timeout: 20000 });
    const backupCountAfterRestore = await page.locator('.maint-list .maint-item').count();
    assert.ok(backupCountAfterRestore >= 2, `Restore should create pre-restore backup (count=${backupCountAfterRestore})`);
    pass('M3 restore with confirmation & pre-restore snapshot passed');

    // Test failed update automatic rollback (using broken synthetic update zip in isolated work dir)
    const updateRes = await page.evaluate(async (zipPath) => window.companionProduct.applySafeUpdate({ zipPath }), brokenZip);
    assert.equal(updateRes.ok, false);
    assert.equal(updateRes.rolledBack, true);
    await page.locator('.maint-stage-banner.warn').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await exists(path.join(installDir, 'service.mjs')), true, 'Rollback preserved service.mjs');
    assert.equal(await exists(path.join(installDir, 'data', 'bangumi.db')), true, 'Rollback preserved bangumi.db');
    await page.screenshot({ path: path.join(SHOT_DIR, '05-update-rollback.png') });
    pass('M3 failed-update automatic rollback preserved application and user data');

    // Save skipIntro=true + autoStart=true for second cold launch test
    await page.evaluate(async () => window.companionProduct.savePreferences({ skipIntro: true, autoStart: true }));

    // Close window safely
    await page.locator('[aria-label="关闭"]').click();
    await app.waitForEvent('close', { timeout: 20000 }).catch(async () => app.close());
    app = null;
    await wait(500);
    pass('First Electron session closed cleanly');

    // 3. Second launch -> directly enters Home & auto-starts Analyzer -> safe uninstall preserving data/
    const second = await launchProduct(companionHome);
    app = second.app;
    const page2 = second.page;
    await page2.locator('.home').waitFor({ state: 'visible', timeout: 15000 });
    await page2.waitForFunction(() => document.body.innerText.includes('运行中'), { timeout: 25000 });
    await page2.screenshot({ path: path.join(SHOT_DIR, '06-second-launch-home.png') });
    pass('Second launch skipped setup/intro & auto-started Analyzer into Home');

    // Safe uninstall preserving data/
    await page2.getByRole('tab', { name: /维护与诊断/ }).click();
    await page2.getByRole('button', { name: '管理卸载选项' }).click();
    await page2.getByRole('button', { name: '卸载程序（保留全部用户数据）' }).click();
    await page2.locator('.intro').waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await exists(path.join(installDir, 'service.mjs')), false, 'Program files removed');
    assert.equal(await exists(path.join(installDir, 'data', 'bangumi.db')), true, 'User bangumi.db preserved after uninstall!');
    assert.equal(await exists(path.join(installDir, 'data', 'backups')), true, 'User backups preserved after uninstall!');
    pass('M3 uninstall removed program & protected user data/ directory');

    await page2.locator('[aria-label="关闭"]').click();
    await app.waitForEvent('close', { timeout: 20000 }).catch(async () => app.close());
    app = null;
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nPRODUCT_E2E_ALL_PASS (${checks.length} checks)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
