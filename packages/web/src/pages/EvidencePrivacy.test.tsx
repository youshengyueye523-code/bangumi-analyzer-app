import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { DiagnosticsReport } from '@bangumi-analyzer/shared';
import { DataCenterPage } from './DataCenterPage.js';
import { ToastProvider } from '../components/ui/toast.js';
import { api } from '../lib/api.js';
import { useDiagnosticsRepair, diagnosticEvidenceKey, queryKeys } from '../lib/queries.js';
const secret='PRIVATE-CONSENT-TEST';
const withheld='受保护证据：原文完整保留，需通过独立「完整审计证据」确认入口查看。';
const report=(real=false):DiagnosticsReport=>({presentation:{version:1,mode:real?'real':'visible',privacyApplied:!real,note:'安全审计摘要'},coverage:{status:'complete',note:'全部注册检查已完成'},generatedAt:'2026-11-05T00:00:00.000Z',durationMs:1,dataVersion:1,hideNsfw:true,lastMutation:{scope:null,at:null,detail:null},scope:{subjects:1,collections:1,relations:0,series:1,franchises:0,staleSeries:0},summary:{error:0,suspicious:0,'needs-review':1,uncertain:0,external:0,info:0,total:1},modules:[],issues:[{id:'series.counter-drift',detector:'series.entities',category:'派生数据',severity:'needs-review',title:real?secret:'公开诊断',explanation:'有待处理的派生数据',evidence:[],impact:[],affected:[],affectedCount:1,actions:[]}]});
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function mount(q=new QueryClient({defaultOptions:{queries:{retry:false}}})) {render(<QueryClientProvider client={q}><ToastProvider><MemoryRouter><DataCenterPage /></MemoryRouter></ToastProvider></QueryClientProvider>);return q;}
afterEach(()=>vi.unstubAllGlobals());

it('keeps diagnostics and refresh in the single protected view even when Real evidence is cached',async()=>{
 const calls:{url:string;hasEvidenceHeader:boolean}[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);
  calls.push({url,hasEvidenceHeader:new Headers(init?.headers).has('X-Analyzer-Evidence')});
  const value=report();
  if(url.includes('/history')) return json({entries:[],total:0,filters:{entityKind:'all',actor:'all',limit:20},presentation:value.presentation});
  if(url.includes('refresh=1')) value.issues[0]!.title='重新检测后的诊断';
  return json(value);
 }));
 await api.franchiseDetail('public','real');
 expect(calls[0]!.url).toContain('visibility=real');
 const q=new QueryClient({defaultOptions:{queries:{retry:false}}});
 q.setQueryData(diagnosticEvidenceKey('real'),report(true));
 mount(q);
 await screen.findByText('公开诊断');
 await screen.findByText('当前筛选下还没有治理记录。');
 fireEvent.click(screen.getByRole('button',{name:'重新检测'}));
 await screen.findByText('重新检测后的诊断');
 expect(calls.some(c=>c.url.includes('refresh=1'))).toBe(true);
 expect(calls.every(c=>!c.url.includes('evidence=real')&&!c.hasEvidenceHeader)).toBe(true);
 expect(screen.queryByRole('button',{name:/查看完整审计证据|返回安全审计摘要/})).toBeNull();
 expect(screen.queryByText(secret)).toBeNull();
 expect(q.getQueryData<DiagnosticsReport>(queryKeys.diagnostics)?.presentation?.mode).toBe('visible');
});
it('does not render a history response marked as Real evidence in the protected view',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>String(input).includes('/history')
  ? json({entries:[{id:1,summary:secret,entityTitle:secret}],total:1,presentation:report(true).presentation})
  : json(report())));
 mount();
 await screen.findByText('公开诊断');
 await screen.findByText('历史响应未通过隐私保护检查，未展示证据。');
 expect(screen.queryByText(secret)).toBeNull();
});
it('B1 Web refuses unproven private legacy responses instead of rendering their contents',async()=>{
 const raw=report(true);delete raw.presentation;
 vi.stubGlobal('fetch',vi.fn(async()=>json(raw)));mount();await screen.findByText(/诊断响应缺少安全隐私投影证明/);expect(screen.queryByText(secret)).toBeNull();
});
it('restores the public diagnostic fields and usable links without rendering projection placeholders',async()=>{
 const value=report();
 value.scope.series=411;
 value.scope.staleSeries=16;
 value.modules=[{id:'series',label:'Series 派生数据',description:'成员归属与计数',status:'ok',checked:411,details:[withheld,withheld,'仍可查看的模块明细']}];
 value.issues=[{...value.issues[0]!,id:'relations.uncollected-members',affectedCount:7,
  explanation:'有效的诊断说明',
  evidence:[{label:'未收藏的 Series 成员',value:withheld},{label:'有效证据',value:'可见详情'}],
  impact:[{kind:'series',label:'Series 成员（仅名称）'}],
  actions:[{kind:'link',label:'失效的占位入口',href:'/diagnostics',hint:withheld},{kind:'link',label:'真实治理入口',href:'/settings'}],
 }];
 const row={actor:'user',at:value.generatedAt,entityKind:'series',currentState:'stable'};
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>String(input).includes('/history') ? json({
  total:2,presentation:value.presentation,entries:[
   {...row,id:'event:1',summary:'记录甲：受保护实体；历史证据原文保留',entityId:0,candidate:{title:withheld},stateChange:withheld,reason:withheld,evidence:'安全摘要：事件类型、时间、操作者与当前可见对象如上；未公开历史证据。'},
   {...row,id:'event:2',summary:'记录乙',entityId:1,entityKey:'sr_1',entityTitle:'可见对象',reason:'可见原因',evidence:'{"public":"可见快照"}'},
  ],
 }) : json(value)));
 mount();
 await screen.findByText('411 个 Series（非 stale）');
 expect(screen.getByText('保留的历史实体行（stale）：16 条，不参与展示')).toBeTruthy();
 expect(screen.getByText('仍可查看的模块明细')).toBeTruthy();
 expect(screen.getByText('7 个 Series 成员没有本地详情')).toBeTruthy();
 expect(screen.getByText('7 个')).toBeTruthy();
 expect(screen.getByText('可见详情')).toBeTruthy();
 expect(screen.getByRole('link',{name:'Series 成员（仅名称）'}).getAttribute('href')).toBe('/series');
 expect(screen.getByRole('link',{name:'真实治理入口'}).getAttribute('href')).toBe('/settings');
 expect(screen.queryByText('失效的占位入口')).toBeNull();
 await screen.findByText('记录甲：受保护实体');
 expect(screen.queryByText(/series #0|受保护证据：|历史证据原文保留/)).toBeNull();
 expect(screen.getAllByText('证据快照')).toHaveLength(1);
 expect(screen.getByText('原因：可见原因')).toBeTruthy();
});
it('B1 Real repair responses do not populate the default diagnostics consumer cache',async()=>{
 const full=report(true);vi.stubGlobal('fetch',vi.fn(async()=>json({ok:true,repair:{kind:'recompute-derived',label:'重建'},verification:{verified:true,partial:false,summary:'完成',resolvedIssueIds:[],remainingIssueIds:[],checks:[]},report:full})));
 const q=new QueryClient({defaultOptions:{queries:{retry:false}}});const {result}=renderHook(()=>useDiagnosticsRepair('real'),{wrapper:({children})=><QueryClientProvider client={q}>{children}</QueryClientProvider>});
 await act(async()=>{await result.current.mutateAsync({issueId:'series.counter-drift',kind:'recompute-derived'});});expect(q.getQueryData(queryKeys.diagnostics)).toBeUndefined();expect(q.getQueryData<DiagnosticsReport>(diagnosticEvidenceKey('real'))!.issues[0]!.title).toBe(secret);
});
