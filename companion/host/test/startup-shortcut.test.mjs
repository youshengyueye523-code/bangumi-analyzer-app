import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shortcutTargetSpec, resolveCompanionHome } from '../setup-service.mjs';

function makeTempTree(label) {
  return mkdtempSync(join(tmpdir(), `companion-shortcut-${label}-`));
}

test('Installed RC targets Bangumi-Analyzer-Companion.exe with clean Installed shortcut name', () => {
  const base = makeTempTree('installed');
  try {
    const root = join(base, 'Program Files', 'Bangumi Analyzer Companion');
    const host = join(root, 'host');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(root, 'Bangumi-Analyzer-Companion.exe'), '');
    writeFileSync(join(root, '.companion-installed'), 'installed');
    writeFileSync(join(host, 'main.mjs'), '');

    const spec = shortcutTargetSpec({
      electronExe: join(host, 'node_modules', 'electron', 'dist', 'electron.exe'),
      mainScript: join(host, 'main.mjs'),
      companionHome: resolveCompanionHome(null),
    });

    assert.equal(spec.shortcutName, 'Bangumi Analyzer Companion.lnk');
    assert.equal(spec.targetPath, join(root, 'Bangumi-Analyzer-Companion.exe'));
    assert.equal(spec.argumentsStr, '');
    assert.equal(spec.workingDir, root);
    assert.equal(spec.iconLocation, `${join(root, 'Bangumi-Analyzer-Companion.exe')},0`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Portable RC separates shortcut name and targets its own portable EXE', () => {
  const base = makeTempTree('portable');
  try {
    const root = join(base, 'Bangumi-Analyzer-Companion-Portable-win-x64');
    const host = join(root, 'host');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(root, 'Bangumi-Analyzer-Companion.exe'), '');
    writeFileSync(join(root, '.companion-portable'), 'portable');
    writeFileSync(join(host, 'main.mjs'), '');

    const spec = shortcutTargetSpec({
      electronExe: join(host, 'node_modules', 'electron', 'dist', 'electron.exe'),
      mainScript: join(host, 'main.mjs'),
      companionHome: join(root, 'companion-data'),
    });

    assert.equal(spec.shortcutName, 'Bangumi Analyzer Companion (Portable).lnk');
    assert.equal(spec.targetPath, join(root, 'Bangumi-Analyzer-Companion.exe'));
    assert.equal(spec.argumentsStr, '');
    assert.equal(spec.workingDir, root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Dev fallback quotes mainScript and companionHome containing spaces', () => {
  const base = makeTempTree('dev space');
  try {
    const host = join(base, 'Bangumi Analyzer Companion', 'host');
    const assets = join(host, 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(host, 'main.mjs'), '');
    writeFileSync(join(assets, 'companion-icon.ico'), '');
    const customHome = join(base, 'Home With Spaces');

    const spec = shortcutTargetSpec({
      electronExe: join(host, 'electron.exe'),
      mainScript: join(host, 'main.mjs'),
      companionHome: customHome,
    });

    assert.equal(spec.shortcutName, 'Bangumi Analyzer Companion.lnk');
    assert.equal(spec.targetPath, join(host, 'electron.exe'));
    assert.match(spec.argumentsStr, /^"[^"]*Bangumi Analyzer Companion\\host\\main\.mjs" --companionHome "[^"]*Home With Spaces"$/);
    assert.equal(spec.iconLocation, `${join(assets, 'companion-icon.ico')},0`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
