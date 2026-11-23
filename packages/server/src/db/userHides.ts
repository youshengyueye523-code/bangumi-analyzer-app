import { randomUUID } from 'node:crypto';
import { ApiError } from '@bangumi-analyzer/shared';
import { all, dataVersion, one, run, transactionWithoutIndirectWrites } from './index.js';
import { recordMutation } from './mutation.js';
import { hideNsfwEnabled, personallyVisibleId } from './visibility.js';
import { nowIso } from '../util.js';

function boundary(): never {
  throw new ApiError('发现超出允许范围的写入，隐藏变更已回滚。',{code:'user_hide_write_boundary',status:409,dataIntact:true});
}
function hiddenResponse(changed:boolean) {return {ok:true,changed,dataVersion:dataVersion()};}

export function hideWork(id:number) {
  return transactionWithoutIndirectWrites(()=>{
    if(!one(`SELECT 1 FROM subjects s JOIN collections c ON c.subject_id=s.id
      WHERE s.id=? ${hideNsfwEnabled()?'AND s.nsfw=0':''}`,[id])) {
      // Repeated writes to a previously hidden known work stay idempotent even if its official state changed.
      if(one('SELECT 1 FROM subject_user_hides WHERE subject_id=? AND revoked_at IS NULL',[id]))return hiddenResponse(false);
      throw new ApiError('当前没有可隐藏的收藏作品。',{code:'user_hide_unavailable',status:404,dataIntact:true});
    }
    if(one('SELECT 1 FROM subject_user_hides WHERE subject_id=? AND revoked_at IS NULL',[id]))return hiddenResponse(false);
    const before=dataVersion();
    run('INSERT INTO subject_user_hides(handle,subject_id,created_at) VALUES(?,?,?)',[randomUUID(),id,nowIso()]);
    recordMutation('governance','personal visibility changed');
    if(dataVersion()!==before+1 || one(`SELECT 1 WHERE ${personallyVisibleId(':id')}`,{id}))boundary();
    return hiddenResponse(true);
  },boundary);
}

export function restoreWork(handle:string) {
  return transactionWithoutIndirectWrites(()=>{
    const before=dataVersion();
    const changed=run('UPDATE subject_user_hides SET revoked_at=? WHERE handle=? AND revoked_at IS NULL',[nowIso(),handle]).changes;
    if(!changed)return hiddenResponse(false);
    recordMutation('governance','personal visibility changed');
    if(dataVersion()!==before+1||one('SELECT 1 FROM subject_user_hides WHERE handle=? AND revoked_at IS NULL',[handle]))boundary();
    return hiddenResponse(true);
  },boundary);
}

export function hiddenWorks() {
  const name = hideNsfwEnabled() ? "CASE WHEN s.nsfw=0 THEN COALESCE(NULLIF(s.name_cn,''),s.name) END"
    : "COALESCE(NULLIF(s.name_cn,''),s.name)";
  return all<{handle:string;title:string|null;createdAt:string}>(`SELECT h.handle,${name} AS title,h.created_at AS createdAt
    FROM subject_user_hides h LEFT JOIN subjects s ON s.id=h.subject_id
    WHERE h.revoked_at IS NULL ORDER BY h.created_at DESC,h.handle`);
}
