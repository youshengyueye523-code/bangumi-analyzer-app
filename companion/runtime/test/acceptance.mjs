// Narrow, real r2 acceptance. Never run a checkout's server, installed Local or an existing data copy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AnalyzerSupervisor, openDefaultBrowser, serviceEnvironment } from '../supervisor.mjs';
import { checkPackage, sha256 } from '../package-check.mjs';
import { delay, extract, ready, runtime, sourceCheck, work, zip, zipHash } from './helpers.mjs';

const dir = await work('r2-acceptance');
const report = { startedAt: new Date().toISOString(), kind: 'real-independent-r2-empty-databases',
  zipSha256: zipHash, checks: [], externalBangumi: false, paidAI: false, local8787Access: false,
  browserHandoff: 'not requested', work: dir };
const check = (name, condition = true) => { assert.ok(condition, name); report.checks.push(name); console.log('PASS ' + name); };
const missing = async file => { try { await access(file); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } };
const active = [];
let transport, standalone;

async function api(url, path, options) {
  assert.equal(new URL(url).hostname, '127.0.0.1'); assert.notEqual(new URL(url).port, '8787');
  const res = await fetch(url + path, { ...options, signal: AbortSignal.timeout(3000), redirect: 'error' });
  assert.equal(res.status, 200); return res.json();
}
async function transportTest(root) {
  const child = spawn(join(root, 'runtime/node.exe'), [join(runtime, 'cli.mjs'), '--packageRoot', root], {
    cwd: dir, windowsHide: true, env: serviceEnvironment(root, 0), stdio: ['pipe', 'pipe', 'pipe'],
  });
  transport = child;
  const responses = [], waiting = new Map(); let buffer = '', seq = 0;
  child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      const response = JSON.parse(line); responses.push(response);
      if (waiting.has(response.id)) { waiting.get(response.id)(response); waiting.delete(response.id); }
    }
  });
  const ended = new Promise((yes, no) => { child.once('error', no); child.once('exit', yes); });
  const send = method => {
    const id = ++seq;
    const result = new Promise((yes, no) => {
      const timer = setTimeout(() => { waiting.delete(id); no(new Error('JSONL response timeout')); }, 15000);
      waiting.set(id, value => { clearTimeout(timer); yes(value); });
    });
    child.stdin.write(JSON.stringify({ id, method }) + '\n'); return result;
  };
  assert.equal((await send('getStatus')).status.state, 'idle');
  assert.equal((await send('openAnalyzer')).error.code, 'NOT_READY');
  child.stdin.write('{"id":"PRIVATE_CANARY","method":"run","command":"SECRET_CANARY"}\n');
  child.stdin.write('x'.repeat(5000) + '\n');
  await send('getStatus');
  assert.ok(responses.filter(x => x.error?.code === 'INVALID_REQUEST').length >= 2);
  const start = await send('startAnalyzer'); assert.ok(start.ok); assert.equal(start.status.state, 'starting');
  let status;
  for (let i = 0; i < 200; i++) {
    status = (await send('getStatus')).status;
    if (status.state === 'ready') break;
    assert.notEqual(status.state, 'failed'); await delay(50);
  }
  assert.equal(status.state, 'ready');
  const health = await api(status.url, 'api/health'); assert.equal(health.collections, 0);
  child.stdin.end();
  let timer;
  const exit = await Promise.race([ended, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('JSONL EOF shutdown timeout; no process killed')), 40000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(exit, 0); transport = null;
  assert.ok(responses.some(x => x.event === 'transportClosing' && x.status.state === 'stopped'));
  assert.ok(!/PRIVATE_CANARY|SECRET_CANARY/.test(JSON.stringify(responses)));
  assert.ok(await missing(join(root, '.analyzer-session.json')));
  return { frames: responses.length, eofStoppedOwnedService: true, arbitraryRequestsRejected: true };
}
try {
  report.sourceBefore = await sourceCheck(); assert.deepEqual(report.sourceBefore.changed, []);
  const rootA = await extract(dir, 'Analyzer 独立 A & 空库');
  const rootB = await extract(dir, 'Analyzer 独立 B & 外部服务哨兵');
  report.copies = [rootA, rootB];
  check('Original trusted r2 ZIP verified and two fresh Unicode/space/& copies extracted', await sha256(zip) === zipHash);
  const packageA = await checkPackage(rootA), packageB = await checkPackage(rootB);
  check('Full independent manifests match: 3249 hashed files plus checksums.json', packageA.files === 3249 && packageB.files === 3249);
  check('No user data before first start', await missing(join(rootA, 'data')) && await missing(join(rootB, 'data')));
  let opens = 0;
  const a = new AnalyzerSupervisor({ packageRoot: rootA, openBrowser: async url => {
    assert.equal(a.getStatus().state, 'ready');
    assert.equal((await api(url, 'api/health')).ok, true);
    const html = await (await fetch(url, { signal: AbortSignal.timeout(3000) })).text();
    assert.match(html, /<div id="root">/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)]; assert.ok(assets.length >= 2);
    for (const asset of assets) {
      const response = await fetch(url.slice(0, -1) + asset[1], { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength > 0);
    }
    if (process.argv.includes('--open-browser')) {
      await openDefaultBrowser(url);
      report.browserHandoff = 'Owned openAnalyzer adapter: Windows default-handler command exited 0 after readiness; physical display not asserted';
    }
    opens++;
  } });
  const b = new AnalyzerSupervisor({ packageRoot: rootB, openBrowser: async () => {} });
  active.push(a, b);
  assert.equal((await a.openAnalyzer()).error.code, 'NOT_READY'); assert.equal(opens, 0);
  check('Open before ready refused without invoking browser adapter');
  // Only synthetic inherited values; never read any real credentials/configuration.
  const names = ['BANGUMI_DATA_DIR', 'BANGUMI_USERNAME', 'BANGUMI_TOKEN', 'AI_API_KEY', 'AI_ENABLED', 'NODE_OPTIONS', 'HOST', 'PORT'];
  const old = names.map(k => process.env[k]);
  try {
    names.forEach(k => process.env[k] = 'SYNTHETIC_DO_NOT_INHERIT');
    const first = a.startAnalyzer(); assert.equal(a.getStatus().state, 'checking'); assert.equal(first, a.startAnalyzer());
    const startedA = await first; assert.equal(startedA.status.state, 'starting'); assert.equal(startedA.ok, true);
    assert.equal((await b.startAnalyzer()).ok, true);
  } finally { names.forEach((k, i) => old[i] === undefined ? delete process.env[k] : process.env[k] = old[i]); }
  const sa = await ready(a), sb = await ready(b);
  assert.notEqual(sa.url, sb.url); assert.notEqual(new URL(sa.url).port, '8787'); assert.notEqual(new URL(sb.url).port, '8787');
  report.ports = [Number(new URL(sa.url).port), Number(new URL(sb.url).port)];
  const ha = await api(sa.url, 'api/health'), hb = await api(sb.url, 'api/health');
  assert.equal(ha.dataDir, join(rootA, 'data')); assert.equal(hb.dataDir, join(rootB, 'data'));
  check('Two actual bundled r2 instances reach ready on distinct non-8787 loopback ports', ha.ok && hb.ok && ha.collections === 0 && hb.collections === 0);
  const cfg = await api(sa.url, 'api/config');
  check('Empty account/token/AI, distribution capability and no inherited synthetic secrets', cfg.username === '' && !cfg.hasToken && !cfg.ai.hasApiKey && !cfg.ai.enabled && cfg.canDisconnectBangumi === true);
  const lock = JSON.parse(await readFile(join(rootA, '.analyzer-session.json'), 'utf8'));
  check('Portable-compatible lock contains actual supervisor and service ownership', lock.launcherPid === process.pid && Number.isSafeInteger(lock.servicePid));
  const stranger = new AnalyzerSupervisor({ packageRoot: rootA });
  assert.equal((await stranger.startAnalyzer()).error.code, 'SESSION_LOCKED');
  await stranger.stopAnalyzer(); assert.equal(stranger.getStatus().ownsProcess, false);
  check('Second supervisor refuses adoption; its stop leaves owner instance alive', (await api(sa.url, 'api/health')).ok);
  // The unmodified portable launcher must respect the Companion-owned standard session lock too.
  const duplicate = spawn(join(rootA, 'runtime/node.exe'), [join(rootA, 'launch.mjs'), '--no-browser', '--port=0'], {
    cwd: dir, env: serviceEnvironment(rootA, 0), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let duplicateText = ''; duplicate.stdout.on('data', x => duplicateText += x); duplicate.stderr.on('data', x => duplicateText += x);
  const duplicateCode = await new Promise((yes, no) => { duplicate.once('error', no); duplicate.once('exit', yes); });
  check('Existing portable launcher refuses duplicate without stopping Companion service', duplicateCode === 1 && /already be running/.test(duplicateText) && (await api(sa.url, 'api/health')).ok);
  assert.equal((await a.openAnalyzer()).ok, true); assert.equal(opens, 1);
  check('Ready-only browser adapter loads real SPA and non-empty shipped JS/CSS assets');
  if (process.argv.includes('--open-browser')) {
    check('System default browser handoff accepted after readiness (not visual/user acceptance)', report.browserHandoff !== 'not requested');
  }
  const written = await api(sa.url, 'api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'Companion M0 temporary fixture' }) });
  assert.equal(written.nickname, 'Companion M0 temporary fixture');
  const stopped = await a.stopAnalyzer(); assert.equal(stopped.ok, true); assert.equal(stopped.status.state, 'stopped');
  check('Owned A gracefully stopped, lock removed; B remains healthy', await missing(join(rootA, '.analyzer-session.json')) && (await api(sb.url, 'api/health')).ok);
  assert.equal((await a.openAnalyzer()).error.code, 'NOT_READY');
  check('Stopped instance cannot be opened');
  assert.equal((await a.startAnalyzer()).ok, true); const again = await ready(a);
  check('Restart preserves temporary data/configuration', (await api(again.url, 'api/config')).nickname === 'Companion M0 temporary fixture');
  await a.stopAnalyzer(); await b.stopAnalyzer();
  report.coreTransitions = a.getStatus().logs.map(x => x.event);
  for (const root of [rootA, rootB]) {
    const db = new DatabaseSync(join(root, 'data/bangumi.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collections').get().n, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { db.close(); }
  }
  check('After graceful close, both real temporary DBs are Schema 15, empty, integral and FK-clean');
  // Independent legacy launcher is not owned by the new supervisor, even when it uses the same package path.
  const legacy = spawn(join(rootB, 'runtime/node.exe'), [join(rootB, 'launch.mjs'), '--no-browser', '--port=0'], {
    cwd: dir, env: serviceEnvironment(rootB, 0), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  standalone = legacy;
  let legacyText = ''; legacy.stdout.on('data', x => legacyText += x); legacy.stderr.on('data', x => legacyText += x);
  const legacyEnded = new Promise((yes, no) => { legacy.once('error', no); legacy.once('exit', yes); });
  for (let i = 0; i < 300 && !/Analyzer ready:/.test(legacyText); i++) await delay(50);
  const legacyURL = /Analyzer ready: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(legacyText)?.[1]; assert.ok(legacyURL);
  const nonowner = new AnalyzerSupervisor({ packageRoot: rootB });
  assert.equal((await nonowner.startAnalyzer()).error.code, 'SESSION_LOCKED'); await nonowner.stopAnalyzer();
  check('Supervisor stop does not touch independently launched legacy r2 instance', (await api(legacyURL, 'api/health')).ok);
  legacy.stdin.write('\n'); assert.equal(await legacyEnded, 0); standalone = null;
  report.transport = await transportTest(rootA);
  check('Real JSONL transport: get/start/status, bad/oversize requests, EOF safe shutdown and no raw canary leakage');
  await checkPackage(rootA); await checkPackage(rootB);
  check('All application bytes unchanged after start, browser, config, stop, restart and JSONL tests');
  report.sourceAfter = await sourceCheck(); assert.deepEqual(report.sourceAfter.changed, []);
  check('187 owning source inputs still match accepted r2; original ZIP unchanged', await sha256(zip) === zipHash);
  report.ok = true;
} catch (error) {
  report.ok = false;
  // Assertions use only synthetic copies; keep failure trace local, never send it through the UI protocol.
  report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  for (const s of active) {
    const result = await s.stopAnalyzer();
    if (result.status.ownsProcess) { report.cleanupIncomplete = true; process.exitCode = 1; }
  }
  if (transport) transport.stdin.end();
  if (standalone) standalone.stdin.write('\n');
  report.finishedAt = new Date().toISOString();
  await writeFile(join(dir, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, work: dir, error: report.error }));
}
