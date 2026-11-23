import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { desktopEnvironment, host } from './isolated.mjs';

const args = [join(host, 'main.mjs')];
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token === '--companionHome' || token === '--port' || token === '--r2Zip') {
    const val = process.argv[i + 1];
    if (!val || ((token === '--companionHome' || token === '--r2Zip') && !isAbsolute(val))) {
      throw new Error(`Invalid argument for ${token}: must pass an absolute path`);
    }
    args.push(token, val);
    i += 1;
  } else {
    throw new Error(`Unknown argument: ${token}`);
  }
}

const electronExe = join(host, 'node_modules/electron/dist/electron.exe');
if (!existsSync(electronExe)) {
  console.error('Companion host executable missing; reinstall companion/host dependencies.');
  process.exit(1);
}

const env = desktopEnvironment();
delete env.ELECTRON_RUN_AS_NODE;

let child;
try {
  child = spawn(electronExe, args, {
    cwd: host,
    env,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  console.error(`Companion Product Mode could not start: ${err?.code ?? err?.message ?? 'UNKNOWN'}`);
  process.exit(1);
}

let windowVisible = false;
let stdoutBuf = '';
let startupFailed = false;
const startupTimer = setTimeout(() => {
  if (!windowVisible) {
    startupFailed = true;
    console.error('Companion Product Mode timed out before displaying its desktop window.');
    process.exitCode = 1;
  }
}, 20000);
startupTimer.unref();

child.stdout.on('data', chunk => {
  stdoutBuf += chunk.toString('utf8');
  if (!windowVisible && stdoutBuf.includes('COMPANION_WINDOW_VISIBLE')) {
    windowVisible = true;
    clearTimeout(startupTimer);
    console.log('Bangumi Analyzer Companion launched in Product Mode. Use window controls to exit safely.');
  }
  if (stdoutBuf.length > 4096) stdoutBuf = stdoutBuf.slice(-1024);
});

child.stderr.on('data', chunk => {
  if (!windowVisible && chunk.toString('utf8').includes('COMPANION_HOST_FAILED')) {
    startupFailed = true;
  }
});

child.once('error', err => {
  clearTimeout(startupTimer);
  console.error(`Companion Product Mode could not start: ${err.code ?? err.message}`);
  process.exitCode = 1;
});

child.once('exit', code => {
  clearTimeout(startupTimer);
  if (!windowVisible || startupFailed) {
    console.error(`Companion exited before displaying a window (code=${code ?? 'unknown'}).`);
    process.exitCode = code && code !== 0 ? code : 1;
    return;
  }
  process.exitCode = code ?? 0;
});
