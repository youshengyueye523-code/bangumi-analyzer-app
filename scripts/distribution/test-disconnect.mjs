// Focused tests in the builder's isolated SOURCE copy, never the formal dist/data.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inside, resolvePackage } from './lib.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const build = resolve(process.argv[2] ?? '');
assert.ok(inside(join(repo, 'dist'), build) && /[\\/]distribution-[^\\/]+[\\/]build$/.test(build));
for (const path of ['packages/server/vitest.config.ts', 'packages/server/test/setup.ts', 'packages/server/test/helpers.ts', 'packages/server/test/fixtures.ts', 'packages/server/test/http-api.test.ts', 'packages/server/test/account-disconnect.test.ts', 'packages/web/src/test/setup.ts', 'packages/web/src/pages/SettingsPage.test.tsx', 'packages/web/src/pages/SettingsPageDisconnect.test.tsx']) {
  const target = join(build, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repo, path), target);
}
const vitest = join(resolvePackage('vitest', repo).dir, 'vitest.mjs');
for (const [pkg, args] of [
  ['server', ['--config', 'vitest.config.ts', 'test/account-disconnect.test.ts', 'test/http-api.test.ts', '-t', 'portable-only|账号|凭据|用户名|Token|同步分页']],
  ['web', ['--config', 'vite.config.ts', 'src/pages/SettingsPageDisconnect.test.tsx', 'src/pages/SettingsPage.test.tsx']],
]) {
  const result = spawnSync(process.execPath, [vitest, 'run', ...args], { cwd: join(build, 'packages', pkg), env: { ...process.env, BANGUMI_DISTRIBUTION: '', NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(dirname(build), `disconnect-${pkg}-tests.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  console.log(JSON.stringify({ package: pkg, exitCode: result.status, output: (result.stdout + result.stderr).slice(-6000) }));
  if (result.status !== 0) process.exitCode = 1;
}
