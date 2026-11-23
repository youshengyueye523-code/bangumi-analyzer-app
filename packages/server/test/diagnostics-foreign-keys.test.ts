import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { all, one, run, exec, getDatabase, dataVersion } from '../src/db/index.js';
import { saveConfig } from '../src/config.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { runDiagnosticsRepair } from '../src/diagnostics/repair.js';
import { captureProtectedSources, protectedSourcesCheck } from '../src/diagnostics/sourceProtection.js';
import { buildApp } from '../src/app.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';
const T='2026-11-05T15:00:00.000Z';
const ID='storage.foreign-key-violations';
const issue=()=>getDiagnosticsReport({refresh:true}).issues.find(x=>x.id===ID);
function subject(id:number,name='Public source') {run('INSERT INTO subjects(id,name,name_cn,created_at,updated_at) VALUES(:id,:name,:name,:t,:t)',{id,name,t:T});}
function unchecked(fn:()=>void){exec('PRAGMA foreign_keys=OFF');try{fn();}finally{exec('PRAGMA foreign_keys=ON');}}
function orphanCollection(id:number){run('INSERT INTO collections(subject_id,type,first_seen_at,synced_at,comment) VALUES(:id,2,:t,:t,\'private comment\')',{id,t:T});}
beforeEach(()=>{resetDatabase();saveConfig({hideNsfw:false});invalidateDiagnosticsReport();});
afterEach(()=>{vi.restoreAllMocks();exec('PRAGMA foreign_keys=ON');exec('DROP TABLE IF EXISTS malformed_child');exec('DROP TABLE IF EXISTS malformed_parent');exec('DROP TABLE IF EXISTS "PRIVATE_SCHEMA_秘密"');exec('DROP TABLE IF EXISTS sqliteX_user_reference');invalidateDiagnosticsReport();});
async function app(){const client=new FakeBangumiClient();return buildApp({deps:{client,engine:new SyncEngine({client,getConfig:()=>testConfig()}),coverCache:new CoverCache(client)},logger:false});}

it('Detect: old quick_check can pass while a declared foreign key is broken',()=>{
 unchecked(()=>orphanCollection(901));expect(one<{quick_check:string}>('PRAGMA quick_check')!.quick_check).toBe('ok');
 const i=issue();expect(i).toBeDefined();expect(i!.severity).toBe('error');expect(i!.affectedCount).toBe(1);expect(i!.actions.some(a=>a.kind==='repair')).toBe(false);
});
it('Coverage: all seven declared constraint failures counted, not child rows',()=>{
 unchecked(()=>{orphanCollection(901);run('INSERT INTO subject_staff(subject_id,name,relation,source) VALUES(902,\'Private worker\',\'监督\',\'persons\')');run('INSERT INTO subject_relations(subject_id,related_id,relation,created_at) VALUES(903,9999,\'续集\',:t)',{t:T});run('INSERT INTO translation_jobs(subject_id,source_hash,created_at,updated_at) VALUES(904,\'private-hash\',:t,:t)',{t:T});run('INSERT INTO series_entity_members(series_id,subject_id) VALUES(905,9999)');run('INSERT INTO franchise_series(franchise_id,series_id) VALUES(906,907)');});
 const report=getDiagnosticsReport({refresh:true});const i=report.issues.find(x=>x.id===ID)!;expect(i?.affectedCount).toBe(7);expect(i.foreignKeys?.violationCount).toBe(7);expect(i.foreignKeys?.constraintCount).toBe(7);expect(i.foreignKeys?.tablesInspected).toBe(21);expect(report.modules).toHaveLength(10);expect(report.modules.find(x=>x.id==='storage')!.status).toBe('error');
});
it('Negative: normal data, relation-only targets and historical governance refs are not FK corruption',()=>{
 subject(1);run('INSERT INTO subject_relations(subject_id,related_id,relation,created_at) VALUES(1,9999,\'续集\',:t)',{t:T});run('INSERT INTO series_entities(id,key,title,created_at,updated_at) VALUES(1,\'sr_normal_fk\',\'Manual title\',:t,:t)',{t:T});run('INSERT INTO series_entity_members(series_id,subject_id) VALUES(1,9999)');
 run('INSERT INTO entity_events(entity_kind,entity_id,kind,payload,created_at) VALUES(\'series\',99999,\'merged\',\'{}\',:t)',{t:T});run('INSERT INTO franchise_member_exclusions(franchise_id,series_id,created_at) VALUES(8888,9999,:t)',{t:T});
 const r=getDiagnosticsReport({refresh:true});expect(r.issues.some(x=>x.id===ID)).toBe(false);expect(r.modules.find(x=>x.id==='storage')!.foreignKeys?.status).toBe('complete');expect(r.modules.find(x=>x.id==='storage')!.foreignKeys?.violationCount).toBe(0);
});
it('Bounds: full violation count survives bounded samples and does not mutate raw facts',()=>{
 unchecked(()=>{for(let i=1000;i<1605;i++)orphanCollection(i);});const before=captureProtectedSources();const version=dataVersion();const total=one<{n:number}>('SELECT total_changes() n')!.n;
 const i=issue()!;expect(i.affectedCount).toBe(605);expect(i.foreignKeys!.samples.length).toBeLessThanOrEqual(20);expect(i.foreignKeys!.samplesTruncated).toBe(true);expect(i.foreignKeys!.groups[0]!.violationCount).toBe(605);expect(protectedSourcesCheck(before).ok).toBe(true);expect(dataVersion()).toBe(version);expect(one<{n:number}>('SELECT total_changes() n')!.n).toBe(total);
});
it('No invented Repair: API refuses recompute for the new source/structure issue and retains manual locks/history',async()=>{
 subject(1);run('INSERT INTO series_entities(key,title,title_state,title_confirmed_at,created_at,updated_at) VALUES(\'manual_fk\',\'Locked title\',\'manual\',:t,:t,:t)',{t:T});unchecked(()=>orphanCollection(900));
 const before={sources:captureProtectedSources(),entities:all('SELECT * FROM series_entities'),events:all('SELECT * FROM entity_events'),version:dataVersion()};const a=await app();try{const r=await a.inject({method:'POST',url:'/api/diagnostics/repairs',payload:{issueId:ID,kind:'recompute-derived'}});expect(r.statusCode).toBe(400);expect(r.json().error.code).toBe('repair_not_allowed');expect(r.json().ok).toBeUndefined();expect({sources:captureProtectedSources(),entities:all('SELECT * FROM series_entities'),events:all('SELECT * FROM entity_events'),version:dataVersion()}).toEqual(before);}finally{await a.close();}
});
it('Recheck: reliable external correction resolves only the missing parent without automatic deletion',()=>{
 unchecked(()=>orphanCollection(901));expect(issue()).toBeDefined();const child=all('SELECT * FROM collections');subject(901,'Recovered from independent reliable fixture source');expect(issue()).toBeUndefined();expect(all('SELECT * FROM collections')).toEqual(child);expect(getDiagnosticsReport({refresh:true}).modules.find(x=>x.id==='storage')!.foreignKeys!.violationCount).toBe(0);
});
it('Privacy: Visible and metric Real protect row identities; explicit full evidence retains exact positions',async()=>{
 unchecked(()=>orphanCollection(901));saveConfig({hideNsfw:true});const a=await app();try{for(const q of ['', '?visibility=real']){const r=await a.inject('/api/diagnostics'+q);expect(r.statusCode).toBe(200);const c=r.json().issues.find((x:any)=>x.id===ID).foreignKeys;expect(c.violationCount).toBe(1);expect(c.samples[0].table).toBe('collections');expect(c.samples[0].rowid).toBeNull();expect(c.samples[0].identityProtected).toBe(true);expect(r.body).not.toContain('private comment');}const r=await a.inject({url:'/api/diagnostics?evidence=real',headers:{'X-Analyzer-Evidence':'real'}});const s=r.json().issues.find((x:any)=>x.id===ID).foreignKeys.samples[0];expect(s.rowid).toBe('901');expect(s.identityProtected).toBe(false);}finally{await a.close();}
});
it('Incomplete: malformed declaration cannot become an empty successful structural scan',()=>{
 exec('CREATE TABLE malformed_parent(code TEXT)');exec('CREATE TABLE malformed_child(ref TEXT REFERENCES malformed_parent(code))');expect(()=>getDiagnosticsReport({refresh:true})).toThrow('已声明外键检查未完成');expect(getDatabase().isTransaction).toBe(false);
});
it('Privacy: arbitrary imported schema names are not treated as public provenance',async()=>{
 exec('CREATE TABLE "PRIVATE_SCHEMA_秘密"(id INTEGER PRIMARY KEY, "PRIVATE_COLUMN_秘密" INTEGER REFERENCES subjects(id))');unchecked(()=>run('INSERT INTO "PRIVATE_SCHEMA_秘密" VALUES(1,987654)'));saveConfig({hideNsfw:true});const a=await app();try{
  const r=await a.inject('/api/diagnostics');expect(r.statusCode).toBe(200);expect(r.body).not.toContain('PRIVATE_SCHEMA');expect(r.body).not.toContain('PRIVATE_COLUMN');const c=r.json().issues.find((x:any)=>x.id===ID).foreignKeys;expect(c.violationCount).toBe(1);expect(c.groups[0].schemaProtected).toBe(true);expect(c.groups[0].table).toBeNull();
  const full=await a.inject({url:'/api/diagnostics?evidence=real',headers:{'X-Analyzer-Evidence':'real'}});expect(full.body).toContain('PRIVATE_SCHEMA');expect(full.body).toContain('PRIVATE_COLUMN');
 }finally{await a.close();}
});
it('Readonly: disabled enforcement is reported without enabling it, and a mid-stream failure never returns complete',()=>{
 exec('PRAGMA foreign_keys=OFF');try {const r=getDiagnosticsReport({refresh:true});expect(r.modules.find(x=>x.id==='storage')!.foreignKeys!.foreignKeysEnabled).toBe(false);expect(one<{foreign_keys:number}>('PRAGMA foreign_keys')!.foreign_keys).toBe(0);}finally{exec('PRAGMA foreign_keys=ON');}
 unchecked(()=>orphanCollection(901));const db=getDatabase();const original=db.prepare.bind(db);vi.spyOn(db,'prepare').mockImplementation(((sql:string)=>sql==='PRAGMA foreign_key_check'?{setReadBigInts:()=>{},iterate:function*(){yield {table:'collections',parent:'subjects',fkid:0n,rowid:901n};throw Error('PRIVATE_INTERRUPTION');}}:original(sql)) as any);
 expect(()=>getDiagnosticsReport({refresh:true})).toThrow('已声明外键检查未完成');expect(db.isTransaction).toBe(false);
});
it('Coverage: sqliteX user tables are included while genuine sqlite_ internals are excluded',()=>{
 subject(1);exec('CREATE TABLE sqliteX_user_reference(id INTEGER PRIMARY KEY,subject_id INTEGER REFERENCES subjects(id))');
 run('INSERT INTO sqliteX_user_reference VALUES(1,1)');
 const normal=getDiagnosticsReport({refresh:true}).modules.find(x=>x.id==='storage')!.foreignKeys!;
 expect(normal.tablesInspected).toBe(22);expect(normal.constraintCount).toBe(8);expect(normal.violationCount).toBe(0);
 unchecked(()=>run('INSERT INTO sqliteX_user_reference VALUES(2,9000)'));
 expect(issue()!.foreignKeys!.violationCount).toBe(1);
});
