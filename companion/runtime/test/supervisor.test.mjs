import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdir, readFile, symlink, writeFile, rm, access } from 'node:fs/promises';
import { ALLOWED_ROUTES, AnalyzerSupervisor, serviceEnvironment } from '../supervisor.mjs';
import { checkPackage, sha256 } from '../package-check.mjs';
import { delay, fixture, ready, rehash, repo, until, work } from './helpers.mjs';

const normalService = `
import { createServer } from 'node:http';
const server = createServer((req,res) => {
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({ok:true,version:'2.0.0',dataDir:process.env.BANGUMI_DATA_DIR}));
});
server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log(JSON.stringify({level:30,msg:'Server listening at http://127.0.0.1:'+process.env.PORT})));
process.on('message',m=>{if(m==='shutdown')server.close(()=>process.exit(0));});
process.on('disconnect',()=>server.close(()=>process.exit(0)));
`;
const quietService = `process.on('message',m=>{if(m==='shutdown')process.exit(0);});`;
const noFile = async p => assert.rejects(access(p), { code: 'ENOENT' });

test('M0 bounded safety and lifecycle tests (synthetic packages, not product acceptance)', async t => {
  const dir = await work('safety');
  const root = await fixture(dir, 'synthetic package', normalService);
  const config = { packageRoot: root, startupTimeoutMs: 2000, stopTimeoutMs: 2000, openBrowser: async () => {} };
  await t.test('rejects 8787, invalid ports and source/private paths before touching data', async () => {
    for (const port of [8787, -1, 80, 65536, NaN, '9000']) assert.throws(() => new AnalyzerSupervisor({ ...config, port }), { code: 'INVALID_PORT' });
    for (const p of [repo, join(repo, 'data'), join(repo, '.runtime/ba-local'), 'relative']) await assert.rejects(checkPackage(p), { code: 'UNSAFE_PATH' });
    await noFile(join(root, 'data'));
  });
  await t.test('environment allowlist removes synthetic credentials, proxy, flags and external data path', () => {
    const names = ['BANGUMI_USERNAME', 'BANGUMI_TOKEN', 'AI_API_KEY', 'AI_ENABLED', 'HTTP_PROXY', 'NODE_OPTIONS', 'NODE_PATH', 'BANGUMI_DATA_DIR', 'HOST', 'PORT'];
    const before = names.map(n => process.env[n]);
    try {
      for (const name of names) process.env[name] = 'synthetic-secret';
      const env = serviceEnvironment(root, 10001);
      assert.equal(env.HOST, '127.0.0.1'); assert.equal(env.PORT, '10001'); assert.equal(env.BANGUMI_DATA_DIR, join(root, 'data'));
      assert.equal(env.BANGUMI_DISTRIBUTION, '1');
      assert.ok(!JSON.stringify(env).includes('synthetic-secret'));
    } finally { names.forEach((n, i) => before[i] === undefined ? delete process.env[n] : process.env[n] = before[i]); }
  });
  await t.test('detects missing, damaged, unexpected files and preserves them', async () => {
    const file = join(root, 'README.txt'), original = await readFile(file);
    await rm(file); await assert.rejects(checkPackage(root), { code: 'PACKAGE_MISSING' });
    await writeFile(file, 'damage'); await assert.rejects(checkPackage(root), { code: 'PACKAGE_DAMAGED' });
    await writeFile(file, original);
    const extra = join(root, 'unlisted.txt'); await writeFile(extra, 'preserve');
    const s = new AnalyzerSupervisor(config);
    assert.equal((await s.startAnalyzer()).error.code, 'PACKAGE_INVALID'); assert.equal(s.getStatus().ownsProcess, false);
    assert.equal(await readFile(extra, 'utf8'), 'preserve'); await noFile(join(root, 'data')); await rm(extra);
  });
  await t.test('rejects traversal, duplicate, omitted mandatory entries and unsupported revision', async () => {
    const file = join(root, 'checksums.json'), original = await readFile(file), manifest = JSON.parse(original);
    for (const files of [[...manifest.files, { path: '../private-secret', sha256: '0'.repeat(64) }],
      [...manifest.files, manifest.files[0]], manifest.files.filter(e => e.path !== 'service.mjs')]) {
      await writeFile(file, JSON.stringify({ algorithm: 'sha256', files }));
      await assert.rejects(checkPackage(root), { code: 'PACKAGE_INVALID' });
    }
    await writeFile(file, original);
    const releasePath = join(root, 'release.json'), release = await readFile(releasePath);
    await writeFile(releasePath, JSON.stringify({ ...JSON.parse(release), distributionRevision: 6 })); await rehash(root);
    await assert.rejects(checkPackage(root), { code: 'PACKAGE_UNSUPPORTED' });
    await writeFile(releasePath, release); await rehash(root);
  });
  await t.test('rejects linked package ancestor and nested data links without reading target', async () => {
    const linked = join(dir, 'linked-package'); await symlink(root, linked, 'junction');
    await assert.rejects(checkPackage(linked), { code: 'UNSAFE_PATH' });
    const data = join(root, 'data'), trap = join(dir, 'synthetic-private'); await mkdir(data); await mkdir(trap);
    await writeFile(join(trap, 'config.json'), 'not-a-real-secret');
    const nested = join(data, 'nested'); await symlink(trap, nested, 'junction');
    await assert.rejects(checkPackage(root), { code: 'UNSAFE_PATH' });
    // Only remove this explicitly verified synthetic junction, never its target.
    await rm(nested); await rm(data, { recursive: false }).catch(async e => { if (e.code === 'ERR_FS_EISDIR') { const { rmdir } = await import('node:fs/promises'); await rmdir(data); } else throw e; });
    assert.equal(await readFile(join(trap, 'config.json'), 'utf8'), 'not-a-real-secret');
  });
  await t.test('never reclaims even a stale lock or adopts a PID', async () => {
    const lock = join(root, '.analyzer-session.json'), bytes = '{"launcherPid":2147483647,"servicePid":2147483646}';
    await writeFile(lock, bytes);
    const s = new AnalyzerSupervisor(config);
    assert.equal((await s.startAnalyzer()).error.code, 'SESSION_LOCKED');
    await s.stopAnalyzer(); assert.equal(s.getStatus().ownsProcess, false);
    assert.equal(await readFile(lock, 'utf8'), bytes); await rm(lock);
  });
  await t.test('occupied port fails with zero HTTP requests to incumbent', async () => {
    let requests = 0;
    const incumbent = createServer((req,res) => { requests++; res.end('foreign'); });
    await new Promise(r => incumbent.listen(0, '127.0.0.1', r));
    try {
      const s = new AnalyzerSupervisor({ ...config, port: incumbent.address().port });
      assert.equal((await s.startAnalyzer()).error.code, 'PORT_IN_USE');
      await s.stopAnalyzer(); assert.equal(requests, 0); assert.ok(incumbent.listening);
      await noFile(join(root, '.analyzer-session.json'));
    } finally { await new Promise(r => incumbent.close(r)); }
  });
  await t.test('stop while checking cancels before spawn; status is a detached snapshot', async () => {
    const s = new AnalyzerSupervisor(config), start = s.startAnalyzer(), stop = s.stopAnalyzer();
    assert.equal(s.getStatus().state, 'checking');
    await Promise.all([start, stop]); assert.equal(s.getStatus().state, 'stopped');
    const snapshot = s.getStatus(); snapshot.logs[0].event = 'altered'; assert.notEqual(s.getStatus().logs[0].event, 'altered');
    await noFile(join(root, '.analyzer-session.json')); await noFile(join(root, 'data'));
  });
  await t.test('idempotent starts/stops, before-ready open refusal and bounded safe output', async () => {
    const serviceFile = join(root, 'service.mjs');
    await writeFile(serviceFile, `console.log('PRIVATE_CANARY '+ 'x'.repeat(30000));console.error('AUTH_CANARY token=secret');\n` + normalService); await rehash(root);
    let opened = 0;
    const s = new AnalyzerSupervisor({ ...config, openBrowser: async () => { opened++; throw new Error('PRIVATE_CANARY'); } });
    try {
      assert.equal((await s.openAnalyzer()).error.code, 'NOT_READY');
      const a = s.startAnalyzer(), b = s.startAnalyzer(); assert.equal(a, b); await a;
      assert.equal(s.getStatus().state, 'starting'); await ready(s);
      assert.equal((await s.startAnalyzer()).ok, true);
      assert.equal((await s.openAnalyzer()).error.code, 'OPEN_FAILED'); assert.equal(opened, 1); assert.equal(s.getStatus().state, 'ready');
      const text = JSON.stringify(s.getStatus()); assert.ok(!/PRIVATE_CANARY|AUTH_CANARY|token=secret|synthetic package/.test(text));
      const stop1 = s.stopAnalyzer(), stop2 = s.stopAnalyzer(); assert.equal(stop1, stop2); assert.equal((await stop1).ok, true);
      assert.equal(s.getStatus().ownsProcess, false); await noFile(join(root, '.analyzer-session.json'));
    } finally { await s.stopAnalyzer(); }
  });
  await t.test('lock replacement is not deleted when stopping own child', async () => {
    const s = new AnalyzerSupervisor(config);
    try {
      await s.startAnalyzer(); await ready(s);
      await writeFile(join(root, '.analyzer-session.json'), '{"companionSession":"foreign-fixture"}');
      await s.stopAnalyzer();
      assert.equal(await readFile(join(root, '.analyzer-session.json'), 'utf8'), '{"companionSession":"foreign-fixture"}');
      assert.ok(s.getStatus().logs.some(e => e.event === 'LOCK_CHANGED'));
    } finally { await s.stopAnalyzer(); await rm(join(root, '.analyzer-session.json')); }
  });
  await t.test('competing supervisors acquire at most one live session', async () => {
    const a = new AnalyzerSupervisor(config), b = new AnalyzerSupervisor(config);
    try {
      const results = await Promise.all([a.startAnalyzer(), b.startAnalyzer()]);
      assert.equal(results.filter(x => x.ok).length, 1);
      const owner = results[0].ok ? a : b, other = results[0].ok ? b : a;
      await ready(owner); await other.stopAnalyzer();
      assert.equal(owner.getStatus().state, 'ready'); assert.equal(other.getStatus().ownsProcess, false);
    } finally { await a.stopAnalyzer(); await b.stopAnalyzer(); }
  });
  await t.test('invalid executable reports spawn failure without system Node fallback', async () => {
    const target = await fixture(dir, 'bad-executable', quietService), exe = join(target, 'runtime/node.exe');
    await writeFile(exe, 'not an executable');
    const release = JSON.parse(await readFile(join(target, 'release.json'), 'utf8'));
    release.runtimeSha256 = await sha256(exe); await writeFile(join(target, 'release.json'), JSON.stringify(release)); await rehash(target);
    const s = new AnalyzerSupervisor({ ...config, packageRoot: target });
    await s.startAnalyzer(); await until(s, x => x.state === 'failed' && !x.ownsProcess);
    assert.equal(s.getStatus().error.code, 'SPAWN_FAILED'); await noFile(join(target, '.analyzer-session.json'));
  });
  await t.test('open rechecks health and does not open a now-unhealthy owned instance', async () => {
    const service = normalService.replace("const server = createServer", "let checks = 0;const server = createServer")
      .replace("version:'2.0.0'", "version:++checks===1?'2.0.0':'invalid'");
    const target = await fixture(dir, 'later-unhealthy', service);
    let opens = 0;
    const s = new AnalyzerSupervisor({ ...config, packageRoot: target, openBrowser: async () => { opens++; } });
    try {
      await s.startAnalyzer(); await ready(s);
      assert.equal((await s.openAnalyzer()).error.code, 'HEALTH_FAILED');
      assert.equal(s.getStatus().state, 'failed'); assert.equal(s.getStatus().ownsProcess, true); assert.equal(opens, 0);
    } finally { await s.stopAnalyzer(); }
  });
  await t.test('no private listening record means no health probes, timeout is not ready', async () => {
    const service = `import {writeFileSync} from 'node:fs';\n` + normalService.replace("res.setHeader('Content-Type','application/json');", "writeFileSync(new URL('./health-request-count',import.meta.url),'unexpected');res.setHeader('Content-Type','application/json');")
      .replace("()=>console.log(JSON.stringify({level:30,msg:'Server listening at http://127.0.0.1:'+process.env.PORT}))", '()=>{}');
    const target = await fixture(dir, 'no-readiness', service);
    const s = new AnalyzerSupervisor({ ...config, packageRoot: target, startupTimeoutMs: 300 });
    await s.startAnalyzer(); await until(s, x => x.state === 'failed' && !x.ownsProcess);
    assert.equal(s.getStatus().error.code, 'START_TIMEOUT'); await noFile(join(target, '.analyzer-session.json'));
    await noFile(join(target, 'health-request-count'));
    assert.equal((await s.openAnalyzer()).ok, false);
  });
  await t.test('incorrect health identity is not accepted', async () => {
    const target = await fixture(dir, 'wrong-health', normalService.replace("version:'2.0.0'", "version:'9.9.9'"));
    const s = new AnalyzerSupervisor({ ...config, packageRoot: target, startupTimeoutMs: 300 });
    await s.startAnalyzer(); await until(s, x => x.state === 'failed' && !x.ownsProcess);
    assert.equal(s.getStatus().error.code, 'START_TIMEOUT');
  });
  await t.test('unexpected exit and stop during early startup are accurately reported', async () => {
    const target = await fixture(dir, 'crash', `setTimeout(()=>process.exit(7),150);process.on('message',()=>{});`);
    const s = new AnalyzerSupervisor({ ...config, packageRoot: target }); await s.startAnalyzer();
    await until(s, x => x.state === 'failed' && !x.ownsProcess); assert.equal(s.getStatus().error.code, 'SERVICE_EXITED');
    await writeFile(join(target, 'service.mjs'), quietService); await rehash(target);
    const early = new AnalyzerSupervisor({ ...config, packageRoot: target }); await early.startAnalyzer();
    assert.equal(early.getStatus().state, 'starting'); assert.equal((await early.stopAnalyzer()).ok, true);
    await noFile(join(target, '.analyzer-session.json'));
  });
  await t.test('stop timeout retains live ownership and never escalates to force-kill', async () => {
    const target = await fixture(dir, 'slow-stop', `process.on('message',()=>{});setTimeout(()=>process.exit(0),1300);`);
    const s = new AnalyzerSupervisor({ ...config, packageRoot: target, stopTimeoutMs: 100 });
    await s.startAnalyzer();
    const stopped = await s.stopAnalyzer(); assert.equal(stopped.error.code, 'STOP_TIMEOUT');
    assert.equal(stopped.status.ownsProcess, true); assert.equal(stopped.status.url, null);
    await access(join(target, '.analyzer-session.json'));
    assert.equal((await s.startAnalyzer()).error.code, 'BUSY');
    await until(s, x => x.state === 'stopped' && !x.ownsProcess);
    assert.ok(s.getStatus().logs.some(e => e.event === 'STOP_TIMEOUT'));
  });
  await t.test('stop racing an in-flight open prevents stale browser handoff', async () => {
    const target = await fixture(dir, 'race', normalService.replace('res.end(JSON.stringify', 'setTimeout(()=>res.end(JSON.stringify').replace("dataDir:process.env.BANGUMI_DATA_DIR}));", "dataDir:process.env.BANGUMI_DATA_DIR})),200);"));
    let opens = 0;
    const s = new AnalyzerSupervisor({ ...config, packageRoot: target, openBrowser: async () => { opens++; } });
    try {
      await s.startAnalyzer(); await ready(s);
      const opening = s.openAnalyzer(); await delay(30); const stopping = s.stopAnalyzer();
      assert.equal((await opening).ok, false); await stopping; assert.equal(opens, 0);
    } finally { await s.stopAnalyzer(); }
  });
  await t.test('openAnalyzer routes all six allowlisted paths to active runtime port and rejects arbitrary routes (F01)', async () => {
    const target = await fixture(dir, 'routes', normalService);
    const opened = [];
    const s = new AnalyzerSupervisor({ ...config, packageRoot: target, openBrowser: async (u) => { opened.push(u); } });
    try {
      const notReady = await s.openAnalyzer('/library');
      assert.equal(notReady.ok, false);
      assert.equal(notReady.error.code, 'NOT_READY');
      assert.equal(opened.length, 0);

      await s.startAnalyzer(); await ready(s);
      const base = s.getStatus().url.replace(/\/$/, '');
      for (const route of ALLOWED_ROUTES) {
        const res = await s.openAnalyzer(route);
        assert.equal(res.ok, true);
        assert.equal(res.openedUrl, `${base}${route}`);
      }
      assert.deepEqual(opened, [...ALLOWED_ROUTES].map((r) => `${base}${r}`));

      for (const badRoute of ['/settings', '/library?next=http://evil', '//evil.com', 'https://evil.invalid/']) {
        await assert.rejects(s.openAnalyzer(badRoute), { code: 'OPEN_FAILED' });
      }
      assert.equal(opened.length, ALLOWED_ROUTES.size);
    } finally { await s.stopAnalyzer(); }
  });
  console.log(JSON.stringify({ evidence: 'synthetic-safety', work: dir, checksumsSha256: await sha256(join(root, 'checksums.json')) }));
});
