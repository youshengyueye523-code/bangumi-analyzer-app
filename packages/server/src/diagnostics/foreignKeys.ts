/** Declared SQLite constraints, not inferred business relationships. Never repairs data. */
import { ApiError, type DiagnosticForeignKeyCheck, type DiagnosticForeignKeyRelation } from '@bangumi-analyzer/shared';
import { getDatabase } from '../db/index.js';

const SAMPLE_LIMIT = 20;
// Public schema copy, not arbitrary names obtained from an imported/corrupt DB.
// Match columns, not FK ordinal: SQLite may reorder constraint IDs after migrations.
const PUBLIC_RELATIONS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['collections', 'subjects', 'subject_id', 'id'],
  ['subject_staff', 'subjects', 'subject_id', 'id'],
  ['subject_relations', 'subjects', 'subject_id', 'id'],
  ['translation_jobs', 'subjects', 'subject_id', 'id'],
  ['series_entity_members', 'series_entities', 'series_id', 'id'],
  ['franchise_series', 'franchise_entities', 'franchise_id', 'id'],
  ['franchise_series', 'series_entities', 'series_id', 'id'],
];
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const key = (table: string, id: number) => JSON.stringify([table, id]);
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid FK coverage counter');
  return value;
}

/** A read snapshot also works inside the caller's existing Repair write transaction. */
export function inspectForeignKeys(): DiagnosticForeignKeyCheck {
  const db = getDatabase();
  let active = false;
  try {
    // Unlike the mutation helper this does not acquire BEGIN IMMEDIATE's write lock.
    db.exec('SAVEPOINT diagnostic_foreign_keys');
    active = true;
    const enabled = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    if (enabled?.foreign_keys !== 0 && enabled?.foreign_keys !== 1) throw new Error('Unknown FK enforcement');
    // GLOB's underscore is literal: sqliteX... is a legal user table, not sqlite_ metadata.
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as Array<{ name: string }>;
    const definitions = new Map<string, DiagnosticForeignKeyRelation>();
    for (const { name } of tables) {
      const rows = db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as Array<{ id: number; seq: number; table: string; from: string; to: string | null }>;
      rows.sort((a,b) => a.id-b.id || a.seq-b.seq);
      for (const row of rows) {
        const id = count(row.id);
        const k = key(name, id);
        const relation = definitions.get(k) ?? { table: name, parent: row.table, foreignKeyId: id, columns: [], parentColumns: [], schemaProtected: false };
        if (relation.parent !== row.table || typeof row.from !== 'string' || (row.to !== null && typeof row.to !== 'string')) throw new Error('Inconsistent FK definition');
        relation.columns.push(row.from); relation.parentColumns.push(row.to);
        definitions.set(k, relation);
      }
    }
    const samples: DiagnosticForeignKeyCheck['samples'] = [];
    const groups = new Map<string, DiagnosticForeignKeyCheck['groups'][number]>();
    let violations = 0;
    const statement = db.prepare('PRAGMA foreign_key_check');
    statement.setReadBigInts(true);
    for (const raw of statement.iterate()) {
      const table = String(raw.table);
      const id = count(Number(raw.fkid));
      const k = key(table, id);
      const relation = definitions.get(k);
      if (!relation || relation.parent !== raw.parent || (raw.rowid !== null && typeof raw.rowid !== 'bigint')) throw new Error('Unresolved FK violation');
      violations = count(violations + 1);
      const group = groups.get(k) ?? { ...relation, violationCount: 0 };
      group.violationCount = count(group.violationCount + 1); groups.set(k, group);
      if (samples.length < SAMPLE_LIMIT) samples.push({ ...relation, rowid: raw.rowid === null ? null : raw.rowid.toString(), identityProtected: false });
    }
    const result: DiagnosticForeignKeyCheck = {
      scope: 'declared-sqlite-foreign-keys', status: 'complete', tablesInspected: tables.length,
      constraintCount: definitions.size, foreignKeysEnabled: enabled.foreign_keys === 1,
      violationCount: violations, sampleLimit: SAMPLE_LIMIT, samplesTruncated: violations > samples.length,
      groupCount: groups.size, groupsTruncated: groups.size > SAMPLE_LIMIT,
      groups: [...groups.values()].sort((a,b)=>String(a.table).localeCompare(String(b.table)) || a.foreignKeyId-b.foreignKeyId).slice(0,SAMPLE_LIMIT), samples,
    };
    db.exec('RELEASE SAVEPOINT diagnostic_foreign_keys'); active = false;
    return result;
  } catch {
    if (active) {
      try { db.exec('ROLLBACK TO SAVEPOINT diagnostic_foreign_keys'); }
      finally { db.exec('RELEASE SAVEPOINT diagnostic_foreign_keys'); }
    }
    throw new ApiError('已声明外键检查未完成，不能认定结构正常', {
      code: 'foreign_key_check_incomplete', status: 500, dataIntact: true,
      hint: '底层检查中断或约束无法执行；原因尚未确认。请先保留备份与证据，不要删除来源记录或反复尝试修复。',
    });
  }
}

/** Explicit B1 projection: counts/schema are public, record identities are not. */
export function visibleForeignKeys(check: DiagnosticForeignKeyCheck): DiagnosticForeignKeyCheck {
  if (check.scope !== 'declared-sqlite-foreign-keys' || check.status !== 'complete' ||
      count(check.sampleLimit) > SAMPLE_LIMIT || check.samples.length > check.sampleLimit || check.groups.length > SAMPLE_LIMIT) throw new Error('Invalid FK evidence');
  const relation = (r: DiagnosticForeignKeyRelation): DiagnosticForeignKeyRelation => {
    const known = PUBLIC_RELATIONS.some(([table,parent,column,target])=> r.table===table && r.parent===parent && r.columns.length===1 && r.columns[0]===column && r.parentColumns.length===1 && r.parentColumns[0]===target);
    return { table:known ? r.table : null, parent:known ? r.parent : null, foreignKeyId:count(r.foreignKeyId),
      columns:known ? [...r.columns] : [], parentColumns:known ? [...r.parentColumns] : [], schemaProtected:!known };
  };
  return { scope:'declared-sqlite-foreign-keys',status:'complete',tablesInspected:count(check.tablesInspected),constraintCount:count(check.constraintCount),
    foreignKeysEnabled:check.foreignKeysEnabled===true,violationCount:count(check.violationCount),sampleLimit:count(check.sampleLimit),samplesTruncated:check.samplesTruncated===true,
    groupCount:count(check.groupCount),groupsTruncated:check.groupsTruncated===true,
    groups:check.groups.map(r=>({...relation(r),violationCount:count(r.violationCount)})),
    samples:check.samples.map(r=>({...relation(r),rowid:null,identityProtected:true})),
  };
}
