import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, api } from '../../lib/api.js';
import { ToastProvider } from '../ui/toast.js';
import { DataManagementCard } from './DataManagementCard.js';
vi.mock('../../lib/queries.js', () => ({
 useConfig: () => ({ data: undefined }),
 useBackups: () => ({ data: { backups: [] }, refetch: vi.fn() }),
 useCoverStatus: () => ({ data: undefined, refetch: vi.fn() }),
}));
const preview={detectedFormat:'bangumi-analyzer-export',total:1,newSubjects:1,updatedSubjects:0,newCollections:0,updatedCollections:0,skipped:0,sampleTitles:['测试作品'],warnings:[]} as const;
function show(){const client=new QueryClient();return render(<QueryClientProvider client={client}><ToastProvider><DataManagementCard /></ToastProvider></QueryClientProvider>);}
function pick(container:HTMLElement){const file=new File(['{}'],'fixture.json',{type:'application/json'});Object.defineProperty(file,'text',{value:()=>Promise.resolve('{}')});fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[file]}});}
describe('数据导入异步边界',()=>{
 beforeEach(()=>vi.restoreAllMocks());
 it('读取预览期间锁定重新选择文件，返回后解锁',async()=>{
  let release!: (value: Awaited<ReturnType<typeof api.importPreview>>) => void;
  vi.spyOn(api,'importPreview').mockImplementation(()=>new Promise(r=>release=r));
  const {container}=show();pick(container);
  await waitFor(()=>expect((screen.getByRole('button',{name:'选择 JSON 文件'}) as HTMLButtonElement).disabled).toBe(true));
  release({...preview,sampleTitles:[...preview.sampleTitles],warnings:[]});
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button',{name:'取消'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect((screen.getByRole('button',{name:'选择 JSON 文件'}) as HTMLButtonElement).disabled).toBe(false);
 });
 it('提交事务期间取消与Esc不能伪装取消，完成后关闭',async()=>{
  vi.spyOn(api,'importPreview').mockResolvedValue({...preview,sampleTitles:[...preview.sampleTitles],warnings:[]});
  let release!: (value: Awaited<ReturnType<typeof api.importApply>>) => void;
  vi.spyOn(api,'importApply').mockImplementation(()=>new Promise(r=>release=r));
  const {container}=show();pick(container);await screen.findByRole('dialog');fireEvent.click(screen.getByRole('button',{name:'确认导入'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'取消'}) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.keyDown(document,{key:'Escape'});expect(screen.getByRole('dialog')).toBeTruthy();
  release({...preview,sampleTitles:[...preview.sampleTitles],warnings:[],applied:true,durationMs:1});
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 });
 it('连接失败时不能断言事务未提交，保留预览并提示结果未知',async()=>{
  vi.spyOn(api,'importPreview').mockResolvedValue({...preview,sampleTitles:[...preview.sampleTitles],warnings:[]});
  vi.spyOn(api,'importApply').mockRejectedValue(new ApiRequestError('无法连接',{code:'network_error'}));
  const {container}=show();pick(container);await screen.findByRole('dialog');fireEvent.click(screen.getByRole('button',{name:'确认导入'}));
  await screen.findByText('无法确认导入结果');expect(screen.getByRole('dialog')).toBeTruthy();
 });
 it('另一项备份请求结束不会提前解锁仍在读取的文件预览',async()=>{
  let release!: (value: Awaited<ReturnType<typeof api.importPreview>>) => void;
  vi.spyOn(api,'importPreview').mockImplementation(()=>new Promise(r=>release=r));
  vi.spyOn(api,'createBackup').mockResolvedValue({backup:{fileName:'fixture.db',sizeBytes:1,createdAt:'2026-10-12'},backups:[]});
  const {container}=show();pick(container);await waitFor(()=>expect((screen.getByRole('button',{name:'选择 JSON 文件'}) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(screen.getByRole('button',{name:'立即备份'}));await screen.findByText('备份已创建');
  expect((screen.getByRole('button',{name:'选择 JSON 文件'}) as HTMLButtonElement).disabled).toBe(true);
  release({...preview,sampleTitles:[...preview.sampleTitles],warnings:[]});await screen.findByRole('dialog');
 });
});
