import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {all,one,run,getDatabase,dataVersion,setMeta} from '../src/db/index.js';
import {saveConfig} from '../src/config.js';
import {recomputeSeries,confirmFranchise,captureEntityEventWrites,insertEvent} from '../src/db/series.js';
import {getDiagnosticsReport,invalidateDiagnosticsReport} from '../src/diagnostics/report.js';
import {runDiagnosticsRepair} from '../src/diagnostics/repair.js';
import {genericEventsPreserved} from '../src/diagnostics/genericPlan.js';
import {resetDatabase} from './helpers.js';
import * as query from '../src/db/query.js';
const TS='2026-11-08T03:00:00Z';
function seed(){
  for(const id of [81,99]){
    run(`INSERT INTO subjects(id,name,name_cn,type,detail_state,relations_state,created_at,updated_at) VALUES(?,?,?,2,'ok','ok',?,?)`,[id,`安全${id}`,`安全${id}`,TS,TS]);
    run('INSERT INTO collections(subject_id,subject_type,type,rate,first_seen_at,synced_at) VALUES(?,2,2,7,?,?)',[id,TS,TS]);
  }
  run(`INSERT INTO subject_relations(subject_id,related_id,relation,type,created_at) VALUES(81,99,'不同演绎',2,?)`,[TS]);
  setMeta('collection_owner_uid','37');recomputeSeries();
  const f=one<{id:number;key:string}>('SELECT id,key FROM franchise_entities')!;expect(confirmFranchise(f.key)).toBe(true);
  run('UPDATE series_entities SET member_count=90 WHERE id=(SELECT MIN(id) FROM series_entities)');return f;
}
const snapshot=()=>all<{name:string}>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .map(({name})=>[name,all(`SELECT * FROM "${name}" ORDER BY rowid`)]);
function plan(){const i=getDiagnosticsReport({refresh:true}).issues.find(i=>i.id==='series.counter-drift')!;const a=i.actions.find(a=>a.kind==='repair')!;if(a.kind!=='repair')throw Error('no plan');return {issueId:i.id,kind:a.repairKind,value:a.value};}
beforeEach(()=>{resetDatabase();saveConfig({hideNsfw:false});invalidateDiagnosticsReport();});
afterEach(()=>{getDatabase().exec('DROP TRIGGER IF EXISTS safety_fault');vi.restoreAllMocks();});
it.each(['state','member','history','manual','system-extra','manual-reopen','unknown'] as const)('D safety %s: rejects indirect writes and rolls back everything',fault=>{
  const f=seed();
  const payload=fault==='manual-reopen'?'"trigger":"manual"':'';
  const sql=fault==='state'?`UPDATE franchise_entities SET state='candidate' WHERE id=${f.id}`
    :fault==='member'?`UPDATE franchise_series SET state='candidate' WHERE franchise_id=${f.id}`
    :fault==='history'?"UPDATE entity_events SET payload='{}' WHERE kind='confirmed'"
    :`INSERT INTO entity_events(entity_kind,entity_id,kind,payload,created_at) VALUES('franchise',${f.id},'${fault==='manual'?'title_manual':fault==='system-extra'?'created':fault==='unknown'?'future-unknown':'candidate_reopened'}','{${payload}}','${TS}')`;
  getDatabase().exec(`CREATE TRIGGER safety_fault AFTER UPDATE ON franchise_entities WHEN NEW.id=${f.id} BEGIN ${sql}; END`);
  const p=plan(),before=snapshot(),v=dataVersion();
  expect(()=>runDiagnosticsRepair(p)).toThrow(/允许写集/);expect(snapshot()).toEqual(before);expect(dataVersion()).toBe(v);
  getDatabase().exec('DROP TRIGGER safety_fault');expect(runDiagnosticsRepair(plan()).ok).toBe(true);
});
it('D valid execution, explicit governance outside audit, token replay and stale rejection',()=>{
  const f=seed(),p=plan();
  expect(()=>runDiagnosticsRepair({...p,value:undefined})).toThrow(/预览已失效/);
  expect(runDiagnosticsRepair(p).ok).toBe(true);expect(one<{state:string}>('SELECT state FROM franchise_entities WHERE id=?',[f.id])!.state).toBe('confirmed');
  const before=snapshot();expect(()=>runDiagnosticsRepair(p)).toThrow();expect(snapshot()).toEqual(before);
});
it('D event audit observes exact writer intent, not DB tail manufactured by triggers',()=>{
  const f=seed(),watermark=String(one<{n:number}>('SELECT MAX(id) AS n FROM entity_events')!.n);
  const audit=captureEntityEventWrites(()=>insertEvent('franchise',f.id,'conflict_resolved',{key:f.key},TS));
  expect(genericEventsPreserved(audit.events,watermark)).toBe(true);
  run('UPDATE entity_events SET payload=? WHERE id=?',['{"key":"forged"}',audit.events[0]!.id]);expect(genericEventsPreserved(audit.events,watermark)).toBe(false);
});
it('D rejects human event even through the central writer; scope cleans up on throw',()=>{
  const f=seed(),watermark=String(one<{n:number}>('SELECT MAX(id) AS n FROM entity_events')!.n);
  const audit=captureEntityEventWrites(()=>insertEvent('franchise',f.id,'candidate_reopened',{trigger:'manual'},TS));
  expect(genericEventsPreserved(audit.events,watermark)).toBe(false);
  expect(()=>captureEntityEventWrites(()=>{throw Error('scope fault');})).toThrow('scope fault');
  expect(captureEntityEventWrites(()=>0).events).toEqual([]);
});
it('D catches Verify-side protected mutation and rolls back; ordinary consumer failure remains partial',()=>{
  seed();const original=query.getSeriesDetail;
  vi.spyOn(query,'getSeriesDetail').mockImplementation((...args)=>{setMeta('forbidden-verify','1');return original(...args);});
  const p=plan(),before=snapshot();expect(()=>runDiagnosticsRepair(p)).toThrow(/允许写集/);expect(snapshot()).toEqual(before);
  vi.restoreAllMocks();vi.spyOn(query,'getSeriesDetail').mockReturnValue(null);const r=runDiagnosticsRepair(plan());expect(r.ok).toBe(false);expect(r.verification.partial).toBe(true);
});
