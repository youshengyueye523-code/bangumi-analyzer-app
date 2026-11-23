import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { DiagnosticsReport, DiagnosticForeignKeyCheck } from '@bangumi-analyzer/shared';
import { DataCenterPage } from './DataCenterPage.js';
import { ToastProvider } from '../components/ui/toast.js';
function check(full=false):DiagnosticForeignKeyCheck {return {scope:'declared-sqlite-foreign-keys',status:'complete',tablesInspected:21,constraintCount:7,foreignKeysEnabled:true,violationCount:605,sampleLimit:20,samplesTruncated:true,groupCount:1,groupsTruncated:false,groups:[{table:'collections',parent:'subjects',columns:['subject_id'],parentColumns:['id'],foreignKeyId:0,schemaProtected:false,violationCount:605}],samples:[{table:'collections',parent:'subjects',columns:['subject_id'],parentColumns:['id'],foreignKeyId:0,schemaProtected:false,rowid:full?'9223372036854775806':null,identityProtected:!full}]};}
function report(full=false):DiagnosticsReport{return {coverage:{status:'complete',note:'全部注册检查已完成'},presentation:{version:1,mode:full?'real':'visible',privacyApplied:!full,note:'安全审计摘要'},generatedAt:'2026-11-05T15:00:00.000Z',durationMs:1,dataVersion:1,hideNsfw:true,lastMutation:{scope:null,at:null,detail:null},scope:{subjects:1,collections:605,relations:0,series:0,franchises:0,staleSeries:0},summary:{error:1,suspicious:0,'needs-review':0,uncertain:0,external:0,info:0,total:1},modules:[{id:'storage',label:'存储与数据库',description:'已声明外键',status:'error',checked:606,details:[],foreignKeys:check(full)}],issues:[{id:'storage.foreign-key-violations',detector:'storage.database',category:'存储与数据库',severity:'error',title:'存在违反已声明外键的记录',explanation:'仅有确定失效引用，不推断应补父或删子。',evidence:[],impact:[],affected:[],affectedCount:605,actions:[],foreignKeys:check(full),waiting:{kind:'manual-review',label:'需要人工核查或补取可靠来源',detail:'保留原始来源，修正后重新检测'}}]};}
function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ToastProvider><MemoryRouter><DataCenterPage /></MemoryRouter></ToastProvider></QueryClientProvider>);}
afterEach(()=>vi.unstubAllGlobals());
it('new issue explains scope, counts and bounded evidence without inventing a Repair',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>new Response(JSON.stringify(String(input).includes('/history')?{entries:[],total:0,filters:{entityKind:'all',actor:'all',limit:20},presentation:report().presentation}:report()),{headers:{'Content-Type':'application/json'}})));mount();await screen.findByText('存在违反已声明外键的记录');expect(screen.getAllByText(/21 张表 \/ 7 个约束/).length).toBeGreaterThan(0);expect(screen.getByText(/有界样本，非全量明细/)).toBeTruthy();expect(screen.getByText(/collections.subject_id → subjects.id/)).toBeTruthy();expect(screen.queryByRole('button',{name:'执行修复'})).toBeNull();expect(screen.queryByText(/rowid=/)).toBeNull();
});
it('does not expose precise foreign-key rowids from an unexpected Real report',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(report(true)),{headers:{'Content-Type':'application/json'}})));
 mount();
 await screen.findByText(/诊断响应缺少安全隐私投影证明/);
 expect(screen.queryByText(/rowid=9223372036854775806/)).toBeNull();
});
