// Focused r2 ZIP acceptance. Synthetic identities only; never the formal Local.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { audit, json, sha256 } from './lib.mjs';
import { verify } from './portable/integrity.mjs';
import { chromium } from '@playwright/test';

const zip = resolve(process.argv[2] ?? ''); assert.ok(zip.endsWith('.zip') && existsSync(zip));
const work = mkdtempSync(join(dirname(zip), 'disconnect-acceptance-'));
const root = join(work, '分发退出 新用户'); mkdirSync(root);
const report = { startedAt: new Date().toISOString(), zipSha256: sha256(zip), checks: [], externalServices: false };
function check(name, condition = true) { assert.ok(condition, name); report.checks.push(name); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PATH|PATHEXT)$/i.test(k)));
let launcher, app, upstream, browser, db, releaseLate;
async function startLauncher() {
  const child = spawn(join(root, 'runtime/node.exe'), [join(root, 'launch.mjs'), '--no-browser', '--port=0'], { cwd: work, env: systemEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', ended = false;
  const log = join(work, `launcher-${report.checks.length}.log`);
  child.stdout.on('data', d => { output += d; writeFileSync(log, output); }); child.stderr.on('data', d => { output += d; writeFileSync(log, output); });
  const end = new Promise((yes, no) => { child.once('error', no); child.once('exit', code => { ended = true; yes(code); }); });
  launcher = { child, end };
  for (let i = 0; i < 160 && !ended; i++) {
    const match = /Analyzer ready: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
    if (match) { assert.notEqual(new URL(match[1]).port, '8787'); return match[1]; }
    await sleep(250);
  }
  throw new Error(`Portable launcher failed: ${output.slice(-2000)}`);
}
async function stopLauncher() {
  if (!launcher) return;
  launcher.child.stdin.write('\n'); let timer;
  const status = await Promise.race([launcher.end, new Promise((_, no) => { timer = setTimeout(() => no(new Error('Shutdown timeout; not force-killed')), 30000); })]).finally(() => clearTimeout(timer));
  launcher = undefined; assert.equal(status, 0);
}
try {
  const extraction = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${zip.replaceAll("'", "''")}','${root.replaceAll("'", "''")}')`], { encoding: 'utf8', windowsHide: true });
  assert.equal(extraction.status, 0, extraction.stderr);
  check('Clean r2 ZIP: no private data/config/credentials/links; hashes match; no initial data', audit(root).length > 100 && verify(root) > 100 && !existsSync(join(root, 'data')) && json(join(root, 'release.json')).distributionRevision === 2);
  let base = await startLauncher();
  check('Unmodified portable launcher enables runtime-only disconnect capability', (await (await fetch(base + '/api/config')).json()).canDisconnectBangumi === true);
  await stopLauncher();
  for (const key of Object.keys(process.env)) if (/^(BANGUMI_|AI_|HTTPS?_PROXY$)/i.test(key)) delete process.env[key];
  Object.assign(process.env, { BANGUMI_DISTRIBUTION: '1', BANGUMI_DATA_DIR: join(root, 'data'), HOST: '127.0.0.1', NODE_ENV: 'production' });
  const at = file => import(pathToFileURL(join(root, 'packages/server/dist', file)));
  const config = await at('config.js'); db = await at('db/index.js'); db.openDatabase();
  let holdPage = false, pageEntered = false;
  const requests = [];
  const owner = { id: 987654321, username: 'portable-user', nickname: 'Synthetic owner', avatar: {}, sign: '' };
  function subject(id) { return { id, type: 2, name: `Fixture isolated ${id}`, name_cn: `隔离收藏作品${id}`, summary: '分发验收中文简介。', nsfw: false, date: '2026-01-01', platform: 'TV', eps: 12, total_episodes: 12, images: {}, infobox: [], tags: [], rating: { rank: 0, total: 1, score: 7, count: {} }, collection: { wish: 0, collect: 1, doing: 0, on_hold: 0, dropped: 0 } }; }
  const rows = [1, 2].map(id => ({ subject_id: id, subject_type: 2, type: 2, rate: 8, ep_status: 12, vol_status: 0, private: false, comment: '', updated_at: '2026-11-22T00:00:00Z', tags: [], subject: subject(id) }));
  upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push(url.pathname);
    let payload;
    if (url.pathname === '/v0/me' || ['/v0/users/portable-user', '/v0/users/987654321'].includes(url.pathname)) payload = owner;
    else if (url.pathname === '/v0/users/other-user') payload = { ...owner, id: 222222, username: 'other-user' };
    else if (url.pathname === '/v0/users/portable-user/collections' || url.pathname === '/v0/users/987654321/collections') {
      if (holdPage) { pageEntered = true; await new Promise(r => { releaseLate = r; }); }
      payload = { total: 2, limit: 50, offset: Number(url.searchParams.get('offset')), data: Number(url.searchParams.get('offset')) ? [] : rows };
    } else if (/^\/v0\/subjects\/[12]$/.test(url.pathname)) payload = subject(Number(url.pathname.split('/').at(-1)));
    else { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  config.saveConfig({ username: owner.username, token: 'fixture-bangumi-token', nickname: '保留的本机昵称', onboardingSeen: true, cacheCovers: false, summaryAutoTranslate: false, requestIntervalMs: 0, ai: { enabled: false, apiKey: 'fixture-independent-ai-key', model: 'fixture-model' } });
  const { BangumiClient } = await at('bangumi/client.js'), { SyncEngine } = await at('sync/engine.js'), { CoverCache } = await at('images/coverCache.js'), { buildApp } = await at('app.js');
  const client = new BangumiClient({ token: '', userAgent: 'distribution-acceptance', requestIntervalMs: 0, httpProxy: '', baseUrl: `http://127.0.0.1:${upstream.address().port}`, maxRetries: 1 });
  const engine = new SyncEngine({ client, getConfig: config.loadConfig });
  app = await buildApp({ deps: { client, engine, coverCache: new CoverCache(client) }, logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, method = 'GET', body, status = 200) {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`); return value;
  }
  await api('/api/sync', 'POST', { mode: 'full', depth: 1 }, 202); await engine.whenIdle(); assert.equal(engine.getStatus().lastRun.status, 'success');
  const series = (await api('/api/series?includeSingletons=1')).series;
  const command = { action: 'create', title: '保留的人工家族', series: series.slice(0, 2).map(x => x.key) };
  const preview = await api('/api/manual-franchises/preview', 'POST', command); await api('/api/manual-franchises', 'POST', { command, token: preview.token });
  await api('/api/profile/snapshots', 'POST', { stageLabel: '保留的历史分析' }, 201);
  const backup = (await api('/api/data/backups', 'POST', {})).backup;
  const backupHash = sha256(join(root, 'data/backups', backup.fileName));
  const beforeConfig = config.loadConfig();
  function snapshot() { return Object.fromEntries(db.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").map(({ name }) => [name, db.all(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)])); }
  const before = snapshot();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
  await page.goto(base + '/settings?tab=bangumi'); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '断开 Bangumi 账号', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  check('Real Edge cancellation leaves credentials and database intact', config.loadConfig().token === beforeConfig.token);
  await page.getByLabel('Access Token', { exact: true }).fill('unsaved-fixture-token');
  await page.getByRole('button', { name: '验证 Token', exact: true }).click();
  await page.getByText(/认证成功：Synthetic owner/).first().waitFor();
  await page.getByRole('button', { name: '断开 Bangumi 账号', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认断开', exact: true }).click();
  await page.getByText('未绑定 Bangumi 账号', { exact: true }).first().waitFor();
  check('Real Edge confirms logout, clears account and unsaved Token, hides logout entry', await page.getByLabel('Access Token', { exact: true }).inputValue() === '' && await page.getByLabel('Bangumi 用户名（或数字 UID）').inputValue() === '' && await page.getByRole('button', { name: '断开 Bangumi 账号', exact: true }).count() === 0);
  assert.deepEqual(snapshot(), before); assert.deepEqual(config.loadConfig(), { ...beforeConfig, username: '', token: '' });
  check('Every DB table, ratings, manual governance, analysis snapshot, owner, backup and independent AI config preserved', sha256(join(root, 'data/backups', backup.fileName)) === backupHash);
  check('Credentials cleared on disk', json(join(root, 'data/config.json')).token === '' && json(join(root, 'data/config.json')).username === '');
  await page.screenshot({ path: join(work, 'settings-disconnected.png'), fullPage: true });
  const syncBlocked = await api('/api/sync', 'POST', { mode: 'full' }, 400); check('New sync rejected while unbound', syncBlocked.error.code === 'missing_username');
  await page.getByLabel('Bangumi 用户名（或数字 UID）').fill('other-user');
  const rejected = page.waitForResponse(response => response.url() === base + '/api/config' && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  check('Real Edge rejects cross-account binding with 409', (await rejected).status() === 409);
  assert.deepEqual(snapshot(), before); assert.equal(config.loadConfig().username, '');
  check('Other account never reaches collection fetch', !requests.some(path => path.includes('other-user/collections')));
  await page.getByLabel('Bangumi 用户名（或数字 UID）').fill('987654321');
  await page.getByLabel('Access Token', { exact: true }).fill('fixture-original-token');
  const rebound = page.waitForResponse(response => response.url() === base + '/api/config' && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await rebound).status(), 200);
  await api('/api/sync', 'POST', { mode: 'full', depth: 1 }, 202); await engine.whenIdle();
  check('Original UID rebind succeeds and full sync works', engine.getStatus().lastRun.status === 'success' && db.countRows('collections') === 2);
  const collections = db.all('SELECT * FROM collections');
  holdPage = true;
  await api('/api/sync', 'POST', { mode: 'full', depth: 1 }, 202);
  for (let i = 0; !pageEntered && i < 100; i++) await sleep(20); assert.ok(pageEntered);
  await page.getByRole('button', { name: '断开 Bangumi 账号', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认断开', exact: true }).click();
  await page.getByText('未绑定 Bangumi 账号', { exact: true }).first().waitFor();
  releaseLate?.(); releaseLate = undefined;
  check('Logout during actual HTTP sync cancels and drains it', !engine.running && engine.getStatus().lastRun.status === 'cancelled');
  assert.deepEqual(db.all('SELECT * FROM collections'), collections);
  check('Late response cannot replace retained collection data');
  await app.close(); app = undefined; db.closeDatabase();
  await new Promise(r => upstream.close(r)); upstream = undefined;
  base = await startLauncher();
  const persisted = await (await fetch(base + '/api/config')).json(), health = await (await fetch(base + '/api/health')).json();
  check('Official portable restart remains unbound with retained collections and AI key', persisted.canDisconnectBangumi && persisted.username === '' && !persisted.hasToken && persisted.ai.hasApiKey && health.collections === 2);
  await page.goto(base + '/me'); await page.waitForLoadState('networkidle');
  await page.getByText('未绑定 Bangumi 账号', { exact: true }).first().waitFor();
  await page.screenshot({ path: join(work, 'profile-unbound-after-restart.png'), fullPage: true });
  check('Settings/profile/sidebar consume unbound state without browser errors', errors.length === 0);
  await stopLauncher();
  check('Packaged application and original ZIP unchanged after acceptance', verify(root) > 100 && sha256(zip) === report.zipSha256);
  report.ok = true; report.browserErrors = errors; report.upstreamRequests = requests;
} catch (error) { report.ok = false; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  releaseLate?.();
  try { if (app) await app.close(); db?.closeDatabase(); } catch (e) { report.cleanupError = String(e); }
  if (upstream) await new Promise(r => upstream.close(r));
  await browser?.close();
  try { await stopLauncher(); } catch (e) { report.cleanupError = String(e); }
  report.finishedAt = new Date().toISOString(); writeFileSync(join(work, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, work, checks: report.checks.length, error: report.error }));
}
