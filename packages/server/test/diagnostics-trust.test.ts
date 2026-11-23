import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { all, one, run, transaction, dataVersion } from '../src/db/index.js';
import { saveConfig } from '../src/config.js';
import { recomputeSeries } from '../src/db/series.js';
import * as writes from '../src/db/franchiseGovernance.js';
import * as reads from '../src/db/query.js';
import { runFranchiseGovernance } from '../src/diagnostics/franchiseGovernance.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import * as reports from '../src/diagnostics/report.js';
import { DETECTORS } from '../src/diagnostics/detectors.js';
import { runDiagnosticsRepair } from './repairPreview.js';
import { captureProtectedSources, protectedSourcesCheck } from '../src/diagnostics/sourceProtection.js';
import { buildApp } from '../src/app.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';

const TS='2026-11-05T00:00:00.000Z';
function seed(id:number) {
  run(`INSERT INTO subjects(id,name,name_cn,detail_state,relations_state,created_at,updated_at)
    VALUES(:id,:title,:title,'ok','ok',:ts,:ts)`,{id,title:`Fixture ${id}`,ts:TS});
  run(`INSERT INTO collections(subject_id,type,rate,first_seen_at,synced_at) VALUES(:id,2,8,:ts,:ts)`,{id,ts:TS});
}
function entity(id:number) {
  run(`INSERT INTO series_entities(id,key,title,title_state,member_count,collected_count,created_at,updated_at)
    VALUES(:id,:key,:title,'provisional',1,1,:ts,:ts)`,{id,key:`sr_trust_${id}`,title:`Fixture ${id}`,ts:TS});
  run("INSERT INTO series_entity_members(series_id,subject_id,role,state) VALUES(:id,:id,'primary','probable')",{id});
  run('UPDATE subjects SET series_key=:key WHERE id=:id',{id,key:`sr_trust_${id}`});
}
function family() {
  seed(1);seed(2);
  for(const [a,b] of [[1,2],[2,1]])run(`INSERT INTO subject_relations(subject_id,related_id,relation,created_at) VALUES(:a,:b,'不同演绎',:ts)`,{a,b,ts:TS});
  run("INSERT INTO subject_staff(subject_id,name,relation,source) VALUES(1,'Artist','监督','infobox')");
  recomputeSeries();return one<{key:string}>('SELECT key FROM franchise_entities')!.key;
}
beforeEach(()=>{resetDatabase();saveConfig({hideNsfw:false});invalidateDiagnosticsReport();});
afterEach(()=>{vi.restoreAllMocks();invalidateDiagnosticsReport();});

it('B2: 205 provisional entities have exact count, not a 200-row scan',()=>{
  transaction(()=>{for(let i=1;i<=205;i++){seed(i);entity(i);}});
  expect(getDiagnosticsReport({refresh:true}).issues.find(x=>x.id==='titles.provisional')!.affectedCount).toBe(205);
});
it('B2: title anomalies beyond 800 and 500 are detected',()=>{
  transaction(()=>{for(let i=1;i<=805;i++){seed(i);entity(i);}});
  run("UPDATE series_entities SET title_candidates=:c",{c:JSON.stringify([{title:'Normal',valid:true}])});
  run("UPDATE series_entities SET title='Open(',title_candidates=:c WHERE id=805",{c:JSON.stringify([{title:'Open(',valid:true}])});
  const report=getDiagnosticsReport({refresh:true});
  expect(report.issues.find(x=>x.id==='titles.display-truncated')!.affectedCount).toBe(1);
  expect(report.issues.find(x=>x.id==='titles.candidate-structural')!.affectedCount).toBe(1);
});
it('B2: orphan and dead alias totals are not display sample sizes',()=>{
  for(let i=1;i<=25;i++){
    run(`INSERT INTO series_entities(key,title,created_at,updated_at) VALUES(:key,'Empty',:ts,:ts)`,{key:`sr_empty_${i}`,ts:TS});
    run(`INSERT INTO entity_aliases(alias_key,entity_kind,entity_id,created_at) VALUES(:key,'series',99999,:ts)`,{key:`old_${i}`,ts:TS});
  }
  const report=getDiagnosticsReport({refresh:true});
  for(const id of ['orphan.series','orphan.alias'])expect(report.issues.find(x=>x.id===id)!.affectedCount).toBe(25);
});
it('B2: visibility query validates later library pages, not only first 200',()=>{
  transaction(()=>{for(let i=1;i<=250;i++){seed(i);entity(i);} seed(999);run('UPDATE subjects SET nsfw=1 WHERE id=999');});
  saveConfig({hideNsfw:true});const original=reads.listSubjects;
  const spy=vi.spyOn(reads,'listSubjects').mockImplementation((query,options)=>{
    const result=original(query,options);
    return (query.page??1)>1 ? {...result,items:[...result.items,{...result.items[0]!,id:999}]} : result;
  });
  const report=getDiagnosticsReport({refresh:true});
  expect(report.issues.find(x=>x.id==='visibility.subject-leak')).toBeTruthy();
  expect(spy.mock.calls.some(([q])=>(q.page??1)>1)).toBe(true);
});

it.each([
  "UPDATE subjects SET summary='changed but same count' WHERE id=1",
  "UPDATE collections SET comment='changed but same count' WHERE subject_id=1",
  "UPDATE subject_relations SET name='changed but same count' WHERE subject_id=1",
  "UPDATE subject_staff SET name='changed but same count' WHERE subject_id=1",
])('B3: content-only source corruption is rejected by Verify: %s',(sql)=>{
  const key=family();const original=writes.adoptFranchiseTitle;
  vi.spyOn(writes,'adoptFranchiseTitle').mockImplementation((...args)=>{const result=original(...args);run(sql);return result;});
  const before=captureProtectedSources(),version=dataVersion();
  const history=all('SELECT * FROM entity_events ORDER BY id');
  expect(()=>runFranchiseGovernance({kind:'adopt-franchise-title',franchiseKey:key,title:'Manual family'}))
    .toThrow(/受保护来源边界/);
  expect(captureProtectedSources()).toEqual(before);
  expect(dataVersion()).toBe(version);
  expect(all('SELECT * FROM entity_events ORDER BY id')).toEqual(history);
});
it('B3: generic Repair also detects same-count original-content corruption',()=>{
  seed(1);recomputeSeries();run('UPDATE series_entities SET member_count=99');
  run(`CREATE TRIGGER corrupt_source AFTER UPDATE ON series_entities BEGIN
    UPDATE subjects SET raw='{"unexpected":"modified"}' WHERE id=1; END`);
    const before=all('SELECT * FROM subjects'),projection=all('SELECT * FROM series_entities');
    expect(()=>runDiagnosticsRepair({issueId:'series.counter-drift',kind:'recompute-derived'})).toThrow(/允许写集/);
    expect(all('SELECT * FROM subjects')).toEqual(before);expect(all('SELECT * FROM series_entities')).toEqual(projection);
});
it('B3: legal derived recompute and cover-marker repair still verify',()=>{
  seed(1);recomputeSeries();const before=all('SELECT raw,summary,name FROM subjects');
  run('UPDATE series_entities SET member_count=99');
  expect(runDiagnosticsRepair({issueId:'series.counter-drift',kind:'recompute-derived'}).ok).toBe(true);
  expect(all('SELECT raw,summary,name FROM subjects')).toEqual(before);
  run("UPDATE subjects SET cover_path='missing-trust.jpg',cover_cached_at=:ts",{ts:TS});const version=dataVersion();
  expect(runDiagnosticsRepair({issueId:'cover.cache-drift',kind:'clear-cover-cache'}).ok).toBe(true);
  expect(dataVersion()).toBe(version);
});
it('B3: fingerprints distinguish SQLite value types and allow only declared derived columns',()=>{
  seed(1);run("UPDATE subjects SET summary='stable'");
  const before=captureProtectedSources();
  run("UPDATE subjects SET series_key='permitted-projection',cover_path='permitted-cache'");
  expect(protectedSourcesCheck(before).ok).toBe(true);
  run("UPDATE subjects SET summary=X'737461626c65'");
  expect(protectedSourcesCheck(before).ok).toBe(false);
});
it('B2: HTTP diagnostic issue pagination is bounded, complete and traversable',async()=>{
  for(let i=1;i<=240;i++)run(`INSERT INTO franchise_entities(key,title,created_at,updated_at) VALUES(:key,:title,:ts,:ts)`,{key:`fr_page_${i}`,title:`Family ${i}`,ts:TS});
  const client=new FakeBangumiClient();const engine=new SyncEngine({client,getConfig:()=>testConfig()});
  const app=await buildApp({deps:{client,engine,coverCache:new CoverCache(client)},logger:false});
  try {
    const first=(await app.inject({url:'/api/diagnostics?limit=40'})).json();
    const second=(await app.inject({url:'/api/diagnostics?limit=40&offset=40'})).json();
    expect(first.issues).toHaveLength(40);expect(first.issuePage).toMatchObject({offset:0,limit:40,hasMore:true});
    expect(second.issues).toHaveLength(40);expect(second.issuePage.total).toBe(first.summary.total);
    expect(new Set([...first.issues,...second.issues].map((x:{id:string})=>x.id)).size).toBe(80);
    const bounded=(await app.inject({url:'/api/diagnostics?limit=1000'})).json();
    expect(bounded.issues).toHaveLength(200);expect(bounded.issuePage.limit).toBe(200);
    const bad=await app.inject({url:'/api/diagnostics?offset=-1'});expect(bad.statusCode).toBe(400);
  } finally {await app.close();}
});
it('B2: failed detector and oversized evidence never return a successful empty report',async()=>{
  const client=new FakeBangumiClient();const engine=new SyncEngine({client,getConfig:()=>testConfig()});
  const app=await buildApp({deps:{client,engine,coverCache:new CoverCache(client)},logger:false});
  const original=[...DETECTORS];
  try {
    DETECTORS.push(()=>{throw new Error('injected incomplete diagnostic');});
    const failed=await app.inject({url:'/api/diagnostics?refresh=1'});
    expect(failed.statusCode).toBe(500);expect(failed.json().issues).toBeUndefined();
    DETECTORS.splice(0,DETECTORS.length,...original);
    seed(1);run("UPDATE subjects SET cover_path='missing.jpg',cover_cached_at=:ts",{ts:TS});
    const report=getDiagnosticsReport({refresh:true});
    const mock=vi.spyOn(reports,'getDiagnosticsReport').mockReturnValue({...report,issues:[{...report.issues[0]!,evidence:[{label:'oversized',value:'x'.repeat(2_000_001)}]}]});
    const large=await app.inject({url:'/api/diagnostics'});
    expect(large.statusCode).toBe(413);expect(large.json().error.code).toBe('diagnostics_response_too_large');
    mock.mockRestore();
  } finally {DETECTORS.splice(0,DETECTORS.length,...original);await app.close();}
});
