import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, copyFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export const json = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function writeJson(file, value) { writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
export function inside(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(file).startsWith('\\\\') && !rel.includes(':');
}
export function files(root) {
  const result = [];
  function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry), stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Link forbidden: ${relative(root, full)}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) result.push(full);
      else throw new Error('Non-regular file');
    }
  }
  walk(root); return result;
}
export function copy(file, target) {
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`Expected regular file: ${file}`);
  mkdirSync(dirname(target), { recursive: true }); copyFileSync(file, target);
}
export function resolvePackage(name, from) {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || name.split('/').some(x => x === '.' || x === '..')) throw new Error('Invalid package name');
  const req = createRequire(join(from, 'package.json'));
  for (const lookup of req.resolve.paths(name) ?? []) {
    const file = join(lookup, name, 'package.json');
    if (existsSync(file)) {
      const dir = dirname(realpathSync(file));
      return { dir, metadata: json(join(dir, 'package.json')) };
    }
  }
  throw new Error(`Missing installed dependency: ${name}`);
}

// Product files are selected by the builder, not by traversing the workspace root.
// Reject unexpected data even if an input rule is accidentally widened later.
export function audit(root) {
  const inventory = [];
  for (const file of files(root)) {
    const path = relative(root, file).split(sep).join('/');
    if (/^data(\/|$)/i.test(path) || /(^|\/)(backups?|snapshot|logs?|covers|wallpapers|\.git|\.runtime|\.env[^/]*)(\/|$)/i.test(path) ||
        /(?:\.db(?:-wal|-shm)?|\.sqlite\d?|\.bak|\.log|\.map|\.tsbuildinfo|\.node)$/i.test(path) ||
        /(^|\/)config\.json$/i.test(path) || /(^|\/)(public-demo|site)(\/|$)/i.test(path)) throw new Error(`Private/unexpected file: ${path}`);
    if (/\.(?:js|mjs|cjs|json|html|css|md|txt|bat)$/i.test(path)) {
      const text = readFileSync(file, 'utf8');
      if (/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+/i.test(text) ||
          /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/.test(text) ||
          /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{15,}/.test(text)) throw new Error(`Potential private content: ${path}`);
    }
    inventory.push({ path, bytes: lstatSync(file).size, sha256: sha256(file) });
  }
  return inventory;
}
