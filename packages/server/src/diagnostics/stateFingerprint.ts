/** Typed, ordered fingerprints for local plans. No source text leaves this module. */
import { createHash } from 'node:crypto';
import { getDatabase } from '../db/index.js';

export function typedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? ['integer', v.toString()]
    : typeof v === 'number' ? ['real', Object.is(v, -0) ? '-0' : String(v)]
      : v instanceof Uint8Array ? ['blob', Buffer.from(v).toString('hex')] : v);
}

/** Identifiers/WHERE come only from code, never HTTP input. Streaming retains no row array. */
export function fingerprint(sql: string, params: Record<string, string> = {}): string {
  const stmt = getDatabase().prepare(sql);
  stmt.setReadBigInts(true);
  const hash = createHash('sha256');
  for (const row of stmt.iterate(params)) hash.update(typedJson(row)).update('\n');
  return hash.digest('hex');
}

export function digest(value: unknown): string {
  return createHash('sha256').update(typedJson(value)).digest('hex');
}
