import { useState } from 'react';
import { Button } from '../ui/button.js';
import { governanceRequest, privacyChanged } from '../../lib/userGovernance.js';

type HiddenWork = { handle:string; title:string|null; createdAt:string };
const headers = {'X-Analyzer-Private-Intent':'hidden-works'};
const path = '/api/settings/user-hidden-subjects';

export function HiddenWorksCard() {
  const [items,setItems] = useState<HiddenWork[]|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function load() {
    setBusy(true); setError('');
    try { setItems((await governanceRequest<{items:HiddenWork[]}>(path,{headers})).items); }
    catch(e) { setError(String((e as Error).message)); }
    finally {setBusy(false);}
  }
  async function restore(handle:string) {
    setBusy(true); setError('');
    try {
      const result = await governanceRequest<{dataVersion:number}>(`${path}/${encodeURIComponent(handle)}`,{method:'DELETE',headers});
      privacyChanged(result.dataVersion,'/settings?tab=appearance');
    } catch(e) { setError(String((e as Error).message)); setBusy(false); }
  }
  return <section className="space-y-2 rounded-xl border p-4" aria-label="主动隐藏">
    <h3>主动隐藏</h3>
    <p>主动隐藏不改动原始收藏或官方 NSFW。解除主动隐藏不会绕过官方 NSFW 设置。</p>
    <Button size="sm" disabled={busy} onClick={()=>items ? setItems(null) : void load()}>{items ? '关闭隐藏清单' : '管理已隐藏作品'}</Button>
    {error && <p role="alert">{error}</p>}
    {items && (items.length ? <ul>{items.map(item=><li key={item.handle} className="flex justify-between gap-2 p-2">
      <span>{item.title ?? '受保护作品'}</span>
      <Button size="sm" disabled={busy} onClick={()=>void restore(item.handle)}>解除主动隐藏</Button>
    </li>)}</ul> : <p>没有主动隐藏的作品。</p>)}
  </section>;
}
