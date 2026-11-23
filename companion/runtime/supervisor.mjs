import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, unlink, lstat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { checkPackage, fail, normalPath, RuntimeError, safeData } from './package-check.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
const messages = {
  UNSAFE_PATH: '必须使用独立的普通目录，不能链接或指向正式数据。',
  PACKAGE_MISSING: '分发包不完整或目录不存在，请重新完整解包。',
  PACKAGE_INVALID: '分发清单或目录内容不合法，请使用干净的独立分发包。',
  PACKAGE_DAMAGED: '分发文件校验失败，请重新完整解包，不要覆盖个人数据。',
  PACKAGE_UNSUPPORTED: '仅支持 Windows x64 的 Analyzer 2.0.0 正式分发包（r2 / r3）。',
  PACKAGE_ACCESS: '无法读写分发目录，请使用有权限的独立本地目录。',
  SESSION_LOCKED: '该副本已有会话锁；不会接管、探测或停止已有实例。',
  LOCK_CHANGED: '会话锁已变化，未删除他人的锁，请人工核查。',
  PLATFORM_UNSUPPORTED: '运行核心需要 Windows x64 和 Node 24。',
  INVALID_PORT: '端口必须为 0（自动）或 1024–65535，禁止 8787。',
  PORT_IN_USE: '指定端口已被占用；未请求或停止占用方。',
  PORT_UNAVAILABLE: '无法分配独立本机端口。',
  SPAWN_FAILED: '无法启动随包 Node，未使用系统 Node 或其他服务。',
  SERVICE_EXITED: 'Analyzer 子进程异常退出；数据保留，请检查分发包或重试。',
  START_TIMEOUT: '启动超时；已请求安全退出，未强制结束进程。',
  HEALTH_FAILED: '未能确认该实例已就绪；未打开浏览器。',
  NOT_READY: '仅能打开当前监督器已确认就绪的实例。',
  STOP_TIMEOUT: '安全关闭尚未完成；仍保留进程归属，可重试，未强杀。',
  STOP_FAILED: '未能发送安全退出请求；未按 PID 结束任何进程。',
  OPEN_FAILED: '无法交给系统默认浏览器；可在就绪状态使用返回的本机地址。',
  BUSY: '当前操作尚未结束，请等待后重试。',
  INTERNAL: '运行核心操作失败；未输出底层路径、配置或敏感错误。',
};
const publicError = code => ({ code: messages[code] ? code : 'INTERNAL', message: messages[code] ?? messages.INTERNAL });

export function serviceEnvironment(root, port) {
  // No inherited credentials, proxies, NODE_OPTIONS, NODE_PATH, data paths or AI flags.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PATHEXT)$/i.test(k)));
  env.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  return { ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
    BANGUMI_DATA_DIR: join(root, 'data'), BANGUMI_DISTRIBUTION: '1', LOG_LEVEL: 'info' };
}

async function reservePort(port) {
  const server = createServer();
  try {
    await new Promise((yes, no) => { server.once('error', no); server.listen({ host: '127.0.0.1', port, exclusive: true }, yes); });
    const selected = server.address().port;
    if (selected === 8787) { await new Promise(r => server.close(r)); return reservePort(0); }
    return { port: selected, close: () => new Promise((yes, no) => server.close(e => e ? no(e) : yes())) };
  } catch (error) { fail(error.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'PORT_UNAVAILABLE'); }
}

export async function openDefaultBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url) || new URL(url).port === '8787') fail('OPEN_FAILED');
  await new Promise((yes, no) => {
    const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe'), ['/d', '/c', 'start', '""', url],
      { windowsHide: true, stdio: 'ignore', env: serviceEnvironment('', 0) });
    child.once('error', no);
    child.once('exit', code => code === 0 ? yes() : no(new RuntimeError('OPEN_FAILED')));
  });
}

/** No persisted PID adoption and no PID-based termination. One object owns at most one ChildProcess. */
export class AnalyzerSupervisor {
  #root; #port; #opener; #startupMs; #stopMs; #state = 'idle'; #package = { state: 'unknown' };
  #error = null; #logs = []; #seq = 0; #session; #starting; #stopping; #stopRequested = false;
  constructor({ packageRoot, port = 0, startupTimeoutMs = 30000, stopTimeoutMs = 35000, openBrowser = openDefaultBrowser }) {
    if (typeof packageRoot !== 'string') fail('UNSAFE_PATH');
    if (!Number.isInteger(port) || port < 0 || port > 65535 || (port && port < 1024) || port === 8787) fail('INVALID_PORT');
    if (![startupTimeoutMs, stopTimeoutMs].every(n => Number.isFinite(n) && n >= 100 && n <= 120000)) fail('INTERNAL');
    this.#root = packageRoot; this.#port = port; this.#opener = openBrowser;
    this.#startupMs = startupTimeoutMs; this.#stopMs = stopTimeoutMs;
    this.#log('info', 'CREATED');
  }
  #log(level, event) {
    this.#logs.push({ seq: ++this.#seq, at: new Date().toISOString(), level, event });
    if (this.#logs.length > 100) this.#logs.shift();
  }
  #set(state) { this.#state = state; this.#log('info', state.toUpperCase()); }
  #fail(error) { this.#error = publicError(error.code); this.#state = 'failed'; this.#log('error', this.#error.code); }
  #result(ok, error) { return { ok, ...(error ? { error: publicError(error.code) } : {}), status: this.getStatus() }; }
  getStatus() {
    return structuredClone({ protocolVersion: 1, state: this.#state, package: this.#package,
      ownsProcess: Boolean(this.#session && !this.#session.exited),
      url: this.#state === 'ready' ? this.#session?.url ?? null : null,
      error: this.#error, logs: this.#logs });
  }
  startAnalyzer() {
    if (this.#starting) return this.#starting;
    if (this.#stopping) return Promise.resolve(this.#result(false, new RuntimeError('BUSY')));
    if (this.#session) return Promise.resolve(this.#state === 'ready' || this.#state === 'starting'
      ? this.#result(true) : this.#result(false, new RuntimeError('BUSY')));
    this.#stopRequested = false;
    this.#starting = this.#start().finally(() => { this.#starting = null; });
    return this.#starting;
  }
  async #start() {
    let reservation;
    try {
      this.#error = null; this.#package = { state: 'checking' }; this.#set('checking');
      if (process.platform !== 'win32' || process.arch !== 'x64' || !process.version.startsWith('v24.')) fail('PLATFORM_UNSUPPORTED');
      const pkg = await checkPackage(this.#root);
      this.#package = { state: 'valid', version: pkg.version, distributionRevision: pkg.distributionRevision, files: pkg.files, checksumsSha256: pkg.checksumsSha256 };
      this.#root = pkg.root;
      this.#log('info', 'PACKAGE_VALID');
      if (this.#stopRequested) { this.#set('stopped'); return this.#result(true); }
      const lockPath = join(this.#root, '.analyzer-session.json');
      let lock;
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { fail(error.code === 'EEXIST' ? 'SESSION_LOCKED' : 'PACKAGE_ACCESS'); }
      const s = { nonce: randomUUID(), lock, lockPath, child: null, exited: false, listening: false, url: null, done: null };
      this.#session = s;
      s.lockStat = await lock.stat();
      await lock.writeFile(JSON.stringify({ launcherPid: process.pid, companionSession: s.nonce }));
      await safeData(this.#root);
      reservation = await reservePort(this.#port);
      s.url = `http://127.0.0.1:${reservation.port}/`;
      if (this.#stopRequested) { await this.#release(s); this.#session = null; this.#set('stopped'); return this.#result(true); }
      // Release immediately before spawning. A bind race fails closed; never attach to the winner.
      await reservation.close(); reservation = null;
      this.#set('starting');
      let child;
      try {
        child = spawn(join(this.#root, 'runtime/node.exe'), [join(this.#root, 'service.mjs')], {
          cwd: this.#root, env: serviceEnvironment(this.#root, Number(new URL(s.url).port)),
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
      } catch { fail('SPAWN_FAILED'); }
      s.child = child;
      let buffer = '', dropping = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        // Drain but never persist/forward raw output (may include personal identifiers/paths).
        for (const fragment of chunk.split(/(?<=\n)/)) {
          if (!dropping) buffer += fragment;
          if (buffer.length > 16384) { buffer = ''; dropping = true; }
          if (fragment.endsWith('\n')) {
            if (!dropping) {
              try {
                const record = JSON.parse(buffer);
                // A private stdout record emitted only AFTER this child has actually bound its port.
                if (record.msg === `Server listening at ${s.url.slice(0, -1)}` && record.level === 30) s.listening = true;
              } catch { /* Plain startup messages are intentionally discarded. */ }
            }
            buffer = ''; dropping = false;
          }
        }
      });
      child.stderr.on('data', () => {});
      s.done = new Promise(done => {
        const ended = async (code, spawnError = false) => {
          if (s.exited) return;
          s.exited = true; s.code = code;
          await this.#release(s);
          if (this.#session === s) {
            this.#session = null;
            if (this.#stopRequested && code === 0 && !spawnError) this.#set('stopped');
            else this.#fail(new RuntimeError(spawnError ? 'SPAWN_FAILED' : this.#error?.code ?? 'SERVICE_EXITED'));
          }
          done();
        };
        child.once('error', () => void ended(null, true));
        child.once('exit', code => void ended(code));
      });
      if (child.pid) {
        // Compatible with the portable launcher: it must also see a live service during parent-loss drain.
        const bytes = Buffer.from(JSON.stringify({ launcherPid: process.pid, servicePid: child.pid, url: s.url, companionSession: s.nonce }));
        await s.lock.write(bytes, 0, bytes.length, 0);
        await s.lock.truncate(bytes.length);
      }
      void this.#awaitReady(s);
      return this.#result(true);
    } catch (error) {
      this.#package = this.#package.state === 'valid' ? this.#package : { state: 'invalid' };
      const s = this.#session;
      if (s && !s.child) { await this.#release(s); this.#session = null; }
      this.#fail(error);
      if (s?.child && !s.exited) void this.#stopOwned(s);
      return this.#result(false, error);
    } finally { if (reservation) await reservation.close(); }
  }
  async #release(s) {
    try {
      await normalPath(s.lockPath, false);
      const stat = await lstat(s.lockPath);
      const text = JSON.parse(await readFile(s.lockPath, 'utf8'));
      if (stat.ino !== s.lockStat.ino || stat.dev !== s.lockStat.dev || text.companionSession !== s.nonce) fail('LOCK_CHANGED');
      await s.lock.close(); s.lock = null;
      await unlink(s.lockPath);
    } catch { this.#log('error', 'LOCK_CHANGED'); }
    finally { if (s.lock) { await s.lock.close().catch(() => {}); s.lock = null; } }
  }
  async #healthy(s) {
    if (!s.listening || s.exited || !s.child?.connected || this.#session !== s) return false;
    try {
      // Native HTTP with literal loopback, no global fetch dispatcher or inherited environment proxy.
      const health = await new Promise(done => {
        let timer, settled = false;
        const finish = value => { if (!settled) { settled = true; clearTimeout(timer); done(value); } };
        const req = request({ host: '127.0.0.1', port: Number(new URL(s.url).port), path: '/api/health', method: 'GET', agent: false }, res => {
          const chunks = []; let bytes = 0;
          if (res.statusCode !== 200 || Number(res.headers['content-length'] ?? 0) > 16384) { finish(null); res.destroy(); return; }
          res.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) { finish(null); res.destroy(); } else chunks.push(chunk); });
          res.on('error', () => finish(null));
          res.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(null); } });
        });
        req.on('error', () => finish(null));
        timer = setTimeout(() => { finish(null); req.destroy(); }, 750);
        req.end();
      });
      if (!health) return false;
      return health.ok === true && health.version === '2.0.0' && typeof health.dataDir === 'string' &&
        resolve(health.dataDir).toLowerCase() === join(this.#root, 'data').toLowerCase() && !s.exited;
    } catch { return false; }
  }
  async #awaitReady(s) {
    const deadline = Date.now() + this.#startupMs;
    while (!s.exited && this.#session === s && !this.#stopRequested && Date.now() < deadline) {
      if (await this.#healthy(s)) {
        if (!this.#stopRequested && !s.exited && this.#session === s) { this.#set('ready'); return; }
      }
      await delay(100);
    }
    if (!s.exited && this.#session === s && !this.#stopRequested) {
      this.#fail(new RuntimeError('START_TIMEOUT'));
      // Timeout is not success. Request graceful drain but retain failed status even if it exits cleanly.
      void this.#stopOwned(s);
    }
  }
  async #stopOwned(s) {
    const deadline = Date.now() + this.#stopMs;
    while (!s.exited && Date.now() < deadline) {
      // Repeating IPC handles early startup and the official shutdown barrier's retry semantics.
      if (s.child?.connected) {
        try { s.child.send('shutdown', () => {}); } catch { this.#log('error', 'STOP_FAILED'); }
      }
      await Promise.race([s.done, delay(300)]);
    }
    if (!s.exited) { this.#fail(new RuntimeError('STOP_TIMEOUT')); return this.#result(false, new RuntimeError('STOP_TIMEOUT')); }
    await s.done;
    return this.#result(this.#state === 'stopped');
  }
  stopAnalyzer() {
    if (this.#stopping) return this.#stopping;
    this.#stopRequested = true;
    this.#stopping = (async () => {
      if (this.#starting) await this.#starting;
      const s = this.#session;
      if (!s) { if (this.#state !== 'failed') this.#set('stopped'); return this.#result(true); }
      this.#set('stopping');
      return this.#stopOwned(s);
    })().finally(() => { this.#stopping = null; });
    return this.#stopping;
  }
  async openAnalyzer() {
    const s = this.#session;
    if (this.#state !== 'ready' || !s || this.#stopRequested) return this.#result(false, new RuntimeError('NOT_READY'));
    if (!await this.#healthy(s)) {
      if (this.#session === s && !s.exited && !this.#stopRequested) this.#fail(new RuntimeError('HEALTH_FAILED'));
      return this.#result(false, new RuntimeError('HEALTH_FAILED'));
    }
    // Re-check after await: stop/start must not open a stale or replacement address.
    if (this.#session !== s || this.#state !== 'ready' || this.#stopRequested || s.exited) return this.#result(false, new RuntimeError('NOT_READY'));
    try { await this.#opener(s.url); this.#log('info', 'BROWSER_HANDOFF'); return this.#result(true); }
    catch { this.#log('error', 'OPEN_FAILED'); return this.#result(false, new RuntimeError('OPEN_FAILED')); }
  }
}
