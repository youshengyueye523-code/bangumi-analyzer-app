import {fireEvent, render, screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {describe,expect,it,vi} from 'vitest';
import type {ProfileAiStatus} from '@bangumi-analyzer/shared';
import {AiPanel} from './AiPanel.js';

function panel(props: Record<string,unknown> = {}) {
  const onGenerate=vi.fn(async()=>{}),onStatusRetry=vi.fn();
  const view=render(<MemoryRouter><AiPanel {...{status:undefined,error:null,generating:false,onGenerate,...props,onStatusRetry}} /></MemoryRouter>);
  return {...view,onGenerate,onStatusRetry};
}
describe('AI只读状态与生成独立',()=>{
  it('读取中不能宣称未配置或显示配置入口',()=>{
    panel({statusLoading:true});
    expect(screen.getByText(/正在读取 AI 状态/)).toBeTruthy();
    expect(screen.queryByText(/当前未启用 AI 总结/)).toBeNull();
    expect(screen.queryByText('去配置 AI')).toBeNull();
  });
  it('读取失败重试只读状态，不调用生成',()=>{
    const {onGenerate,onStatusRetry}=panel({statusError:new Error('状态读取失败')});
    expect(screen.getByText(/无法读取 AI 状态/)).toBeTruthy();
    expect(screen.queryByText('去配置 AI')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'重试读取 AI 状态'}));
    expect(onStatusRetry).toHaveBeenCalledOnce();expect(onGenerate).not.toHaveBeenCalled();
  });
  it('旧configured缓存不能使读取失败时的生成按钮可用',()=>{
    panel({status:{configured:true,report:null} as ProfileAiStatus,statusError:new Error('503')});
    expect(screen.queryByRole('button',{name:'生成总结'})).toBeNull();
    expect((screen.getByRole('button',{name:'重试读取 AI 状态'}) as HTMLButtonElement).disabled).toBe(false);
  });
  it('明确未配置仍提供原配置入口',()=>{
    panel({status:{configured:false,reason:'未启用',report:null} as ProfileAiStatus});
    expect(screen.getByText('去配置 AI')).toBeTruthy();
  });
  it('已配置正常状态恢复生成入口，但状态重试不构成生成',()=>{
    const {onGenerate}=panel({status:{configured:true,report:null} as ProfileAiStatus});
    expect((screen.getByRole('button',{name:'生成总结'}) as HTMLButtonElement).disabled).toBe(false);expect(onGenerate).not.toHaveBeenCalled();
  });
  it('历史报告可通过深色菜单切换，不会触发生成',async ()=>{
    const previous = {id:2,model:'fixture',createdAt:'2026-11-01T12:00:00Z',upToDate:false};
    const onSelectReport=vi.fn();
    const {onGenerate}=panel({onSelectReport,status:{enabled:true,configured:true,reports:[previous,{...previous,id:1,model:'fixture-long-name'}],report:{
      ...previous, output:{verdict:'旧总结',sections:[],uncertainties:[],surprises:[]},usage:{}
    }}});
    expect(screen.getByText('历史总结 · 原样保留')).toBeTruthy();
    expect(screen.getByText('旧总结')).toBeTruthy();
    expect(screen.queryByText('去配置 AI')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button',{name:/选择 AI 总结/}),{key:'ArrowDown'});
    expect((await screen.findByRole('menu')).className).toContain('bg-[#111827]');
    fireEvent.click(screen.getByRole('menuitem',{name:/fixture-long-name/}));
    expect(onSelectReport).toHaveBeenCalledWith(1);
    expect(onGenerate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'生成总结'}));
    expect(onGenerate).toHaveBeenCalledWith(false);
  });
  it('未生成与读取失败分开显示，失败恢复只读不重发',()=>{
    const {onStatusRetry,onGenerate}=panel({error:new Error('结果未知'),status:{configured:true,reports:[],report:null}});
    expect(screen.getByText(/尚未生成 AI 总结/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'读取报告状态（不重新生成）'}));
    expect(onStatusRetry).toHaveBeenCalledOnce();
    expect(onGenerate).not.toHaveBeenCalled();
  });
  it('重新读取状态时不冒充实时结果',()=>{
    panel({statusLoading:true,status:{configured:true,report:{output:{verdict:'旧总结'}}}});
    expect(screen.queryByText('旧总结')).toBeNull();
  });
});
