/**
 * Companion M0 端到端交互验证与截图采集脚本
 * 用法：在 companion/ui 下执行 `node scripts/screenshots.mjs`
 *
 * 行为：
 *   1. 启动本地 vite preview（127.0.0.1:5291）
 *   2. 完整走通 欢迎演出 → 环境检查 → 安装目录 → 账号 → AI → 初始化 → 完成 → 进入 Analyzer → 日常启动 → 首页
 *   3. 验证模拟报错、断点重试恢复、服务启停、主题切换、模拟控制台
 *   4. 输出截图到 companion/ui/screenshots/，并校验零 console.error / pageerror
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(UI_DIR, 'screenshots');
const require = createRequire(path.resolve(UI_DIR, '../../package.json'));
const { chromium } = require('@playwright/test');

const PORT = 5291;
const BASE = `http://127.0.0.1:${PORT}/`;

function startServer() {
  const viteBin = path.join(UI_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: UI_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite preview timeout')), 10000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes(String(PORT))) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => {
      const txt = d.toString();
      if (txt.toLowerCase().includes('error')) console.error('[vite]', txt);
    });
  });
}

async function run() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const server = await startServer();
  const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
  const errors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1320, height: 840 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });

    const shot = async (name) => {
      if (await page.locator('.bubble').count()) {
        await page.waitForSelector('.bubble .caret.done', { timeout: 4500 }).catch(() => {});
      }
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
      console.log(`captured ${name}.png`);
    };

    // 1. 欢迎演出（带 4x 加速，完整走到第4幕）
    await page.goto(`${BASE}?speed=4`);
    await page.waitForSelector('.intro.ph-4', { timeout: 5000 });
    await page.waitForTimeout(450);
    await shot('01-intro');

    // 2. 环境检查（正常通过）
    await page.getByRole('button', { name: /开始设置/ }).click();
    await page.waitForSelector('.env-summary.v-ok', { timeout: 6000 });
    await shot('02-env-ok');

    // 3. 打开模拟控制台 → 切换端口占用 → 重新检测验证报错态 → 再切回正常并重试恢复
    await page.locator('.dev-fab').click();
    await page.locator('.dev-row', { hasText: '环境检查' }).getByRole('button', { name: '端口占用' }).click();
    await page.locator('.dev-fab').click();
    await page.getByRole('button', { name: '重新检测' }).click();
    await page.waitForSelector('.env-summary.v-fail', { timeout: 6000 });
    await shot('03-env-error');

    // 恢复：由于 recoverOnRetry 默认开启，点「仅重测失败项」即可自动恢复通过
    await page.getByRole('button', { name: '仅重测失败项' }).click();
    await page.waitForSelector('.env-summary.v-ok', { timeout: 6000 });
    await page.locator('.dev-fab').click();
    await page.locator('.dev-row', { hasText: '环境检查' }).getByRole('button', { name: '全部通过' }).click();
    await page.locator('.dev-fab').click();

    // 4. 安装目录
    await page.getByRole('button', { name: /继续/ }).click();
    await page.waitForSelector('.verdict.lv-ok', { timeout: 3000 });
    await shot('04-dir');

    // 5. Bangumi 账号引导（填写并验证成功）
    await page.getByRole('button', { name: /使用此位置/ }).click();
    await page.getByPlaceholder('例如 sai 或 123456').fill('sai');
    await page.getByRole('button', { name: '验证账号' }).click();
    await page.waitForSelector('.profile-card', { timeout: 5000 });
    await shot('05-account-verified');

    // 6. 可选 AI 配置（填写测试 Key 并测试连接成功）
    await page.getByRole('button', { name: /继续/ }).click();
    await page.getByPlaceholder('sk-…').fill('sk-demo-test-key-0001');
    await page.getByRole('button', { name: '测试连接' }).click();
    await page.waitForSelector('.banner-ok', { timeout: 5000 });
    await shot('06-ai');

    // 7. 初始化与同步进度（先演示 429 限流中断与断点恢复）
    await page.locator('.dev-fab').click();
    await page.locator('.dev-row', { hasText: '初始化 / 同步' }).getByRole('button', { name: '429 限流' }).click();
    await page.locator('.dev-fab').click();

    await page.getByRole('button', { name: /保存并继续/ }).click();
    await page.waitForSelector('.stage.st-running', { timeout: 4000 });
    await page.waitForTimeout(450);
    await shot('07-init-running');

    await page.waitForSelector('.init-error', { timeout: 10000 });
    await shot('08-init-error');

    // 从断点继续 → 自动完成并进入 Ready
    await page.getByRole('button', { name: '从断点继续' }).click();
    await page.waitForSelector('.ready-card', { timeout: 15000 });
    await shot('09-ready');

    // 8. 进入 Analyzer
    await page.getByRole('button', { name: /进入 Analyzer/ }).click();
    await page.waitForSelector('.analyzer-preview', { timeout: 8000 });
    await shot('10-launch');

    // 9. 进入日常首页（运行中）
    await page.getByRole('button', { name: '进入 Companion 日常首页' }).click();
    await page.waitForSelector('.home-hero', { timeout: 4000 });
    await page.waitForTimeout(300);
    await shot('12-home-running');

    // 10. 浅色主题验证
    await page.locator('.tb-btn[title*="浅色"]').click();
    await page.waitForTimeout(250);
    await shot('13-home-light');
    await page.locator('.tb-btn[title*="深色"]').click();

    // 11. 首页安全停止 + 驱动失败 + 日志面板验证
    await page.getByRole('button', { name: '安全停止' }).click();
    await page.waitForSelector('.orb-idle', { timeout: 5000 });

    await page.locator('.dev-fab').click();
    await page.locator('.dev-row', { hasText: 'Analyzer 驱动' }).getByRole('button', { name: '启动失败' }).click();
    await page.locator('.dev-fab').click();

    await page.getByRole('button', { name: /启动 Analyzer/ }).click();
    await page.waitForSelector('.orb-err', { timeout: 5000 });
    await page.getByRole('tab', { name: /运行日志/ }).click();
    await shot('14-home-error-logs');

    // 重试恢复运行
    await page.getByRole('button', { name: '重试启动 Analyzer' }).click();
    await page.waitForSelector('.orb-ok', { timeout: 5000 });

    // 12. 预览日常启动演出 (Splash) — 在自动跳转至首页前抓拍
    await page.getByRole('tab', { name: /启动与偏好/ }).click();
    await page.getByRole('button', { name: '预览日常启动' }).click();
    await page.waitForSelector('.splash-card', { timeout: 4000 });
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(OUT_DIR, '11-splash.png') });
    console.log('captured 11-splash.png');

    // 13. 紧凑桌面窗口适配校验 (1024x700)：确保无横向溢出且站娘保留可见
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.goto(`${BASE}?screen=home&speed=4`);
    await page.waitForSelector('.home-hero', { timeout: 4000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error('Horizontal overflow detected at 1024x700');
    await shot('15-home-compact-1024');

    // 14. Codex Driver 无桥接保护校验 (?driver=codex 未注入 bridge 时必报 BRIDGE_UNAVAILABLE)
    await page.setViewportSize({ width: 1320, height: 840 });
    await page.goto(`${BASE}?driver=codex&screen=home`);
    await page.waitForSelector('.codex-tag.lost', { timeout: 4000 });
    const hasBridgeError = await page.locator('.init-error', { hasText: 'BRIDGE_UNAVAILABLE' }).count();
    if (!hasBridgeError) throw new Error('Expected BRIDGE_UNAVAILABLE when window.companionBridge is absent');

    // 15. Codex Host Bridge v1 契约联调测试（严格对齐 companion/host/bridge.d.ts）
    const codexCtx = await browser.newContext({ viewport: { width: 1320, height: 840 }, deviceScaleFactor: 1 });
    const cPage = await codexCtx.newPage();
    cPage.on('pageerror', (e) => errors.push(`codex pageerror: ${e.message}`));
    cPage.on('console', (m) => {
      if (m.type() === 'error') errors.push(`codex console.error: ${m.text()}`);
    });
    await cPage.addInitScript(() => {
      let rev = 1;
      let state = 'unknown';
      let rtState = 'idle';
      let pkgState = 'unknown';
      let ownsProcess = false;
      let url = null;
      let port = null;
      let stopTried = 0;
      const statusListeners = new Set();
      const logListeners = new Set();
      const logs = [{ seq: 1, at: new Date().toISOString(), level: 'info', event: 'supervisor.init' }];
      const snap = (err = null) => ({
        state,
        url,
        port,
        pid: null,
        version: '2.0.0',
        startedAt: null,
        dataDir: null,
        error: err,
        revision: rev++,
        runtime: { state: rtState, ownsProcess, packageState: pkgState },
      });
      const emit = (err = null) => {
        const s = snap(err);
        statusListeners.forEach((cb) => cb(s));
        logListeners.forEach((cb) => cb([...logs]));
        return s;
      };
      window.companionBridge = {
        bridgeVersion: 1,
        async getStatus() {
          return snap();
        },
        async getLogs() {
          return [...logs];
        },
        async startAnalyzer() {
          state = 'starting';
          rtState = 'checking';
          pkgState = 'checking';
          ownsProcess = true;
          logs.push({ seq: 2, at: new Date().toISOString(), level: 'info', event: 'package.check.start' });
          emit();
          await new Promise((r) => setTimeout(r, 120));
          rtState = 'starting';
          pkgState = 'valid';
          logs.push({ seq: 3, at: new Date().toISOString(), level: 'info', event: 'service.spawn' });
          emit();
          await new Promise((r) => setTimeout(r, 120));
          state = 'running';
          rtState = 'ready';
          port = 19091;
          url = 'http://127.0.0.1:19091/';
          logs.push({ seq: 4, at: new Date().toISOString(), level: 'info', event: 'service.ready' });
          return emit();
        },
        async openAnalyzer() {
          return {
            opened: false,
            url: '',
            error: {
              code: 'UNKNOWN',
              runtimeCode: 'OPEN_FAILED',
              message: '系统默认浏览器命令退出码非 0',
              hint: '服务仍在运行，请复制上方本机地址手动打开。',
            },
          };
        },
        async stopAnalyzer() {
          stopTried += 1;
          if (stopTried === 1) {
            state = 'error';
            rtState = 'failed';
            ownsProcess = true;
            logs.push({ seq: 5, at: new Date().toISOString(), level: 'error', event: 'service.stop.STOP_TIMEOUT' });
            return emit({
              code: 'TIMEOUT',
              runtimeCode: 'STOP_TIMEOUT',
              message: '安全停止超时，子进程仍在退出',
              hint: '请勿强行结束，点击重试安全停止。',
            });
          }
          state = 'stopped';
          rtState = 'stopped';
          ownsProcess = false;
          url = null;
          port = null;
          logs.push({ seq: 6, at: new Date().toISOString(), level: 'info', event: 'service.stopped' });
          return emit();
        },
        onStatus(cb) {
          statusListeners.add(cb);
          cb(snap());
          return () => statusListeners.delete(cb);
        },
        onLogs(cb) {
          logListeners.add(cb);
          cb([...logs]);
          return () => logListeners.delete(cb);
        },
      };
    });
    await cPage.goto(`${BASE}?driver=codex&screen=home`);
    await cPage.waitForSelector('.codex-tag:not(.lost)', { timeout: 4000 });
    // 验证在 Codex 模式下隐藏了 mock 窗口控制与假同步按钮
    if ((await cPage.locator('.tb-close').count()) !== 0) throw new Error('Mock close button should be hidden in codex mode');
    await cPage.getByRole('button', { name: '启动 Analyzer' }).click();
    await cPage.waitForSelector('.orb-ok', { timeout: 6000 });
    await cPage.getByRole('button', { name: '打开 Analyzer 网页端' }).click();
    await cPage.waitForSelector('.banner-warn', { timeout: 3000 });
    await cPage.getByRole('tab', { name: /运行日志/ }).click();
    await cPage.waitForTimeout(300);
    await cPage.screenshot({ path: path.join(OUT_DIR, '16-codex-bridge-openfail.png') });
    console.log('captured 16-codex-bridge-openfail.png');
    await cPage.getByRole('button', { name: '安全停止' }).click();
    await cPage.waitForSelector('.orb-err', { timeout: 3000 });
    await cPage.getByRole('button', { name: '重试安全停止' }).click();
    await cPage.waitForSelector('.orb-idle', { timeout: 3000 });
    await codexCtx.close();

    if (errors.length) {
      throw new Error(`Browser errors detected:\n${errors.join('\n')}`);
    }
    console.log('ALL INTERACTIVE CHECKS & SCREENSHOTS PASSED!');
  } finally {
    await browser.close();
    server.kill();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
