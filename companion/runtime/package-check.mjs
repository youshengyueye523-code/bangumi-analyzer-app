import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const required = ['runtime/node.exe', 'runtime/LICENSE', 'service.mjs', 'launch.mjs', 'integrity.mjs',
  'Start-Analyzer.bat', 'package.json', 'release.json', 'README.txt', 'THIRD_PARTY_NOTICES.txt',
  'packages/server/dist/index.js', 'packages/server/dist/lifecycle.js',
  'packages/web/dist/index.html', 'packages/shared/dist/index.js'];

export class RuntimeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const fail = code => { throw new RuntimeError(code); };
const key = p => resolve(p).toLowerCase();
const within = (parent, child) => key(child) === key(parent) || key(child).startsWith(key(parent) + sep);

// Reject linked ancestors as well as a linked leaf. Never follow a link into Local data.
export async function normalPath(path, directory = true) {
  const absolute = resolve(path);
  if (!isAbsolute(path) || absolute.startsWith('\\\\')) fail('UNSAFE_PATH');
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && cursor !== absolute)) fail('UNSAFE_PATH');
  }
  const stat = await lstat(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) fail('UNSAFE_PATH');
  if (key(await realpath(absolute)) !== key(absolute)) fail('UNSAFE_PATH');
  return absolute;
}

export async function safeData(root) {
  async function walk(dir) {
    const stat = await lstat(dir);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) fail('UNSAFE_PATH');
    if (stat.isDirectory()) for (const name of await readdir(dir)) await walk(join(dir, name));
  }
  const data = join(root, 'data');
  try {
    const stat = await lstat(data);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH');
    await walk(data); // Metadata only: never read config, DB, logs or any personal bytes.
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function checkPackage(path) {
  try {
    if (typeof path !== 'string' || !isAbsolute(path)) fail('UNSAFE_PATH');
    const root = resolve(path);
    if (key(root) === key(workspace) || ['data', '.runtime', 'packages', 'public-demo', 'site'].some(p => within(join(workspace, p), root))) fail('UNSAFE_PATH');
    await normalPath(root);
    // Check portable structure BEFORE even traversing data metadata; a source checkout is not a package.
    for (const name of [...required, 'checksums.json']) await normalPath(join(root, name), false);
    const manifestFile = join(root, 'checksums.json');
    if ((await lstat(manifestFile)).size > 4 * 1024 * 1024) fail('PACKAGE_INVALID');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest.algorithm !== 'sha256' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000) fail('PACKAGE_INVALID');
    const expected = new Set(['checksums.json']);
    for (const entry of manifest.files) {
      const name = entry.path;
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_@./+ -]+$/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)) ||
          /^(data|\.analyzer-session\.json)(\/|$)/i.test(name) || !/^[a-f0-9]{64}$/.test(entry.sha256) || expected.has(name.toLowerCase())) fail('PACKAGE_INVALID');
      expected.add(name.toLowerCase());
      const file = join(root, name);
      await normalPath(file, false);
      if (await sha256(file) !== entry.sha256) fail('PACKAGE_DAMAGED');
    }
    for (const name of required) if (!expected.has(name.toLowerCase())) fail('PACKAGE_INVALID');
    async function walk(dir) {
      for (const name of await readdir(dir)) {
        if (dir === root && name === 'data') continue;
        if (dir === root && name === '.analyzer-session.json') fail('SESSION_LOCKED');
        const full = join(dir, name), stat = await lstat(full);
        if (stat.isSymbolicLink()) fail('UNSAFE_PATH');
        if (stat.isDirectory()) await walk(full);
        else if (!stat.isFile() || stat.nlink !== 1 || !expected.has(relative(root, full).split(sep).join('/').toLowerCase())) fail('PACKAGE_INVALID');
      }
    }
    await walk(root);
    const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
    const rev = Number(release.distributionRevision);
    if (release.product !== 'Bangumi Analyzer' || release.version !== '2.0.0' || !(Number.isInteger(rev) && rev >= 2 && rev <= 5) ||
        release.flavor !== 'full-local' || release.platform !== 'windows-x64' || !/^v24\./.test(release.node) ||
        release.runtimeSha256 !== await sha256(join(root, 'runtime/node.exe'))) fail('PACKAGE_UNSUPPORTED');
    await safeData(root);
    await access(root, constants.W_OK);
    return { root, version: release.version, distributionRevision: rev, files: manifest.files.length, checksumsSha256: await sha256(manifestFile) };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (error.code === 'ENOENT') fail('PACKAGE_MISSING');
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) fail('PACKAGE_ACCESS');
    fail('PACKAGE_INVALID');
  }
}
