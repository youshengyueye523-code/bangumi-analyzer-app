import { randomUUID } from 'node:crypto';
import { ApiError } from '@bangumi-analyzer/shared';
import { z } from 'zod';
import { all, dataVersion, one, run, transactionWithoutIndirectWrites } from './index.js';
import { digest } from '../diagnostics/stateFingerprint.js';
import { nowIso, toJson } from '../util.js';
import { recordMutation } from './mutation.js';
import { insertEvent } from './series.js';
import { activeManualAssignment, projectManualFranchiseLinks, refreshManualFranchiseCounters, releaseManualProjection } from './manualFranchiseProjection.js';
import { seriesVisibilityClause, franchiseVisibilityClause, personalHidesActive, publicSeriesTitle, publicFranchiseTitle, personalSeriesNameSafe } from './visibility.js';

const key=z.string().min(1).max(120);
export const manualFranchiseCommand=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),title:z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/),series:z.array(key).min(2).max(20)}),
  z.object({action:z.literal('attach'),franchise:key,series:key}),
  z.object({action:z.literal('release'),franchise:key,assignment:z.number().int().positive()}),
  z.object({action:z.literal('archive'),franchise:key}),
]);
type Command=z.infer<typeof manualFranchiseCommand>;
interface Assignment {id:number;series_id:number;franchise_id:number}
interface Family {id:number;key:string;revision:number;state:string;origin:string}
function reject(code:string,message:string): never {
  throw new ApiError(message,{code,status:409,dataIntact:true});
}

function prepare(command:Command) {
  const family=command.action==='create'?undefined:one<Family>(
    `SELECT id,key,revision,state,origin FROM franchise_entities f
       WHERE key=? AND state NOT IN ('stale','rejected') AND ${franchiseVisibilityClause('f')}`,[command.franchise]);
  if(command.action!=='create'&&!family) reject('manual_franchise_unavailable','家族不可见、已否决或已退役，请先处理该状态。');
  const requested=command.action==='create'?command.series:command.action==='attach'?[command.series]:[];
  if(new Set(requested).size!==requested.length) reject('manual_franchise_duplicate','请选择不同的系列。');
  const series=requested.map(k=>{
    const row=one<{id:number;key:string;revision:number}>(
      `SELECT id,key,revision FROM series_entities e WHERE key=? AND state<>'stale' AND ${seriesVisibilityClause('e')}`,[k]);
    if(!row) reject('manual_series_unavailable','系列不可见、已退役或不是当前正式身份。请重新选择。');
    if(activeManualAssignment(row.id)) reject('manual_assignment_exists','该系列已有人工归属。请先在原家族明确撤销指定。');
    if(one(`SELECT 1 FROM franchise_series l JOIN franchise_entities f ON f.id=l.franchise_id
            WHERE l.series_id=? AND f.state NOT IN ('rejected','stale')
              AND (l.state='confirmed' OR (f.state='confirmed' AND l.state='conflict')) LIMIT 1`,[row.id])) {
      reject('manual_franchise_locked','系列已有确认锁。请先在原家族预览并明确移出；最后成员可先否决原家族。');
    }
    if(family && one("SELECT 1 FROM franchise_member_exclusions WHERE franchise_id=? AND series_id=? AND state='active'",[family.id,row.id])){
      reject('manual_franchise_excluded','目标家族有有效排除。请先明确撤销排除，再指定归属。');
    }
    return row;
  });
  const assignments=family?all<Assignment>('SELECT id,series_id,franchise_id FROM franchise_member_assignments WHERE franchise_id=? AND revoked_at IS NULL ORDER BY id',[family.id]):[];
  const links=family?all<{series_id:number;state:string;evidence:string;series_state:string}>(
    'SELECT l.series_id,l.state,l.evidence,e.state AS series_state FROM franchise_series l JOIN series_entities e ON e.id=l.series_id WHERE franchise_id=? ORDER BY l.series_id',
    [family.id]):[];
  if(command.action==='release') {
    if(!assignments.some(x=>x.id===command.assignment)) reject('manual_assignment_stale','该指定已撤销或不属于此家族。');
    const selected=assignments.find(x=>x.id===command.assignment)!;
    if(!one(`SELECT 1 FROM series_entities e WHERE id=? AND ${seriesVisibilityClause('e')}
       ${personalHidesActive()?`AND (${personalSeriesNameSafe('e.id')})`:''}`,[selected.series_id]))
      reject('manual_series_unavailable','该身份当前不可用于归属操作。');
    if(links.filter(x=>x.series_state!=='stale' && x.state!=='conflict' && x.series_id!==selected.series_id).length===0)
      reject('manual_franchise_last_member','不能单独移出最后一个成员；纯人工家族可明确撤销整个家族。');
  }
  if(command.action==='archive' && (family?.origin!=='manual'||
      assignments.some(a=>!one(`SELECT 1 FROM series_entities e WHERE id=? AND ${seriesVisibilityClause('e')}`,[a.series_id]))||
      links.some(l=>!assignments.some(x=>x.series_id===l.series_id))||
      one("SELECT 1 FROM candidate_decisions WHERE entity_kind='franchise' AND entity_id=? LIMIT 1",[family.id])||
      one("SELECT 1 FROM franchise_member_exclusions WHERE franchise_id=? AND state='active' LIMIT 1",[family.id]))) {
    reject('manual_franchise_archive_locked','此家族已有其他确认或治理记录，不允许整体撤销。');
  }
  // Binds exact commands, live identities and link evidence (including no-version changes).
  const token=digest({command,version:dataVersion(),family,series,assignments,links});
  return { token,family,series,assignments };
}

export function previewManualFranchise(command:Command) {
  const plan=prepare(command);
  const choices=plan.series.map(s=>({
    seriesKey:s.key,
    suggestions:all<{title:string;state:string}>(`SELECT ${publicFranchiseTitle('f')} AS title,l.state
      FROM franchise_series l JOIN franchise_entities f ON f.id=l.franchise_id
      WHERE l.series_id=? AND f.state NOT IN ('stale','rejected') AND ${franchiseVisibilityClause('f')}
      ORDER BY f.id`,[s.id]),
  }));
  return { token:plan.token, action:command.action, affected:plan.series.length|| (command.action==='archive'?plan.assignments.length:1), choices };
}

export function executeManualFranchise(command:Command,token:string) {
  return transactionWithoutIndirectWrites(()=>{
    const plan=prepare(command);
    if(token!==plan.token) reject('manual_franchise_stale','数据已经变化，请重新预览。');
    const timestamp=nowIso(), before=dataVersion();
    const family=plan.family ?? (() => {
      if(command.action!=='create') throw Error('missing target');
      const key='manual-f-'+randomUUID();
      const inserted=run(`INSERT INTO franchise_entities(key,title,title_state,title_source,state,origin,created_at,updated_at)
        VALUES(:key,:title,'manual','manual','candidate','manual',:timestamp,:timestamp)`,{key,title:command.title,timestamp});
      return {id:inserted.lastInsertRowid,key};
    })();
    for(const s of plan.series) {
      const old=one('SELECT state,evidence FROM franchise_series WHERE franchise_id=? AND series_id=?',[family.id,s.id]);
      run(`INSERT INTO franchise_member_assignments(franchise_id,series_id,reason,evidence,created_at)
        VALUES(:f,:s,'用户明确指定',:evidence,:timestamp)`,{f:family.id,s:s.id,evidence:toJson({previousLink:old??null,seriesRevision:s.revision}),timestamp});
    }
    const releases=command.action==='archive'?plan.assignments
      :command.action==='release'?plan.assignments.filter(a=>a.id===command.assignment):[];
    for(const a of releases){
      run("UPDATE franchise_member_assignments SET revoked_at=:timestamp,revoked_reason='用户明确撤销' WHERE id=:id AND revoked_at IS NULL",{timestamp,id:a.id});
      releaseManualProjection(family.id,a.series_id,a.id);
    }
    if(command.action==='archive') run("UPDATE franchise_entities SET state='stale' WHERE id=?",[family.id]);
    projectManualFranchiseLinks(family.id);
    refreshManualFranchiseCounters(family.id,timestamp);
    insertEvent('franchise',family.id,'manual_membership_'+command.action,
      {trigger:'manual',assigned:plan.series.map(s=>s.id),revoked:releases.map(a=>a.id)},timestamp);
    recordMutation('governance','manual franchise membership');
    for(const s of plan.series){
      const fact=activeManualAssignment(s.id);
      const linked=one("SELECT 1 FROM franchise_series WHERE franchise_id=? AND series_id=? AND state='confirmed'",[family.id,s.id]);
      if(fact?.franchise_id!==family.id||!linked) reject('manual_franchise_verify_failed','归属未通过验证，已回滚。');
    }
    if(releases.some(a=>one('SELECT 1 FROM franchise_member_assignments WHERE id=? AND revoked_at IS NULL',[a.id]))||dataVersion()!==before+1)
      reject('manual_franchise_verify_failed','归属未通过验证，已回滚。');
    return {ok:true,key:family.key,dataVersion:dataVersion()};
  },()=>reject('manual_franchise_write_boundary','发现超出允许范围的写入，归属变更已回滚。'));
}

export function visibleManualAssignments(franchise:string) {
  const family=one<{id:number;origin:string;state:string}>(`SELECT id,origin,state FROM franchise_entities f WHERE key=?
    AND state<>'stale' AND ${franchiseVisibilityClause('f')}`,[franchise]);
  if(!family) return {manual:false,items:[]};
  const items=all<{id:number;seriesKey:string|null;title:string|null;state:string}>(`SELECT a.id,e.state,
      CASE WHEN e.state<>'stale' AND ${seriesVisibilityClause('e')} THEN ${publicSeriesTitle('e')} END AS title,
      CASE WHEN e.state<>'stale' AND ${seriesVisibilityClause('e')} THEN e.key ELSE NULL END AS seriesKey
    FROM franchise_member_assignments a JOIN series_entities e ON e.id=a.series_id
    WHERE a.franchise_id=? AND a.revoked_at IS NULL ORDER BY a.id`,[family.id]);
  return {manual:family.origin==='manual',items:personalHidesActive()?items.filter(i=>i.seriesKey!==null):items};
}
