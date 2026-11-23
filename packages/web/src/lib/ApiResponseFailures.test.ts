import {afterEach,describe,expect,it,vi} from 'vitest';
import {api,ApiRequestError} from './api.js';
afterEach(()=>vi.unstubAllGlobals());
const rejected = async(promise: Promise<unknown>) => {try{await promise;throw new Error('Expected a failure');}catch(e){expect(e).toBeInstanceOf(ApiRequestError);return e as ApiRequestError;}};
describe('成功响应不可读不等于未提交',()=>{
  it.each(['confirm','reopen','reject'] as const)('%s成功体截断保留HTTP与结果未知',async(action)=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"ok":',{status:200})));
    const call=action==='confirm'?api.confirmFranchise:action==='reopen'?api.reopenFranchise:api.rejectFranchise;
    const error=await rejected(call('fr_1'));
    expect(error.code).toBe('response_unreadable');expect(error.status).toBe(200);expect(error.resultUnknown).toBe(true);expect(error.dataIntact).toBe(false);expect(error.cause).toBeInstanceOf(SyntaxError);
  });
  it.each([true,false])('body读取中断，readOnly=%s',async(readOnly)=>{
    const response=new Response('{}',{status:200});vi.spyOn(response,'text').mockRejectedValue(new TypeError('body interrupted'));
    vi.stubGlobal('fetch',vi.fn(async()=>response));
    const e=await rejected(readOnly?api.profileAiStatus():api.reopenFranchise('fr_1'));
    expect(e.status).toBe(200);expect(e.resultUnknown).toBe(!readOnly);expect(e.dataIntact).toBe(readOnly);
  });
  it('GET非法JSON是读取错误，不推断写入',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('invalid',{status:200})));
    const e=await rejected(api.profileAiStatus());expect(e.code).toBe('response_unreadable');expect(e.resultUnknown).toBe(false);expect(e.dataIntact).toBe(true);
  });
  it('只读导入Preview虽用POST也不推断提交',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('invalid',{status:200})));
    const e=await rejected(api.importPreview({}));expect(e.resultUnknown).toBe(false);expect(e.dataIntact).toBe(true);
  });
  it.each(['{','{"error":{"message":"明确失败"}}'])('明确503保持HTTP失败，即使错误体损坏：%s',async(body)=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{status:503})));
    const e=await rejected(api.reopenFranchise('fr_1'));expect(e.status).toBe(503);expect(e.resultUnknown).toBe(false);
  });
  it.each([204,200])('现行允许的空响应%s保持兼容',async(status)=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status})));
    expect(await api.reopenFranchise('fr_1')).toBeUndefined();
  });
  it('完整JSON响应保持原值',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"reopened":true}')));
    expect(await api.reopenFranchise('fr_1')).toEqual({reopened:true});
  });
  it('头前断连仍是network_error且写入结果未知',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new TypeError('network lost');}));
    const e=await rejected(api.reopenFranchise('fr_1'));expect(e.code).toBe('network_error');expect(e.resultUnknown).toBe(true);
  });
});
