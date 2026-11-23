import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../src/db/schema.js';
import { assertIsolatedTestDatabase } from './helpers.js';

const originalPaths = { ...paths };
let dir: string;
const version = (db: DatabaseSync) => db.prepare('PRAGMA user_version').get()?.user_version;
const source = (db: DatabaseSync) => db.prepare('SELECT id, name, raw FROM subjects ORDER BY id').all();
const schema = (db: DatabaseSync) => db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all();

function read<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

function seed(file: string, through: number): void {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const step of MIGRATIONS.filter((item) => item.version <= through)) {
      if (!step.isApplied?.(db)) db.exec(step.sql);
      db.exec(`PRAGMA user_version = ${step.version}`);
    }
    db.exec(`INSERT INTO subjects(id,name,raw,created_at,updated_at) VALUES(1,'before','{"fixture":1}','2020','2020');
      INSERT INTO collections(subject_id,type,rate,first_seen_at,synced_at) VALUES(1,2,8,'2020','2020')`);
  } finally { db.close(); }
}

function backups(): string[] {
  return readdirSync(paths.backupDir).filter((name) => /^pre-migration-.*\.db$/.test(name));
}

function attempt(file?: string): unknown {
  try { openDatabase({ file }); return undefined; }
  catch (error) { return error; }
  finally { closeDatabase(); }
}

describe('启动时迁移的备份保护', () => {
  beforeEach(() => {
    assertIsolatedTestDatabase();
    dir = mkdtempSync(join(paths.dataDir, 'startup-backup-'));
    paths.dbFile = join(dir, 'bangumi.db');
    paths.backupDir = join(dir, 'backups');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    Object.assign(paths, originalPaths);
  });

  it('备份目标不可写时在源库变更前停止；解除故障可重试', () => {
    seed(paths.dbFile, 14);
    const before = read(paths.dbFile, (db) => ({ schema: schema(db), source: source(db), version: version(db) }));
    const bytes = readFileSync(paths.dbFile);
    writeFileSync(paths.backupDir, 'this is a file, not a directory');

    const failure = attempt();
    expect(read(paths.dbFile, (db) => ({ schema: schema(db), source: source(db), version: version(db) }))).toEqual(before);
    expect(readFileSync(paths.dbFile)).toEqual(bytes);
    expect(failure).toMatchObject({ message: expect.stringMatching(/迁移前备份失败.*已停止.*v14/) });

    paths.backupDir = join(dir, 'available-backups');
    expect(version(openDatabase())).toBe(LATEST_SCHEMA_VERSION);
    expect(backups()).toHaveLength(1);
    expect(read(join(paths.backupDir, backups()[0]!), version)).toBe(14);
  });

  it('备份文件无法打开校验时，不接受生成动作的表面成功', () => {
    seed(paths.dbFile, 14);
    const realExec = DatabaseSync.prototype.exec;
    let reached = false;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      realExec.call(this, sql);
      const path = /^VACUUM INTO '(.*)'$/.exec(sql)?.[1]?.replaceAll("''", "'");
      if (path) {
        reached = true;
        writeFileSync(path, 'synthetic interrupted SQLite output');
      }
    });
    const failure = attempt();
    expect(reached).toBe(true);
    expect(read(paths.dbFile, version)).toBe(14);
    expect(failure).toMatchObject({ message: expect.stringMatching(/迁移前备份失败.*已停止/) });
    expect(backups()).toEqual([]);
  });

  it('显式指定的旧库也生成可单独恢复的 WAL 一致快照', () => {
    const file = join(dir, 'alternate.db');
    seed(file, 14);
    const keeper = new DatabaseSync(file);
    try {
      keeper.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)');
      const mainBefore = readFileSync(file);
      keeper.exec(`BEGIN; UPDATE subjects SET name='committed only in WAL' WHERE id=1; COMMIT`);
      expect(statSync(file + '-wal').size).toBeGreaterThan(32);
      expect(readFileSync(file)).toEqual(mainBefore);
      const expected = source(keeper);
      const migrated = openDatabase({ file });
      expect(version(migrated)).toBe(LATEST_SCHEMA_VERSION);
      expect(source(migrated)).toEqual(expected);
      expect(backups()).toHaveLength(1);
      expect(existsSync(paths.dbFile)).toBe(false);
      const restored = join(dir, 'restored.db');
      copyFileSync(join(paths.backupDir, backups()[0]!), restored);
      expect(existsSync(restored + '-wal')).toBe(false);
      expect(read(restored, (db) => ({
        version: version(db), source: source(db), integrity: db.prepare('PRAGMA integrity_check').get(),
      }))).toEqual({ version: 14, source: expected, integrity: { integrity_check: 'ok' } });
    } finally { closeDatabase(); keeper.close(); }
  });

  it('迁移中途失败保留已核验备份，重试另做快照；目标版本重复启动不做备份', () => {
    seed(paths.dbFile, 13);
    const db = new DatabaseSync(paths.dbFile);
    db.exec('CREATE TABLE idx_active_subject_user_hide (fixture INTEGER)');
    db.close();
    const expected = read(paths.dbFile, source);
    expect(attempt()).toMatchObject({ message: expect.stringMatching(/迁移失败.*v15/) });
    expect(read(paths.dbFile, version)).toBe(14);
    const [first] = backups();
    expect(read(join(paths.backupDir, first!), (snapshot) => ({ version: version(snapshot), source: source(snapshot) })))
      .toEqual({ version: 13, source: expected });
    writeFileSync(join(paths.backupDir, 'pre-migration-v14-interrupted.db.partial'), 'abandoned after interruption');

    const retry = new DatabaseSync(paths.dbFile);
    retry.exec('DROP TABLE idx_active_subject_user_hide');
    retry.close();
    expect(attempt()).toBeUndefined();
    expect(read(paths.dbFile, version)).toBe(LATEST_SCHEMA_VERSION);
    const after = backups();
    expect(after).toHaveLength(2);
    expect(after).toContain(first);
    expect(read(join(paths.backupDir, after.find((name) => name !== first)!), version)).toBe(14);
    expect(attempt()).toBeUndefined();
    expect(backups()).toEqual(after);
    expect(read(paths.dbFile, source)).toEqual(expected);
  });

  it.each([false, true])('无待备份内容时不依赖备份目录（现有目标版本=%s）', (existing) => {
    if (existing) seed(paths.dbFile, LATEST_SCHEMA_VERSION);
    const blockedParent = join(dir, 'blocked-parent');
    writeFileSync(blockedParent, 'not a directory');
    paths.backupDir = join(blockedParent, 'backups');
    expect(version(openDatabase())).toBe(LATEST_SCHEMA_VERSION);
    expect(existsSync(paths.backupDir)).toBe(false);
  });

  it('user_version 为 0 但含本地表时不按空库豁免', () => {
    const file = join(dir, 'unversioned.db');
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE local_notes(value TEXT); INSERT INTO local_notes VALUES('owned')");
    db.close();
    mkdirSync(paths.backupDir);
    expect(version(openDatabase({ file }))).toBe(LATEST_SCHEMA_VERSION);
    expect(backups()).toHaveLength(1);
    expect(read(join(paths.backupDir, backups()[0]!), (snapshot) => ({
      version: version(snapshot), note: snapshot.prepare('SELECT value FROM local_notes').get(),
    }))).toEqual({ version: 0, note: { value: 'owned' } });
  });
});
