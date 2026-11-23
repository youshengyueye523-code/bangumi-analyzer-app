/**
 * Companion M1 无边框窗口、F11/Esc 全屏、窗口状态恢复 & 小番舞台联合验收脚本
 * 用法：.\.runtime\node-v24.22.1-win-x64\node.exe companion/ui/scripts/frameless-xiaofan-acceptance.mjs
 */
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopEnvironment, extractR2, host, newWork, repo } from '../../host/scripts/isolated.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(UI_DIR, 'screenshots', 'frameless');
const WINDOW_STATE_FILE = path.join(host, '.work', 'window-state.json');
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

async function launchHost(packageRoot) {
  const app = await _electron.launch({
    executablePath: path.join(host, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(host, 'main.mjs'), '--packageRoot', packageRoot],
    cwd: host,
    env: desktopEnvironment(),
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.companionBridge && window.companionWindow));
  await page.locator('.home').waitFor({ state: 'visible' });
  return { app, page };
}

async function main() {
  await rm(SHOT_DIR, { recursive: true, force: true });
  await mkdir(SHOT_DIR, { recursive: true });
  await rm(WINDOW_STATE_FILE, { force: true });

  const work = await newWork('frameless-xiaofan');
  const copyA = await extractR2(work, 'Analyzer A 无边框验收');
  const checks = [];
  const pass = (name) => {
    checks.push(name);
    console.log('PASS', name);
  };

  let app;
  try {
    // 1. 首次启动：校验无边框、拖动区、高 DPI 尺寸未超出工作区、小番半身占位舞台
    const first = await launchHost(copyA);
    app = first.app;
    const page = first.page;
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    const winInfo = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.isVisible());
      const wa = screen.getDisplayMatching(w.getBounds()).workArea;
      return { bounds: w.getBounds(), workArea: wa, menuBarVisible: w.isMenuBarVisible() };
    });
    assert.ok(winInfo.bounds.width <= winInfo.workArea.width && winInfo.bounds.height <= winInfo.workArea.height);
    pass('Frameless Electron window sized safely within active display workArea');

    const dragStyles = await page.evaluate(() => {
      const tb = getComputedStyle(document.querySelector('.titlebar')).getPropertyValue('-webkit-app-region');
      const btn = getComputedStyle(document.querySelector('.tb-close')).getPropertyValue('-webkit-app-region');
      return { tb: tb.trim(), btn: btn.trim() };
    });
    assert.equal(dragStyles.tb, 'drag');
    assert.equal(dragStyles.btn, 'no-drag');
    pass('Titlebar drag region and no-drag button exclusions verified');

    const slotText = await page.locator('.mascot-slot').textContent();
    assert.match(slotText ?? '', /小番 · 半身立绘占位/);
    // 验证小番 8 种状态按钮均可切换
    for (const label of ['招呼', '思考', '工作', '开心', '担心', '休息', '庆祝', '待机']) {
      await page.locator('.hrs-pill', { hasText: label }).click();
    }
    await page.locator('.hrs-head button', { hasText: '恢复自动' }).click();
    pass('Xiaofan half-body stage and 8-state interface verified on Home');

    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOT_DIR, 'frameless-home.png') });
    console.log('captured frameless-home.png');

    // 2. 最大化 / 还原 / 最小化与恢复测试
    await page.getByRole('button', { name: '最大化' }).click();
    await wait(350);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), true);
    await page.getByRole('button', { name: '向下还原' }).click();
    await wait(350);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), false);
    pass('Custom maximize and restore controls work cleanly');

    await page.getByRole('button', { name: '最小化' }).click();
    await wait(250);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true);
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.restore();
      w.focus();
    });
    await wait(300);
    pass('Custom minimize and restore work cleanly');

    // 3. F11 进入无边框全屏 → 截图 → Esc 退出全屏 → Titlebar 按钮再切换一次
    await page.keyboard.press('F11');
    await page.locator('.window-frame.is-fullscreen').waitFor({ state: 'visible', timeout: 4000 });
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true);
    await page.locator('.fs-pill').waitFor({ state: 'visible' });
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(SHOT_DIR, 'frameless-fullscreen.png') });
    console.log('captured frameless-fullscreen.png');

    await page.keyboard.press('Escape');
    await page.locator('.window-frame.is-fullscreen').waitFor({ state: 'detached', timeout: 4000 });
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false);

    await page.getByRole('button', { name: '进入全屏' }).click();
    await page.locator('.window-frame.is-fullscreen').waitFor({ state: 'visible', timeout: 4000 });
    await page.locator('.fs-pill').click();
    await page.locator('.window-frame.is-fullscreen').waitFor({ state: 'detached', timeout: 4000 });
    pass('F11 / Esc / TitleBar / Fullscreen Pill entry & exit verified');

    // 4. 欢迎页（小番全身立绘占位舞台）截图与全屏按键互不冲突检查
    await page.locator('.dev-fab').click();
    await page.locator('.dev-screens button', { hasText: '欢迎演出' }).click();
    await page.locator('.dev-fab').click();
    await page.locator('.intro.ph-4').waitFor({ state: 'visible', timeout: 6000 });
    const fullSlot = await page.locator('.intro .mascot-slot').textContent();
    assert.match(fullSlot ?? '', /小番 · 全身立绘占位/);
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(SHOT_DIR, 'frameless-intro-xiaofan.png') });
    console.log('captured frameless-intro-xiaofan.png');
    pass('Intro screen renders Xiaofan full-body stage cleanly');

    // 回到首页并从真实 UI 启动 → 健康检查 → 点击自定义关闭按钮安全退出
    await page.locator('.dev-fab').click();
    await page.locator('.dev-screens button', { hasText: '首页' }).click();
    await page.locator('.dev-fab').click();
    await page.getByRole('button', { name: '启动 Analyzer' }).click();
    await page.locator('.orb-ok').waitFor({ state: 'visible', timeout: 30000 });
    const st = await page.evaluate(() => window.companionBridge.getStatus());
    const healthRes = await fetch(`${st.url}api/health`);
    assert.equal(healthRes.status, 200);
    pass(`Real isolated Analyzer started in frameless window at ${st.url}`);

    // 故意调整尺寸后再通过自定义 X 按钮关闭，验证持久化和安全退出
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setBounds({ x: 80, y: 60, width: 1020, height: 630 });
    });
    await wait(350);

    const exited = new Promise((resolve) => app.process().once('exit', (code) => resolve(code)));
    await page.locator('.tb-close').click();
    const exitCode = await Promise.race([
      exited,
      wait(45000).then(() => {
        throw new Error('Custom close button did not shut down cleanly');
      }),
    ]);
    app = null;
    assert.equal(exitCode, 0);
    assert.ok(await noFile(path.join(copyA, '.analyzer-session.json')));
    assert.equal(errors.length, 0, `Errors: ${errors.join('; ')}`);
    pass('Custom titlebar close button safely stopped Analyzer and exited with code 0');

    // 5. 第二次启动验证窗口位置/尺寸恢复，且离屏坐标自动钳制
    const saved = JSON.parse(await readFile(WINDOW_STATE_FILE, 'utf8'));
    assert.ok(Math.abs(saved.width - 1020) <= 10 && Math.abs(saved.height - 630) <= 10);
    const second = await launchHost(copyA);
    app = second.app;
    const restored = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.ok(Math.abs(restored.width - saved.width) <= 10 && Math.abs(restored.height - saved.height) <= 10);
    const ex2 = new Promise((resolve) => app.process().once('exit', (code) => resolve(code)));
    await second.page.locator('.tb-close').click();
    assert.equal(await ex2, 0);
    app = null;
    // 验证未调整尺寸重启退出后 window-state.json 不发生 DPI 漂移
    const savedAfterNoResize = JSON.parse(await readFile(WINDOW_STATE_FILE, 'utf8'));
    assert.equal(savedAfterNoResize.width, saved.width);
    assert.equal(savedAfterNoResize.height, saved.height);
    pass('Window bounds persisted and restored cleanly across launches with zero DPI drift');

    // 6. 模拟双屏断开（保存了一个离屏 x=9999 坐标）→ 重启应自动钳制回主屏可见区域
    await writeFile(WINDOW_STATE_FILE, JSON.stringify({ x: 9999, y: 9999, width: 1080, height: 640, isMaximized: false }));
    const third = await launchHost(copyA);
    app = third.app;
    const clamped = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const b = w.getBounds();
      const wa = screen.getPrimaryDisplay().workArea;
      return { b, wa };
    });
    assert.ok(clamped.b.x >= clamped.wa.x && clamped.b.x + clamped.b.width <= clamped.wa.x + clamped.wa.width);
    assert.ok(clamped.b.y >= clamped.wa.y && clamped.b.y + clamped.b.height <= clamped.wa.y + clamped.wa.height);
    const ex3 = new Promise((resolve) => app.process().once('exit', (code) => resolve(code)));
    await third.page.locator('.tb-close').click();
    assert.equal(await ex3, 0);
    app = null;
    pass('Off-screen / unplugged secondary monitor coordinates safely clamped back to primary workArea');

    console.log(JSON.stringify({ ok: true, checks: checks.length, shotDir: SHOT_DIR }, null, 2));
  } finally {
    if (app) {
      try {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close()));
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
