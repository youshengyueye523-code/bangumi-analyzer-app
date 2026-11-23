import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../runtime/package-check.mjs';

export const host = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repo = resolve(host, '../..');
export const zip = join(repo, 'dist/distribution-fr6uZl/Bangumi-Analyzer-2.0.0-windows-x64-r2.zip');
export const ZIP_HASH = 'ef8ea8cb083fb0b5e7b3091fa07eae065a5de3b84ea13b0245078bc3cc613236';
export async function newWork(prefix) { await mkdir(join(host, '.work'), { recursive: true }); return mkdtemp(join(host, '.work', prefix + '-')); }
export async function extractR2(work, name = 'Analyzer 独立 & M1') {
  if (await sha256(zip) !== ZIP_HASH) throw new Error('ZIP hash mismatch');
  const root = join(work, name); await mkdir(root);
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-NonInteractive','-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(zip)},${quote(root)})`],
    { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Independent ZIP extraction failed');
  return root;
}
export function desktopEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PATHEXT)$/i.test(k)));
  env.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  return env;
}
