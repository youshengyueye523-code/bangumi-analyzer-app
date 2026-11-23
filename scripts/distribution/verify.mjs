// Run against a ZIP, never against the workspace or an existing Local installation.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, json, sha256 } from './lib.mjs';
import { verify } from './portable/integrity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const zip = resolve(process.argv[2] ?? '');
assert.ok(zip.endsWith('.zip') && existsSync(zip), 'Pass the clean distribution ZIP');
const work = mkdtempSync(join(dirname(zip), 'acceptance-'));
const root = join(work, '全新用户 空格 & 离线'); mkdirSync(root);
const report = { startedAt: new Date().toISOString(), zipSha256: sha256(zip), extraction: root, checks: [], realExternalServices: false };
let active;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PATHEXT)$/i.test(k)));
env.PATH = join(process.env.SystemRoot, 'System32');
const delay = ms => new Promise(r => setTimeout(r, ms));
function check(name, value = true) { assert.ok(value, name); report.checks.push(name); }
async function launch(expectedCount = 0, port = 0) {
  const trap = join(work, 'must-not-be-created');
  const child = spawn(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/c', 'Start-Analyzer.bat', '--no-browser', `--port=${port}`], {
    cwd: root, env: { ...env, BANGUMI_DATA_DIR: trap, BANGUMI_USERNAME: 'must-not-inherit', AI_API_KEY: 'fixture-do-not-inherit', AI_ENABLED: 'true', HOST: '0.0.0.0', PORT: '8787' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', exited = false;
  const logFile = join(work, `launch-${report.checks.length}.log`);
  child.stdout.on('data', d => { output += d; writeFileSync(logFile, output); }); child.stderr.on('data', d => { output += d; writeFileSync(logFile, output); });
  const ended = new Promise((yes, no) => { child.once('error', no); child.once('exit', code => { exited = true; yes(code); }); });
  const instance = { child, ended, async stop() {
    child.stdin.write('\n');
    let timer;
    const status = await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Graceful stop timed out; no process was killed')), 30000); })]).finally(() => clearTimeout(timer));
    writeFileSync(logFile, output);
    assert.equal(status, 0, output.slice(-3000)); assert.match(output, /Stopped\./);
    active = undefined;
  } };
  active = instance;
  for (let i = 0; i < 240 && !exited; i++) {
    const match = /Analyzer ready: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
    if (match) {
      instance.base = match[1];
      const health = await (await fetch(instance.base + '/api/health')).json();
      assert.equal(health.version, '2.0.0'); assert.equal(health.ok, true);
      assert.equal(health.collections, expectedCount); assert.equal(resolve(health.dataDir), join(root, 'data'));
      assert.notEqual(new URL(instance.base).port, '8787');
      assert.equal(existsSync(trap), false);
      return instance;
    }
    await delay(250);
  }
  writeFileSync(logFile, output); throw new Error(`Launcher did not become ready: ${output.slice(-3500)}`);
}
async function api(instance, path, options) {
  const res = await fetch(instance.base + path, options);
  assert.equal(res.status, 200, path); return res.json();
}
try {
  const extract = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${zip.replaceAll("'", "''")}','${root.replaceAll("'", "''")}')`], { encoding: 'utf8', windowsHide: true });
  assert.equal(extract.status, 0, extract.stderr);
  check('ZIP extracted with Unicode, spaces and ampersand path');
  check('No links, private data, config, backups, logs, sourcemaps or credential pattern in clean ZIP', audit(root).length > 100);
  check('Complete file checksums match ZIP', verify(root) > 100);
  check('No data exists before first start', !existsSync(join(root, 'data')));
  const first = await launch();
  check('BAT first start succeeds without system Node/pnpm/Git; zero collections; isolated data; inherited credentials ignored');
  const config = await api(first, '/api/config');
  check('Default account/profile/AI/proxy are empty and AI disabled', config.username === '' && config.nickname === '' && !config.hasToken && !config.ai.enabled && !config.ai.hasApiKey && config.httpProxy === '');
  const onboard = await api(first, '/api/profile/local');
  check('First-run onboarding visible and sync not pre-completed', !onboard.seen && !onboard.steps.find(x => x.id === 'sync').done);
  const { chromium } = await import('@playwright/test');
  const initialBrowser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await initialBrowser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.route('**/*', route => route.request().url().startsWith(first.base + '/') ? route.continue() : route.abort());
    await page.goto(first.base + '/'); await page.waitForLoadState('networkidle');
    assert.match(await page.locator('body').innerText(), /开始建立你的本地动画数据库|配置 Bangumi 账号/);
    await page.screenshot({ path: join(work, 'browser-first-run.png'), fullPage: true });
    check('Real Edge displays first-run guidance from empty database');
  } finally { await initialBrowser.close(); }
  const html = await (await fetch(first.base + '/')).text(); assert.match(html, /<div id="root">/);
  for (const asset of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) {
    const res = await fetch(first.base + asset[1]); assert.equal(res.status, 200); assert.ok((await res.arrayBuffer()).byteLength);
  }
  for (const path of ['/api/subjects', '/api/series', '/api/franchises', '/api/stats/dashboard', '/api/profile/dataset', '/api/diagnostics?refresh=1', '/api/data/integrity']) await api(first, path);
  check('Empty database read APIs, SPA and actual JS/CSS assets load');
  const updated = await api(first, '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: '独立新用户', onboardingSeen: true }) });
  check('Full Local config writes enabled (not Demo)', updated.nickname === '独立新用户');
  // A second copy of the launcher must not kill or connect to an unrelated instance.
  const second = spawn(join(root, 'runtime/node.exe'), [join(root, 'launch.mjs'), '--no-browser', '--port=0'], { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let secondOutput = ''; second.stderr.on('data', d => { secondOutput += d; }); second.stdout.on('data', d => { secondOutput += d; });
  const secondCode = await new Promise((yes, no) => { second.once('exit', yes); second.once('error', no); });
  check('Duplicate launcher fails safely without stopping first instance', secondCode === 1 && /already be running/.test(secondOutput) && (await api(first, '/api/health')).ok);
  await first.stop(); check('Enter triggers official graceful shutdown and clears session lock', !existsSync(join(root, '.analyzer-session.json')));
  const fixtureEnv = { ...env, BANGUMI_DATA_DIR: join(root, 'data'), HOST: '127.0.0.1', NODE_ENV: 'production' };
  const fixture = spawnSync(join(root, 'runtime/node.exe'), [join(here, 'sync-fixture.mjs'), root, join(work, 'sync-fixture.json')], { cwd: work, env: fixtureEnv, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(work, 'sync-fixture.log'), (fixture.stdout ?? '') + (fixture.stderr ?? ''));
  assert.equal(fixture.status, 0, `${fixture.error ?? ''}\n${fixture.stderr}\n${fixture.stdout}`);
  check('Shipped modules sync 51 synthetic upstream items over loopback HTTP and pass writable functional checks', json(join(work, 'sync-fixture.json')).ok);
  const restarted = await launch(51);
  check('After restart, personal config and 51 collections persist', (await api(restarted, '/api/config')).nickname === '隔离新用户');
  // Use the installed browser only for acceptance; no browser or test tooling is shipped.
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(restarted.base + '/') ? route.continue() : route.abort());
    for (const path of ['/', '/library', '/series', '/franchises', '/diagnostics', '/settings?tab=about']) {
      await page.goto(restarted.base + path); await page.waitForLoadState('networkidle');
      const text = await page.locator('body').innerText(); assert.ok(text.length > 120, path);
      assert.equal(new URL(page.url()).pathname, new URL(restarted.base + path).pathname);
      if (path.includes('about')) assert.match(text, /2\.0\.0/);
    }
    await page.screenshot({ path: join(work, 'browser-about.png'), fullPage: true });
    await page.goto(restarted.base + '/library'); await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(work, 'browser-library.png'), fullPage: true });
    assert.deepEqual(errors, []);
    report.browser = { engine: 'Edge headless', pages: 6, pageErrors: errors, externalRequestsBlocked: true };
    check('Real Edge renders relocated offline UI and v2.0.0 without page errors');
  } finally { await browser.close(); }
  await restarted.stop();
  const occupied = createServer(); await new Promise(r => occupied.listen(0, '127.0.0.1', r));
  try {
    const other = occupied.address().port, fallback = await launch(51, other);
    check('Occupied port falls back without touching incumbent', Number(new URL(fallback.base).port) !== other && occupied.listening);
    await fallback.stop();
  } finally { await new Promise(r => occupied.close(r)); }
  check('Application bytes unchanged after first run, sync and restart', verify(root) > 100);
  check('Original ZIP hash unchanged after acceptance', sha256(zip) === report.zipSha256);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(root, 'data/bangumi.db'), { readOnly: true });
  try {
    check('Final persisted DB: Schema 15, 51 collections, integrity ok, no FK violations', db.prepare('PRAGMA user_version').get().user_version === 15 && db.prepare('SELECT COUNT(*) AS n FROM collections').get().n === 51 && db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' && db.prepare('PRAGMA foreign_key_check').all().length === 0);
  } finally { db.close(); }
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  if (active) { try { await active.stop(); } catch (e) { report.shutdownError = String(e); } }
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(work, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, work, checks: report.checks.length, error: report.error }));
}
