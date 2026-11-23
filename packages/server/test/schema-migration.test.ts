import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../src/db/schema.js';

function oldDatabase(version: number): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const migration of MIGRATIONS.filter((item) => item.version <= version)) {
    if (!migration.isApplied?.(db)) db.exec(migration.sql);
    db.exec(`PRAGMA user_version=${migration.version}`);
  }
  db.exec(`INSERT INTO subjects(id,name,raw,created_at,updated_at) VALUES(1,'migration fixture','{"source":"fixture"}','2020','2020');
    INSERT INTO collections(subject_id,type,rate,comment,private,first_seen_at,synced_at) VALUES(1,2,9,'private fixture',1,'2020','2020')`);
  return db;
}

describe('隔离旧 schema 升级', () => {
  it('v13在DDL后版本写入故障时撤销新列/旧行变化，去除故障后可重试', () => {
    const db = oldDatabase(12);
    const before = db.prepare('SELECT * FROM subjects').all();
    let injected = false;
    const wrapper = {
      prepare: db.prepare.bind(db),
      exec(sql: string) {
        if (/PRAGMA user_version\s*=\s*13/.test(sql)) {
          expect(db.prepare("SELECT name FROM pragma_table_info('subjects') WHERE name='collection_total_known'").get()).toBeDefined();
          injected = true; throw new Error('v13 version fault');
        }
        return db.exec(sql);
      },
    };
    try {
      expect(() => migrate(wrapper as unknown as DatabaseSync)).toThrow('v13 version fault');
      expect(injected).toBe(true);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
      expect(db.prepare("SELECT name FROM pragma_table_info('subjects') WHERE name='collection_total_known'").get()).toBeUndefined();
      expect(db.prepare('SELECT * FROM subjects').all()).toEqual(before);
      migrate(db); migrate(db);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: LATEST_SCHEMA_VERSION });
      expect(db.prepare('SELECT collection_total_known FROM subjects').get()).toEqual({ collection_total_known: null });
    } finally { db.close(); }
  });
  it('v14 failed version write rolls back the history table and projection marker', () => {
    const db = oldDatabase(13);
    const source = db.prepare('SELECT * FROM collections').all();
    const wrapper = {
      prepare: db.prepare.bind(db),
      exec(sql: string) {
        if (/PRAGMA user_version\s*=\s*14/.test(sql)) throw new Error('v14 version fault');
        return db.exec(sql);
      },
    };
    try {
      expect(() => migrate(wrapper as unknown as DatabaseSync)).toThrow('v14 version fault');
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 });
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='collection_rating_history'").get()).toBeUndefined();
      expect(db.prepare("SELECT value FROM meta WHERE key='personal_rating_projection_pending'").get()).toBeUndefined();
      migrate(db); migrate(db);
      expect(db.prepare('SELECT * FROM collections').all()).toEqual(source);
      expect(db.prepare('SELECT * FROM collection_rating_history').all()).toEqual([]);
    } finally { db.close(); }
  });
  it('v15 failure is atomic and legacy governance and rating history survive retry', () => {
    const db = oldDatabase(14);
    db.exec(`INSERT INTO franchise_entities(key,title,created_at,updated_at) VALUES('legacy','Preserved','2020','2020')`);
    const before=db.prepare('SELECT * FROM franchise_entities').all();
    const source=db.prepare('SELECT * FROM collections').all();
    const wrapper={
      prepare:db.prepare.bind(db),
      exec(sql:string){
        if (/PRAGMA user_version\s*=\s*15/.test(sql)) throw Error('v15 injected version failure');
        db.exec(sql);
      },
    };
    try {
      expect(()=>migrate(wrapper as unknown as DatabaseSync)).toThrow('v15 injected version failure');
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('subject_user_hides','franchise_member_assignments')").all()).toEqual([]);
      expect(db.prepare('SELECT * FROM franchise_entities').all()).toEqual(before);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({user_version:14});
      migrate(db);migrate(db);
      expect(db.prepare('SELECT * FROM franchise_entities').all()).toEqual(before.map(row=>({...row,origin:'auto'})));
      expect(db.prepare('SELECT * FROM collections').all()).toEqual(source);
      expect(db.prepare('SELECT * FROM subject_user_hides').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM franchise_member_assignments').all()).toEqual([]);
    } finally {db.close();}
  });
  it('v13仅添加来源状态，旧零/正值及raw不回填、不重写，状态有数据库约束', () => {
    const db = oldDatabase(12);
    try {
      db.exec(`INSERT INTO subjects(id,collection_total,raw,created_at,updated_at) VALUES(2,400,'{"missing":true}','2020','2020')`);
      const before = db.prepare('SELECT id,collection_total,raw FROM subjects ORDER BY id').all();
      migrate(db); migrate(db);
      expect(db.prepare('SELECT id,collection_total,raw FROM subjects ORDER BY id').all()).toEqual(before);
      expect(db.prepare('SELECT collection_total_known FROM subjects').all()).toEqual([{ collection_total_known: null }, { collection_total_known: null }]);
      expect(() => db.exec('UPDATE subjects SET collection_total_known=2')).toThrow();
    } finally { db.close(); }
  });
  it.each(MIGRATIONS.map((item) => item.version))('v%s 升至当前版本保留用户源数据，并可重复打开迁移', (version) => {
    const db = oldDatabase(version);
    try {
      const subject = db.prepare('SELECT id,name,raw,created_at FROM subjects').get();
      const collection = db.prepare('SELECT * FROM collections').get();
      migrate(db);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: LATEST_SCHEMA_VERSION });
      expect(db.prepare('SELECT id,name,raw,created_at FROM subjects').get()).toEqual(subject);
      expect(db.prepare('SELECT * FROM collections').get()).toEqual(collection);
      const schema = db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
      migrate(db);
      expect(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('迁移中途 DDL 失败撤销该步表和 user_version，修正隔离故障后可再次升级', () => {
    const db = oldDatabase(11);
    try {
      db.exec('CREATE TABLE idx_franchise_member_exclusions_franchise (fixture INTEGER)');
      const collection = db.prepare('SELECT * FROM collections').get();
      expect(() => migrate(db)).toThrow('数据库迁移失败');
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='franchise_member_exclusions'").get()).toBeUndefined();
      expect(db.prepare('SELECT * FROM collections').get()).toEqual(collection);
      db.exec('DROP TABLE idx_franchise_member_exclusions_franchise');
      migrate(db);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: LATEST_SCHEMA_VERSION });
    } finally { db.close(); }
  });
});
