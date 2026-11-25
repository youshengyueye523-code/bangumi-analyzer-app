import { existsSync, mkdirSync, readdirSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ApiError, type BackupInfo } from '@bangumi-analyzer/shared';
import { paths } from '../config.js';
import { getDatabase } from '../db/index.js';

const FILE_PATTERN = /^[A-Za-z0-9._-]+\.db$/;

function ensureBackupDir(): string {
  if (!existsSync(paths.backupDir)) mkdirSync(paths.backupDir, { recursive: true });
  return paths.backupDir;
}

function isBackupFile(dir: string, target: string): boolean {
  try {
    const stat = lstatSync(target);
    // 文件名过滤不能阻止重解析点、目录与硬链接把下载入口导向其他文件。
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
      dirname(realpathSync(target)) === realpathSync(dir);
  } catch {
    return false;
  }
}

/** 使用 SQLite 的 VACUUM INTO 生成一致性快照（比复制文件更安全）。 */
export function createBackup(): BackupInfo {
  const dir = ensureBackupDir();
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const fileName = `bangumi-${stamp}.db`;
  const target = join(dir, fileName);
  if (existsSync(target)) {
    throw new ApiError('同名备份已存在', { code: 'backup_exists', status: 409 });
  }
  try {
    getDatabase().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (error) {
    throw new ApiError(`备份失败：${(error as Error).message}`, {
      code: 'backup_failed',
      status: 500,
      hint: '请确认 data 目录有可写权限，且磁盘空间充足。现有数据未受影响。',
    });
  }
  const stat = statSync(target);
  return {
    fileName,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString(),
  };
}

export function listBackups(): BackupInfo[] {
  const dir = ensureBackupDir();
  return readdirSync(dir)
    .filter((name) => FILE_PATTERN.test(name) && isBackupFile(dir, join(dir, name)))
    .map((name) => {
      const stat = statSync(join(dir, name));
      return { fileName: name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 校验并返回备份文件绝对路径，防止路径穿越。 */
export function resolveBackupPath(fileName: string): string {
  if (!FILE_PATTERN.test(fileName)) {
    throw new ApiError('备份文件名不合法', { code: 'invalid_backup_name', status: 400 });
  }
  const dir = ensureBackupDir();
  const target = resolve(dir, fileName);
  if (!isBackupFile(dir, target)) {
    throw new ApiError('备份文件不存在', { code: 'backup_not_found', status: 404 });
  }
  return target;
}
