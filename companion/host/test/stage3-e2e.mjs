import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REPO = resolve('.');
const require = createRequire(join(REPO, 'package.json'));
const { _electron: electron } = require('@playwright/test');
const ELECTRON_EXE = join(REPO, 'companion/host/node_modules/electron/dist/electron.exe');
const MAIN_SCRIPT = join(REPO, 'companion/host/main.mjs');
const WORK_BASE = join(REPO, 'companion/host/.work');
const SHOTS = resolve(process.env.STAGE3_SHOTS_DIR || join(WORK_BASE, 'stage3-verify'));

await mkdir(WORK_BASE, { recursive: true });
await mkdir(SHOTS, { recursive: true });

const homeDir = await mkdtemp(join(WORK_BASE, 'stage3-home-'));
const lockedDir = await mkdtemp(join(WORK_BASE, 'stage3-locked-'));
const cleanDir = await mkdtemp(join(WORK_BASE, 'stage3-clean-'));

// Spawn a real dummy process to simulate a live external Analyzer holding lockedDir
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)'], { windowsHide: true });
await writeFile(join(lockedDir, '.analyzer-session.json'), JSON.stringify({ launcherPid: sleeper.pid, servicePid: sleeper.pid }));

let app;
try {
  // 1. Test Step 05 failure recovery, non-overlapping layout, Back & Change Dir, and clean valid install
  app = await electron.launch({
    executablePath: ELECTRON_EXE,
    args: [MAIN_SCRIPT, '--mode', 'product', '--companionHome', homeDir],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.intro, .home, .setup', { timeout: 15000 });

  // Jump through Step 01 -> Step 02
  if (await win.locator('.intro').isVisible().catch(() => false)) {
    await win.getByRole('button', { name: /开始首次设置|立即开始|开始/ }).first().click();
  }
  await win.waitForSelector('.step', { timeout: 10000 });
  // Wait for Step 01 Env checks to complete
  await win.getByRole('button', { name: /下一步|继续/ }).first().waitFor({ state: 'visible', timeout: 15000 });
  await win.waitForFunction(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /下一步|继续/.test(b.textContent || ''));
    return btn && !btn.disabled;
  }, null, { timeout: 15000 });
  await win.getByRole('button', { name: /下一步|继续/ }).first().click();

  // Step 02: Verify lockedDir is immediately flagged as error at Step 02
  const dirInput = win.locator('.dir-field input');
  await dirInput.waitFor({ state: 'visible', timeout: 10000 });
  await dirInput.fill(lockedDir);
  await win.waitForTimeout(450);
  const lockedVerdictText = await win.locator('.verdict').innerText();
  const useBtnDisabled = await win.getByRole('button', { name: '使用此位置' }).isDisabled();
  console.log('[Step 02 Active Lock Check]', { useBtnDisabled, verdict: lockedVerdictText.replace(/\s+/g, ' ').slice(0, 120) });
  if (!useBtnDisabled) throw new Error('Expected Step 02 to block active external SESSION_LOCKED directory');

  // Now pick cleanDir so we can pass Step 02 -> 03 -> 04, then place an active lock into cleanDir right before Step 05 to test real Step 05 failure recovery!
  await dirInput.fill(cleanDir);
  await win.waitForTimeout(450);
  await win.getByRole('button', { name: '使用此位置' }).click();

  // Step 03: Skip account
  await win.getByRole('button', { name: /稍后再绑定|跳过/ }).first().click();
  // Step 04: Wait & place active lock into cleanDir right before clicking Next to reproduce Step 05 SESSION_LOCKED!
  await writeFile(join(cleanDir, '.analyzer-session.json'), JSON.stringify({ launcherPid: sleeper.pid, servicePid: sleeper.pid }));
  await win.getByRole('button', { name: /跳过|开始初始化|下一步/ }).first().click();

  // Step 05: Should fail cleanly with SESSION_LOCKED and show recovery buttons
  await win.locator('.init-error').waitFor({ state: 'visible', timeout: 15000 });
  const errText = await win.locator('.init-error').innerText();
  console.log('[Step 05 Failure UI]', errText.replace(/\s+/g, ' '));
  if (!errText.includes('SESSION_LOCKED')) throw new Error(`Expected SESSION_LOCKED in init-error, got: ${errText}`);

  // Open LogConsole and verify ZERO bounding-box overlap between .init-body, .init-error, .console, and .step-foot!
  await win.getByRole('button', { name: /运行日志/ }).click();
  await win.locator('.console').waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(250);
  const layout = await win.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    return {
      body: rect('.init-body'),
      err: rect('.init-error'),
      log: rect('.console'),
      foot: rect('.step-foot'),
      railDirDisabled: document.querySelectorAll('.rail-step-btn')[1]?.disabled ?? true,
    };
  });
  console.log('[Step 05 Layout & Rail Unlock]', layout);
  if (layout.body.bottom > layout.err.top + 2) throw new Error(`Overlap: init-body bottom ${layout.body.bottom} > init-error top ${layout.err.top}`);
  if (layout.err.bottom > layout.log.top + 2) throw new Error(`Overlap: init-error bottom ${layout.err.bottom} > console top ${layout.log.top}`);
  if (layout.log.bottom > layout.foot.top + 2) throw new Error(`Overlap: console bottom ${layout.log.bottom} > foot top ${layout.foot.top}`);
  if (layout.railDirDisabled) throw new Error('Expected rail step 02 button to unlock after Step 05 failure');

  await win.screenshot({ path: join(SHOTS, 'step05-session-locked-recovery.png') });

  // Click "更换安装目录" -> returns to Step 02 -> pick a fresh valid dir -> retry -> completes!
  const freshDir = await mkdtemp(join(WORK_BASE, 'stage3-fresh-'));
  await win.getByRole('button', { name: '更换安装目录' }).click();
  await dirInput.waitFor({ state: 'visible', timeout: 8000 });
  await dirInput.fill(freshDir);
  await win.waitForTimeout(450);
  await win.getByRole('button', { name: '使用此位置' }).click();
  await win.getByRole('button', { name: /稍后再绑定|跳过/ }).first().click();
  await win.getByRole('button', { name: /跳过|开始初始化|下一步/ }).first().click();

  // Wait for Ready screen (install + start Analyzer + finishFirstRun succeeded!)
  await win.waitForSelector('.ready-page, .home', { timeout: 60000 });
  console.log('[Stage 3.1 Recovery -> Clean Install] PASSED');

  // Navigate to Home to test Stage 3.2 (105+ randomized Xiaofan interactions + visual captures)
  if (await win.locator('.ready-page').isVisible().catch(() => false)) {
    await win.getByRole('button', { name: /前往 Companion 首页|进入桌面助手|进入首页/ }).first().click();
  }
  await win.waitForSelector('.home', { timeout: 15000 });
  await win.waitForSelector('.mascot-live2d-wrap.ready', { timeout: 15000 });
  await win.waitForTimeout(600);

  const stateBefore = await win.locator('canvas.mascot-live2d-canvas').getAttribute('data-director-state');
  console.log('[Stage 3.2] Initial business state:', stateBefore);

  // Sample 105 interactions spaced 220ms apart (> 180ms guard) & capture screenshots for each unique variant
  const seenVariants = new Set();
  const sequence = [];
  const counts = {};
  let minTriSeen = 1.0;

  for (let i = 0; i < 105; i++) {
    await win.locator('.hr-poke').click();
    await win.waitForTimeout(230);
    const snap = await win.evaluate(() => {
      const c = document.querySelector('canvas.mascot-live2d-canvas');
      return {
        state: c?.dataset.directorState || '',
        active: c?.dataset.activeInteraction || '',
        last: c?.dataset.lastInteraction || '',
        count: Number(c?.dataset.interactionCount || 0),
        exp: c?.dataset.directorExpression || '',
        minTri: Number(c?.dataset.minTriRatio || 1),
      };
    });
    if (snap.state !== stateBefore) {
      throw new Error(`Business state mutated during interaction #${i}: ${stateBefore} -> ${snap.state}`);
    }
    if (!snap.last) throw new Error(`Missing lastInteraction on click #${i}`);
    sequence.push(snap.last);
    counts[snap.last] = (counts[snap.last] || 0) + 1;
    if (Number.isFinite(snap.minTri) && snap.minTri > 0) minTriSeen = Math.min(minTriSeen, snap.minTri);

    if (!seenVariants.has(snap.last)) {
      seenVariants.add(snap.last);
      // Wait 350ms for smooth pose settle before capturing this variant visually
      await win.waitForTimeout(350);
      await win.locator('.home-right').screenshot({ path: join(SHOTS, `interact-${snap.last}.png`) });
    }
  }

  // Check consecutive repeats & diversity
  let immediateRepeats = 0;
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] === sequence[i - 1]) immediateRepeats++;
  }
  console.log('[Stage 3.2 105-Sample Results]', {
    samples: sequence.length,
    uniqueVariants: seenVariants.size,
    immediateRepeats,
    minTriSeen,
    counts,
  });
  if (seenVariants.size < 7) throw new Error(`Expected all 7 variants, got ${seenVariants.size}: ${[...seenVariants].join(',')}`);
  if (immediateRepeats > 0) throw new Error(`Expected 0 immediate repeats, got ${immediateRepeats}`);

  // Rapid-click burst stress test (10 clicks 40ms apart) + verify restoration to business state after 3.2s
  for (let k = 0; k < 10; k++) {
    await win.locator('.hr-poke').click();
    await win.waitForTimeout(40);
  }
  await win.waitForTimeout(3400);
  const afterBurst = await win.evaluate(() => {
    const c = document.querySelector('canvas.mascot-live2d-canvas');
    return {
      state: c?.dataset.directorState || '',
      active: c?.dataset.activeInteraction || '',
      minTri: Number(c?.dataset.minTriRatio || 1),
    };
  });
  console.log('[Stage 3.2 Post-Burst Restoration]', afterBurst);
  if (afterBurst.state !== stateBefore) throw new Error(`State did not stay ${stateBefore}: got ${afterBurst.state}`);
  if (afterBurst.active !== '') throw new Error(`Interaction did not expire cleanly: active=${afterBurst.active}`);

  // Graceful stop & close
  await win.evaluate(() => window.companionWindow?.close());
  await app.close();
  app = null;
  await rm(freshDir, { recursive: true, force: true });
  console.log('ALL STAGE 3 E2E CHECKS PASSED!');
} finally {
  if (app) await app.close().catch(() => {});
  sleeper.kill();
  await rm(homeDir, { recursive: true, force: true }).catch(() => {});
  await rm(lockedDir, { recursive: true, force: true }).catch(() => {});
  await rm(cleanDir, { recursive: true, force: true }).catch(() => {});
}
