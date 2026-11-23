import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { saveConfig, paths } from '../src/config.js';
import { all, dataVersion, getDatabase, getMeta, one, run, setMeta, transaction } from '../src/db/index.js';
import { recomputeSeries } from '../src/db/series.js';
import { getFranchiseDetail, listFranchises } from '../src/db/query.js';
import { LINK_DRIFT, inspectFranchiseLinkCounts, recomputeFranchiseLinkCounts } from '../src/db/franchiseLinkCounts.js';
import { inspectSyncEvidence } from '../src/diagnostics/syncEvidence.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { runDiagnosticsRepair } from '../src/diagnostics/repair.js';
import { projectEvidence } from '../src/diagnostics/presentation.js';
import { genericProtectedState } from '../src/diagnostics/genericPlan.js';
import { typedJson } from '../src/diagnostics/stateFingerprint.js';
import { resetDatabase } from './helpers.js';

const TS='2026-11-08T00:00:00.000Z';
export function seedFamily(){
  for(let id=1;id<=4;id++){
    run(`INSERT INTO subjects(id,type,name,name_cn,detail_state,relations_state,created_at,updated_at) VALUES(?,2,?,?,'ok','ok',?,?)`,[id,`作品${id}`,`作品${id}`,TS,TS]);
    run(`INSERT INTO collections(subject_id,subject_type,type,rate,first_seen_at,synced_at) VALUES(?,2,2,8,?,?)`,[id,TS,TS]);
    if(id>1)run(`INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at) VALUES(1,?,'不同演绎',2,?,?,?)`,[id,`作品${id}`,`作品${id}`,TS]);
  }
  setMeta('collection_owner_uid','1');recomputeSeries();
  const f=one<{id:number;key:string}>("SELECT id,key FROM franchise_entities WHERE state<>'stale'")!;
  const links=all<{series_id:number}>('SELECT series_id FROM franchise_series WHERE franchise_id=? ORDER BY series_id',[f.id]);
  expect(links).toHaveLength(4);
  ['confirmed','provisional','candidate','conflict'].forEach((s,i)=>run('UPDATE franchise_series SET state=? WHERE franchise_id=? AND series_id=?',[s,f.id,links[i]!.series_id]));
  run('UPDATE franchise_entities SET confirmed_series_count=2,candidate_series_count=1,conflict_series_count=1 WHERE id=?',[f.id]);
  invalidateDiagnosticsReport();return {...f,links};
}
function action(id:string){const issue=getDiagnosticsReport({refresh:true}).issues.find(i=>i.id===id)!;expect(issue).toBeTruthy();const a=issue.actions.find(a=>a.kind==='repair'&&a.repairKind==='recompute-derived')!;if(a.kind!=='repair')throw Error('no action');return {issueId:id,kind:a.repairKind,target:a.target,value:a.value};}
function corrupt(id:number){run('UPDATE franchise_entities SET confirmed_series_count=3,candidate_series_count=0 WHERE id=?',[id]);}
const state=()=>['subjects','collections','series_entities','series_entity_members','franchise_entities','franchise_series','entity_events','meta'].map(t=>all(`SELECT * FROM ${t} ORDER BY rowid`));

describe('综合增强 A/B/C/D 开发验证',()=>{
  beforeEach(()=>{resetDatabase();saveConfig({hideNsfw:false});invalidateDiagnosticsReport();});
  afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
  it('A: 独立显式 Oracle，正常四种链接、总和相同错分布、API 与保护',()=>{
    const f=seedFamily();expect(inspectFranchiseLinkCounts().drift).toBe(0);
    corrupt(f.id);const scan=inspectFranchiseLinkCounts();expect(scan.drift).toBe(1);expect(scan.plans[0]!.expected).toEqual([2,1,1]);
    const protectedBefore=genericProtectedState(),links=all('SELECT * FROM franchise_series'),version=dataVersion();
    const result=runDiagnosticsRepair(action(LINK_DRIFT));expect(result.verification.checks.filter(c=>!c.ok)).toEqual([]);expect(result.ok).toBe(true);
    for(const v of [getFranchiseDetail(f.key),listFranchises({key:f.key})[0]])expect([v!.confirmedSeriesCount,v!.candidateSeriesCount,v!.conflictSeriesCount]).toEqual([2,1,1]);
    expect(all('SELECT * FROM franchise_series')).toEqual(links);expect(genericProtectedState()).toBe(protectedBefore);expect(dataVersion()).toBe(version+1);
  });
  it.each(['state','projection','governance','source'] as const)('A: 旧计划拒绝 %s',kind=>{
    const f=seedFamily();corrupt(f.id);const a=action(LINK_DRIFT);
    if(kind==='state')run('UPDATE franchise_series SET state=\'candidate\' WHERE series_id=?',[f.links[0]!.series_id]);
    if(kind==='projection')run('UPDATE franchise_entities SET conflict_series_count=99 WHERE id=?',[f.id]);
    if(kind==='governance')run('UPDATE franchise_entities SET title=\'人工新名\',title_state=\'manual\' WHERE id=?',[f.id]);
    if(kind==='source')run('UPDATE series_entities SET revision=revision+1 WHERE id=?',[f.links[0]!.series_id]);
    const before=state();expect(()=>runDiagnosticsRepair(a)).toThrow();expect(state()).toEqual(before);
  });
  it('A: 投影BLOB不能被数值强转伪装为正确计数',()=>{
    const f=seedFamily();run("UPDATE franchise_entities SET confirmed_series_count=X'02' WHERE id=?",[f.id]);
    expect(inspectFranchiseLinkCounts().drift).toBe(1);expect(runDiagnosticsRepair(action(LINK_DRIFT)).ok).toBe(true);
  });
  it.each(['invalid','stale','missing','excluded','identity'] as const)('A: 不可靠链接 %s 无修复',kind=>{
    const f=seedFamily();corrupt(f.id);const sid=f.links[3]!.series_id;
    if(kind==='invalid')run("UPDATE franchise_series SET state='bogus' WHERE series_id=?",[sid]);
    if(kind==='stale')run("UPDATE series_entities SET state='stale' WHERE id=?",[sid]);
    if(kind==='identity')run("UPDATE series_entities SET state='unrecognized' WHERE id=?",[sid]);
    if(kind==='missing'){getDatabase().exec('PRAGMA foreign_keys=OFF');run('DELETE FROM series_entities WHERE id=?',[sid]);getDatabase().exec('PRAGMA foreign_keys=ON');}
    if(kind==='excluded')run(`INSERT INTO franchise_member_exclusions(franchise_id,series_id,state,reason,evidence,actor,created_at) VALUES(?,?,'active','原因','{}','user',?)`,[f.id,sid,TS]);
    const scan=inspectFranchiseLinkCounts();expect(scan.blocked).toBe(1);expect(scan.plans).toHaveLength(0);expect(scan.blockers[0]!.reasons[0]).toContain(String(sid));
    expect(()=>recomputeFranchiseLinkCounts(f.key,'old')).toThrow();
  });
  it('A: 未识别家族状态不是可信重算来源，空家族同样不能盲修',()=>{
    const f=seedFamily();corrupt(f.id);run("UPDATE franchise_entities SET state='unrecognized' WHERE id=?",[f.id]);
    expect(inspectFranchiseLinkCounts().blocked).toBe(1);expect(inspectFranchiseLinkCounts().plans).toHaveLength(0);
    run('DELETE FROM franchise_series');expect(inspectFranchiseLinkCounts().blocked).toBe(1);expect(()=>recomputeFranchiseLinkCounts(f.key,'old')).toThrow();
  });
  it('A: 尾部14名致因不被正常前缀挤掉，12000链接与27家族样本有界',()=>{
    transaction(()=>{for(let i=1;i<=27;i++)run(`INSERT INTO franchise_entities(id,key,state,title,created_at,updated_at) VALUES(?,?,'confirmed','F',?,?)`,[i,`F${i}`,TS,TS]);
      for(let id=1;id<=12000;id++){run(`INSERT INTO series_entities(id,key,title,created_at,updated_at) VALUES(?,?,'S',?,?)`,[id,`S${id}`,TS,TS]);run(`INSERT INTO franchise_series(franchise_id,series_id,state) VALUES(1,?,?)`,[id,id>11986?'illegal':'candidate']);}
      for(let i=2;i<=27;i++)run(`INSERT INTO franchise_series(franchise_id,series_id,state) VALUES(?,1,'candidate')`,[i]);});
    const start=performance.now(),scan=inspectFranchiseLinkCounts();
    expect(scan.scanned).toBe(27);expect(scan.links).toBe(12026);expect(scan.drift).toBe(26);expect(scan.plans).toHaveLength(20);
    expect(scan.blockers[0]!.blocked).toBe(14);expect(scan.blockers[0]!.reasons).toHaveLength(10);expect(scan.blockers[0]!.reasons[0]).toContain('11987');
    expect(inspectFranchiseLinkCounts('F27').plans[0]!.key).toBe('F27');expect(JSON.stringify(scan).length).toBeLessThan(20000);
    console.log('PERF A',performance.now()-start,JSON.stringify(scan).length);
  });
  it('A: Verify false 为partial，抛错回滚，撤故障重试成功',()=>{
    const f=seedFamily();corrupt(f.id);
    getDatabase().exec(`CREATE TRIGGER corrupt_bucket AFTER UPDATE OF confirmed_series_count ON franchise_entities BEGIN UPDATE franchise_entities SET conflict_series_count=99 WHERE id=NEW.id; END`);
    const partial=runDiagnosticsRepair(action(LINK_DRIFT));expect(partial.ok).toBe(false);expect(partial.verification.partial).toBe(true);
    getDatabase().exec('DROP TRIGGER corrupt_bucket');
    getDatabase().exec(`CREATE TRIGGER reject_bucket BEFORE UPDATE OF confirmed_series_count ON franchise_entities BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
    const a=action(LINK_DRIFT),before=state();expect(()=>runDiagnosticsRepair(a)).toThrow();expect(state()).toEqual(before);
    getDatabase().exec('DROP TRIGGER reject_bucket');expect(runDiagnosticsRepair(action(LINK_DRIFT)).ok).toBe(true);
  });
  it('A: 目标A成功不被目标B残留污染，隐藏证据和Real指标不越权',()=>{
    const f=seedFamily();corrupt(f.id);
    run(`INSERT INTO franchise_entities(key,title,state,candidate_series_count,created_at,updated_at) VALUES('other','其他','confirmed',9,?,?)`,[TS,TS]);
    const a=action(LINK_DRIFT);expect(runDiagnosticsRepair(a).ok).toBe(true);expect(inspectFranchiseLinkCounts().drift).toBe(1);
    corrupt(f.id);saveConfig({hideNsfw:true});run('UPDATE subjects SET nsfw=1');
    const raw=getDiagnosticsReport({refresh:true}),safe=projectEvidence(raw,'visible');expect(JSON.stringify(safe)).not.toContain(f.key);
    expect(JSON.stringify(safe)).not.toContain('series=');expect(projectEvidence(raw,'real').issues).toEqual(raw.issues);
    expect(runDiagnosticsRepair(action(LINK_DRIFT)).ok).toBe(true);
  });
  it('B: 历史坏终态不被新成功掩盖；失败/取消暂存合法，孤儿与未知分开',()=>{
    for(let id=1;id<=4;id++)run(`INSERT INTO sync_runs(id,mode,status,phase,started_at,finished_at) VALUES(?,'full',?,?,?,?)`,[id,id===1?'success':id===2?'cancelled':'success',id===2?'cancelled':'done',TS,id===1?null:TS]);
    run(`INSERT INTO sync_stage(run_id,subject_id,payload,created_at) VALUES(2,1,'{}',?),(999,2,'{}',?)`,[TS,TS]);
    let s=inspectSyncEvidence();expect(s.errors).toBe(2);expect(s.unknown).toBe(0);expect(s.errorSamples.map(x=>x.object)).toEqual(['run=1','stage=999/2']);
    const before=state();expect(()=>runDiagnosticsRepair({issueId:'sync.local-evidence-invalid',kind:'recompute-derived'})).toThrow('不支持这个修复动作');expect(state()).toEqual(before);
    setMeta('sync_projection_pending','1');s=inspectSyncEvidence();expect(s.unknown).toBe(1);expect(s.errors).toBe(2);
    run('UPDATE sync_runs SET finished_at=? WHERE id=1',[TS]);run('DELETE FROM sync_stage WHERE run_id=999');expect(inspectSyncEvidence().errors).toBe(0);expect(getMeta('sync_projection_pending')).toBe('1');
  });
  it('B: 长历史全量、独立计数、只读与未知账号，不补配置',()=>{
    transaction(()=>{for(let i=1;i<=12000;i++)run(`INSERT INTO sync_runs(id,mode,status,phase,started_at,finished_at) VALUES(?,'full','success','done',?,?)`,[i,TS,i%1000===0?null:TS]);});
    const before=getDatabase().prepare('SELECT total_changes() AS n').get(),start=performance.now();const s=inspectSyncEvidence();
    expect(s.runs).toBe(12000);expect(s.errors).toBe(12);expect(s.errorSamples.at(-1)!.object).toBe('run=12000');expect(getDatabase().prepare('SELECT total_changes() AS n').get()).toEqual(before);
    console.log('PERF B',performance.now()-start,JSON.stringify(s).length);
    setMeta('sync_projection_pending','bogus');setMeta('collection_owner_uid','NaN');expect(inspectSyncEvidence().errors).toBe(14);
    transaction(()=>{for(let i=12001;i<=12030;i++)run(`INSERT INTO sync_runs(id,mode,status,phase,started_at) VALUES(?,'full','success','done',?)`,[i,TS]);});
    const tail=inspectSyncEvidence();expect(tail.runs).toBe(12030);expect(tail.errors).toBe(44);expect(tail.errorSamples).toHaveLength(20);
  });
  it('C: 时钟到期不重扫、不改变错误数；手动刷新后新观察，倒退也过期',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date(TS));const first=getDiagnosticsReport({refresh:true}),v=dataVersion();
    vi.setSystemTime(new Date(Date.parse(TS)+60_001));const old=getDiagnosticsReport();expect(old.generatedAt).toBe(first.generatedAt);expect(old.freshness!.status).toBe('expired');expect(old.summary).toEqual(first.summary);
    expect(getDiagnosticsReport({refresh:true}).freshness!.status).toBe('snapshot');expect(dataVersion()).toBe(v);
    vi.setSystemTime(new Date(TS));expect(getDiagnosticsReport().freshness!.reason).toBe('clock');
  });
  it('C: 非核心DB写入标过期，磁盘变化诚实为未监控，手动检测实际文件',()=>{
    const f=seedFamily();const file='development-only-cover.jpg';mkdirSync(paths.coverDir,{recursive:true});writeFileSync(join(paths.coverDir,file),'fixture');
    run('UPDATE subjects SET cover_path=?,cover_cached_at=? WHERE id=1',[file,TS]);const v=dataVersion();
    const first=getDiagnosticsReport({refresh:true});expect(first.issues.some(i=>i.id==='cover.cache-drift')).toBe(false);
    unlinkSync(join(paths.coverDir,file));const cached=getDiagnosticsReport();expect(cached.generatedAt).toBe(first.generatedAt);expect(cached.freshness!.boundary).toContain('未被持续监控');
    expect(getDiagnosticsReport({refresh:true}).issues.some(i=>i.id==='cover.cache-drift')).toBe(true);
    run('UPDATE sync_runs SET phase=phase');setMeta('noncore-fixture','changed');expect(getDiagnosticsReport().freshness!.reason).toBe('local-change');expect(dataVersion()).toBe(v);expect(f.key).toBeTruthy();
  });
  it.each(['member','source','projection','governance','generation'] as const)('D: 旧通用预览拒绝 %s，无额外写入',kind=>{
    seedFamily();run('UPDATE series_entities SET member_count=99 WHERE id=(SELECT MIN(id) FROM series_entities)');const a=action('series.counter-drift');expect(a.value).toMatch(/^global-v1:/);
    if(kind==='member')run("UPDATE series_entity_members SET reason_code='changed' WHERE series_id=(SELECT MIN(id) FROM series_entities)");
    if(kind==='source')run("UPDATE collections SET rate=9 WHERE subject_id=1");
    if(kind==='projection')run('UPDATE series_entities SET revision=revision+1 WHERE id=(SELECT MIN(id) FROM series_entities)');
    if(kind==='governance')run("UPDATE franchise_series SET state='confirmed' WHERE series_id=(SELECT MAX(id) FROM series_entities)");
    if(kind==='generation')setMeta('data_version',String(dataVersion()+1));
    const before=state();expect(()=>runDiagnosticsRepair(a)).toThrow(/预览已失效/);expect(state()).toEqual(before);
  });
  it('D: 合法通用修复可达、旧无token拒绝、重复请求不重复写',()=>{
    seedFamily();run('UPDATE series_entities SET member_count=99 WHERE id=(SELECT MIN(id) FROM series_entities)');
    expect(()=>runDiagnosticsRepair({issueId:'series.counter-drift',kind:'recompute-derived'})).toThrow(/预览已失效/);
    const a=action('series.counter-drift'),before=genericProtectedState();const r=runDiagnosticsRepair(a);
    expect(r.verification.checks.filter(c=>!c.ok)).toEqual([]);expect(r.ok).toBe(true);expect(genericProtectedState()).toBe(before);
    const after=state();expect(()=>runDiagnosticsRepair(a)).toThrow();expect(state()).toEqual(after);
  });
  it('D: 允许写集违反时拒绝并事务回滚，非安全Verify仍保持partial',()=>{
    seedFamily();run('UPDATE series_entities SET member_count=99 WHERE id=(SELECT MIN(id) FROM series_entities)');
    getDatabase().exec(`CREATE TRIGGER forbidden_write AFTER UPDATE ON series_entities BEGIN INSERT INTO meta(key,value) VALUES('forbidden-fixture','changed') ON CONFLICT(key) DO UPDATE SET value='changed'; END`);
    try{const p=action('series.counter-drift'),before=state();expect(()=>runDiagnosticsRepair(p)).toThrow(/允许写集/);expect(state()).toEqual(before);expect(getMeta('forbidden-fixture')).toBeNull();}
    finally{getDatabase().exec('DROP TRIGGER forbidden_write');}
  });
  it('C: 外部连接非版本写入使观察过期，不自动增加检测次数',()=>{
    const first=getDiagnosticsReport({refresh:true});const other=new DatabaseSync(paths.dbFile);
    try{other.exec("INSERT INTO meta(key,value) VALUES('outside-fixture','changed')");}
    finally{other.close();}
    const next=getDiagnosticsReport();expect(next.generatedAt).toBe(first.generatedAt);expect(next.freshness!.status).toBe('expired');expect(next.freshness!.reason).toBe('local-change');
  });
  it('绑定指纹保留整数、浮点、非有限值、BLOB与NULL区别',()=>{
    const values=[1n,1,Infinity,-Infinity,-0,0,null,new Uint8Array([49]),'1'];
    expect(new Set(values.map(v=>typedJson({v}))).size).toBe(values.length);
  });
});
