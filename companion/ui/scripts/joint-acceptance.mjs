/**
 * Companion M1-A 独立联合验收脚本（最新 companion/ui/dist + companion/host + 真实 r2 Runtime）
 * 用法（从仓库根目录执行可信 Node 24）：
 *   .\.runtime\node-v24.22.1-win-x64\node.exe companion/ui/scripts/joint-acceptance.mjs
 */
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AnalyzerSupervisor } from '../../runtime/supervisor.mjs';
import { checkPackage, sha256 } from '../../runtime/package-check.mjs';
import { desktopEnvironment, extractR2, host, newWork, repo, zip, ZIP_HASH } from '../../host/scripts/isolated.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(UI_DIR, 'screenshots', 'joint');
const require = createRequire(path.join(repo, 'package.json'));
const { _electron } = require('@playwright/test');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const noFile = async (p) => {
  try {
    await access(p);
    return false;
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    throw e;
  }
};

async function health(url) {
  const u = new URL(url);
  assert.equal(u.hostname, '127.0.0.1');
  assert.notEqual(u.port, '8787');
  const r = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(3000) });
  assert.equal(r.status, 200);
  return r.json();
}

async function main() {
  await rm(SHOT_DIR, { recursive: true, force: true });
  await mkdir(SHOT_DIR, { recursive: true });

  // 1. 记录当前 companion/ui/dist 实际静态文件哈希，后续与 Electron session 快照对账
  const distAssets = await readdir(path.join(UI_DIR, 'dist', 'assets'));
  const distJs = distAssets.find((f) => /^index-.*\.js$/.test(f));
  assert.ok(distJs, 'Expected built dist JS bundle');
  const distHtmlSha = await sha256(path.join(UI_DIR, 'dist', 'index.html'));
  const distJsSha = await sha256(path.join(UI_DIR, 'dist', 'assets', distJs));

  const work = await newWork('ui-joint-acceptance');
  const report = {
    startedAt: new Date().toISOString(),
    work,
    distBundle: distJs,
    distHtmlSha,
    distJsSha,
    checks: [],
  };
  const pass = (name) => {
    report.checks.push(name);
    console.log(`PASS ${name}`);
  };

  let app;
  let externalB;
  try {
    const copyA = await extractR2(work, 'Analyzer A 宿主测试');
    const copyB = await extractR2(work, 'Analyzer B 外部哨兵');
    assert.equal(await sha256(zip), ZIP_HASH);
    assert.ok((await noFile(path.join(copyA, 'data'))) && (await noFile(path.join(copyB, 'data'))));
    pass('Extracted two clean isolated r2 copies from verified ZIP');

    // 启动独立外部哨兵 B，确认后续宿主操作绝不影响 B
    externalB = new AnalyzerSupervisor({ packageRoot: copyB, openBrowser: async () => {} });
    await externalB.startAnalyzer();
    for (let i = 0; i < 200 && externalB.getStatus().state !== 'ready'; i++) await wait(100);
    assert.equal(externalB.getStatus().state, 'ready');
    const bUrl = externalB.getStatus().url;
    assert.ok((await health(bUrl)).ok);
    pass('Independent external Analyzer B is running on isolated loopback port');

    // 启动真实 Electron Host
    const sessionsBefore = new Set((await readdir(path.join(host, '.work'))).filter((n) => n.startsWith('session-')));
    app = await _electron.launch({
      executablePath: path.join(host, 'node_modules/electron/dist/electron.exe'),
      args: [path.join(host, 'main.mjs'), '--packageRoot', copyA],
      cwd: host,
      env: desktopEnvironment(),
      timeout: 30000,
    });
    const page = await app.firstWindow();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    await page.waitForFunction(() => Boolean(window.companionBridge));
    await page.locator('.home').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);

    // 2. 验证 Electron 实际加载的静态快照就是最新的 companion/ui/dist（非旧构建、非 Mock）
    const sessionsAfter = (await readdir(path.join(host, '.work'))).filter((n) => n.startsWith('session-'));
    const newSessions = [];
    for (const s of sessionsAfter) {
      if (!sessionsBefore.has(s)) {
        const st = await stat(path.join(host, '.work', s));
        newSessions.push({ name: s, mtime: st.mtimeMs });
      }
    }
    newSessions.sort((x, y) => y.mtime - x.mtime);
    const sessionDir = path.join(host, '.work', newSessions[0].name);
    const uiInputs = JSON.parse(await readFile(path.join(sessionDir, 'ui-inputs.json'), 'utf8'));
    const snapJs = uiInputs.find((x) => x.path === `assets/${distJs}`);
    const snapHtml = uiInputs.find((x) => x.path === 'index.html');
    assert.ok(snapJs && snapJs.sha256 === distJsSha, `Expected snapshot JS hash match for ${distJs}`);
    assert.ok(snapHtml && snapHtml.sha256 === distHtmlSha, 'Expected snapshot index.html hash match');
    const codexTagText = await page.locator('.codex-tag').first().textContent();
    assert.match(codexTagText ?? '', /CODEX RUNTIME/);
    assert.equal(await page.locator('.tb-close').count(), 0, 'Mock close button must not appear in Codex mode');
    pass(`Electron loaded exact latest UI dist (${distJs}) in Codex mode with zero mock chrome`);

    await page.screenshot({ path: path.join(SHOT_DIR, 'electron-01-idle.png') });
    console.log('captured electron-01-idle.png');

    // 3. 异常反馈：损坏隔离包内 README.txt → 通过 UI 按钮点击「启动 Analyzer」→ 展示 INTEGRITY_FAILED
    const readmePath = path.join(copyA, 'README.txt');
    const readmeBytes = await readFile(readmePath);
    await writeFile(readmePath, 'corrupted-by-joint-acceptance');
    await page.getByRole('button', { name: '启动 Analyzer' }).click();
    await page.locator('.init-error').waitFor({ state: 'visible', timeout: 10000 });
    const errText = await page.locator('.init-error').textContent();
    assert.match(errText ?? '', /PACKAGE_DAMAGED|INTEGRITY_FAILED/);
    assert.ok(await noFile(path.join(copyA, '.analyzer-session.json')), 'Must not spawn or lock on damaged package');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOT_DIR, 'electron-02-integrity-error.png') });
    console.log('captured electron-02-integrity-error.png');
    pass('UI accurately displays real INTEGRITY_FAILED error and refuses to start damaged package');

    // 4. 恢复文件 → 通过 UI 按钮「重试启动 Analyzer」→ 达到真实 running + 切换日志面板验证真实事件
    await writeFile(readmePath, readmeBytes);
    await page.getByRole('button', { name: '重试启动 Analyzer' }).click();
    await page.locator('.orb-ok').waitFor({ state: 'visible', timeout: 30000 });
    const liveStatus = await page.evaluate(() => window.companionBridge.getStatus());
    assert.equal(liveStatus.state, 'running');
    assert.ok(liveStatus.url && (await health(liveStatus.url)).ok);
    report.analyzerUrl = liveStatus.url;
    pass(`UI retry button started real isolated Analyzer at ${liveStatus.url}`);

    // 5. 通过 UI 按钮「打开 Analyzer 网页端」真实调用 Runtime openAnalyzer
    await page.getByRole('button', { name: '打开 Analyzer 网页端' }).click();
    await page.locator('.toast-success', { hasText: '已唤醒默认浏览器' }).waitFor({ state: 'visible', timeout: 8000 });
    pass('UI openAnalyzer button handed off real loopback URL to default browser');

    await page.getByRole('tab', { name: /运行日志/ }).click();
    await page.locator('.console-line', { hasText: '[runtime #' }).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOT_DIR, 'electron-03-running-logs.png') });
    console.log('captured electron-03-running-logs.png');
    pass('Real Runtime seq-deduplicated logs displayed in Home console');

    // 6. 通过 UI 按钮「安全停止」→ 状态回到 stopped，锁移除，外部 B 不受影响
    await page.getByRole('button', { name: '安全停止' }).click();
    await page.locator('.orb-idle').waitFor({ state: 'visible', timeout: 20000 });
    assert.ok(await noFile(path.join(copyA, '.analyzer-session.json')));
    assert.ok((await health(bUrl)).ok, 'External Analyzer B must remain untouched');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOT_DIR, 'electron-04-stopped.png') });
    console.log('captured electron-04-stopped.png');
    pass('UI safe-stop gracefully stopped only owned Analyzer while leaving external instance B intact');

    // 7. 再次从 UI 启动并用原生窗口 close() 安全退出宿主
    await page.getByRole('button', { name: '启动 Analyzer' }).click();
    await page.locator('.orb-ok').waitFor({ state: 'visible', timeout: 30000 });
    const exited = new Promise((resolve) => app.process().once('exit', (code) => resolve(code)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible()).close());
    const exitCode = await Promise.race([
      exited,
      wait(45000).then(() => {
        throw new Error('Native Electron close timed out');
      }),
    ]);
    app = null;
    assert.equal(exitCode, 0);
    assert.ok(await noFile(path.join(copyA, '.analyzer-session.json')));
    assert.ok((await health(bUrl)).ok);
    pass('Native Electron window close cleanly stopped owned Analyzer/CLI and exited with code 0');

    // 8. 校验临时库完整与清单无损坏，零 renderer 错误
    await externalB.stopAnalyzer();
    externalB = null;
    await checkPackage(copyA);
    await checkPackage(copyB);
    for (const root of [copyA, copyB]) {
      const db = new DatabaseSync(path.join(root, 'data/bangumi.db'), { readOnly: true });
      try {
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15);
        assert.equal(db.prepare('SELECT count(*) AS n FROM collections').get().n, 0);
      } finally {
        db.close();
      }
    }
    assert.equal(pageErrors.length, 0, `pageErrors: ${pageErrors.join('; ')}`);
    assert.equal(consoleErrors.length, 0, `consoleErrors: ${consoleErrors.join('; ')}`);
    pass('Databases intact (Schema 15, integrity ok), manifests unchanged, 0 renderer errors');

    report.ok = true;
    await writeFile(path.join(SHOT_DIR, 'joint-report.json'), JSON.stringify(report, null, 2));
    console.log('ALL JOINT ACCEPTANCE CHECKS PASSED!');
  } finally {
    if (app) {
      try {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close()));
      } catch {
        /* ignore */
      }
    }
    if (externalB) await externalB.stopAnalyzer();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
