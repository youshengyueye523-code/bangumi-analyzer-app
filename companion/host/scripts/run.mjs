import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { newWork, extractR2, host, desktopEnvironment } from './isolated.mjs';

// No arguments: a new isolated r2 every time. Explicit existing copies are a trusted operator decision.
let root;
if (!process.argv[2]) { root = await extractR2(await newWork('manual')); }
else {
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) throw new Error('Pass one absolute independent package directory');
  root = process.argv[2];
}

const electronExe = join(host, 'node_modules/electron/dist/electron.exe');
if (!existsSync(electronExe)) {
  console.error('Companion host executable missing; reinstall companion/host dependencies.');
  process.exit(1);
}

const env = desktopEnvironment();
delete env.ELECTRON_RUN_AS_NODE;

// windowsHide MUST remain false for GUI Electron: SW_HIDE in STARTUPINFO causes BrowserWindow.show() on Windows to stay invisible.
let child;
try {
  child = spawn(electronExe, [join(host, 'main.mjs'), '--packageRoot', root], {
    cwd: host,
    env,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  console.error(`Companion host could not start: ${err?.code ?? err?.message ?? 'UNKNOWN'}`);
  process.exit(1);
}

let windowVisible = false;
let stdoutBuf = '';
let startupFailed = false;
const startupTimer = setTimeout(() => {
  if (!windowVisible) {
    startupFailed = true;
    console.error('Companion host timed out before displaying its desktop window.');
    process.exitCode = 1;
  }
}, 20000);
startupTimer.unref();

child.stdout.on('data', chunk => {
  stdoutBuf += chunk.toString('utf8');
  if (!windowVisible && stdoutBuf.includes('COMPANION_WINDOW_VISIBLE')) {
    windowVisible = true;
    clearTimeout(startupTimer);
    console.log('Companion M1-A launched with an independent package. Use native window controls to exit safely.');
  }
  if (stdoutBuf.length > 4096) stdoutBuf = stdoutBuf.slice(-1024);
});

// Drain stderr so the pipe never stalls Chromium; capture only explicit host failure markers.
child.stderr.on('data', chunk => {
  if (!windowVisible && chunk.toString('utf8').includes('COMPANION_HOST_FAILED')) {
    startupFailed = true;
  }
});

child.once('error', err => {
  clearTimeout(startupTimer);
  console.error(`Companion host could not start: ${err.code ?? err.message}`);
  process.exitCode = 1;
});

child.once('exit', code => {
  clearTimeout(startupTimer);
  if (!windowVisible || startupFailed) {
    console.error(`Companion host exited before displaying a window (code=${code ?? 'unknown'}).`);
    process.exitCode = code && code !== 0 ? code : 1;
    return;
  }
  process.exitCode = code ?? 0;
});
