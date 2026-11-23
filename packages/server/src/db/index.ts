import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { paths, ensureDataDirs } from '../config.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema.js';

export type SqlParam = string | number | bigint | null | Uint8Array;
export type SqlParams = Record<string, unknown> | object | unknown[];

let database: DatabaseSync | null = null;
const statementCache = new Map<string, StatementSync>();

export interface OpenOptions {
  file?: string;
  verbose?: (message: string) => void;
}

function normalizeValue(value: unknown): SqlParam {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function normalizeParams(params?: SqlParams): Record<string, SqlParam> | SqlParam[] {
  if (!params) return [];
  if (Array.isArray(params)) return params.map(normalizeValue);
  const out: Record<string, SqlParam> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = normalizeValue(value);
  }
  return out;
}

/** 打开（或创建）数据库并执行迁移。重复调用返回同一连接。 */
export function openDatabase(options: OpenOptions = {}): DatabaseSync {
  if (database) return database;
  ensureDataDirs();
  const file = options.file ?? paths.dbFile;
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    backupBeforeMigration(db, options.verbose);
    configureDatabase(db);
    migrate(db, options.verbose);
    database = db;
    return db;
  } catch (error) {
    try { db.close(); } catch { /* 保留原始启动失败原因。 */ }
    throw error;
  }
}

function configureDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA temp_store = MEMORY');

  // 只读评分投影：SQLite 的 TEXT/非有限值不可借比较或 AVG 进入有效样本。
  const canonicalRate = (value: unknown): number => {
    if (typeof value === 'bigint') return value >= 1n && value <= 10n ? Number(value) : 0;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10 ? value : 0;
  };
  const ratingOptions = { deterministic: true, useBigIntArguments: true };
  db.function('canonical_rate', ratingOptions, canonicalRate);
  // 06A: exclude only wish (type 1). Source numbers and all other statuses stay as before.
  db.function('effective_personal_rate', ratingOptions, (status, rate) =>
    status === 1n || status === 1 ? 0 : canonicalRate(rate));
  db.function('canonical_score', { deterministic: true, useBigIntArguments: true }, (value) => {
    if (typeof value === 'bigint') return value >= 1n && value <= 10n ? Number(value) : null;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10 ? value : null;
  });
  const count = (value: unknown): number | null => {
    if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  db.function('canonical_count', { deterministic: true, useBigIntArguments: true }, count);
  db.function('canonical_positive_integer', { deterministic: true, useBigIntArguments: true }, (value) => {
    const integer = count(value);
    return integer !== null && integer > 0 ? integer : null;
  });
}

/**
 * schema 升级前的一致性备份（VACUUM INTO）。
 * 在切换源库 journal_mode 或执行第一条迁移 SQL 前完成。
 */
function backupBeforeMigration(
  db: DatabaseSync,
  verbose?: (message: string) => void,
): void {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (current >= LATEST_SCHEMA_VERSION) return;
  // 只有没有任何用户对象的未初始化库才能跳过快照。不能只看默认文件名或 subjects。
  if (current === 0 && !db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()) return;

  // Keep both names short enough for SQLite on Windows; never reuse a prior snapshot.
  const stamp = new Date().toISOString().replace(/[:\-]/g, '').slice(0, 15);
  const token = randomBytes(6).toString('base64url');
  const target = join(paths.backupDir, `pre-migration-v${current}-${stamp}-${token}.db`);
  const pending = join(paths.backupDir, `.migration-${token}.partial`);
  let created = false;
  try {
    mkdirSync(paths.backupDir, { recursive: true });
    const reserved = openSync(pending, 'wx');
    created = true;
    closeSync(reserved);
    db.exec(`VACUUM INTO '${pending.replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(pending, { readOnly: true });
    try {
      if (Number(copy.prepare('PRAGMA user_version').get()?.user_version) !== current) {
        throw new Error('备份 Schema 版本与原库不符');
      }
      const integrity = copy.prepare('PRAGMA integrity_check').get()?.integrity_check;
      if (integrity !== 'ok') throw new Error(`备份完整性检查未通过：${String(integrity)}`);
    } finally { copy.close(); }
    const fd = openSync(pending, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(target)) throw new Error('备份文件名冲突，请重试');
    renameSync(pending, target);
  } catch (error) {
    // 半成品不以 .db 结尾；即使清理失败，也不会被当成有效备份或在下次复用。
    if (created) {
      try { unlinkSync(pending); } catch { /* 保留原始失败原因。 */ }
    }
    throw new Error(
      `迁移前备份失败，已停止数据库升级（v${current} → v${LATEST_SCHEMA_VERSION}）：${(error as Error).message}`,
      { cause: error },
    );
  }
  verbose?.(`迁移前备份完成并通过校验：${target}`);
}

export function getDatabase(): DatabaseSync {
  if (!database) return openDatabase();
  return database;
}

export function migrate(db: DatabaseSync, verbose?: (message: string) => void): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      /*
       * 幂等保护：某些迁移（例如 ADD COLUMN）在开发过程中可能已经生效。
       * 已经生效时只推进 user_version，不重复执行 SQL，避免
       * 「duplicate column name」导致整次迁移失败。
       */
      const alreadyApplied = migration.isApplied?.(db) ?? false;
      if (!alreadyApplied) db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      verbose?.(
        alreadyApplied
          ? `数据库迁移跳过（已生效）：v${migration.version} ${migration.name}`
          : `数据库迁移完成：v${migration.version} ${migration.name}`,
      );
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `数据库迁移失败（v${migration.version} ${migration.name}）：${(error as Error).message}`,
      );
    }
  }
}

export function schemaVersion(): number {
  const row = getDatabase().prepare('PRAGMA user_version').get() as
    | { user_version?: number }
    | undefined;
  return Number(row?.user_version ?? 0);
}

export function expectedSchemaVersion(): number {
  return LATEST_SCHEMA_VERSION;
}

/** 启动时的完整性自检，返回 SQLite 的检查结果（`ok` 表示正常）。 */
export function integrityCheck(): string {
  const row = getDatabase().prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
  return String(row?.quick_check ?? 'unknown');
}

export function statement(sql: string): StatementSync {
  const cached = statementCache.get(sql);
  if (cached) return cached;
  const prepared = getDatabase().prepare(sql);
  // node:sqlite 默认把 INTEGER 转成 Number，遇到旧 64 位异常值会整条查询抛错。
  prepared.setReadBigInts(true);
  statementCache.set(sql, prepared);
  return prepared;
}

/** 正常数值保持 Number；异常来源转为显式文本，避免舍入或 JSON 静默变成 null。 */
function readRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    typeof value === 'bigint'
      ? value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value) : value.toString()
      : typeof value === 'number' && !Number.isFinite(value) ? String(value) : value,
  ]));
}

export function all<T>(sql: string, params?: SqlParams): T[] {
  const prepared = statement(sql);
  const bound = normalizeParams(params);
  const rows = Array.isArray(bound) ? prepared.all(...bound) : prepared.all(bound);
  return rows.map(readRow) as unknown as T[];
}

export function one<T>(sql: string, params?: SqlParams): T | undefined {
  const prepared = statement(sql);
  const bound = normalizeParams(params);
  const row = Array.isArray(bound) ? prepared.get(...bound) : prepared.get(bound);
  return row === undefined ? undefined : readRow(row) as unknown as T;
}

let directWriteCount: bigint | undefined;

export function run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number } {
  const prepared = statement(sql);
  const bound = normalizeParams(params);
  const result = Array.isArray(bound) ? prepared.run(...bound) : prepared.run(bound);
  if (directWriteCount !== undefined) directWriteCount += BigInt(result.changes);
  return {
    changes: Number(result.changes ?? 0),
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
  };
}

export function exec(sql: string): void {
  getDatabase().exec(sql);
}

/**
 * 事务包装：使用 BEGIN IMMEDIATE 尽早拿到写锁，避免并发写入时的死锁。
 * 回调抛错时回滚，保证数据库不会停留在中间状态。
 */
let savepointSequence = 0;

export function transaction<T>(fn: () => T): T {
  const db = getDatabase();
  // 业务操作可组合：内部重建使用 savepoint，外层仍决定整个 mutation 的提交。
  const savepoint = db.isTransaction ? `mutation_${++savepointSequence}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    try {
      if (savepoint) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始错误，交由上层处理
    }
    throw error;
  }
}

/**
 * A synchronous write boundary for actions whose only authorized DML is through
 * run(). SQLite counts trigger/FK side effects in total_changes(), but not in
 * each statement's changes. Check inside the outer transaction, after the last
 * write (including nested savepoints and mutation metadata), before committing.
 */
export function transactionWithoutIndirectWrites<T>(fn: () => T, onViolation: () => never): T {
  const totalChanges = () =>
    (statement('SELECT total_changes() AS n').get() as { n: bigint }).n;
  return transaction(() => {
    const before = totalChanges();
    const outermost = directWriteCount === undefined;
    directWriteCount ??= 0n;
    const expectedBefore = directWriteCount;
    try {
      const result = fn();
      if (totalChanges() - before !== directWriteCount - expectedBefore) onViolation();
      return result;
    } finally {
      if (outermost) directWriteCount = undefined;
    }
  });
}

export function closeDatabase(): void {
  statementCache.clear();
  if (database) {
    try {
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 忽略 checkpoint 失败
    }
    database.close();
    database = null;
  }
}

/* ------------------------------------------------------------------ meta */

export function getMeta(key: string): string | null {
  const row = one<{ value: string }>('SELECT value FROM meta WHERE key = :key', { key });
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  run(
    `INSERT INTO meta (key, value) VALUES (:key, :value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    { key, value },
  );
}

/** 数据版本号：任何写操作后递增，用于统计缓存失效。 */
export function dataVersion(): number {
  return Number(getMeta('data_version') ?? 0);
}

export function bumpDataVersion(): number {
  const next = dataVersion() + 1;
  setMeta('data_version', String(next));
  return next;
}

export function countRows(table: 'subjects' | 'collections' | 'subject_staff' | 'series'): number {
  const row = one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row?.n ?? 0);
}
