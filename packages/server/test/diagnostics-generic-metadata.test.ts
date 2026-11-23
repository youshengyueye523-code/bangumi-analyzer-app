import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {all,run,setMeta,getDatabase,dataVersion,getMeta} from '../src/db/index.js';
import {recomputeSeries} from '../src/db/series.js';
import {saveConfig} from '../src/config.js';
import {getDiagnosticsReport,invalidateDiagnosticsReport} from '../src/diagnostics/report.js';
import {runDiagnosticsRepair} from '../src/diagnostics/repair.js';
import * as query from '../src/db/query.js';
import {resetDatabase} from './helpers.js';
const T='2026-11-08T08:00:00Z';let fired=0;
function seed(version=0){for(const id of [71,93]){run(`INSERT INTO subjects(id,type,name,detail_state,relations_state,created_at,updated_at) VALUES(?,2,?,'ok','ok',?,?)`,[id,`元数据${id}`,T,T]);run('INSERT INTO collections(subject_id,subject_type,type,first_seen_at,synced_at) VALUES(?,2,2,?,?)',[id,T,T]);}setMeta('collection_owner_uid','37');setMeta('data_version',String(version));recomputeSeries();run('UPDATE series_entities SET member_count=77 WHERE id=(SELECT MIN(id) FROM series_entities)');}
const snapshot=()=>all<{name:string}>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").map(t=>[t.name,all(`SELECT * FROM "${t.name}" ORDER BY rowid`)]);
function plan(){const i=getDiagnosticsReport({refresh:true}).issues.find(i=>i.id==='series.counter-drift')!;const a=i.actions.find(a=>a.kind==='repair')!;if(a.kind!=='repair')throw Error('missing plan');return {issueId:i.id,kind:a.repairKind,value:a.value};}
beforeEach(()=>{resetDatabase();saveConfig({hideNsfw:false});invalidateDiagnosticsReport();fired=0;getDatabase().function('metadata_fault_seen',()=>{fired++;return 1;});});
afterEach(()=>{getDatabase().exec('DROP TRIGGER IF EXISTS metadata_fault');vi.restoreAllMocks();});
it.each([0,17])('one legal global repair advances exactly one generation from %i',version=>{seed(version);expect(runDiagnosticsRepair(plan()).ok).toBe(true);expect(dataVersion()).toBe(version+1);expect(getMeta('last_mutation_scope')).toBe('repair');expect(getMeta('last_mutation_detail')).toBe('recompute-derived');});
it.each(['engine-version','scope','at','detail','version-after-mutation'] as const)('indirect %s mutation is reached, rejected and entirely rolled back',fault=>{
  seed();const body=fault==='engine-version'?"UPDATE meta SET value=CAST(value AS INTEGER)+100 WHERE key='data_version'"
    :`UPDATE meta SET value='${fault==='version-after-mutation'?'901':'forged'}' WHERE key='${fault==='scope'?'last_mutation_scope':fault==='at'?'last_mutation_at':fault==='detail'?'last_mutation_detail':'data_version'}'`;
  const on=fault==='engine-version'?'AFTER UPDATE ON series_entities':"AFTER INSERT ON meta WHEN NEW.key='last_mutation_detail'";
  getDatabase().exec(`CREATE TRIGGER metadata_fault ${on} BEGIN SELECT metadata_fault_seen(); ${body}; END`);
  const p=plan(),before=snapshot();expect(()=>runDiagnosticsRepair(p)).toThrow(/允许写集/);expect(fired).toBeGreaterThan(0);expect(snapshot()).toEqual(before);expect(dataVersion()).toBe(0);
  getDatabase().exec('DROP TRIGGER metadata_fault');expect(runDiagnosticsRepair(plan()).ok).toBe(true);expect(dataVersion()).toBe(1);
});
it.each(['data_version','last_mutation_scope','last_mutation_at','last_mutation_detail'])('Verify-side %s side effect cannot commit',key=>{seed();const original=query.getSeriesDetail;vi.spyOn(query,'getSeriesDetail').mockImplementation((...args)=>{setMeta(key,'999');return original(...args);});const p=plan(),before=snapshot();expect(()=>runDiagnosticsRepair(p)).toThrow(/允许写集/);expect(snapshot()).toEqual(before);});
it('ordinary consumer false remains partial, with exactly one authorized mutation',()=>{seed();vi.spyOn(query,'getSeriesDetail').mockReturnValue(null);const r=runDiagnosticsRepair(plan());expect(r.ok).toBe(false);expect(r.verification.partial).toBe(true);expect(dataVersion()).toBe(1);});
