import { supportsQualitySchema } from '../db/schema.js';
/** Read-only local run invariants. No remote completeness certificate or automatic cleanup. */
import { ApiError, type DiagnosticIssue } from '@bangumi-analyzer/shared';
import { getDatabase, getMeta, one, schemaVersion } from '../db/index.js';

const LIMIT=20;
interface Sample {object:string;reasons:string[]}
export interface SyncEvidence {
  runs:number; stages:number; errors:number; unknown:number; errorSamples:Sample[]; unknownSamples:Sample[];
}
export function inspectSyncEvidence():SyncEvidence{
  const db=getDatabase();db.exec('SAVEPOINT diagnostic_sync_evidence');
  try{
    if(!supportsQualitySchema(schemaVersion()))throw Error('Unassessed sync schema');
    const out:SyncEvidence={runs:0,stages:0,errors:0,unknown:0,errorSamples:[],unknownSamples:[]};
    const add=(object:string,reasons:string[],uncertain=false)=>{
      if(!reasons.length)return;
      const samples=uncertain?out.unknownSamples:out.errorSamples;
      if(uncertain)out.unknown++;else out.errors++;
      if(samples.length<LIMIT)samples.push({object,reasons});
    };
    const stmt=db.prepare('SELECT id,status,phase,started_at,finished_at,duration_ms FROM sync_runs ORDER BY id');stmt.setReadBigInts(true);
    for(const r of stmt.iterate()){
      out.runs++;const reasons:string[]=[],unknown:string[]=[];
      const terminal:Record<string,string>={success:'done',error:'error',cancelled:'cancelled',interrupted:'interrupted'};
      const state=String(r.status);
      if(Object.hasOwn(terminal,state)){
        if(r.finished_at===null)reasons.push('terminal-without-finished-at');
        if(r.phase!==terminal[state])reasons.push('terminal-phase-mismatch');
      }else if(state==='running'){
        if(r.finished_at!==null)reasons.push('running-with-finished-at');
        if(Object.values(terminal).includes(String(r.phase)))reasons.push('running-terminal-phase');
      }else unknown.push('unrecognized-historical-state');
      for(const key of ['started_at','finished_at'] as const){
        const v=r[key];if(v!==null&&(typeof v!=='string'||!Number.isFinite(Date.parse(v))))reasons.push(`invalid-${key}`);
      }
      if(r.duration_ms!==null&&(typeof r.duration_ms!=='bigint'||r.duration_ms<0n))reasons.push('invalid-duration');
      add(`run=${String(r.id)}`,reasons);add(`run=${String(r.id)}`,unknown,true);
    }
    out.stages=Number(one<{n:number}>('SELECT COUNT(*) AS n FROM sync_stage')!.n);
    const orphan=db.prepare(`SELECT s.run_id,s.subject_id FROM sync_stage s LEFT JOIN sync_runs r ON r.id=s.run_id WHERE r.id IS NULL ORDER BY s.run_id,s.subject_id`);
    orphan.setReadBigInts(true);
    for(const r of orphan.iterate())add(`stage=${String(r.run_id)}/${String(r.subject_id)}`,['missing-run']);
    const pending=getMeta('sync_projection_pending');
    if(pending!==null&&!['0','1'].includes(pending))add('sync_projection_pending',['invalid-pending-value']);
    else if(pending==='1')add('sync_projection_pending',['projection-pending-not-attributable-to-a-specific-run'],true);
    const owner=getMeta('collection_owner_uid');
    if(owner!==null&&(!/^\d+$/.test(owner)||!Number.isSafeInteger(Number(owner))||Number(owner)<=0))add('collection_owner_uid',['invalid-owner']);
    else if(owner===null&&Number(one<{n:number}>('SELECT COUNT(*) AS n FROM collections')!.n)>0)add('collection_owner_uid',['historical-owner-unknown'],true);
    db.exec('RELEASE diagnostic_sync_evidence');return out;
  }catch{
    db.exec('ROLLBACK TO diagnostic_sync_evidence; RELEASE diagnostic_sync_evidence');
    throw new ApiError('同步本地证据检查未完成，不能认定正常',{code:'sync_evidence_incomplete',status:500,dataIntact:true});
  }
}
export function syncEvidenceIssues(scan:SyncEvidence):DiagnosticIssue[]{
  return ([false,true] as const).flatMap(unknown=>{
    const count=unknown?scan.unknown:scan.errors,samples=unknown?scan.unknownSamples:scan.errorSamples;
    if(!count)return [];
    return [{id:unknown?'sync.local-evidence-unknown':'sync.local-evidence-invalid',detector:'sync.state',category:'同步本地运行证据',
      severity:unknown?'uncertain' as const:'error' as const,
      title:unknown?'部分同步本地证据不足以作确定判断':'同步本地运行记录违反已知契约',
      explanation:unknown?'历史状态或账号归属证据不足；pending 可能正在处理或等待恢复，不能归因某次运行，不从当前配置补造历史事实。'
        :'检查全部本地历史终态及暂存引用；仅证明本地记录矛盾，不代表远端漏项、数据丢失或当前死锁。失败和取消后保留暂存可能合法。',
      evidence:[{label:'全量判定与有界证据',value:`运行 ${scan.runs} / 暂存 ${scan.stages}；对象 ${count}；展示 ${samples.length}；未展示 ${count-samples.length}`},
        ...samples.map(s=>({label:s.object,value:s.reasons.join(' / ')}))],
      impact:[{kind:'api' as const,label:'同步状态与恢复解释'}],affected:samples.map(s=>({label:s.object})),affectedCount:count,actions:[],
      waitingFor:'保留记录与来源，可靠核查或合法恢复后重新检测；数据中枢不会清理或改写同步记录。'}];
  });
}
