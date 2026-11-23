import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {api} from './api.js';
import {useSyncController} from './queries.js';
const idle={running:false,progress:null,lastRun:null,lastSuccessfulSyncAt:null};
function Controls({name}:{name:string}){
 const task=useSyncController();
 return <div><output data-testid={name}>{task.starting?'starting':task.cancelling?'cancelling':task.statusError?'unknown':'ready'}</output><button onClick={()=>void task.start({mode:'enrich'})}>{name}启动</button><button onClick={()=>void task.cancel()}>{name}取消</button></div>;
}
function show(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><Controls name="设置"/><Controls name="顶栏"/></QueryClientProvider>);}
describe('共享同步请求边界',()=>{
 beforeEach(()=>{vi.restoreAllMocks();vi.spyOn(api,'syncStatus').mockResolvedValue(idle);});
 it('两个入口启动等待时共享pending，重复调用只有一个请求',async()=>{
  let release!: (value: Awaited<ReturnType<typeof api.startSync>>) => void;
  const start=vi.spyOn(api,'startSync').mockImplementation(()=>new Promise(r=>release=r));show();
  fireEvent.click(screen.getByText('设置启动'));fireEvent.click(screen.getByText('顶栏启动'));
  await waitFor(()=>expect(start).toHaveBeenCalledOnce());
  await waitFor(()=>expect(screen.getByTestId('顶栏').textContent).toBe('starting'));
  release({status:idle} as Awaited<ReturnType<typeof api.startSync>>);
  await waitFor(()=>expect(screen.getByTestId('顶栏').textContent).toBe('ready'));
 });
 it('取消等待也共享pending且不重复请求',async()=>{
  let release!: (value: Awaited<ReturnType<typeof api.cancelSync>>) => void;
  const cancel=vi.spyOn(api,'cancelSync').mockImplementation(()=>new Promise(r=>release=r));show();
  fireEvent.click(screen.getByText('设置取消'));fireEvent.click(screen.getByText('顶栏取消'));
  await waitFor(()=>expect(cancel).toHaveBeenCalledOnce());await waitFor(()=>expect(screen.getByTestId('设置').textContent).toBe('cancelling'));
  release({cancelled:false,status:idle});await waitFor(()=>expect(screen.getByTestId('顶栏').textContent).toBe('ready'));
 });
 it('状态读取失败表达未知，而非默认为已空闲',async()=>{
  vi.spyOn(api,'syncStatus').mockRejectedValue(new Error('状态读取失败'));show();
  await waitFor(()=>expect(screen.getByTestId('设置').textContent).toBe('unknown'));
 });
});
