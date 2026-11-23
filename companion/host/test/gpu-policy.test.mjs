import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { markGpuHealthy, recordGpuCrash, resolveGpuStartupPolicy } from '../gpu-policy.mjs';

test('GPU policy never emits unsafe-swiftshader switches and adapts per adapter topology & crashes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'companion-gpu-policy-'));
  try {
    // 1. Single-GPU fresh machine keeps Electron default backend cleanly
    await writeFile(join(home, 'gpu-state.json'), JSON.stringify({ adapters: ['NVIDIA GeForce RTX 4060'] }));
    const single = resolveGpuStartupPolicy({ companionHome: home, argv: [], stateGpuMode: 'auto' });
    assert.equal(single.activeBackend, 'default');
    assert.equal(single.webglAllowed, true);
    assert.deepEqual(single.switches, []);
    assert.equal(single.switches.some(([k]) => k.includes('swiftshader')), false);

    // 2. Hybrid multi-GPU machine selects ANGLE OpenGL backend cleanly on launch #1
    await writeFile(join(home, 'gpu-state.json'), JSON.stringify({ adapters: ['Intel(R) Graphics', 'NVIDIA GeForce RTX 5070 Laptop GPU'] }));
    const hybrid = resolveGpuStartupPolicy({ companionHome: home, argv: [], stateGpuMode: 'auto' });
    if (process.platform === 'win32') {
      assert.equal(hybrid.hybridMultiGpu, true);
      assert.equal(hybrid.activeBackend, 'gl');
      assert.deepEqual(hybrid.switches, [['use-gl', 'angle'], ['use-angle', 'gl']]);
    }

    // 3. Crash recovery transitions default -> gl -> disabled-2d cleanly
    await writeFile(join(home, 'gpu-state.json'), JSON.stringify({ adapters: ['Single GPU'] }));
    const initial = resolveGpuStartupPolicy({ companionHome: home, argv: [], stateGpuMode: 'auto' });
    recordGpuCrash(home, initial, { exitCode: -1073741819, reason: 'crashed' });

    const recovered = resolveGpuStartupPolicy({ companionHome: home, argv: [], stateGpuMode: 'auto' });
    assert.equal(recovered.activeBackend, 'gl');
    assert.equal(recovered.webglAllowed, true);
    assert.equal(recovered.reason, 'RECOVERY_FROM_DEFAULT_CRASH');

    recordGpuCrash(home, recovered, { exitCode: -1073741819, reason: 'crashed' });
    const safeFallback = resolveGpuStartupPolicy({ companionHome: home, argv: [], stateGpuMode: 'auto' });
    assert.equal(safeFallback.activeBackend, 'disabled-2d');
    assert.equal(safeFallback.webglAllowed, false);
    assert.equal(safeFallback.reason, 'GPU_REPEATED_CRASH_FALLBACK');

    // 4. markGpuHealthy clears transient crashes while preserving cached adapters
    await writeFile(join(home, 'gpu-state.json'), JSON.stringify({ adapters: ['Intel(R) Graphics', 'NVIDIA RTX'], crashCount: 1, failedBackends: ['default'] }));
    markGpuHealthy(home, { webglAllowed: true, activeBackend: 'gl' });
    const reset = resolveGpuStartupPolicy({ companionHome: home, argv: [], stateGpuMode: 'auto' });
    assert.equal(reset.crashCount, 0);
    assert.equal(reset.adapterCount, 2);

    // 5. Explicit user 'off' mode disables WebGL safely
    const disabled = resolveGpuStartupPolicy({ companionHome: home, argv: [], stateGpuMode: 'off' });
    assert.equal(disabled.webglAllowed, false);
    assert.equal(disabled.reason, 'USER_DISABLED');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
