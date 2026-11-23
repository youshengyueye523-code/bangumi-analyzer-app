import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function verify(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'checksums.json'), 'utf8'));
  const expected = new Set(['checksums.json']);
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.split('/').some(x => !x || x === '.' || x === '..') || entry.path.includes(':')) throw new Error('Invalid checksum path');
    const file = resolve(root, entry.path);
    if (!file.startsWith(resolve(root) + sep)) throw new Error('Checksum path escaped package');
    let cursor = root;
    for (const component of entry.path.split('/')) {
      cursor = join(cursor, component);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('Package links are not supported');
    }
    if (!lstatSync(file).isFile() || createHash('sha256').update(readFileSync(file)).digest('hex') !== entry.sha256) throw new Error(`Missing or damaged file: ${entry.path}`);
    expected.add(entry.path);
  }
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (dir === root && ['data', '.analyzer-session.json'].includes(name)) continue;
      const file = join(dir, name), stat = lstatSync(file), rel = relative(root, file).split(sep).join('/');
      if (stat.isSymbolicLink()) throw new Error('Package links are not supported');
      if (stat.isDirectory()) walk(file);
      else if (!expected.has(rel)) throw new Error(`Unexpected package file: ${rel}`);
    }
  }
  walk(root); return manifest.files.length;
}
