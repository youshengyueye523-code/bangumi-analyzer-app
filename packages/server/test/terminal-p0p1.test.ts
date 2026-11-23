import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@bangumi-analyzer/shared';
import { saveConfig } from '../src/config.js';
import { all, closeDatabase, dataVersion, getDatabase, getMeta, one, run } from '../src/db/index.js';
import { recomputeSeries } from '../src/db/series.js';
import { runFranchiseGovernance } from '../src/diagnostics/franchiseGovernance.js';
import { runDiagnosticsRepair } from '../src/diagnostics/repair.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { captureProtectedSources } from '../src/diagnostics/sourceProtection.js';
import { SYNC_FAILURE_EXPLANATIONS as COPY } from '../src/sync/failureExplanation.js';
import { SyncEngine } from '../src/sync/engine.js';
import { ProgressTracker } from '../src/sync/progress.js';
import { buildApp } from '../src/app.js';
import { CoverCache } from '../src/images/coverCache.js';
import { FakeBangumiClient, makeCollectionItem, resetDatabase, testConfig } from './helpers.js';

const TS = '2026-11-08T00:00:00.000Z';
beforeEach(() => { resetDatabase(); saveConfig({ hideNsfw: false, cacheCovers: false, summaryAutoTranslate: false }); invalidateDiagnosticsReport(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const t of all<{name:string}>("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'terminal_%'")) {
    getDatabase().exec(`DROP TRIGGER "${t.name}"`);
  }
  invalidateDiagnosticsReport();
});
function seed() {
  for (const id of [1, 2]) {
    run("INSERT INTO subjects(id,type,name,name_cn,summary,detail_state,relations_state,created_at,updated_at) VALUES(?,2,?,?,'original','ok','ok',?,?)", [id,`Member ${id}`,`Member ${id}`,TS,TS]);
    run('INSERT INTO collections(subject_id,subject_type,type,rate,first_seen_at,synced_at) VALUES(?,2,2,7,?,?)', [id,TS,TS]);
  }
  run("INSERT INTO subject_relations(subject_id,related_id,relation,type,name,created_at) VALUES(1,2,'不同演绎',2,'Member 2',?)", [TS]);
  run("INSERT INTO subject_staff(subject_id,name,relation,source) VALUES(1,'Artist','导演','infobox')");
  recomputeSeries();
  return one<{id:number;key:string}>("SELECT id,key FROM franchise_entities WHERE state<>'stale'")!;
}
function snapshot() {
  return all<{name:string}>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .map(({name}) => [name, all(`SELECT * FROM "${name}" ORDER BY rowid`)]);
}
const adopt = (key:string) => ({kind:'adopt-franchise-title' as const,franchiseKey:key,title:'Terminal manual',reason:'local fixture'});

it.each([
  "UPDATE subjects SET summary='corrupt' WHERE id=1",
  "UPDATE subjects SET summary=CAST(summary AS BLOB) WHERE id=1",
  "UPDATE collections SET comment='corrupt' WHERE subject_id=1",
  "UPDATE subject_relations SET name='corrupt' WHERE subject_id=1",
  "DELETE FROM subject_staff WHERE subject_id=1",
])('P0 sources: reached indirect mutation rolls back all tables, history, version: %s', (sql) => {
  const f=seed(),db=getDatabase();let reached=0;
  db.function('terminal_reached',()=>{reached++;return 1;});
  db.exec(`CREATE TRIGGER terminal_source AFTER UPDATE OF title ON franchise_entities WHEN NEW.title='Terminal manual'
    BEGIN SELECT terminal_reached(); ${sql}; END`);
  const before=snapshot(),source=captureProtectedSources(),v=dataVersion();
  expect(()=>runFranchiseGovernance(adopt(f.key))).toThrowError(expect.objectContaining({code:'protected_source_write_violation',status:409,dataIntact:true}));
  expect(reached).toBeGreaterThan(0);expect(snapshot()).toEqual(before);expect(captureProtectedSources()).toEqual(source);
  expect(dataVersion()).toBe(v);expect(db.isTransaction).toBe(false);
  // A normal cached read must observe the rolled-back state, not a report from failed Verify.
  expect(getDiagnosticsReport().dataVersion).toBe(v);
  db.exec('DROP TRIGGER terminal_source');
  expect(runFranchiseGovernance(adopt(f.key)).verification.verified).toBe(true);
  expect(dataVersion()).toBe(v+1);expect(captureProtectedSources()).toEqual(source);
});

it('P0 second shared entry: confirm-franchise cannot commit a source side effect', () => {
  const f=seed(),db=getDatabase();let reached=0;
  db.function('terminal_reached',()=>{reached++;return 1;});
  const issue=getDiagnosticsReport({refresh:true}).issues.find(i=>i.actions.some(a=>a.kind==='repair'&&a.repairKind==='confirm-franchise'))!;
  const action=issue.actions.find(a=>a.kind==='repair'&&a.repairKind==='confirm-franchise')!;
  db.exec("CREATE TRIGGER terminal_source AFTER UPDATE OF state ON franchise_entities BEGIN SELECT terminal_reached(); UPDATE collections SET comment='corrupt' WHERE subject_id=1; END");
  const before=snapshot();
  expect(()=>runDiagnosticsRepair({issueId:issue.id,kind:'confirm-franchise',target:'target' in action?action.target:f.key}))
    .toThrowError(expect.objectContaining({code:'protected_source_write_violation'}));
  expect(reached).toBeGreaterThan(0);expect(snapshot()).toEqual(before);expect(db.isTransaction).toBe(false);
});

it('P0 ordinary non-source Verify mismatch stays partial and legally commits', () => {
  const f=seed();getDatabase().exec(`CREATE TRIGGER terminal_candidate AFTER UPDATE OF title ON franchise_entities
    WHEN NEW.title='Terminal manual' BEGIN UPDATE franchise_entities SET title_candidates='[]' WHERE id=NEW.id; END`);
  const source=captureProtectedSources(),v=dataVersion();
  const result=runFranchiseGovernance(adopt(f.key));
  expect(result.verification.partial).toBe(true);expect(result.verification.verified).toBe(false);
  expect(dataVersion()).toBe(v+1);expect(captureProtectedSources()).toEqual(source);
});

it('P0 real TCP: default privacy HTTP409 matches rollback; no partial-success DTO', async () => {
  const f=seed();saveConfig({hideNsfw:true});
  const client=new FakeBangumiClient(),engine=new SyncEngine({client,getConfig:()=>testConfig()});
  const app=await buildApp({deps:{client,engine,coverCache:new CoverCache(client)},logger:false});
  let reached=0;getDatabase().function('terminal_reached',()=>{reached++;return 1;});
  getDatabase().exec("CREATE TRIGGER terminal_source AFTER UPDATE OF title ON franchise_entities WHEN NEW.title='Terminal manual' BEGIN SELECT terminal_reached(); UPDATE subjects SET summary='corrupt' WHERE id=1; END");
  const before=snapshot();
  try {
    const url=await app.listen({host:'127.0.0.1',port:0});expect(url).not.toContain(':8787');
    const res=await fetch(url+`/api/franchises/${f.key}/governance`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(adopt(f.key))});
    const body=await res.json();expect(res.status).toBe(409);expect(body.error).toMatchObject({code:'protected_source_write_violation',dataIntact:true});
    expect(body.error.message).toContain('已回滚');expect(body.verification).toBeUndefined();
    expect(reached).toBeGreaterThan(0);expect(snapshot()).toEqual(before);
  } finally {await app.close();}
});

async function failedSync(stage:'before'|'after'|'notify'|'pending'|'cancel') {
  let injected=false;let engine:SyncEngine;
  if (stage === 'notify') {
    const original = ProgressTracker.prototype.setMessage;
    vi.spyOn(ProgressTracker.prototype, 'setMessage').mockImplementation(function(message) {
      original.call(this, message);
      // Deterministically exercise the post-apply callback window, irrespective of throttling.
      this.emit(true);
    });
  }
  const client=new FakeBangumiClient({collections:[makeCollectionItem({subject_id:31})],...(stage==='before'?{pageErrors:{0:new Error('local page failure')}}:{})});
  engine=new SyncEngine({client,getConfig:()=>testConfig({subjectTypes:[2]}),onChange:p=>{
    const at=stage==='notify'?p.message.startsWith('收藏同步完成'):p.phase==='series';
    if(stage!=='before'&&at&&!injected){injected=true;
      if(stage==='cancel'){engine.cancel();return;}
      if(stage==='pending')getDatabase().exec("CREATE TRIGGER terminal_recovery BEFORE INSERT ON series_entities BEGIN SELECT RAISE(ABORT,'local recovery failure'); END");
      throw new Error('local post-apply failure');
    }
  }});
  engine.start({mode:'incremental',depth:1});await engine.whenIdle();
  if(stage!=='before')expect(injected).toBe(true);
  return {engine,client,last:engine.getStatus().lastRun!,source:one('SELECT subject_id FROM collections WHERE subject_id=31')};
}
it.each(['before','after','notify','pending','cancel'] as const)('P1 persisted local outcome: %s',async(stage)=>{
  const {last,source}=await failedSync(stage);
  expect(last.status).toBe(stage==='cancel'?'cancelled':'error');
  const expected=stage==='before'?COPY.beforeApply:stage==='pending'?COPY.afterApplyPending:COPY.afterApplyRestored;
  expect(last.warnings).toContain(expected);expect(Boolean(source)).toBe(stage!=='before');
  if(stage==='pending')expect(getMeta('sync_projection_pending')).toBe('1');
  if(stage!=='before'&&stage!=='pending')expect(getMeta('sync_projection_pending')).toBe('0');
  // Reopen the synthetic database: explanation must not depend on an in-memory engine flag.
  closeDatabase();invalidateDiagnosticsReport();
  const issue=getDiagnosticsReport({refresh:true}).issues.find(i=>i.id==='sync.last-failed');
  if(stage==='cancel')expect(issue).toBeUndefined();
  else expect(issue!.explanation).toBe(expected);
});

it.each(['[]','null','not-json',JSON.stringify([COPY.beforeApply,COPY.afterApplyRestored])])('P1 legacy/ambiguous warnings are Unknown: %s', warnings=>{
  run("INSERT INTO sync_runs(mode,depth,status,phase,started_at,finished_at,warnings) VALUES('incremental',1,'error','error',?,?,?)",[TS,TS,warnings]);
  expect(getDiagnosticsReport({refresh:true}).issues.find(i=>i.id==='sync.last-failed')!.explanation).toBe(COPY.unknown);
});

it.each(['before','after','pending'] as const)('P1 real TCP privacy projection preserves finite outcome and never false unchanged: %s',async(stage)=>{
  const {engine,client}=await failedSync(stage);saveConfig({hideNsfw:true});
  const app=await buildApp({deps:{client,engine,coverCache:new CoverCache(client)},logger:false});
  try {
    const url=await app.listen({host:'127.0.0.1',port:0});
    const res=await fetch(url+'/api/diagnostics?refresh=1'),body=await res.json();expect(res.status).toBe(200);
    const issue=body.issues.find((i:{id:string})=>i.id==='sync.last-failed');
    expect(issue.explanation).toBe(stage==='before'?COPY.beforeApply:stage==='pending'?COPY.afterApplyPending:COPY.afterApplyRestored);
    expect(JSON.stringify(issue)).not.toContain('本地数据保持上一次成功同步的状态');
    expect(issue.impact[0].label).not.toContain('尚未进入本地库');
    expect(body.presentation.privacyApplied).toBe(true);
  }finally{await app.close();}
});
