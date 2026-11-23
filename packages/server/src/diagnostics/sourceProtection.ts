import { createHash } from 'node:crypto';
import type { DiagnosticsRepairCheck } from '@bangumi-analyzer/shared';
import { ApiError } from '@bangumi-analyzer/shared';
import { getDatabase } from '../db/index.js';

// Only these derived/cache columns may change during the existing repair actions.
// All other Subject columns, and every Collection/Relation/Staff field, are protected.
const SOURCE_TABLES = ['subjects', 'collections', 'subject_relations', 'subject_staff', 'collection_rating_history',
  'franchise_member_assignments','subject_user_hides'] as const;
const SUBJECT_DERIVED = new Set(['series_key', 'series_source', 'cover_path', 'cover_cached_at']);
type SourceSnapshot = Record<(typeof SOURCE_TABLES)[number], string>;

function typed(value: unknown): unknown {
  if (typeof value === 'bigint') return ['integer', value.toString()];
  if (typeof value === 'number') return ['real', Object.is(value, -0) ? '-0' : String(value)];
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('hex')];
  return [value === null ? 'null' : typeof value, value];
}

/** Read inside the caller's repair transaction; fingerprints never expose source content. */
export function captureProtectedSources(): SourceSnapshot {
  const db = getDatabase();
  return Object.fromEntries(SOURCE_TABLES.map((table) => {
    if ((table === 'collection_rating_history' || table === 'franchise_member_assignments' || table === 'subject_user_hides') &&
        !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='collection_rating_history'").get()) {
      // Older schemas have no such facts. If a table disappears during an operation,
      // this sentinel also differs from any real table fingerprint.
      return [table, 'not-present'];
    }
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name)
      .filter((name) => table !== 'subjects' || !SUBJECT_DERIVED.has(name));
    const statement = db.prepare(`SELECT ${columns.map((name) => `"${name}"`).join(',')} FROM ${table}`);
    statement.setReadBigInts(true);
    const rows: string[] = [];
    for (const row of statement.iterate()) {
      rows.push(createHash('sha256').update(JSON.stringify(columns.map((name) => typed(row[name])))).digest('hex'));
    }
    // Multiset equality, independent of physical row order; duplicates are retained.
    rows.sort();
    return [table, createHash('sha256').update(JSON.stringify([columns, rows])).digest('hex')];
  })) as SourceSnapshot;
}

export function protectedSourcesCheck(before: SourceSnapshot): DiagnosticsRepairCheck {
  const after = captureProtectedSources();
  const changed = SOURCE_TABLES.filter((table) => before[table] !== after[table]);
  return {
    layer: 'source', label: '原始数据未被修改', ok: changed.length === 0,
    detail: changed.length === 0
      ? '执行后来源内容与执行前一致（包含类型、原始证据及重复行；不含允许重算的归属/封面标记）'
      : `受保护来源内容发生变化：${changed.join(' / ')}；不能宣称修复已完全验证`,
  };
}

/** A source safety failure is not an ordinary consumer mismatch/partial commit. */
export function enforceProtectedSources(check: DiagnosticsRepairCheck): void {
  if (!check.ok) {
    throw new ApiError('修复越过受保护来源边界，本次事务已回滚', {
      code: 'protected_source_write_violation', status: 409, dataIntact: true,
      hint: '来源内容必须保持不变；请重新检测并报告此问题，不要重复提交旧预览。',
    });
  }
}
