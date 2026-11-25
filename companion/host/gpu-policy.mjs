import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GPU_MODES = new Set(['auto', 'gl', 'd3d11', 'off']);

const DISPLAY_CLASS_REG = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
const VIRTUAL_ADAPTER_RE = /Microsoft Basic|Virtual Display|Remote|RDP|Indirect|Mirage|Parsec|Citrix/i;

function readJsonSync(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeJsonSync(file, data) {
  try {
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* non-fatal telemetry write */
  }
}

export function detectWindowsAdapters() {
  if (process.platform !== 'win32') return [];
  try {
    const regExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    const r = spawnSync(regExe, ['query', DISPLAY_CLASS_REG, '/s', '/v', 'DriverDesc'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1500,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const found = new Set();
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/DriverDesc\s+REG_SZ\s+(.+)/i);
      if (!m) continue;
      const name = m[1].trim();
      if (name && !VIRTUAL_ADAPTER_RE.test(name)) found.add(name);
    }
    return [...found];
  } catch {
    return [];
  }
}

export function gpuStatePath(companionHome) {
  return companionHome ? join(companionHome, 'gpu-state.json') : null;
}

export function resolveGpuStartupPolicy({ companionHome, argv = [], stateGpuMode = 'auto' } = {}) {
  const cliModeArg = argv.find((a) => a.startsWith('--gpuMode='))?.slice('--gpuMode='.length);
  const cliAngleArg = argv.find((a) => a.startsWith('--use-angle='))?.slice('--use-angle='.length);
  const effectiveMode = GPU_MODES.has(cliModeArg)
    ? cliModeArg
    : GPU_MODES.has(stateGpuMode)
      ? stateGpuMode
      : 'auto';

  const stateFile = gpuStatePath(companionHome);
  const gpuState = stateFile ? readJsonSync(stateFile) : {};
  const failedBackends = Array.isArray(gpuState.failedBackends) ? gpuState.failedBackends.filter((x) => typeof x === 'string') : [];
  const crashCount = Number.isFinite(gpuState.crashCount) ? gpuState.crashCount : 0;

  let adapters = Array.isArray(gpuState.adapters) ? gpuState.adapters.filter((x) => typeof x === 'string') : null;
  if (!adapters) {
    adapters = detectWindowsAdapters();
    if (stateFile && companionHome) {
      try {
        mkdirSync(companionHome, { recursive: true });
        writeJsonSync(stateFile, { ...gpuState, adapters });
      } catch {
        /* ignore */
      }
    }
  }
  const hybridMultiGpu = process.platform === 'win32' && adapters.length >= 2;
  const base = {
    policyMode: effectiveMode,
    adapterCount: adapters.length,
    hybridMultiGpu,
    crashCount,
    failedBackends,
  };

  if (cliAngleArg) {
    return {
      ...base,
      activeBackend: cliAngleArg,
      webglAllowed: true,
      switches: [['use-gl', 'angle'], ['use-angle', cliAngleArg]],
      reason: 'CLI_USE_ANGLE_OVERRIDE',
    };
  }

  if (effectiveMode === 'off') {
    return {
      ...base,
      activeBackend: 'disabled-2d',
      webglAllowed: false,
      switches: [],
      reason: 'USER_DISABLED',
    };
  }

  const d3d11Switches = process.platform === 'win32' ? [['use-gl', 'angle'], ['use-angle', 'd3d11']] : [];
  const glSwitches = process.platform === 'win32' ? [['use-gl', 'angle'], ['use-angle', 'gl']] : [];

  if (effectiveMode === 'gl') {
    return {
      ...base,
      activeBackend: 'gl',
      webglAllowed: true,
      switches: glSwitches,
      reason: 'USER_SELECTED_GL',
    };
  }

  if (effectiveMode === 'd3d11') {
    return {
      ...base,
      activeBackend: 'default',
      webglAllowed: true,
      switches: d3d11Switches,
      reason: 'USER_SELECTED_D3D11',
    };
  }

  // 'auto' policy: avoid --enable-unsafe-swiftshader; prefer Windows DirectComposition-compatible
  // ANGLE D3D11 on both single- and hybrid-GPU systems, falling back to ANGLE GL only if D3D11 crashes.
  if (failedBackends.includes('default') && failedBackends.includes('gl')) {
    return {
      ...base,
      activeBackend: 'disabled-2d',
      webglAllowed: false,
      switches: [],
      reason: 'GPU_REPEATED_CRASH_FALLBACK',
    };
  }
  if (failedBackends.includes('default')) {
    return {
      ...base,
      activeBackend: 'gl',
      webglAllowed: true,
      switches: glSwitches,
      reason: 'RECOVERY_FROM_DEFAULT_CRASH',
    };
  }
  if (failedBackends.includes('gl')) {
    return {
      ...base,
      activeBackend: 'default',
      webglAllowed: true,
      switches: d3d11Switches,
      reason: 'RECOVERY_FROM_GL_CRASH',
    };
  }
  if (hybridMultiGpu) {
    return {
      ...base,
      activeBackend: 'default',
      webglAllowed: true,
      switches: d3d11Switches,
      reason: 'HYBRID_MULTI_GPU_D3D11',
    };
  }
  return {
    ...base,
    activeBackend: 'default',
    webglAllowed: true,
    switches: d3d11Switches,
    reason: 'SINGLE_GPU_DEFAULT',
  };
}

export function recordGpuCrash(companionHome, policy, details = {}) {
  const file = gpuStatePath(companionHome);
  if (!file) return;
  const cur = readJsonSync(file);
  const backend = policy?.activeBackend === 'gl' ? 'gl' : 'default';
  const prevFailed = Array.isArray(cur.failedBackends) ? cur.failedBackends : [];
  const nextFailed = [...new Set([...prevFailed, backend])];
  try {
    mkdirSync(companionHome, { recursive: true });
    writeJsonSync(file, {
      ...cur,
      crashCount: (Number(cur.crashCount) || 0) + 1,
      failedBackends: nextFailed,
      lastBackend: backend,
      lastReason: typeof details.reason === 'string' ? details.reason.slice(0, 64) : 'crashed',
      lastExitCode: Number.isFinite(details.exitCode) ? details.exitCode : null,
      lastCrashAt: new Date().toISOString(),
    });
  } catch {
    /* non-fatal */
  }
}

export function markGpuHealthy(companionHome, policy) {
  const file = gpuStatePath(companionHome);
  if (!file || !policy?.webglAllowed) return;
  const cur = readJsonSync(file);
  const curFailed = Array.isArray(cur.failedBackends) ? cur.failedBackends : [];
  const currentBackend = policy.activeBackend === 'gl' ? 'gl' : 'default';
  // Only clear the currently healthy backend; retain failures for other backends to prevent boot ping-pong.
  const nextFailed = curFailed.filter((b) => b !== currentBackend);
  if (!cur.crashCount && nextFailed.length === curFailed.length) return;
  try {
    mkdirSync(companionHome, { recursive: true });
    writeJsonSync(file, {
      ...cur,
      crashCount: 0,
      failedBackends: nextFailed,
      lastHealthyBackend: policy.activeBackend,
      lastHealthyAt: new Date().toISOString(),
    });
  } catch {
    /* non-fatal */
  }
}
