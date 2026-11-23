// Offline, additive build from the CURRENT working files; never git archive or existing dist.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { audit, copy, files, inside, json, resolvePackage, sha256, writeJson } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const version = json(join(repo, 'package.json')).version;
if (process.platform !== 'win32' || process.arch !== 'x64' || !process.version.startsWith('v24.')) throw new Error('Build with Windows x64 Node 24');
if (version !== '2.0.0' || !readFileSync(join(repo, 'packages/server/src/config.ts'), 'utf8').includes("APP_VERSION = '2.0.0'")) throw new Error('Expected current v2.0.0');
const base = join(repo, 'dist'); mkdirSync(base, { recursive: true });
if (resolve(base) !== (await import('node:fs')).realpathSync(base)) throw new Error('Output root must not be a junction');
const work = mkdtempSync(join(base, 'distribution-'));
const build = join(work, 'build'); mkdirSync(build);
const distributionRevision = 3;
const releaseName = `Bangumi-Analyzer-${version}-windows-x64-r${distributionRevision}`;
const release = join(work, releaseName); mkdirSync(release);
const sourceFiles = [];
function input(path) {
  const file = join(repo, path); copy(file, join(build, path));
  sourceFiles.push({ path: path.split(sep).join('/'), sha256: sha256(file) });
}
for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json']) input(path);
for (const pkg of ['shared', 'server', 'web']) {
  for (const name of ['package.json', 'tsconfig.json']) input(`packages/${pkg}/${name}`);
  const root = join(repo, 'packages', pkg, 'src');
  for (const file of files(root)) {
    const rel = relative(root, file);
    if (/(^|[\\/])(?:test|__tests__)([\\/]|$)/.test(rel) || /\.(test|spec)\./.test(rel)) continue;
    if (!/\.(ts|tsx|css)$/.test(file)) throw new Error(`Unreviewed source type: ${rel}`);
    input(relative(repo, file));
  }
}
input('packages/web/index.html'); input('packages/web/vite.config.ts');
// There are currently no public assets. Fail closed instead of silently omitting future ones.
if (existsSync(join(repo, 'packages/web/public')) && files(join(repo, 'packages/web/public')).length) throw new Error('Review public asset allowlist first');
// Only build-time dependency junctions. They never enter the release.
for (const location of ['', 'packages/shared', 'packages/server', 'packages/web']) {
  const original = join(repo, location), target = join(build, location, 'node_modules'); mkdirSync(target);
  const metadata = json(join(original, 'package.json'));
  for (const name of new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.devDependencies ?? {})])) {
    const source = name === '@bangumi-analyzer/shared' ? join(build, 'packages/shared') : resolvePackage(name, original).dir;
    const link = join(target, name); mkdirSync(dirname(link), { recursive: true }); symlinkSync(source, link, 'junction');
  }
}
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:BANGUMI_|AI_|VITE_|NODE_OPTIONS$|NODE_PATH$|PORT$|HOST$)/i.test(key)));
const logFile = join(work, 'build.log');
function run(args, cwd = build) {
  const result = spawnSync(process.execPath, args, { cwd, env: cleanEnv, encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  (awaitlessAppend)(logFile, `\n$ node ${args.map(x => x.replaceAll(build, '<isolated-build>')).join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.status !== 0) throw new Error(`Build command failed (${result.status}); see ${logFile}`);
}
// Keep the source tree intact; command diagnostics are outside the distributable.
function awaitlessAppend(file, text) { writeFileSync(file, text, { flag: 'a' }); }
const tsc = join(resolvePackage('typescript', repo).dir, 'bin/tsc');
for (const pkg of ['shared', 'server']) run([tsc, '-p', join(build, 'packages', pkg, 'tsconfig.json'), '--sourceMap', 'false', '--declarationMap', 'false']);
run([tsc, '-p', join(build, 'packages/web/tsconfig.json'), '--noEmit']);
run([join(resolvePackage('vite', join(repo, 'packages/web')).dir, 'bin/vite.js'), 'build'], join(build, 'packages/web'));

for (const pkg of ['shared', 'server', 'web']) {
  const root = join(build, 'packages', pkg, 'dist');
  for (const file of files(root)) {
    if (file.endsWith('.d.ts')) continue; // needed for isolated typechecking, not runtime
    if (pkg !== 'web' && !file.endsWith('.js')) throw new Error('Unexpected compiler output');
    copy(file, join(release, 'packages', pkg, 'dist', relative(root, file)));
  }
  if (pkg !== 'web') copy(join(build, 'packages', pkg, 'package.json'), join(release, 'packages', pkg, 'package.json'));
}
writeJson(join(release, 'package.json'), { name: 'bangumi-analyzer-portable', version, private: true, type: 'module' });
const dependencies = [];
const locked = readFileSync(join(build, 'pnpm-lock.yaml'), 'utf8');
function assertLocked(metadata) {
  if (!locked.split(/\r?\n/).some(line => line.startsWith(`  ${metadata.name}@${metadata.version}:`) || line.startsWith(`  '${metadata.name}@${metadata.version}':`))) throw new Error(`Installed dependency absent from lock: ${metadata.name}@${metadata.version}`);
}
const pruned = new Set(['node_modules', 'test', 'tests', '__tests__', 'docs', 'doc', 'examples', 'example', 'benchmark', 'benchmarks', '.github', '.git']);
function stage(name, from, target, ancestors = new Map()) {
  if (name === '@bangumi-analyzer/shared') return; // official workspace package is below node_modules
  const { dir, metadata } = resolvePackage(name, from);
  assertLocked(metadata);
  if (ancestors.get(name) === dir) return;
  const next = new Map(ancestors).set(name, dir);
  function walk(source, dest) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (pruned.has(entry.name) || entry.name.startsWith('.env') || /(?:\.map|\.d\.[cm]?ts|\.tsbuildinfo)$/.test(entry.name)) continue;
      if (entry.isDirectory()) walk(join(source, entry.name), join(dest, entry.name));
      else copy(join(source, entry.name), join(dest, entry.name));
    }
  }
  walk(dir, target);
  dependencies.push({ name, version: metadata.version, license: metadata.license ?? 'See package license', path: relative(release, target).split(sep).join('/') });
  for (const dep of Object.keys(metadata.dependencies ?? {}).sort()) stage(dep, dir, join(target, 'node_modules', dep), next);
  for (const dep of Object.keys(metadata.optionalDependencies ?? {}).sort()) {
    // No native modules are needed by the current dependency closure. Review changes explicitly.
    try { resolvePackage(dep, dir); } catch { continue; }
    stage(dep, dir, join(target, 'node_modules', dep), next);
  }
}
for (const name of Object.keys(json(join(repo, 'packages/server/package.json')).dependencies).sort()) stage(name, join(repo, 'packages/server'), join(release, 'node_modules', name));
for (const file of files(join(release, 'packages/shared'))) copy(file, join(release, 'node_modules/@bangumi-analyzer/shared', relative(join(release, 'packages/shared'), file)));

// Runtime executable actually used for this build, plus its complete upstream license notices.
const nodeLicense = join(dirname(process.execPath), 'LICENSE');
if (!existsSync(nodeLicense)) throw new Error('Node redistribution requires the upstream LICENSE');
copy(process.execPath, join(release, 'runtime/node.exe')); copy(nodeLicense, join(release, 'runtime/LICENSE'));
for (const name of ['launch.mjs', 'service.mjs', 'integrity.mjs', 'Start-Analyzer.bat']) copy(join(here, 'portable', name), join(release, name));
copy(join(repo, 'docs/distribution/USER_README.md'), join(release, 'README.txt'));
// Include frontend bundled dependency notices, without copying any workspace settings or assets.
const frontend = new Map();
function notices(name, from) {
  if (name === '@bangumi-analyzer/shared') return;
  const { dir, metadata } = resolvePackage(name, from), id = `${metadata.name}@${metadata.version}`;
  assertLocked(metadata);
  if (frontend.has(id)) return;
  const texts = readdirSync(dir).filter(n => /^(LICENSE|LICENCE|COPYING|NOTICE)([.-]|$)/i.test(n)).map(n => `${n}\n${readFileSync(join(dir, n), 'utf8')}`);
  if (!texts.length && !metadata.license) throw new Error(`Missing license: ${id}`);
  frontend.set(id, { license: metadata.license, notices: texts });
  for (const dep of Object.keys(metadata.dependencies ?? {})) notices(dep, dir);
}
for (const name of Object.keys(json(join(repo, 'packages/web/package.json')).dependencies)) notices(name, join(repo, 'packages/web'));
writeFileSync(join(release, 'THIRD_PARTY_NOTICES.txt'), [...frontend].map(([id, x]) => `=== ${id} (${JSON.stringify(x.license)}) ===\n${x.notices.join('\n')}`).join('\n\n'), { flag: 'wx' });
writeJson(join(release, 'release.json'), { product: 'Bangumi Analyzer', version, distributionRevision, flavor: 'full-local', platform: 'windows-x64', node: process.version, runtimeSha256: sha256(process.execPath), sourceFiles: sourceFiles.sort((a,b) => a.path.localeCompare(b.path)), dependencies });
// A concurrent edit must fail the build, not create an untraceable mixed source release.
for (const entry of sourceFiles) if (sha256(join(repo, entry.path)) !== entry.sha256) throw new Error(`Source changed during build: ${entry.path}`);
writeJson(join(release, 'checksums.json'), { algorithm: 'sha256', files: audit(release) });
audit(release);
const zip = join(work, `${releaseName}.zip`);
const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${release.replaceAll("'", "''")}', '${zip.replaceAll("'", "''")}')`;
const packed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
if (packed.status !== 0) throw new Error(`ZIP failed: ${packed.stderr}`);
writeFileSync(`${zip}.sha256`, `${sha256(zip)}  ${releaseName}.zip\n`, { flag: 'wx' });
writeJson(join(work, 'build-result.json'), { release, zip, sha256: sha256(zip), files: audit(release).length, sourceFiles: sourceFiles.length, node: process.version });
console.log(JSON.stringify({ release, zip, work }));
