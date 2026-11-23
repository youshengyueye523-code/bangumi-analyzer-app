import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { serviceEnvironment } from '../runtime/supervisor.mjs';
import { HostError, RUNTIME_CODES, validateStatus } from './contract.mjs';

// Construct only AFTER the host has validated this exact package and its bundled executable.
export class RuntimeClient extends EventEmitter {
  #child; #pending = new Map(); #seq = 0; #ending = false; #dead = false; #closed;
  constructor({ packageRoot, cliPath, port = 0 }) {
    super();
    this.#child = spawn(join(packageRoot, 'runtime/node.exe'), [cliPath, '--packageRoot', packageRoot, '--port', String(port)], {
      cwd: packageRoot, env: serviceEnvironment(packageRoot, port), windowsHide: true, stdio: ['pipe','pipe','pipe'],
    });
    let buffer = '';
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', chunk => {
      if (this.#dead) return;
      buffer += chunk;
      if (buffer.length > 65536) { buffer = ''; this.#fault('HOST_PROTOCOL'); return; }
      while (buffer.includes('\n')) {
        const pos = buffer.indexOf('\n'), line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        try { this.#receive(JSON.parse(line)); } catch { this.#fault('HOST_PROTOCOL'); return; }
      }
    });
    this.#child.stderr.on('data', () => {}); // Never forward raw errors or paths to the renderer.
    this.#child.stdin.on('error', () => this.#fault('HOST_UNAVAILABLE'));
    this.#closed = new Promise(done => {
      this.#child.once('error', () => { this.#fault('HOST_UNAVAILABLE'); done(false); });
      this.#child.once('close', code => { if (!this.#ending) this.#fault('HOST_UNAVAILABLE'); this.#dead = true; done(code === 0); });
    });
  }
  get dead() { return this.#dead; }
  uncertain(method) { return [...this.#pending.values()].some(p => p.method === method && p.timedOut); }
  #fault(code) {
    if (this.#dead) return;
    this.#dead = true;
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new HostError(code)); }
    this.#pending.clear(); this.emit('fault', code);
    // No kill, no new CLI, no adoption. Existing IPC/channel is left to drain.
  }
  #receive(frame) {
    if (frame.event === 'transportClosing') {
      if (!this.#ending || !frame.status) throw new HostError('HOST_PROTOCOL');
      this.emit('status', validateStatus(frame.status)); return;
    }
    if (!Number.isSafeInteger(frame.id) || !this.#pending.has(frame.id) || typeof frame.ok !== 'boolean') throw new HostError('HOST_PROTOCOL');
    const p = this.#pending.get(frame.id), status = frame.status ? validateStatus(frame.status) : null;
    if (frame.error && !RUNTIME_CODES.has(frame.error.code) && !['INVALID_REQUEST','BUSY'].includes(frame.error.code)) throw new HostError('HOST_PROTOCOL');
    if (!status) throw new HostError('HOST_PROTOCOL');
    this.#pending.delete(frame.id); clearTimeout(p.timer);
    this.emit('status', status);
    p.resolve({ ok: frame.ok, status, error: frame.error ? { code: frame.error.code } : null });
  }
  call(method, timeoutMs = 5000) {
    if (!['getStatus','startAnalyzer','stopAnalyzer','openAnalyzer'].includes(method)) return Promise.reject(new HostError('IPC_DENIED'));
    if (this.#dead || this.#ending) return Promise.reject(new HostError('HOST_UNAVAILABLE'));
    if (this.#pending.size >= 8) return Promise.reject(new HostError('BUSY'));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const p = { method, resolve, reject, timedOut: false };
      p.timer = setTimeout(() => {
        p.timedOut = true; reject(new HostError('HOST_TIMEOUT'));
        // Keep a tombstone until its response: timeouts are NOT cancellations or permission to retry start.
      }, timeoutMs);
      this.#pending.set(id, p);
      this.#child.stdin.write(JSON.stringify({ id, method }) + '\n', error => { if (error) this.#fault('HOST_UNAVAILABLE'); });
    });
  }
  async end(timeoutMs = 6000) {
    this.#ending = true; this.#child.stdin.end();
    let timer;
    try {
      const ok = await Promise.race([this.#closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new HostError('HOST_TIMEOUT')), timeoutMs); })]);
      if (!ok) throw new HostError('HOST_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
}
