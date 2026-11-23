import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, dataVersion, exec, getDatabase, one, run } from '../src/db/index.js';
import { saveConfig } from '../src/config.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';
import { inspectSourceSnapshots } from '../src/diagnostics/sourceSnapshots.js';
import { captureProtectedSources } from '../src/diagnostics/sourceProtection.js';
import { buildApp } from '../src/app.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';

const T = '2026-11-06T12:00:00.000Z';
const ID = 'source.snapshot-invalid';
beforeEach(() => { resetDatabase(); saveConfig({ hideNsfw: false }); invalidateDiagnosticsReport(); });
afterEach(() => { vi.restoreAllMocks(); exec('PRAGMA user_version=15'); });
function subject(id: number, raw: string | null, hidden=false) {
  run('INSERT INTO subjects(id,name,nsfw,raw,created_at,updated_at) VALUES(:id,\'PRIVATE_NAME\',:hidden,:raw,:t,:t)', {id,raw,hidden:hidden?1:0,t:T});
}
function collection(id: number, raw: string | null) {
  run('INSERT INTO collections(subject_id,type,raw,first_seen_at,synced_at) VALUES(:id,2,:raw,:t,:t)', {id,raw,t:T});
}
it('SRC-E01: invalid stored source JSON is not hidden by canonical fallback reads', () => {
  run('INSERT INTO subjects(id,name,raw,created_at,updated_at) VALUES(1,\'source\',\'{\',:t,:t)', { t: T });
  const issue = getDiagnosticsReport({ refresh: true }).issues.find(i => i.id === ID);
  expect(issue).toBeDefined();
  expect(issue!.affectedCount).toBe(1);
  expect(issue!.actions.some(a => a.kind === 'repair')).toBe(false);
});

it('SRC-library: explicit fixture outcomes across both writers, no inferred identity comparison', () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname,'fixtures/data-quality/source-snapshots.json'),'utf8'));
  const expected = {absentCount:2,objectCount:6,nonObjectCount:6,invalidCount:6,uncheckedCount:0,rowsScanned:20};
  for (const [index,s] of fixture.samples.entries()) { subject(index+1,s.raw); collection(index+1,s.raw); }
  const before=captureProtectedSources(), version=dataVersion(), changes=one<{n:number}>('SELECT total_changes() n')!.n;
  expect(inspectSourceSnapshots()).toMatchObject(expected);
  expect(captureProtectedSources()).toEqual(before); expect(dataVersion()).toBe(version);
  expect(one<{n:number}>('SELECT total_changes() n')!.n).toBe(changes);
});

it('SRC-combined: non-text BLOB and invalid JSON counted together, raw never appears in evidence', () => {
  subject(1,'{}'); collection(1,'{'); run("UPDATE subjects SET raw=x'7B7D' WHERE id=1");
  const c=inspectSourceSnapshots(); expect(c.invalidCount).toBe(2);
  expect(c.samples.map(s=>s.reason)).toEqual(['non-text','invalid-json']);
  expect(JSON.stringify(c)).not.toContain('PRIVATE_NAME');
});

it('SRC-scale: complete counts, bounded samples, and explicit unknown for oversized snapshots', () => {
  const db=getDatabase(); exec('BEGIN');try{for(let id=1;id<=1207;id++)subject(id,'{');exec('COMMIT');}catch(e){exec('ROLLBACK');throw e;}
  subject(2000,'"'+'x'.repeat(1024*1024)+'"');
  const c=inspectSourceSnapshots(); expect(c.rowsScanned).toBe(1208);expect(c.invalidCount).toBe(1207);expect(c.samples).toHaveLength(20);expect(c.samplesTruncated).toBe(true);expect(c.uncheckedCount).toBe(1);expect(db.isTransaction).toBe(false);
  const r=getDiagnosticsReport({refresh:true});expect(r.modules.find(m=>m.id==='collections')!.sourceSnapshots).toEqual(c);
});

it('SRC-failure: mid-scan interruption fails closed, releases only own savepoint', () => {
  subject(1,'{');const db=getDatabase(), original=db.prepare.bind(db);exec('BEGIN');
  vi.spyOn(db,'prepare').mockImplementation(((sql:string)=>sql.includes('AS snapshot')?{setReadBigInts:()=>{},iterate:function*(){yield {record_id:1n,storage:'text',bytes:1n,snapshot:'{'};throw Error('PRIVATE_INTERRUPT');}}:original(sql)) as any);
  expect(()=>inspectSourceSnapshots()).toThrow('来源快照检查未完成');expect(db.isTransaction).toBe(true);vi.restoreAllMocks();exec('ROLLBACK');expect(inspectSourceSnapshots().invalidCount).toBe(1);
});

it('SRC-future-schema: unknown schema cannot produce a successful format assessment', () => {
  exec('PRAGMA user_version=16');expect(()=>getDiagnosticsReport({refresh:true})).toThrow('来源快照检查未完成');
});

it('SRC-recheck: external reliable representation correction preserves identity, historical evidence and manual lock', () => {
  subject(1,'{');collection(1,'{}');run("INSERT INTO series_entities(key,title,title_state,created_at,updated_at) VALUES('locked_source','Locked','manual',:t,:t)",{t:T});
  const before=all('SELECT * FROM series_entities'), history=all('SELECT * FROM entity_events'), col=all('SELECT * FROM collections');
  expect(getDiagnosticsReport({refresh:true}).issues.some(i=>i.id===ID)).toBe(true);
  run("UPDATE subjects SET raw='{}' WHERE id=1");
  expect(getDiagnosticsReport({refresh:true}).issues.some(i=>i.id===ID)).toBe(false);
  expect(all('SELECT * FROM series_entities')).toEqual(before);expect(all('SELECT * FROM entity_events')).toEqual(history);expect(all('SELECT * FROM collections')).toEqual(col);
});

it('SRC-HTTP: evidence intent, not metric/mode params; no fabricated Repair or partial-success failure', async () => {
  subject(987654321,'{"PRIVATE_历史别名":}',true);saveConfig({hideNsfw:true});
  const client=new FakeBangumiClient(), a=await buildApp({deps:{client,engine:new SyncEngine({client,getConfig:()=>testConfig()}),coverCache:new CoverCache(client)},logger:false});
  const before=captureProtectedSources(), version=dataVersion();try{
    for(const q of ['', '?visibility=real','?mode=investigation']){
      const r=await a.inject('/api/diagnostics'+q);expect(r.statusCode).toBe(200);const i=r.json().issues.find((x:any)=>x.id===ID);expect(i).toBeDefined();expect(i.sourceSnapshots.invalidCount).toBe(1);expect(i.sourceSnapshots.samples[0].recordId).toBeNull();expect(i.explanation).toContain('不证明');expect(r.body).not.toContain('987654321');expect(r.body).not.toContain('PRIVATE_');
    }
    const full=await a.inject({url:'/api/diagnostics?evidence=real',headers:{'X-Analyzer-Evidence':'real'}});expect(full.json().issues.find((x:any)=>x.id===ID).sourceSnapshots.samples[0].recordId).toBe('987654321');expect(full.body).not.toContain('PRIVATE_历史别名');
    const denied=await a.inject({url:'/api/diagnostics?evidence=real'});expect(denied.statusCode).toBe(403);
    const refuse=await a.inject({method:'POST',url:'/api/diagnostics/repairs',payload:{issueId:ID,kind:'recompute-derived'}});expect(refuse.statusCode).toBe(400);expect(refuse.json().error.code).toBe('repair_not_allowed');
    exec('PRAGMA user_version=16');const fail=await a.inject('/api/diagnostics?refresh=1');expect(fail.statusCode).toBe(500);expect(fail.json().error.code).toBe('source_snapshot_check_incomplete');expect(fail.json().coverage).toBeUndefined();
    expect(captureProtectedSources()).toEqual(before);expect(dataVersion()).toBe(version);
  }finally{await a.close();}
});

it('DQ-inventory: reproducible isolated Schema census; no formal database connection', () => {
  const tables=all<{name:string}>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name");
  const census=tables.map(t=>({table:t.name,columns:all<{name:string;type:string;notnull:number;pk:number}>(`PRAGMA table_info("${t.name}")`).map(c=>({name:c.name,type:c.type,notnull:c.notnull,pk:c.pk}))}));
  expect(tables).toHaveLength(24);
  if(process.env.DQ_EVIDENCE_DIR) writeFileSync(join(process.env.DQ_EVIDENCE_DIR,'schema-census.json'),JSON.stringify({schema:15,tables:census},null,2));
});
