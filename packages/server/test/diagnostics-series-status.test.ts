import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { all, dataVersion, exec, getDatabase, one, run, transaction } from '../src/db/index.js';
import { saveConfig } from '../src/config.js';
import { getSeriesDetail, listSeries } from '../src/db/query.js';
import { recordMutation } from '../src/db/mutation.js';
import { recomputeSeries } from '../src/db/series.js';
import { inspectSeriesCollectionStatus, STATUS_DRIFT, STATUS_UNASSESSABLE } from '../src/db/seriesCollectionStatus.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { runDiagnosticsRepair } from '../src/diagnostics/repair.js';
import * as reads from '../src/db/query.js';
import { captureProtectedSources } from '../src/diagnostics/sourceProtection.js';
import { buildApp } from '../src/app.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';

const T = '2026-11-07T00:00:00.000Z';
function subject(id: number, type: number | null = 2, hidden = false) {
  run(`INSERT INTO subjects(id,name,name_cn,nsfw,raw,detail_state,relations_state,created_at,updated_at)
    VALUES(:id,:name,:name,:nsfw,:raw,'ok','ok',:t,:t)`, {id, name: `PRIVATE_STATUS_${id}`, nsfw: hidden ? 1 : 0, raw: '{"type":2,"generation":"older"}', t:T});
  if (type !== null) run(`INSERT INTO collections(subject_id,type,rate,raw,first_seen_at,synced_at)
    VALUES(:id,:type,8,:raw,:t,:t)`, {id,type,raw:'{"type":1,"generation":"older"}',t:T});
}
function fixture() {
  subject(1,2); subject(2,1);
  run(`INSERT INTO subject_relations(subject_id,related_id,relation,type,name,created_at) VALUES(1,2,'续集',2,'second',:t)`, {t:T});
  recomputeSeries();
  return listSeries({includeSingletons:true}).find(s=>s.memberCount===2)!.key;
}
function corrupt(key: string) { run(`UPDATE series_entities SET status_counts='{"2":2}' WHERE key=:key`, {key}); invalidateDiagnosticsReport(); }
function request(key: string) {
  const report = getDiagnosticsReport({refresh:true});
  const a=report.issues.find(i=>i.id===STATUS_DRIFT)!.actions.find(a=>a.kind==='repair' && a.target===key)!;
  if (a.kind!=='repair') throw Error('missing plan');
  return {issueId:STATUS_DRIFT,kind:a.repairKind,target:a.target!,value:a.value!};
}
function governance() {
  return ['series_entity_members','candidate_decisions','entity_events','franchise_member_exclusions','franchise_series'].map(t=>all(`SELECT * FROM ${t} ORDER BY rowid`));
}
beforeEach(()=>{resetDatabase();saveConfig({hideNsfw:false});invalidateDiagnosticsReport();});
afterEach(()=>{vi.restoreAllMocks();exec('PRAGMA user_version=15');invalidateDiagnosticsReport();});

it('SC01 normal engine output and older raw snapshots are legitimate local facts',()=>{
  fixture(); expect(inspectSeriesCollectionStatus()).toMatchObject({seriesScanned:1,membersScanned:2,driftCount:0,blockedCount:0});
});
it('SC02 same-total wrong distribution reaches list/detail and is now detected',()=>{
  const key=fixture();corrupt(key);
  expect(listSeries()[0]!.statusCounts).toEqual({'2':2});
  expect(getSeriesDetail(key)!.watch).toMatchObject({wish:1,watched:1});
  const issue=getDiagnosticsReport({refresh:true}).issues.find(i=>i.id===STATUS_DRIFT)!;
  expect(issue.affectedCount).toBe(1);expect(issue.actions[0]).toMatchObject({target:key,preview:{next:'{"1":1,"2":1}'}});
  expect(issue.evidence[1]!.value).toContain('当前');
  expect(JSON.stringify(issue.evidence)).not.toContain('older'); // raw is deliberately not copied.
});
it('SC03 order, whitespace and explicit zero bins are equivalent, not drift',()=>{
  fixture();run(`UPDATE series_entities SET status_counts=' { "5":0, "2":1, "1":1 } '`);
  expect(inspectSeriesCollectionStatus().driftCount).toBe(0);
});
it('SC04 uncollected, relation-only and candidate-only members do not become wish or watched',()=>{
  const key=fixture();subject(3,null);subject(4,3);
  const id=one<{id:number}>('SELECT id FROM series_entities WHERE key=:key',{key})!.id;
  for(const [subjectId,role] of [[3,'primary'],[999,'primary'],[4,'candidate']] as const)run(`INSERT INTO series_entity_members(series_id,subject_id,role,state) VALUES(:id,:subjectId,:role,'probable')`,{id,subjectId,role});
  expect(inspectSeriesCollectionStatus()).toMatchObject({driftCount:0,blockedCount:0,membersScanned:4});
});
it('SC05 source transition without graph recompute creates drift; proper engine recompute converges',()=>{
  fixture();run('UPDATE collections SET type=3,updated_at=:t WHERE subject_id=1',{t:'2026-11-07T01:00:00Z'});recordMutation('sync','synthetic-only');
  expect(getDiagnosticsReport().issues.some(i=>i.id===STATUS_DRIFT)).toBe(true);
  recomputeSeries();invalidateDiagnosticsReport();expect(inspectSeriesCollectionStatus().driftCount).toBe(0);
});
it('SC06 source-driven target repair preserves every source, governance, manual title and history',()=>{
  const key=fixture();run(`UPDATE series_entities SET title='Manual status title',title_state='manual',title_source='manual' WHERE key=:key`,{key});corrupt(key);
  const id=one<{id:number}>('SELECT id FROM series_entities WHERE key=:key',{key})!.id;
  run(`INSERT INTO candidate_decisions(entity_kind,entity_id,candidate_kind,candidate_key,candidate_title,decision,reason,evidence,created_at,updated_at)
    VALUES('series',:id,'title','rejected-name','Rejected name','rejected','human reason','{"original":"decision evidence"}',:t,:t)`,{id,t:T});
  run(`INSERT INTO entity_events(entity_kind,entity_id,kind,payload,created_at) VALUES('series',:id,'title_confirmed','{"actor":"user","original":"history"}',:t)`,{id,t:T});
  run(`INSERT INTO franchise_member_exclusions(franchise_id,series_id,state,reason,evidence,created_at)
    VALUES(80,:id,'active','historical human exclusion','{"original":"membership evidence"}',:t)`,{id,t:T});
  run("INSERT INTO subject_staff(subject_id,name,relation,source) VALUES(1,'Original staff','监督','infobox')");
  const before=captureProtectedSources(), gov=governance(), entities=all('SELECT * FROM series_entities'), version=dataVersion();
  const req=request(key), result=runDiagnosticsRepair(req);
  expect(result.ok).toBe(true);expect(result.verification.checks.some(c=>c.layer==='api' && c.ok)).toBe(true);
  expect(dataVersion()).toBe(version+1);expect(captureProtectedSources()).toEqual(before);expect(governance()).toEqual(gov);
  const after=all<any>('SELECT * FROM series_entities');expect(after.map(r=>({...r,status_counts:null}))).toEqual(entities.map(r=>({...r,status_counts:null})));
  expect(listSeries()[0]!.statusCounts).toEqual({'1':1,'2':1});expect(inspectSeriesCollectionStatus().driftCount).toBe(0);
});
it('SC07 illegal source has honest needs-review and rejects even forced generic Repair',()=>{
  fixture();run('UPDATE collections SET type=99 WHERE subject_id=1');
  const r=getDiagnosticsReport({refresh:true}), i=r.issues.find(i=>i.id===STATUS_UNASSESSABLE)!;
  expect(i.actions).toEqual([]);expect(i.affectedCount).toBe(1);expect(r.modules.find(m=>m.id==='series')!.status).not.toBe('ok');
  const source=captureProtectedSources();expect(()=>runDiagnosticsRepair({issueId:STATUS_UNASSESSABLE,kind:'recompute-derived'})).toThrow('不支持');expect(captureProtectedSources()).toEqual(source);
});
it('SC08 conflicting primary membership blocks deterministic repair; stale duplicates do not',()=>{
  const key=fixture();run(`INSERT INTO series_entities(id,key,title,state,created_at,updated_at) VALUES(90,'sr_other','Other','provisional',:t,:t)`,{t:T});
  run(`INSERT INTO series_entity_members(series_id,subject_id,role) VALUES(90,1,'primary')`);
  expect(inspectSeriesCollectionStatus()).toMatchObject({blockedCount:2,driftCount:0});
  run(`UPDATE series_entities SET state='stale' WHERE id=90`);expect(inspectSeriesCollectionStatus()).toMatchObject({blockedCount:0,driftCount:0});expect(key).toBeTruthy();
});
it.each(['source','projection','version','membership'] as const)('SC09 stale %s preview cannot execute',field=>{
  const key=fixture();corrupt(key);const req=request(key),before=dataVersion();
  if(field==='source')run('UPDATE collections SET type=4 WHERE subject_id=1');
  if(field==='projection')run(`UPDATE series_entities SET status_counts='{"3":2}'`);
  if(field==='version')recordMutation('governance','synthetic-only');
  if(field==='membership')run("UPDATE series_entity_members SET reason_code='synthetic-change' WHERE subject_id=1");
  // Member state is governance evidence too: any plan-relevant edit must invalidate.
  const snapshot=all('SELECT * FROM series_entities');
  expect(()=>runDiagnosticsRepair(req)).toThrow();expect(all('SELECT * FROM series_entities')).toEqual(snapshot);
  expect(dataVersion()).toBe(before+(field==='version'?1:0));
});
it('SC10 unknown Schema and interrupted iteration fail closed and preserve outer transaction',()=>{
  fixture();exec('PRAGMA user_version=16');expect(()=>inspectSeriesCollectionStatus()).toThrow('对账未完成');exec('PRAGMA user_version=15');
  const db=getDatabase(), original=db.prepare.bind(db);exec('BEGIN');
  vi.spyOn(db,'prepare').mockImplementation(((sql:string)=>sql.includes('WITH duplicate_primary')?{setReadBigInts:()=>{},iterate:function*(){throw Error('INTERRUPTED');}}:original(sql)) as any);
  expect(()=>inspectSeriesCollectionStatus()).toThrow('对账未完成');expect(db.isTransaction).toBe(true);vi.restoreAllMocks();exec('ROLLBACK');
  expect(inspectSeriesCollectionStatus().driftCount).toBe(0);
});
it('SC11 failed consumer Verify is partial, not successful solely because detector cleared',()=>{
  const key=fixture();corrupt(key);const req=request(key);
  vi.spyOn(reads,'getSeriesDetail').mockReturnValue(null);
  const result=runDiagnosticsRepair(req);expect(result.ok).toBe(false);expect(result.verification.partial).toBe(true);expect(result.verification.checks.some(c=>c.layer==='api'&&!c.ok)).toBe(true);
});
it('SC12 thrown Verify rolls back writes and version, then fresh retry succeeds',()=>{
  const key=fixture();corrupt(key);const req=request(key),before=all('SELECT * FROM series_entities'),version=dataVersion();
  vi.spyOn(reads,'getSeriesDetail').mockImplementation(()=>{throw Error('VERIFY_FAULT');});
  expect(()=>runDiagnosticsRepair(req)).toThrow();expect(all('SELECT * FROM series_entities')).toEqual(before);expect(dataVersion()).toBe(version);
  vi.restoreAllMocks();expect(runDiagnosticsRepair(request(key)).ok).toBe(true);
});
it('SC13 aggregate target A can verify while B remains; every action has exact bound target',()=>{
  subject(1,2);subject(2,1);recomputeSeries();run(`UPDATE series_entities SET status_counts='{}'`);
  const keys=listSeries({includeSingletons:true}).map(s=>s.key);expect(keys).toHaveLength(2);
  expect(runDiagnosticsRepair(request(keys[0]!)).ok).toBe(true);expect(inspectSeriesCollectionStatus().driftCount).toBe(1);
});
it('SC14 malformed JSON, same count wrong bins and unknown keys are not tolerated by fallback',()=>{
  fixture();for(const value of ['{','[]','null','{"1":2}','{"1":1,"2":1,"unknown":0}','{"1":1,"2":1.5}']){
    run('UPDATE series_entities SET status_counts=:value',{value});expect(inspectSeriesCollectionStatus().driftCount).toBe(1);
  }
});
it('SC14b oversized status evidence is incomplete, never healthy or silently truncated',()=>{
  fixture();run('UPDATE series_entities SET status_counts=:value',{value:' '.repeat(4097)});
  expect(()=>getDiagnosticsReport({refresh:true})).toThrow('对账未完成');
});
it('SC14c non-text projection bytes are bound to the exact preview, not a shared placeholder',()=>{
  const key=fixture();run("UPDATE series_entities SET status_counts=x'7B7D'");const req=request(key);
  run("UPDATE series_entities SET status_counts=x'5B5D'");expect(()=>runDiagnosticsRepair(req)).toThrow();
  expect(runDiagnosticsRepair(request(key)).ok).toBe(true);
});
it('SC15 long tail is fully counted; samples/repair plans are bounded and a late target remains assessable',()=>{
  transaction(()=>{for(let id=1;id<=1500;id++){
    subject(id,2);run(`INSERT INTO series_entities(id,key,title,status_counts,member_count,collected_count,created_at,updated_at) VALUES(:id,:key,'Scale','{}',1,1,:t,:t)`,{id,key:`sr_scale_${id}`,t:T});
    run("INSERT INTO series_entity_members(series_id,subject_id,role) VALUES(:id,:id,'primary')",{id});
  }});
  const start=performance.now(),scan=inspectSeriesCollectionStatus();expect(scan).toMatchObject({seriesScanned:1500,membersScanned:1500,driftCount:1500});expect(scan.plans).toHaveLength(20);
  expect(inspectSeriesCollectionStatus('sr_scale_1500').plans[0]!.key).toBe('sr_scale_1500');
  expect(performance.now()-start).toBeLessThan(5000);
});
it('SC16 actual ephemeral TCP consumer: privacy, Real/Visible, stale refusal and repair lifecycle',async()=>{
  const key=fixture();run('UPDATE subjects SET nsfw=1 WHERE id=1');corrupt(key);saveConfig({hideNsfw:true});
  const client=new FakeBangumiClient(),app=await buildApp({deps:{client,engine:new SyncEngine({client,getConfig:()=>testConfig()}),coverCache:new CoverCache(client)},logger:false});
  try {
    const address=await app.listen({port:0,host:'127.0.0.1'});expect(new URL(address).port).not.toBe('8787');
    for(const suffix of ['', '&visibility=real','&mode=investigation']){
      const response=await fetch(address+'/api/diagnostics?refresh=1'+suffix),text=await response.text();expect(response.status).toBe(200);
      expect(text).toContain(STATUS_DRIFT);expect(text).not.toContain(key);expect(text).not.toContain('PRIVATE_STATUS_');
      const report=JSON.parse(text);expect(report.issues.find((i:any)=>i.id===STATUS_DRIFT).actions[0].preview.requiresRealEvidence).toBe(true);
    }
    const full=await fetch(address+'/api/diagnostics?evidence=real',{headers:{'X-Analyzer-Evidence':'real'}});const report:any=await full.json();
    const a=report.issues.find((i:any)=>i.id===STATUS_DRIFT).actions[0];expect(a.target).toBe(key);
    const body={issueId:STATUS_DRIFT,kind:a.repairKind,target:a.target,value:a.value};
    expect((await fetch(address+'/api/diagnostics?evidence=real')).status).toBe(403);
    const repaired=await fetch(address+'/api/diagnostics/repairs?evidence=real',{method:'POST',headers:{'Content-Type':'application/json','X-Analyzer-Evidence':'real'},body:JSON.stringify(body)});
    expect(repaired.status).toBe(200);expect((await repaired.json() as any).ok).toBe(true);
    expect(listSeries()).toEqual([]);saveConfig({hideNsfw:false});expect(listSeries()[0]!.statusCounts).toEqual({'1':1,'2':1});
    expect(captureProtectedSources().collections).toBeDefined();expect(client.calls).toEqual([]);
  } finally {await app.close();}
});
