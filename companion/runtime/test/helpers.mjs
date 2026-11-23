import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { sha256 } from '../package-check.mjs';

export const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repo = resolve(runtime, '../..');
export const zip = join(repo, 'dist/distribution-fr6uZl/Bangumi-Analyzer-2.0.0-windows-x64-r2.zip');
export const zipHash = 'ef8ea8cb083fb0b5e7b3091fa07eae065a5de3b84ea13b0245078bc3cc613236';
export const delay = ms => new Promise(r => setTimeout(r, ms));
export async function work(prefix) {
  await mkdir(join(runtime, '.work'), { recursive: true });
  return mkdtemp(join(runtime, '.work', prefix + '-'));
}
export async function extract(parent, name) {
  assert.equal(await sha256(zip), zipHash, 'Original r2 ZIP must match published SHA-256');
  const root = join(parent, name);
  await mkdir(root);
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  const child = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(zip)}, ${quote(root)})`],
    { windowsHide: true, encoding: 'utf8' });
  assert.equal(child.status, 0, 'Fresh ZIP extraction succeeded');
  return root;
}
export async function until(supervisor, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = supervisor.getStatus();
    if (predicate(status)) return status;
    await delay(50);
  }
  assert.fail('Expected runtime state was not observed: ' + JSON.stringify(supervisor.getStatus()));
}
export const ready = supervisor => until(supervisor, s => s.state === 'ready');
export async function fixture(parent, name, service) {
  const root = join(parent, name); await mkdir(root);
  for (const p of ['runtime', 'packages/server/dist', 'packages/web/dist', 'packages/shared/dist']) await mkdir(join(root, p), { recursive: true });
  await copyFile(process.execPath, join(root, 'runtime/node.exe'));
  for (const p of ['runtime/LICENSE', 'launch.mjs', 'integrity.mjs', 'Start-Analyzer.bat', 'README.txt', 'THIRD_PARTY_NOTICES.txt',
    'packages/server/dist/index.js', 'packages/server/dist/lifecycle.js', 'packages/web/dist/index.html', 'packages/shared/dist/index.js']) await writeFile(join(root, p), '// synthetic fixture only\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'service.mjs'), service);
  await writeFile(join(root, 'release.json'), JSON.stringify({ product: 'Bangumi Analyzer', version: '2.0.0', distributionRevision: 2,
    flavor: 'full-local', platform: 'windows-x64', node: process.version, runtimeSha256: await sha256(join(root, 'runtime/node.exe')) }));
  await rehash(root);
  return root;
}
export async function rehash(root) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + e.name;
      if (['checksums.json', 'data', '.analyzer-session.json'].includes(path)) continue;
      if (e.isDirectory()) await walk(join(dir, e.name), path + '/');
      else files.push({ path, sha256: await sha256(join(dir, e.name)) });
    }
  }
  await walk(root);
  await writeFile(join(root, 'checksums.json'), JSON.stringify({ algorithm: 'sha256', files }));
}
export async function sourceCheck() {
  // Only the 187 declared product inputs; no whole-repository scan and no Local/private reads.
  const release = JSON.parse(await readFile(join(repo, 'dist/distribution-fr6uZl/Bangumi-Analyzer-2.0.0-windows-x64-r2/release.json'), 'utf8'));
  const changed = [];
  for (const e of release.sourceFiles) if (await sha256(join(repo, e.path)) !== e.sha256) changed.push(e.path);
  return { inputs: release.sourceFiles.length, changed };
}
