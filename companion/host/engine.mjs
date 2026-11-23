import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackage } from '../runtime/package-check.mjs';
import { RuntimeClient } from './runtime-client.mjs';
import { errorInfo, HostError, idle, toUi } from './contract.mjs';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '../runtime/cli.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
export class BridgeEngine extends EventEmitter {
  #root; #port; #client; #raw = idle(); #revision = 0; #fault = null; #timer; #refresh; #start; #stop; #preparing; #closing = false; #pollPaused = false; #closeTask; #closed = false;
  constructor({ packageRoot, port = 0 }) {
    super(); this.#root = packageRoot; this.#port = port;
    if (!Number.isInteger(port) || port < 0 || port > 65535 || (port && port < 1024) || port === 8787) throw new HostError('INVALID_PORT');
    this.#timer = setInterval(() => { if (this.#client && !this.#pollPaused && !this.#closing) void this.getStatus(); }, 400);
    this.#timer.unref();
  }
  status() { return structuredClone(toUi(this.#raw, this.#revision, this.#fault)); }
  logs() { return structuredClone(this.#raw.logs); }
  #publish(raw = this.#raw, fault = null) {
    const before = JSON.stringify([this.#raw, this.#fault]);
    this.#raw = raw; this.#fault = fault;
    if (JSON.stringify([raw, fault]) !== before) { this.#revision++; this.emit('status', this.status()); this.emit('logs', this.logs()); }
  }
  #failure(error) { this.#publish(this.#raw, error.code ?? 'HOST_UNAVAILABLE'); return this.status(); }
  async #prepare() {
    if (this.#client) { if (this.#client.dead) throw new HostError('HOST_UNAVAILABLE'); return; }
    if (this.#preparing) return this.#preparing;
    this.#preparing = (async () => {
      this.#publish({ ...idle(), state: 'checking', package: { state: 'checking' } });
      await checkPackage(this.#root); // Includes full executable hash BEFORE any executable is launched.
      if (this.#closing) throw new HostError('HOST_CLOSING');
      const client = new RuntimeClient({ packageRoot: this.#root, cliPath, port: this.#port }); this.#client = client;
      client.on('status', raw => this.#publish(raw));
      client.on('fault', code => { this.#pollPaused = true; this.#publish(this.#raw, code); });
      await client.call('getStatus');
    })().finally(() => { this.#preparing = null; });
    return this.#preparing;
  }
  async getStatus() {
    if (!this.#client || this.#client.dead) return this.status();
    if (this.#refresh) return this.#refresh;
    this.#refresh = this.#client.call('getStatus', 5000).then(() => { this.#pollPaused = false; return this.status(); })
      .catch(e => { this.#pollPaused = true; return this.#failure(e); }).finally(() => { this.#refresh = null; });
    return this.#refresh;
  }
  startAnalyzer() {
    if (this.#start) return this.#start;
    if (this.#closing || this.#stop) return Promise.resolve(this.#failure(new HostError('HOST_CLOSING')));
    this.#start = (async () => {
      try {
        await this.#prepare();
        if (this.#client.uncertain('startAnalyzer')) throw new HostError('HOST_TIMEOUT');
        const result = await this.#client.call('startAnalyzer', 60000);
        if (!result.ok) return this.status();
        const deadline = Date.now() + 35000;
        while (['checking','starting'].includes(this.#raw.state) && !this.#closing && Date.now() < deadline) {
          await sleep(150); await this.getStatus(); if (this.#fault) return this.status();
        }
        if (['checking','starting'].includes(this.#raw.state) && !this.#closing) throw new HostError('HOST_TIMEOUT');
        return this.status();
      } catch (e) { return this.#failure(e); }
    })().finally(() => { this.#start = null; });
    return this.#start;
  }
  stopAnalyzer() {
    if (this.#stop) return this.#stop;
    this.#stop = (async () => {
      try {
        if (this.#preparing) { try { await this.#preparing; } catch { /* No child has been created. */ } }
        if (!this.#client) {
          if (!this.#fault) this.#publish({ ...idle(), state: 'stopped' });
          return this.status();
        }
        if (this.#client.dead) throw new HostError('HOST_UNAVAILABLE');
        await this.#client.call('stopAnalyzer', 60000); return this.status();
      } catch (e) { return this.#failure(e); }
    })().finally(() => { this.#stop = null; });
    return this.#stop;
  }
  async openAnalyzer() {
    if (this.#closing) return { opened: false, url: '', error: errorInfo('HOST_CLOSING') };
    if (!this.#client || this.#raw.state !== 'ready' || this.#fault) return { opened: false, url: '', error: errorInfo('NOT_READY') };
    try {
      const result = await this.#client.call('openAnalyzer', 10000);
      return result.ok && this.#raw.state === 'ready' ? { opened: true, url: this.#raw.url } : { opened: false, url: '', error: errorInfo(result.error?.code ?? this.#raw.error?.code ?? 'NOT_READY') };
    } catch (e) { return { opened: false, url: '', error: errorInfo(e.code) }; }
  }
  close() {
    if (this.#closed) return Promise.resolve(true);
    if (this.#closeTask) return this.#closeTask;
    this.#closing = true;
    this.#closeTask = (async () => {
      const status = await this.stopAnalyzer();
      if (status.runtime.ownsProcess || (this.#client?.dead && this.#fault)) return false;
      try { if (this.#client) await this.#client.end(); }
      catch (e) { this.#failure(e); return false; }
      clearInterval(this.#timer); this.#closed = true; return true;
    })().finally(() => { this.#closeTask = null; if (!this.#closed) this.#closing = false; });
    return this.#closeTask;
  }
}
