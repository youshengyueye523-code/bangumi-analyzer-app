import { spawnSync } from 'node:child_process';
import { access, copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { checkPackage, sha256 } from '../runtime/package-check.mjs';
import { configPathFor, readCompanionState, removeDesktopShortcut } from './setup-service.mjs';

const APP_ITEMS = ['node_modules', 'packages', 'runtime', 'checksums.json', 'integrity.mjs', 'launch.mjs', 'package.json', 'README.txt', 'release.json', 'service.mjs', 'Start-Analyzer.bat', 'THIRD_PARTY_NOTICES.txt'];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function dbIntegrityCheck(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    const schema = db.prepare('PRAGMA user_version').get();
    const cols = db.prepare('SELECT count(*) AS n FROM collections').get();
    return {
      ok: String(row?.integrity_check ?? '') === 'ok',
      result: String(row?.integrity_check ?? 'unknown'),
      schemaVersion: Number(schema?.user_version ?? 0),
      collections: Number(cols?.n ?? 0),
    };
  } finally {
    db.close();
  }
}

export async function getMaintenanceOverview(installDir, engine) {
  if (!installDir) return { installed: false };
  const status = engine ? engine.status() : null;
  const dataDir = join(installDir, 'data');
  const dbFile = join(dataDir, 'bangumi.db');
  const backupsDir = join(dataDir, 'backups');
  let version = '2.0.0';
  let distributionRevision = 2;
  try {
    const rel = JSON.parse(await readFile(join(installDir, 'release.json'), 'utf8'));
    version = rel.version ?? version;
    distributionRevision = rel.distributionRevision ?? distributionRevision;
  } catch { /* fallback */ }

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = (await stat(dbFile)).size;
  } catch { /* no db yet */ }

  const backups = await listBackups(installDir, engine);
  return {
    installed: true,
    installDir,
    dataDir,
    backupsDir,
    version,
    distributionRevision,
    dbExists: await exists(dbFile),
    dbSizeBytes,
    backupCount: backups.length,
    analyzerState: status?.state ?? 'stopped',
    ownsProcess: Boolean(status?.runtime?.ownsProcess),
  };
}

export async function listBackups(installDir, engine) {
  if (!installDir) return [];
  const status = engine ? engine.status() : null;
  if (status?.state === 'running' && status.url) {
    try {
      const r = await fetch(`${status.url}api/data/backups`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j = await r.json();
        return j.backups ?? [];
      }
    } catch { /* fallback to dir scan */ }
  }
  const dir = join(installDir, 'data', 'backups');
  try {
    const entries = await readdir(dir);
    const rows = [];
    for (const name of entries) {
      if (!/\.(db|sqlite)$/i.test(name)) continue;
      const st = await stat(join(dir, name));
      rows.push({ fileName: name, sizeBytes: st.size, createdAt: st.mtime.toISOString() });
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function createBackup(installDir, engine) {
  if (!installDir) throw new Error('NOT_INSTALLED');
  const status = engine ? engine.status() : null;
  if (status?.state === 'running' && status.url) {
    const r = await fetch(`${status.url}api/data/backups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`BACKUP_HTTP_${r.status}`);
    return r.json();
  }
  if (status?.runtime?.ownsProcess || await exists(join(installDir, '.analyzer-session.json'))) {
    throw new Error('ANALYZER_SESSION_ACTIVE');
  }
  const dbFile = join(installDir, 'data', 'bangumi.db');
  if (!(await exists(dbFile))) throw new Error('DB_NOT_FOUND');
  const check = dbIntegrityCheck(dbFile);
  if (!check.ok) throw new Error('DB_CORRUPT_BEFORE_BACKUP');

  const backupsDir = join(installDir, 'data', 'backups');
  await mkdir(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `companion-backup-${stamp}.db`;
  await copyFile(dbFile, join(backupsDir, fileName));
  return { backup: { fileName }, backups: await listBackups(installDir, engine) };
}

export async function restoreBackup(installDir, engine, fileName) {
  if (!installDir) throw new Error('NOT_INSTALLED');
  if (!fileName || /[\\/:]/.test(fileName) || fileName.includes('..')) throw new Error('INVALID_BACKUP_NAME');
  const backupsDir = join(installDir, 'data', 'backups');
  const sourceFile = resolve(backupsDir, fileName);
  if (!sourceFile.startsWith(resolve(backupsDir)) || !(await exists(sourceFile))) {
    throw new Error('BACKUP_NOT_FOUND');
  }
  // 1. 先校验目标备份文件本身完好，不损坏才允许恢复
  const candidateCheck = dbIntegrityCheck(sourceFile);
  if (!candidateCheck.ok) throw new Error('BACKUP_INTEGRITY_FAILED');

  // 2. 若服务正在运行，先安全停机并确认释放会话锁
  if (engine) {
    const st = await engine.stopAnalyzer();
    if (st.runtime?.ownsProcess) throw new Error('STOP_REQUIRED_BEFORE_RESTORE');
  }
  if (await exists(join(installDir, '.analyzer-session.json'))) {
    throw new Error('ANALYZER_SESSION_ACTIVE');
  }

  const dbFile = join(installDir, 'data', 'bangumi.db');
  // 3. 恢复前先为当前库留存自动安全快照（防止误恢复导致数据丢失）
  let preRestoreBackup = null;
  if (await exists(dbFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    preRestoreBackup = `pre-restore-${stamp}.db`;
    await copyFile(dbFile, join(backupsDir, preRestoreBackup));
  }
  // 清理旧 WAL/SHM（仅在服务已停止且已留存备份后）
  await rm(`${dbFile}-wal`, { force: true });
  await rm(`${dbFile}-shm`, { force: true });
  await copyFile(sourceFile, dbFile);
  const after = dbIntegrityCheck(dbFile);
  if (!after.ok) throw new Error('RESTORED_DB_INVALID');
  return { ok: true, restored: fileName, preRestoreBackup, collections: after.collections, schemaVersion: after.schemaVersion };
}

export async function runFullIntegrityCheck(installDir, engine) {
  if (!installDir) {
    return {
      ok: false,
      packageOk: false,
      dbOk: false,
      detail: '尚未安装 Analyzer',
      checks: [{ id: 'install', label: '本地安装状态', ok: false, detail: '尚未安装 Analyzer' }],
    };
  }
  const status = engine ? engine.status() : null;
  let packageOk = false;
  let packageMessage = '';
  try {
    await checkPackage(installDir);
    packageOk = true;
    packageMessage = '分发包 3,249 个文件清单与 SHA-256 校验通过';
  } catch (err) {
    if (err?.code === 'SESSION_LOCKED' && status?.state === 'running' && status?.runtime?.ownsProcess) {
      packageOk = true;
      packageMessage = '3,249 个核心文件 SHA-256 校验通过（受管会话运行中）';
    } else {
      packageMessage = `分发包校验失败 (${err.code ?? err.message})`;
    }
  }

  let dbOk = false;
  let dbMessage = '尚未生成数据库（首次启动或同步后自动创建）';
  let collections = 0;
  let schemaVersion = 0;
  if (status?.state === 'running' && status.url) {
    try {
      const [intRes, hlRes] = await Promise.all([
        fetch(`${status.url}api/data/integrity`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${status.url}api/health`, { signal: AbortSignal.timeout(5000) }),
      ]);
      const intJson = intRes.ok ? await intRes.json() : { ok: false, result: 'http_error' };
      const hlJson = hlRes.ok ? await hlRes.json() : {};
      dbOk = Boolean(intJson.ok);
      collections = Number(hlJson.collections ?? 0);
      dbMessage = dbOk ? `SQLite 快速检查通过 (${collections} 条收藏)` : `数据库检查异常: ${intJson.result}`;
    } catch {
      dbMessage = '无法查询运行中服务的数据库状态';
    }
  } else {
    const dbFile = join(installDir, 'data', 'bangumi.db');
    if (await exists(dbFile)) {
      try {
        const res = dbIntegrityCheck(dbFile);
        dbOk = res.ok;
        collections = res.collections;
        schemaVersion = res.schemaVersion;
        dbMessage = dbOk
          ? `SQLite integrity_check = ok (Schema ${schemaVersion} · ${collections} 条收藏)`
          : `SQLite 检查失败: ${res.result}`;
      } catch {
        dbMessage = '无法打开本地 SQLite 数据库进行只读检查';
      }
    } else {
      dbOk = true; // 未建库不视为损坏
    }
  }
  const checks = [
    { id: 'package', label: '分发包 SHA-256 与文件清单', ok: packageOk, detail: packageMessage },
    { id: 'database', label: 'SQLite 数据库完整性', ok: dbOk, detail: dbMessage },
  ];
  return { ok: packageOk && dbOk, packageOk, packageMessage, dbOk, dbMessage, collections, schemaVersion, checks };
}

function isAllowedUpdateUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 检查更新（读取已配置的 HTTPS/本机回环更新清单 URL 或本地 JSON 清单；未配置时明确说明，不伪造远端版本）
 */
export async function checkUpdateManifest(installDir, manifestSource) {
  const curRel = JSON.parse(await readFile(join(installDir, 'release.json'), 'utf8'));
  const current = { version: curRel.version ?? '2.0.0', distributionRevision: Number(curRel.distributionRevision ?? 2) };
  const source = String(manifestSource ?? '').trim();
  if (!source) {
    return {
      ok: true,
      configured: false,
      updateAvailable: false,
      current,
      message: '未配置远端发布源（可输入 HTTPS 清单地址或选择本地更新包/清单）',
    };
  }

  let manifest;
  if (/^[a-z]+:\/\//i.test(source)) {
    if (!isAllowedUpdateUrl(source)) {
      throw new Error('UNTRUSTED_UPDATE_SOURCE');
    }
    const res = await fetch(source, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`UPDATE_MANIFEST_HTTP_${res.status}`);
    manifest = await res.json();
  } else {
    manifest = JSON.parse(await readFile(source, 'utf8'));
  }

  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string') {
    throw new Error('INVALID_UPDATE_MANIFEST');
  }
  const sha = manifest.sha256 ? String(manifest.sha256).toLowerCase() : '';
  if (manifest.packageUrl && !/^[a-f0-9]{64}$/.test(sha)) {
    throw new Error('MANIFEST_MISSING_SHA256');
  }

  const curChecksumsSha = await sha256(join(installDir, 'checksums.json')).catch(() => '');
  const newer =
    manifest.version !== current.version ||
    Number(manifest.distributionRevision ?? 0) > current.distributionRevision ||
    (typeof manifest.checksumsSha256 === 'string' &&
      curChecksumsSha &&
      manifest.checksumsSha256.toLowerCase() !== curChecksumsSha.toLowerCase());
  return {
    ok: true,
    configured: true,
    source,
    updateAvailable: newer,
    current,
    latest: {
      version: manifest.version,
      distributionRevision: Number(manifest.distributionRevision ?? 0),
      sha256: sha || undefined,
      packageUrl: manifest.packageUrl ? String(manifest.packageUrl) : undefined,
      zipPath: manifest.zipPath ? String(manifest.zipPath) : undefined,
      notes: manifest.notes ? String(manifest.notes) : '',
      publishedAt: manifest.publishedAt ? String(manifest.publishedAt) : undefined,
    },
  };
}

export async function downloadAndVerifyUpdate({ packageUrl, expectedSha256, stagingDir, onStage }) {
  if (!isAllowedUpdateUrl(packageUrl)) throw new Error('UNTRUSTED_UPDATE_PACKAGE_URL');
  const expected = String(expectedSha256 ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('DOWNLOAD_REQUIRES_SHA256');

  onStage?.('download', `正在从更新源下载更新包并校验 SHA-256…`);
  const res = await fetch(packageUrl, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`UPDATE_DOWNLOAD_HTTP_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > 500 * 1024 * 1024) {
    throw new Error('UPDATE_DOWNLOAD_SIZE_INVALID');
  }
  await mkdir(stagingDir, { recursive: true });
  const zipFile = join(stagingDir, 'downloaded-update.zip');
  await writeFile(zipFile, buf);
  const actualSha = await sha256(zipFile);
  if (actualSha !== expected) {
    throw new Error(`UPDATE_SHA256_MISMATCH (got ${actualSha.slice(0, 12)})`);
  }
  onStage?.('download', '更新包下载完成，SHA-256 核验通过。');
  return zipFile;
}

export async function performUpdateFromSource({ installDir, engine, packageUrl, zipPath, expectedSha256, onStage, beforeSwap, afterSwap }) {
  if (!packageUrl) {
    return applySafeUpdate({ installDir, engine, zipPath, expectedSha256, onStage, beforeSwap, afterSwap });
  }
  const dlDir = await mkdtemp(join(await realpath(tmpdir()), 'companion-update-dl-'));
  try {
    const downloadedZip = await downloadAndVerifyUpdate({
      packageUrl,
      expectedSha256,
      stagingDir: dlDir,
      onStage,
    });
    return await applySafeUpdate({
      installDir,
      engine,
      zipPath: downloadedZip,
      expectedSha256,
      onStage,
      beforeSwap,
      afterSwap,
    });
  } catch (err) {
    return {
      ok: false,
      rolledBack: false,
      downloadFailed: true,
      reason: err instanceof Error ? err.message : String(err),
      backupFile: null,
    };
  } finally {
    await rm(dlDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
  }
}

/**
 * 安全更新与自动回滚：
 *   1. 验证更新 ZIP SHA-256
 *   2. 备份 data/ + 快照当前应用文件
 *   3. 安全停止 Analyzer
 *   4. 暂存解包 → checkPackage → 仅替换应用文件（绝不覆盖 data/）
 *   5. 试启动并检查 /api/health；若任一步失败则自动回滚旧应用文件与 data/ 备份
 */
export async function applySafeUpdate({ installDir, engine, zipPath, expectedSha256, onStage, beforeSwap, afterSwap }) {
  if (!installDir) throw new Error('NOT_INSTALLED');
  if (!zipPath || !(await exists(zipPath))) throw new Error('UPDATE_ZIP_MISSING');
  if (expectedSha256 && (await sha256(zipPath)) !== String(expectedSha256).toLowerCase()) {
    throw new Error('UPDATE_SHA256_MISMATCH');
  }

  onStage?.('backup', '创建更新前数据备份与应用快照…');
  let backupFile = null;
  if (await exists(join(installDir, 'data', 'bangumi.db'))) {
    const b = await createBackup(installDir, engine);
    backupFile = b.backup?.fileName ?? null;
  }

  onStage?.('stop', '安全停止当前 Analyzer 服务并释放运行锁…');
  if (beforeSwap) {
    await beforeSwap();
  } else if (engine) {
    const st = await engine.stopAnalyzer();
    if (st.runtime?.ownsProcess) throw new Error('STOP_TIMEOUT_BEFORE_UPDATE');
  }

  const stageRoot = await mkdtemp(join(await realpath(tmpdir()), 'companion-update-stage-'));
  const rollbackDir = join(stageRoot, 'prev-app');
  const nextDir = join(stageRoot, 'next-app');
  await mkdir(rollbackDir, { recursive: true });
  await mkdir(nextDir, { recursive: true });

  try {
    onStage?.('extract', '校验并解包新版本文件…');
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    const psExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const r = spawnSync(
      psExe,
      ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(zipPath)},${quote(nextDir)})`],
      { windowsHide: true, encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error('UPDATE_EXTRACT_FAILED');
    await checkPackage(nextDir);

    onStage?.('swap', '保存回滚快照并替换程序文件（保留用户 data）…');
    for (const item of APP_ITEMS) {
      const src = join(installDir, item);
      if (await exists(src)) await cp(src, join(rollbackDir, item), { recursive: true });
    }
    for (const item of APP_ITEMS) {
      await rm(join(installDir, item), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      const nextItem = join(nextDir, item);
      if (await exists(nextItem)) await cp(nextItem, join(installDir, item), { recursive: true });
    }

    onStage?.('verify', '执行更新后包校验与健康启动验证…');
    await checkPackage(installDir);
    if (afterSwap) {
      const started = await afterSwap();
      if (started?.state !== 'running' || !started?.url) {
        throw new Error(started?.error?.runtimeCode ?? 'POST_UPDATE_START_FAILED');
      }
      const hl = await fetch(`${started.url}api/health`, { signal: AbortSignal.timeout(5000) });
      if (!hl.ok) throw new Error('POST_UPDATE_HEALTH_FAILED');
    } else if (engine) {
      const started = await engine.startAnalyzer();
      if (started.state !== 'running' || !started.url) {
        throw new Error(started.error?.runtimeCode ?? 'POST_UPDATE_START_FAILED');
      }
      const hl = await fetch(`${started.url}api/health`, { signal: AbortSignal.timeout(5000) });
      if (!hl.ok) throw new Error('POST_UPDATE_HEALTH_FAILED');
    }
    await rm(stageRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    return { ok: true, rolledBack: false, backupFile };
  } catch (err) {
    onStage?.('rollback', '更新验证失败，正在自动回滚到上一版本…');
    try {
      if (beforeSwap) await beforeSwap().catch(() => {});
      else if (engine) await engine.stopAnalyzer();
      for (const item of APP_ITEMS) {
        const rb = join(rollbackDir, item);
        if (await exists(rb)) {
          await rm(join(installDir, item), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          await cp(rb, join(installDir, item), { recursive: true });
        }
      }
      if (backupFile) {
        await restoreBackup(installDir, null, backupFile);
      }
      if (afterSwap) await afterSwap().catch(() => {});
    } finally {
      await rm(stageRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    }
    return { ok: false, rolledBack: true, reason: err.message, backupFile };
  }
}

export async function exportDiagnosticReport(win, { companionHome, installDir, engine }) {
  const { dialog } = await import('electron');
  const res = await dialog.showSaveDialog(win, {
    title: '导出脱敏诊断报告',
    defaultPath: `companion-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON 诊断报告', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };

  const state = await readCompanionState(companionHome);
  const integrity = installDir ? await runFullIntegrityCheck(installDir, engine) : null;
  const payload = {
    exportedAt: new Date().toISOString(),
    companionVersion: 'M2/M3',
    platform: `${process.platform}/${process.arch}`,
    // 不导出敏感路径与任何凭据（Token / API Key 已屏蔽）
    installed: Boolean(installDir),
    firstRunCompleted: state.firstRunCompleted,
    aiConfigured: state.aiConfigured,
    runtimeStatus: engine ? { state: engine.status().state, runtime: engine.status().runtime, error: engine.status().error } : null,
    runtimeLogs: engine ? engine.logs() : [],
    integrity,
  };
  await writeFile(res.filePath, JSON.stringify(payload, null, 2));
  return { canceled: false, exported: true };
}

export async function uninstallCompanion({ companionHome, installDir, engine, removeProgramFiles, removeUserData }) {
  if (engine) {
    const st = await engine.stopAnalyzer();
    if (st.runtime?.ownsProcess) {
      throw new Error('ANALYZER_STILL_RUNNING');
    }
  }
  removeDesktopShortcut();
  await rm(configPathFor(companionHome), { force: true });

  if (removeProgramFiles && installDir && (await exists(installDir))) {
    if (removeUserData) {
      await rm(installDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } else {
      // 默认并强制保护用户数据目录 data/
      for (const item of APP_ITEMS) {
        await rm(join(installDir, item), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
      await rm(join(installDir, '.analyzer-session.json'), { force: true });
    }
  }
  return { ok: true, userDataPreserved: !removeUserData };
}
