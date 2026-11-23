/**
 * Companion Release Candidate Packager (M5 / RC)
 * Builds:
 *   1. companion/dist/Bangumi-Analyzer-Companion-Portable-win-x64/   (Portable folder + Bangumi-Analyzer-Companion.exe GUI launcher)
 *   2. companion/dist/Bangumi-Analyzer-Companion-Setup-2.0.0-win-x64.exe (Standalone Windows GUI Installer)
 *   3. companion/dist/RELEASE_MANIFEST.json (Release SHA-256 verification summary)
 *
 * Strictly protects formal data/, packages/, dist/ (root), public-demo/, and site/.
 * Usage: .\.runtime\node-v24.22.1-win-x64\node.exe companion/dist-scripts/package-companion.mjs
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const COMPANION_ROOT = path.join(REPO_ROOT, 'companion');
const UI_DIR = path.join(COMPANION_ROOT, 'ui');
const HOST_DIR = path.join(COMPANION_ROOT, 'host');
const RUNTIME_DIR = path.join(COMPANION_ROOT, 'runtime');
const INSTALLER_SRC_DIR = path.join(COMPANION_ROOT, 'installer');
const OUT_ROOT = path.join(COMPANION_ROOT, 'dist');
const PORTABLE_DIR = path.join(OUT_ROOT, 'Bangumi-Analyzer-Companion-Portable-win-x64');
const LEGACY_STAGE_DIR = path.join(OUT_ROOT, 'Bangumi-Analyzer-Companion-win-x64');
const RELEASE_VERSION = '2.0.0-rc5';
const SETUP_EXE = path.join(OUT_ROOT, `Bangumi-Analyzer-Companion-Setup-${RELEASE_VERSION}-win-x64.exe`);
const PORTABLE_ZIP = path.join(OUT_ROOT, `Bangumi-Analyzer-Companion-Portable-${RELEASE_VERSION}-win-x64.zip`);
const ANALYZER_REVISION = 4;
const R2_ZIP =
  process.env.ANALYZER_BUNDLE_ZIP ||
  path.join(REPO_ROOT, 'dist/distribution-2nUlPu/Bangumi-Analyzer-2.0.0-windows-x64-r4.zip');
const EXPECTED_R2_SHA256 = process.env.ANALYZER_BUNDLE_SHA256 ?? 'a773d96356cd659ad845926c1f3d695092e09b659d9a3a57e227fb49ca095445';

const CSC_EXE = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function collectFiles(dir, base = dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectFiles(full, base)));
    } else if (ent.isFile()) {
      out.push(path.relative(base, full).replaceAll('\\', '/'));
    }
  }
  return out.sort();
}

function compileCSharpWinExe({ sourceFile, outputExe, extraArgs = [] }) {
  if (!existsSync(CSC_EXE)) {
    throw new Error(`Missing .NET Framework compiler: ${CSC_EXE}`);
  }
  const frameworkDir = path.dirname(CSC_EXE);
  const args = [
    '/nologo',
    '/utf8output',
    '/codepage:65001',
    '/optimize+',
    '/platform:x64',
    '/target:winexe',
    `/lib:${frameworkDir}`,
    '/r:System.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.IO.Compression.dll',
    '/r:System.IO.Compression.FileSystem.dll',
    ...extraArgs,
    `/out:${outputExe}`,
    sourceFile,
  ];
  const r = spawnSync(CSC_EXE, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`csc.exe failed for ${path.basename(sourceFile)}:\n${r.stdout}\n${r.stderr}`);
  }
}

async function main() {
  console.log(`[RC] Verifying official Analyzer v2.0.0 r${ANALYZER_REVISION} distribution archive…`);
  const r2Hash = await sha256(R2_ZIP);
  if (EXPECTED_R2_SHA256 && r2Hash !== EXPECTED_R2_SHA256) {
    throw new Error(`Analyzer r${ANALYZER_REVISION} zip hash mismatch: expected ${EXPECTED_R2_SHA256}, got ${r2Hash}`);
  }

  console.log('[RC] Building companion/ui with VITE_RELEASE_BUILD=1 (strict release hygiene)…');
  execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run build'], {
    cwd: UI_DIR,
    env: { ...process.env, VITE_RELEASE_BUILD: '1' },
    stdio: 'inherit',
  });

  console.log('[RC] Preparing clean portable staging directory:', PORTABLE_DIR);
  // Protect any existing portable companion-data across rebuilds
  const existingPortableData = path.join(PORTABLE_DIR, 'companion-data');
  const tempDataBackup = path.join(OUT_ROOT, '.tmp-preserve-companion-data');
  let preservedPortableData = false;
  if (existsSync(existingPortableData)) {
    await rm(tempDataBackup, { recursive: true, force: true });
    await cp(existingPortableData, tempDataBackup, { recursive: true });
    preservedPortableData = true;
  }
  await rm(LEGACY_STAGE_DIR, { recursive: true, force: true });
  await rm(PORTABLE_DIR, { recursive: true, force: true });
  await rm(SETUP_EXE, { force: true });
  await rm(PORTABLE_ZIP, { force: true });
  await rm(path.join(OUT_ROOT, 'Bangumi-Analyzer-Companion-Setup-2.0.0-win-x64.exe'), { force: true });
  await mkdir(path.join(PORTABLE_DIR, 'host'), { recursive: true });
  await mkdir(path.join(PORTABLE_DIR, 'ui', 'dist'), { recursive: true });
  await mkdir(path.join(PORTABLE_DIR, 'runtime'), { recursive: true });
  await mkdir(path.join(PORTABLE_DIR, 'bundle'), { recursive: true });

  // Copy UI dist (strict release build)
  await cp(path.join(UI_DIR, 'dist'), path.join(PORTABLE_DIR, 'ui', 'dist'), { recursive: true });

  // Copy Runtime bridge
  await cp(RUNTIME_DIR, path.join(PORTABLE_DIR, 'runtime'), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.work`) && !src.includes(`${path.sep}test`),
  });

  // Copy Host files + electron runtime (excluding .work, test, dev scripts)
  const hostFiles = [
    'package.json',
    'main.mjs',
    'preload.cjs',
    'engine.mjs',
    'contract.mjs',
    'assets.mjs',
    'gpu-policy.mjs',
    'runtime-client.mjs',
    'setup-service.mjs',
    'maintenance-service.mjs',
  ];
  for (const file of hostFiles) {
    await cp(path.join(HOST_DIR, file), path.join(PORTABLE_DIR, 'host', file));
  }
  await mkdir(path.join(PORTABLE_DIR, 'host', 'assets'), { recursive: true });
  for (const assetName of ['companion-icon.ico', 'companion-icon-256.png', 'companion-icon.svg']) {
    const srcAsset = path.join(HOST_DIR, 'assets', assetName);
    if (existsSync(srcAsset)) {
      await cp(srcAsset, path.join(PORTABLE_DIR, 'host', 'assets', assetName));
    }
  }
  await cp(path.join(HOST_DIR, 'node_modules'), path.join(PORTABLE_DIR, 'host', 'node_modules'), {
    recursive: true,
    dereference: true,
  });

  // Copy verified Analyzer r3 payload
  await cp(R2_ZIP, path.join(PORTABLE_DIR, 'bundle', `Bangumi-Analyzer-2.0.0-windows-x64-r${ANALYZER_REVISION}.zip`));

  // Copy real Pink Sakura Live2D model assets (CC BY 4.0) with 2048x2048 texture & user-supplied official Core files
  await cp(path.join(COMPANION_ROOT, 'models', 'pink-sakura'), path.join(PORTABLE_DIR, 'models', 'pink-sakura'), {
    recursive: true,
  });
  if (existsSync(path.join(COMPANION_ROOT, 'models', 'vendor', 'live2dcubismcore.min.js'))) {
    await cp(path.join(COMPANION_ROOT, 'models', 'vendor'), path.join(PORTABLE_DIR, 'models', 'vendor'), {
      recursive: true,
    });
  }

  // Copy offline attribution & third-party license files
  for (const docName of ['ATTRIBUTION.md', 'ASSET-LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
    await cp(path.join(COMPANION_ROOT, docName), path.join(PORTABLE_DIR, docName));
  }

  // Compile native GUI launcher & uninstaller executables with brand Win32 icon
  const iconIco = path.join(INSTALLER_SRC_DIR, 'companion-icon.ico');
  const iconArgs = existsSync(iconIco) ? [`/win32icon:${iconIco}`] : [];
  console.log('[RC] Compiling Bangumi-Analyzer-Companion.exe & Uninstall-Companion.exe…');
  compileCSharpWinExe({
    sourceFile: path.join(INSTALLER_SRC_DIR, 'CompanionLauncher.cs'),
    outputExe: path.join(PORTABLE_DIR, 'Bangumi-Analyzer-Companion.exe'),
    extraArgs: iconArgs,
  });
  compileCSharpWinExe({
    sourceFile: path.join(INSTALLER_SRC_DIR, 'CompanionUninstaller.cs'),
    outputExe: path.join(PORTABLE_DIR, 'Uninstall-Companion.exe'),
    extraArgs: iconArgs,
  });
  await writeFile(path.join(PORTABLE_DIR, '.companion-portable'), `portable-${RELEASE_VERSION}\n`, 'utf8');

  // Keep script fallbacks alongside .exe launcher
  const startBat = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'set "ELECTRON_RUN_AS_NODE="',
    'if exist "Bangumi-Analyzer-Companion.exe" (',
    '  start "" "%~dp0Bangumi-Analyzer-Companion.exe"',
    '  exit /b 0',
    ')',
    'start "" /b "%~dp0host\\node_modules\\electron\\dist\\electron.exe" "%~dp0host\\main.mjs"',
    '',
  ].join('\r\n');
  await writeFile(path.join(PORTABLE_DIR, 'Start-Companion.bat'), startBat, 'utf8');

  const startVbs = [
    'Set WshShell = CreateObject("WScript.Shell")',
    'Set FSO = CreateObject("Scripting.FileSystemObject")',
    'BaseDir = FSO.GetParentFolderName(WScript.ScriptFullName)',
    'WshShell.Run Chr(34) & BaseDir & "\\Bangumi-Analyzer-Companion.exe" & Chr(34), 1, False',
    '',
  ].join('\r\n');
  await writeFile(path.join(PORTABLE_DIR, 'Start-Companion.vbs'), startVbs, 'utf8');

  const docs = await readFile(path.join(COMPANION_ROOT, 'USER_GUIDE.md'), 'utf8').catch(() => null);
  const readmeText = [
    `Bangumi Analyzer Companion ${RELEASE_VERSION} (Windows x64) - Release Candidate`,
    '======================================================================',
    '',
    'Portable Launch: Double-click Bangumi-Analyzer-Companion.exe (or Start-Companion.bat / .vbs).',
    `Bundled Core: Bangumi Analyzer 2.0.0 r${ANALYZER_REVISION} (SHA-256 verified before execution).`,
    'User Data: Stored safely inside the Analyzer directory you select during first setup (data\\bangumi.db).',
    `Installer Option: Use ${path.basename(SETUP_EXE)} for guided Windows install.`,
    'Third-Party Licenses: See ATTRIBUTION.md, ASSET-LICENSE.md, and THIRD_PARTY_NOTICES.md.',
    'Note: Live2D Cubism Core (models\\vendor\\live2dcubismcore.min.js) is proprietary software of Live2D Inc.',
    'redistributed strictly under the Live2D Proprietary Software License Agreement (not MIT).',
    '',
  ].join('\r\n');
  await writeFile(path.join(PORTABLE_DIR, 'README.txt'), readmeText, 'utf8');
  if (docs) await writeFile(path.join(PORTABLE_DIR, 'USER_GUIDE.md'), docs, 'utf8');

  // Assert release JS assets do not leak dev flags / mock fallback
  const assetFiles = await readdir(path.join(PORTABLE_DIR, 'ui', 'dist', 'assets'));
  for (const jf of assetFiles.filter((f) => f.endsWith('.js'))) {
    const content = await readFile(path.join(PORTABLE_DIR, 'ui', 'dist', 'assets', jf), 'utf8');
    if (content.includes('VITE_RELEASE_BUILD')) {
      throw new Error('Unexpected raw VITE_RELEASE_BUILD reference in release bundle');
    }
  }

  // Compute checksum manifest for Portable files before packing Setup.exe
  console.log('[RC] Generating portable release-checksums.json…');
  const files = await collectFiles(PORTABLE_DIR);
  const entries = {};
  for (const rel of files) {
    if (rel === 'release-checksums.json') continue;
    const full = path.join(PORTABLE_DIR, rel);
    const st = await stat(full);
    entries[rel] = { size: st.size, sha256: await sha256(full) };
  }
  const buildId = `rc5-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
  await writeFile(
    path.join(PORTABLE_DIR, 'release-checksums.json'),
    JSON.stringify(
      {
        product: 'Bangumi Analyzer Companion',
        version: RELEASE_VERSION,
        buildId,
        bundledAnalyzerVersion: '2.0.0',
        bundledAnalyzerRevision: ANALYZER_REVISION,
        bundledAnalyzerZipSha256: EXPECTED_R2_SHA256,
        generatedAt: new Date().toISOString(),
        fileCount: Object.keys(entries).length,
        files: entries,
      },
      null,
      2,
    ),
    'utf8',
  );

  // Compress portable payload into temporary archive and compile self-extracting GUI Setup.exe
  const payloadZip = path.join(OUT_ROOT, '.tmp-companion-payload.zip');
  await rm(payloadZip, { force: true });
  console.log('[RC] Compressing payload, building standalone GUI Setup EXE and runnable Portable ZIP…');
  const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
  const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const zr = spawnSync(
    psExe,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(PORTABLE_DIR)},${quote(payloadZip)},[IO.Compression.CompressionLevel]::Optimal,$false)`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (zr.status !== 0) {
    throw new Error(`Failed to pack companion payload zip:\n${zr.stderr}`);
  }

  // Create user-facing runnable Portable ZIP with clean top-level folder
  const pz = spawnSync(
    psExe,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(PORTABLE_DIR)},${quote(PORTABLE_ZIP)},[IO.Compression.CompressionLevel]::Optimal,$true)`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (pz.status !== 0) {
    throw new Error(`Failed to pack portable distribution zip:\n${pz.stderr}`);
  }

  try {
    compileCSharpWinExe({
      sourceFile: path.join(INSTALLER_SRC_DIR, 'CompanionSetup.cs'),
      outputExe: SETUP_EXE,
      extraArgs: [...iconArgs, `/resource:${payloadZip},companion-payload.zip`],
    });
  } finally {
    await rm(payloadZip, { force: true });
  }

  if (preservedPortableData) {
    await cp(tempDataBackup, existingPortableData, { recursive: true });
    await rm(tempDataBackup, { recursive: true, force: true });
  }

  const setupStat = await stat(SETUP_EXE);
  const setupHash = await sha256(SETUP_EXE);
  const portableZipStat = await stat(PORTABLE_ZIP);
  const portableZipHash = await sha256(PORTABLE_ZIP);

  await writeFile(
    path.join(OUT_ROOT, 'SHA256SUMS.txt'),
    [
      `${setupHash}  ${path.basename(SETUP_EXE)}`,
      `${portableZipHash}  ${path.basename(PORTABLE_ZIP)}`,
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    path.join(OUT_ROOT, 'RELEASE_MANIFEST.json'),
    JSON.stringify(
      {
        product: 'Bangumi Analyzer Companion',
        version: RELEASE_VERSION,
        buildId,
        generatedAt: new Date().toISOString(),
        installer: {
          fileName: path.basename(SETUP_EXE),
          sizeBytes: setupStat.size,
          sha256: setupHash,
          signed: false,
        },
        portableZip: {
          fileName: path.basename(PORTABLE_ZIP),
          sizeBytes: portableZipStat.size,
          sha256: portableZipHash,
          topLevelDir: path.basename(PORTABLE_DIR),
        },
        portable: {
          dirName: path.basename(PORTABLE_DIR),
          launcherExe: 'Bangumi-Analyzer-Companion.exe',
          fileCount: Object.keys(entries).length + 1,
        },
        bundledAnalyzer: {
          version: '2.0.0',
          distributionRevision: ANALYZER_REVISION,
          sha256: EXPECTED_R2_SHA256,
        },
        knownLimits: [
          'Windows x64 only; installers are currently unsigned (SmartScreen may show an unknown publisher prompt).',
          'Live2D Cubism Core (live2dcubismcore.min.js) is proprietary software of Live2D Inc. redistributed inside compiled Windows releases under the Live2D Proprietary Software License Agreement and excluded from the MIT open-source git repository.',
          'Automatic online update feed is not enabled by default; users can update manually via local package/manifest verification or download new releases from GitHub Releases.',
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`[RC] Portable bundle ready (${Object.keys(entries).length + 1} files): ${PORTABLE_DIR}`);
  console.log(`[RC] Portable ZIP ready (${(portableZipStat.size / (1024 * 1024)).toFixed(1)} MB): ${PORTABLE_ZIP}`);
  console.log(`[RC] Graphical Installer EXE ready (${(setupStat.size / (1024 * 1024)).toFixed(1)} MB): ${SETUP_EXE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
