import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { run, all } from '../src/db/index.js';
import { saveConfig } from '../src/config.js';
import * as reports from '../src/diagnostics/report.js';
import * as history from '../src/db/history.js';
import { buildApp } from '../src/app.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';
import { projectEvidence } from '../src/diagnostics/presentation.js';
import { recomputeSeries } from '../src/db/series.js';
import { getFranchiseDetail } from '../src/db/query.js';

const SECRET='PRIVATE-OLD-TITLE-Ω';
const TS='2026-11-05T00:00:00.000Z';
beforeEach(()=>{resetDatabase();saveConfig({hideNsfw:true});reports.invalidateDiagnosticsReport();});
afterEach(()=>vi.restoreAllMocks());
async function app() {const client=new FakeBangumiClient();return buildApp({deps:{client,engine:new SyncEngine({client,getConfig:()=>testConfig()}),coverCache:new CoverCache(client)},logger:false});}
function rawReport() {
  const base=reports.getDiagnosticsReport({refresh:true});
  return {...base,lastMutation:{at:TS,scope:SECRET,detail:SECRET},issues:[{
    id:`franchise.awaiting-review:${SECRET}`,detector:'franchise.governance',category:'家族治理',severity:'needs-review',title:`家族候选「${SECRET}」等待人工确认`,explanation:'派生数据必须与 source-of-truth（Subjects / Collections / Relations / 人工确认标题）保持一致',
    evidence:[{label:'原始证据',value:JSON.stringify({oldName:SECRET,nested:{member:SECRET}})}],affected:[{label:SECRET,href:`/series/${SECRET}`,detail:SECRET},{label:'obsolete',href:'/subjects/1',detail:SECRET}],affectedCount:2,
    impact:[{kind:'ui',label:'全部页面',href:`/franchises/${SECRET}`}],actions:[],extension:{deep:SECRET},
  }]};
}
it('B1 HTTP default and metric Real never authorize nested diagnostics evidence',async()=>{
  run('INSERT INTO subjects(id,name,name_cn,nsfw,created_at,updated_at) VALUES(1,\'Public title\',\'Public title\',0,:t,:t)',{t:TS});
  const raw=rawReport();vi.spyOn(reports,'getDiagnosticsReport').mockReturnValue(raw as any);
  const a=await app();try {
    for(const suffix of ['', '?visibility=real']) {
      const r=await a.inject(`/api/diagnostics${suffix}`);expect(r.statusCode).toBe(200);expect(r.body).not.toContain(SECRET);
      expect(r.json().issues[0].affected[1].label).toBe('Public title');expect(r.json().issues[0].affectedCount).toBe(2);
      expect(r.json().issues[0].explanation).toContain('source-of-truth');
      expect(r.json().presentation.mode).toBe('visible');
    }
    expect(JSON.stringify(raw)).toContain(SECRET);
  } finally {await a.close();}
});
it('B1 independent evidence intent requires BOTH signals; cross-origin cannot disclose',async()=>{
  const raw=rawReport();vi.spyOn(reports,'getDiagnosticsReport').mockReturnValue(raw as any);const a=await app();try {
    for(const options of [{url:'/api/diagnostics?evidence=real'},{url:'/api/diagnostics',headers:{'x-analyzer-evidence':'real'}},{url:'/api/diagnostics?evidence=real',headers:{'x-analyzer-evidence':'real','sec-fetch-site':'cross-site'}},{url:'/api/diagnostics?evidence=real',headers:{'x-analyzer-evidence':'real',origin:'https://other.invalid'}}]) {
      const r=await a.inject(options);expect(r.statusCode).toBe(403);expect(r.body).not.toContain(SECRET);
    }
    const r=await a.inject({url:'/api/diagnostics?evidence=real',headers:{'x-analyzer-evidence':'real'}});expect(r.statusCode).toBe(200);expect(r.body).toContain(SECRET);expect(r.headers['cache-control']).toBe('no-store');
  } finally {await a.close();}
});
it('B1 history protects old reason/state/candidate/nested evidence without deleting facts',async()=>{
  const entries=[{id:1,at:TS,source:'entity_event',kind:'title_manual',summary:SECRET,actor:'user',entityKind:'series',entityId:999,entityKey:SECRET,entityTitle:SECRET,currentState:'manual',candidate:{kind:'series_title',title:SECRET},stateChange:SECRET,reason:SECRET,evidence:JSON.stringify({old:SECRET,nested:[{key:SECRET}]})}];
  vi.spyOn(history,'listGovernanceHistory').mockReturnValue({entries,total:1,filters:{entityKind:'all',actor:'all',limit:30}} as any);
  const before=all('SELECT * FROM entity_events');const a=await app();try {
    const r=await a.inject('/api/diagnostics/history?visibility=real');expect(r.statusCode).toBe(200);expect(r.body).not.toContain(SECRET);expect(r.json().entries[0].actor).toBe('user');expect(r.json().entries[0].evidence).toContain('原文未被修改');
    const full=await a.inject({url:'/api/diagnostics/history?evidence=real',headers:{'x-analyzer-evidence':'real'}});expect(full.body).toContain(SECRET);
    expect(entries[0]!.reason).toBe(SECRET);expect(all('SELECT * FROM entity_events')).toEqual(before);
  } finally {await a.close();}
});

it('B1 detail projection retains demonstrably public candidates, protects historical associations and does not alter raw evidence',()=>{
  run('INSERT INTO subjects(id,name,name_cn,nsfw,created_at,updated_at) VALUES(1,\'Public title\',\'Public title\',0,:t,:t)',{t:TS});
  const input={key:'test',title:'Public title',titleCandidates:[{title:'Public title',source:'manual',state:'manual',valid:true,evidence:SECRET},{title:SECRET,source:SECRET,state:'contested',valid:true,evidence:SECRET}],exclusions:[{seriesKey:SECRET,seriesTitle:SECRET,state:'active',reason:SECRET,evidence:SECRET,createdAt:TS}],identityConflicts:[{fromSeriesKey:SECRET,fromSeriesTitle:SECRET,toSeriesTitle:SECRET,reason:'superseded',evidence:{members:[999],nested:SECRET}}],extension:{nested:SECRET}};
  const out=projectEvidence(input,'visible');expect(JSON.stringify(out)).not.toContain(SECRET);expect(out.titleCandidates[0].title).toBe('Public title');expect(out.titleCandidates[0].valid).toBe(true);expect(out.titleCandidates[0].state).toBe('manual');expect(out.protectedTitleCandidateCount).toBe(1);expect(out.exclusions[0].identityProtected).toBe(true);expect(out.identityConflicts[0].reason).toBe('superseded');expect(JSON.stringify(input)).toContain(SECRET);expect(projectEvidence(input,'real').titleCandidates).toEqual(input.titleCandidates);
});
it('B1 preview marks unavailable exact plans rather than allowing blind UI execution; Verify booleans remain exact',()=>{
  const p={current:SECRET,next:'按当前真实数据重新计算全部派生投影（Series / Franchise / subjects.series_key / 计数）',reason:SECRET,source:'重新运行 Series / Franchise 引擎（recomputeSeries）',directlyChanges:[SECRET],derivedChanges:[SECRET],untouched:['Collection（评分 / 进度 / 状态）'],chain:[{layer:'source',label:'真实数据',detail:SECRET}]};
  const input={kind:'adopt-franchise-title',label:'采用名称',allowed:true,message:SECRET,preview:p};
  const out=projectEvidence(input,'visible');expect(JSON.stringify(out)).not.toContain(SECRET);expect(out.allowed).toBe(true);expect(out.requiresRealEvidence).toBe(true);expect(out.preview.next).toContain('派生投影');
  const report=rawReport();const result=projectEvidence({ok:false,repair:{kind:'recompute-derived',label:'重建派生数据',target:SECRET},verification:{verified:false,partial:true,summary:SECRET,resolvedIssueIds:[],remainingIssueIds:[SECRET],checks:[{layer:'source',label:'原始数据未被修改',ok:false,detail:SECRET,extension:SECRET}]},report},'visible');
  expect(result.verification.verified).toBe(false);expect(result.verification.partial).toBe(true);expect(result.verification.checks[0].ok).toBe(false);expect(result.verification.checks[0].label).toBe('原始数据未被修改');expect(JSON.stringify(result)).not.toContain(SECRET);
});
it('B1 real HTTP preview/execute remain legal and raw stored governance history survives Visible reads',async()=>{
  for(const id of [1,2]) {run('INSERT INTO subjects(id,name,name_cn,detail_state,relations_state,created_at,updated_at) VALUES(:id,:name,:name,\'ok\',\'ok\',:t,:t)',{id,name:`Public ${id}`,t:TS});run('INSERT INTO collections(subject_id,type,rate,first_seen_at,synced_at) VALUES(:id,2,8,:t,:t)',{id,t:TS});}
  for(const [a,b] of [[1,2],[2,1]])run('INSERT INTO subject_relations(subject_id,related_id,relation,created_at) VALUES(:a,:b,\'不同演绎\',:t)',{a,b,t:TS});recomputeSeries();const key=all<{key:string}>('SELECT key FROM franchise_entities')[0]!.key;
  const a=await app();try {
    const visible=await a.inject(`/api/franchises/${key}/governance/preview?kind=adopt-franchise-title&title=${encodeURIComponent(SECRET)}`);expect(visible.statusCode).toBe(200);expect(visible.body).not.toContain(SECRET);expect(visible.json().requiresRealEvidence).toBe(true);
    const full=await a.inject({url:`/api/franchises/${key}/governance/preview?kind=adopt-franchise-title&title=${encodeURIComponent(SECRET)}&evidence=real`,headers:{'x-analyzer-evidence':'real'}});expect(full.json().allowed).toBe(true);expect(full.body).toContain(SECRET);
    const result=await a.inject({method:'POST',url:`/api/franchises/${key}/governance?evidence=real`,headers:{'x-analyzer-evidence':'real'},payload:{kind:'adopt-franchise-title',title:SECRET,reason:`old ${SECRET}`}});expect(result.statusCode).toBe(200);expect(result.json().verification.verified).toBe(true);expect(result.json().report.presentation.mode).toBe('real');
    const before=all('SELECT * FROM entity_events');const h=await a.inject('/api/diagnostics/history');expect(h.body).not.toContain(`old ${SECRET}`);expect(all('SELECT * FROM entity_events')).toEqual(before);expect(getFranchiseDetail(key)!.title).toBe(SECRET);
  } finally {await a.close();}
});
