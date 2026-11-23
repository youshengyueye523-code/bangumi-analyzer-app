import { supportsQualitySchema } from '../db/schema.js';
/** Local snapshot representation only. Never infers upstream truth or rewrites evidence. */
import { ApiError, type DiagnosticSourceSnapshots } from '@bangumi-analyzer/shared';
import { getDatabase } from '../db/index.js';

const MAX_BYTES = 1024 * 1024;
const SAMPLE_LIMIT = 20;

export function inspectSourceSnapshots(): DiagnosticSourceSnapshots {
  const db = getDatabase();
  let active = false;
  try {
    db.exec('SAVEPOINT diagnostic_source_snapshots'); active = true;
    const schema = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (!supportsQualitySchema(schema.user_version)) throw new Error('Unassessed source schema');
    const result: DiagnosticSourceSnapshots = {
      scope: 'stored-source-json', scanStatus: 'complete', assessment: 'format-only', schemaVersion: schema.user_version,
      maxBytesPerSnapshot: MAX_BYTES, sampleLimit: SAMPLE_LIMIT,
      rowsScanned: 0, absentCount: 0, objectCount: 0, nonObjectCount: 0, invalidCount: 0, uncheckedCount: 0,
      samplesTruncated: false, samples: [],
    };
    for (const [table, id] of [['subjects', 'id'], ['collections', 'subject_id']] as const) {
      // Do not transfer an oversized raw into JS just to decide not to parse it.
      const stmt = db.prepare(`SELECT ${id} AS record_id, typeof(raw) AS storage,
        length(CAST(raw AS BLOB)) AS bytes,
        CASE WHEN length(CAST(raw AS BLOB)) <= ${MAX_BYTES} THEN raw ELSE NULL END AS snapshot
        FROM ${table} ORDER BY ${id}`);
      stmt.setReadBigInts(true);
      for (const row of stmt.iterate()) {
        result.rowsScanned++;
        if (!Number.isSafeInteger(result.rowsScanned) || typeof row.record_id !== 'bigint') throw new Error('Invalid source scan counter');
        if (row.storage === 'null') { result.absentCount++; continue; }
        if (typeof row.bytes !== 'bigint' || row.bytes < 0n) throw new Error('Unknown source size');
        if (row.bytes > BigInt(MAX_BYTES)) { result.uncheckedCount++; continue; }
        let reason: 'invalid-json' | 'non-text' | undefined;
        if (row.storage !== 'text' || typeof row.snapshot !== 'string') reason = 'non-text';
        else {
          try {
            const parsed: unknown = JSON.parse(row.snapshot);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) result.objectCount++;
            else result.nonObjectCount++;
          } catch { reason = 'invalid-json'; }
        }
        if (reason) {
          result.invalidCount++;
          if (result.samples.length < SAMPLE_LIMIT) result.samples.push({ table, recordId: row.record_id.toString(), reason, identityProtected: false });
        }
      }
    }
    result.samplesTruncated = result.invalidCount > result.samples.length;
    db.exec('RELEASE SAVEPOINT diagnostic_source_snapshots'); active = false;
    return result;
  } catch {
    if (active) {
      try { db.exec('ROLLBACK TO SAVEPOINT diagnostic_source_snapshots'); }
      finally { db.exec('RELEASE SAVEPOINT diagnostic_source_snapshots'); }
    }
    throw new ApiError('来源快照检查未完成，不能认定来源正常', {
      code: 'source_snapshot_check_incomplete', status: 500, dataIntact: true,
      hint: 'Schema 未核验或读取中断；保留原始数据与备份，不要清空快照或自动重新同步。',
    });
  }
}

/** Counts are audit scope, not subject facts. Identities require separate full-evidence intent. */
export function visibleSourceSnapshots(c: DiagnosticSourceSnapshots): DiagnosticSourceSnapshots {
  const counters = [c.schemaVersion,c.maxBytesPerSnapshot,c.sampleLimit,c.rowsScanned,c.absentCount,c.objectCount,c.nonObjectCount,c.invalidCount,c.uncheckedCount];
  if (c.scope !== 'stored-source-json' || c.scanStatus !== 'complete' || c.assessment !== 'format-only' ||
      counters.some(n => !Number.isSafeInteger(n) || n < 0) || c.sampleLimit > SAMPLE_LIMIT || c.samples.length > c.sampleLimit ||
      c.rowsScanned !== c.absentCount+c.objectCount+c.nonObjectCount+c.invalidCount+c.uncheckedCount) throw new Error('Invalid source snapshot evidence');
  return { scope:c.scope,scanStatus:c.scanStatus,assessment:c.assessment,schemaVersion:c.schemaVersion,
    maxBytesPerSnapshot:c.maxBytesPerSnapshot,sampleLimit:c.sampleLimit,rowsScanned:c.rowsScanned,absentCount:c.absentCount,
    objectCount:c.objectCount,nonObjectCount:c.nonObjectCount,invalidCount:c.invalidCount,uncheckedCount:c.uncheckedCount,
    samplesTruncated:c.samplesTruncated===true,samples:c.samples.map(s=>{
      if (!['subjects','collections'].includes(s.table) || !['invalid-json','non-text'].includes(s.reason)) throw new Error('Invalid source sample');
      return {table:s.table,recordId:null,reason:s.reason,identityProtected:true};
    }) };
}
