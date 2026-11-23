import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit, inside, sha256, writeJson } from './lib.mjs';
import { verify } from './portable/integrity.mjs';

test('output path boundary rejects self, parents, sibling prefix and another drive', () => {
  const root = join(tmpdir(), 'ba-safety');
  assert.equal(inside(root, root), false);
  assert.equal(inside(root, join(root, '..', 'ba-safety-other')), false);
  assert.equal(inside(root, join(root, 'new')), true);
});
test('privacy scan rejects database, config, env, backup, sourcemap and literal credential canaries', () => {
  for (const name of ['data/bangumi.db', 'bangumi.db-wal', 'config.json', '.env.local', 'archive.bak', 'bundle.js.map', 'key.js']) {
    const root = mkdtempSync(join(tmpdir(), 'ba-dist-private-'));
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), name === 'key.js' ? `const key="${'sk-' + 'proj-abcdefghijklmnopqrstuvwxyz0123456789'}"` : 'canary');
    assert.throws(() => audit(root));
  }
});
test('real product data module is code, not personal data', () => {
  const root = mkdtempSync(join(tmpdir(), 'ba-dist-code-'));
  mkdirSync(join(root, 'packages/server/dist/data'), { recursive: true });
  writeFileSync(join(root, 'packages/server/dist/data/backup.js'), 'export const fixture = 1;');
  assert.equal(audit(root).length, 1);
});
test('integrity rejects altered, missing, unexpected and traversal files, permits personal data after startup', () => {
  const root = mkdtempSync(join(tmpdir(), 'ba-dist-integrity-'));
  writeFileSync(join(root, 'app.js'), 'original');
  writeJson(join(root, 'checksums.json'), { files: [{ path: 'app.js', sha256: sha256(join(root, 'app.js')) }] });
  assert.equal(verify(root), 1);
  mkdirSync(join(root, 'data')); writeFileSync(join(root, 'data/bangumi.db'), 'personal');
  assert.equal(verify(root), 1);
  writeFileSync(join(root, 'app.js'), 'modified'); assert.throws(() => verify(root));
  writeFileSync(join(root, 'app.js'), 'original');
  writeFileSync(join(root, 'extra.js'), 'unexpected'); assert.throws(() => verify(root));
  writeFileSync(join(root, 'checksums.json'), JSON.stringify({ files: [{ path: '../escape', sha256: 'x' }] }));
  assert.throws(() => verify(root), /Invalid checksum path/);
});
