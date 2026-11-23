import { spawn } from 'node:child_process';
import { existsSync, lstatSync, openSync, closeSync, readFileSync, realpathSync, unlinkSync, writeFileSync, accessSync, constants } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { verify } from './integrity.mjs';

const root = dirname(fileURLToPath(import.meta.url));
let child, acquired = false, stopping = false, input;
const lock = join(root, '.analyzer-session.json');
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping safely. Please wait for "Stopped"...');
  if (child?.connected) child.send('shutdown');
}
function cleanup() {
  input?.close();
  if (acquired) { try { unlinkSync(lock); } catch {} acquired = false; }
}
process.on('exit', cleanup);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function portAvailable(port) {
  const server = createServer();
  return new Promise((yes, no) => {
    server.once('error', error => error.code === 'EADDRINUSE' ? yes(null) : no(error));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const selected = server.address().port;
      server.close(error => error ? no(error) : yes(selected));
    });
  });
}
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This package requires Windows x64.');
  if (!process.version.startsWith('v24.')) throw new Error('Use Start-Analyzer.bat with the bundled Node runtime.');
  if (realpathSync(root) !== resolve(root)) throw new Error('Extract to a normal local folder, not a link/junction.');
  if (existsSync(join(root, 'data')) && (lstatSync(join(root, 'data')).isSymbolicLink() || !lstatSync(join(root, 'data')).isDirectory())) throw new Error('data must be a normal directory, not a link.');
  if (existsSync(lock)) {
    if (lstatSync(lock).isSymbolicLink()) throw new Error('Invalid session lock.');
    const session = JSON.parse(readFileSync(lock, 'utf8'));
    if (alive(session.launcherPid) || alive(session.servicePid)) throw new Error(`This copy may already be running: ${session.url ?? ''}. Use its existing window. No process was stopped.`);
    unlinkSync(lock); // dead session only; never terminate a PID
  }
  const fd = openSync(lock, 'wx'); closeSync(fd); acquired = true;
  writeFileSync(lock, JSON.stringify({ launcherPid: process.pid }));
  accessSync(root, constants.W_OK);
  console.log('Checking package integrity...'); verify(root);
  let port = 8787, noBrowser = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--no-browser') noBrowser = true;
    else if (/^--port=\d+$/.test(arg)) port = Number(arg.slice(7));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (port !== 0 && port < 1024)) throw new Error('Invalid port.');
  port = await portAvailable(port) ?? await portAvailable(0);
  const url = `http://127.0.0.1:${port}`;
  // Do not inherit developer credentials, data paths, Node flags or proxy variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PATH|PATHEXT)$/i.test(key)));
  Object.assign(env, { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), BANGUMI_DATA_DIR: join(root, 'data'), BANGUMI_DISTRIBUTION: '1' });
  child = spawn(join(root, 'runtime/node.exe'), [join(root, 'service.mjs')], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  writeFileSync(lock, JSON.stringify({ launcherPid: process.pid, servicePid: child.pid, url }));
  const ended = new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal })); });
  let exited = false; ended.then(() => { exited = true; }).catch(() => { exited = true; });
  let ready = false;
  for (let i = 0; i < 120 && !exited; i++) {
    try {
      const health = await (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) })).json();
      if (health.ok && health.version === '2.0.0' && resolve(health.dataDir) === join(root, 'data')) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) {
    shutdown();
    const status = await ended;
    throw new Error(`Startup failed (${JSON.stringify(status)}). Your data has not been deleted. See messages above.`);
  }
  console.log(`\nAnalyzer ready: ${url}/\nData: ${join(root, 'data')}\nPress ENTER in this window to stop safely. Closing the browser does not stop Analyzer.`);
  if (!noBrowser) {
    const browser = spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/c', 'start', '""', `${url}/`], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.log(`Open this address manually: ${url}/`));
  }
  input = createInterface({ input: process.stdin });
  input.on('line', shutdown);
  input.on('close', shutdown);
  const status = await ended;
  cleanup();
  if (status.code !== 0 || status.signal) throw new Error(`Service ended unexpectedly: ${JSON.stringify(status)}. Data remains in data/.`);
  console.log('Stopped. You may close this window.');
} catch (error) {
  console.error(`\nAnalyzer could not continue: ${error.message}`);
  console.error('No installer or administrator access is required. Read README.txt for help.');
  process.exitCode = 1;
  if (child?.connected) child.send('shutdown');
}
