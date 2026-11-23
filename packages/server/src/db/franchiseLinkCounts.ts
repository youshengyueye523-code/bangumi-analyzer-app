import { supportsQualitySchema } from './schema.js';
/** Current link state buckets, not Franchise confirmation or upstream relationship truth. */
import { ApiError, type DiagnosticIssue, type DiagnosticsRepairCheck } from '@bangumi-analyzer/shared';
import { dataVersion, getDatabase, run, schemaVersion, transaction } from './index.js';
import { recordMutation } from './mutation.js';
import { getFranchiseDetail, isFranchiseHidden, listFranchises } from './query.js';
import { digest, fingerprint, typedJson } from '../diagnostics/stateFingerprint.js';
import { createHash } from 'node:crypto';

export const LINK_DRIFT = 'franchise.link-count-drift';
export const LINK_BLOCKED = 'franchise.link-count-unassessable';
const LIMIT = 20, REASONS = 10;
type Counts = [number, number, number];
interface Plan { id:string; key:string; before:Counts; expected:Counts; token:string; links:number; blocked:number; familyBlocked:boolean; reasons:string[] }
export interface LinkCountScan { scanned:number; links:number; drift:number; blocked:number; plans:Plan[]; blockers:Plan[] }
const equal = (a:Counts,b:Counts) => a.every((n,i)=>n===b[i]);
const formatCounts = (counts:Counts) => `[${counts.map(n=>Number.isSafeInteger(n)&&n>=0?String(n):'非法存储或范围').join(',')}]`;

export function inspectFranchiseLinkCounts(target?: string): LinkCountScan {
  const db=getDatabase();
  db.exec('SAVEPOINT diagnostic_franchise_links');
  try {
    if(!supportsQualitySchema(schemaVersion())) throw Error('Unassessed link schema');
    const schemaFingerprint=fingerprint('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name');
    const result:LinkCountScan={scanned:0,links:0,drift:0,blocked:0,plans:[],blockers:[]};
    const stmt=db.prepare(`SELECT f.*, fs.series_id AS link_id,fs.state AS link_state,fs.evidence AS link_evidence,
      e.id AS parent_id,e.key AS parent_key,e.state AS parent_state,e.revision AS parent_revision,
      EXISTS(SELECT 1 FROM franchise_member_exclusions x WHERE x.franchise_id=f.id AND x.series_id=fs.series_id AND x.state='active') AS excluded
      FROM franchise_entities f LEFT JOIN franchise_series fs ON fs.franchise_id=f.id
      LEFT JOIN series_entities e ON e.id=fs.series_id
      WHERE f.state<>'stale' ${target===undefined?'':'AND f.key=:key'} ORDER BY f.id,fs.series_id`);
    stmt.setReadBigInts(true);
    let p:Plan|undefined, hash=createHash('sha256');
    const finish=()=>{
      if(!p)return;
      p.token=hash.digest('hex');
      if(p.blocked || p.familyBlocked){result.blocked++;if(result.blockers.length<LIMIT)result.blockers.push(p);}
      else if(!equal(p.before,p.expected)){result.drift++;if(result.plans.length<LIMIT)result.plans.push(p);}
    };
    for(const row of stmt.iterate(target===undefined?{}:{key:target})){
      if(!p || p.id!==String(row.id)){
        finish();result.scanned++;
        const stored = ['confirmed_series_count','candidate_series_count','conflict_series_count'].map(k =>
          typeof row[k] === 'bigint' && row[k] >= 0n && row[k] <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(row[k]) : NaN) as Counts;
        p={id:String(row.id),key:String(row.key),before:stored,
          expected:[0,0,0],token:'',links:0,blocked:0,familyBlocked:!['candidate','provisional','confirmed','contested','rejected'].includes(String(row.state)),reasons:[]};
        hash=createHash('sha256').update(typedJson([dataVersion(),schemaFingerprint,row]));
        // Bind even exclusions that currently have no link. They must not change behind the preview.
        hash.update(fingerprint('SELECT * FROM franchise_member_exclusions WHERE franchise_id=:id ORDER BY id',{id:p.id}));
        hash.update(fingerprint("SELECT * FROM candidate_decisions WHERE entity_kind='franchise' AND entity_id=:id ORDER BY id",{id:p.id}));
        hash.update(fingerprint("SELECT * FROM entity_events WHERE entity_kind='franchise' AND entity_id=:id ORDER BY id",{id:p.id}));
      }
      hash.update(typedJson(row));
      if(row.link_id===null)continue;
      p.links++;result.links++;
      const reasons:string[]=[];
      if(row.parent_id===null)reasons.push('missing-parent');
      if(row.parent_state==='stale')reasons.push('stale-identity');
      if(row.parent_id!==null && !['stable','provisional','stale'].includes(String(row.parent_state)))reasons.push('invalid-series-state');
      if(row.excluded===1n)reasons.push('active-exclusion');
      if(!['confirmed','provisional','candidate','conflict'].includes(String(row.link_state)))reasons.push('invalid-link-state');
      if(reasons.length){p.blocked++;if(p.reasons.length<REASONS)p.reasons.push(`series=${String(row.link_id)}: ${reasons.join(',')}`);}
      else p.expected[row.link_state==='candidate'?1:row.link_state==='conflict'?2:0]++;
    }
    finish();db.exec('RELEASE diagnostic_franchise_links');return result;
  }catch(error){db.exec('ROLLBACK TO diagnostic_franchise_links; RELEASE diagnostic_franchise_links');
    throw new ApiError('Franchise 子计数检查未完成，不能认定一致',{code:'franchise_link_check_incomplete',status:500,dataIntact:true});}
}

export function franchiseLinkCountIssues(scan:LinkCountScan):DiagnosticIssue[]{
  const base={detector:'franchise.entities',category:'Franchise 链接子计数',impact:[{kind:'franchise' as const,label:'Franchise 列表 / 详情',href:'/franchises'}]};
  const issues:DiagnosticIssue[]=[];
  if(scan.drift)issues.push({...base,id:LINK_DRIFT,severity:'error',title:'Franchise 链接子计数与成员状态不一致',
    explanation:'逐桶对账当前本地链接；provisional 沿用 confirmed 统计桶但不代表人工确认。只重算三项计数，不改变成员、链接状态或治理。',
    affectedCount:scan.drift,affected:scan.plans.map(p=>({label:p.key,href:`/franchises/${encodeURIComponent(p.key)}`})),
    evidence:[{label:'全量检查与样本',value:`家族 ${scan.scanned} / 链接 ${scan.links}；漂移 ${scan.drift}；展示 ${scan.plans.length}；未展示 ${scan.drift-scan.plans.length}`},
      ...scan.plans.map(p=>({label:p.key,value:`confirmed/candidate/conflict ${formatCounts(p.before)} → ${JSON.stringify(p.expected)}`}))],
    actions:scan.plans.filter(p=>p.key.length<=120).map(p=>({kind:'repair',repairKind:'recompute-derived',target:p.key,value:p.token,label:'从当前链接重新生成三个子计数',
      preview:{current:formatCounts(p.before),next:JSON.stringify(p.expected),reason:'当前链接状态是计数依据，不重新裁决成员。',source:'franchise_series.state',
        directlyChanges:['仅目标的 confirmed_series_count / candidate_series_count / conflict_series_count'],derivedChanges:['Franchise API 与列表／详情候选及冲突提示'],
        untouched:['成员、链接状态、人工标题、排除、历史、其他聚合与原始来源'],chain:[{layer:'source',label:'单目标绑定计划',detail:`${p.key}；${p.token}；${p.links} 条当前链接`}],}}))});
  if(scan.blocked)issues.push({...base,id:LINK_BLOCKED,severity:'needs-review',title:'部分 Franchise 链接子计数无法可靠对账',
    explanation:'缺父、非法链接状态、stale 身份或有效排除与当前链接矛盾；保留原始事实与治理，拒绝自动重算。致因样本有界，不代表全部证据。',
    affectedCount:scan.blocked,affected:scan.blockers.map(p=>({label:p.key,href:`/franchises/${encodeURIComponent(p.key)}`})),
    evidence:[{label:'阻断家族样本',value:`展示 ${scan.blockers.length}/${scan.blocked}；未展示 ${scan.blocked-scan.blockers.length}`},
      ...scan.blockers.map(p=>({label:p.key,value:`家族状态${p.familyBlocked?'非法':'合法'}；阻断链接 ${p.blocked}；原因展示 ${p.reasons.length}/${p.blocked}；未展示 ${p.blocked-p.reasons.length}；${p.reasons.join(';')}`}))],actions:[]});
  return issues;
}

/** Full protected state, except the exact three target columns and mutation metadata. */
function protectedState(id:string):string{
  const tables=['subjects','collections','subject_staff','subject_relations','series_entities','series_entity_members','franchise_series',
    'candidate_decisions','franchise_member_exclusions','entity_events','entity_aliases',
    'series','series_members','series_legacy_snapshot','sync_runs','sync_stage','translation_jobs','profile_reports','profile_snapshots'];
  const state=tables.map(t=>fingerprint(`SELECT * FROM ${t} ORDER BY rowid`));
  const cols=(getDatabase().prepare('PRAGMA table_info(franchise_entities)').all() as {name:string}[])
    .map(c=>['confirmed_series_count','candidate_series_count','conflict_series_count'].includes(c.name)
      ? `CASE WHEN id=${id} THEN NULL ELSE ${c.name} END AS ${c.name}` : c.name).join(',');
  state.push(fingerprint(`SELECT ${cols} FROM franchise_entities ORDER BY id`));
  state.push(fingerprint("SELECT * FROM meta WHERE key NOT IN ('data_version','last_mutation_scope','last_mutation_at','last_mutation_detail') ORDER BY key"));
  return digest(state);
}

export function recomputeFranchiseLinkCounts(target:string,token:string):DiagnosticsRepairCheck[]{
  return transaction(()=>{
    const p=inspectFranchiseLinkCounts(target).plans.find(p=>p.token===token);
    if(!p)throw new ApiError('Franchise 子计数预览已失效或来源不可信，请重新检测',{code:'franchise_link_plan_stale',status:409,dataIntact:true});
    const protectedBefore=protectedState(p.id),version=dataVersion();
    run(`UPDATE franchise_entities SET confirmed_series_count=:a,candidate_series_count=:b,conflict_series_count=:c WHERE id=:id`,
      {a:p.expected[0],b:p.expected[1],c:p.expected[2],id:p.id});
    const mutation=recordMutation('repair','franchise link bucket recompute');
    const after=inspectFranchiseLinkCounts(target),hidden=isFranchiseHidden(target);
    const detail=getFranchiseDetail(target),list=listFranchises({key:target})[0];
    const expected=p.expected;
    const matches=(v:typeof detail|typeof list)=>!!v&&equal([v.confirmedSeriesCount,v.candidateSeriesCount,v.conflictSeriesCount],expected);
    return [
      {layer:'source',label:'目标外与治理保护',ok:protectedState(p.id)===protectedBefore,detail:'仅允许目标三个计数变化；来源、成员、其他实体、人工治理与历史逐字核对'},
      {layer:'projection',label:'Franchise 三桶重新对账',ok:after.scanned===1&&after.drift===0&&after.blocked===0,detail:'按当前链接再次检查三个桶，不以总和代替'},
      {layer:'api',label:'Franchise 列表与详情子计数',ok:hidden?detail===null&&list===undefined:matches(detail)&&matches(list),detail:'Real 不变量与当前消费者可见性分别核验'},
      {layer:'cache',label:'统一 mutation',ok:mutation.dataVersion===version+1,detail:'推进一代并失效统计和报告缓存'},
    ];
  });
}
