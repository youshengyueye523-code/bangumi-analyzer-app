import {useRef,useState} from 'react';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import {Dialog} from './overlay.js';
function AsyncOpened(){
 const ref=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(true);
 return <><button ref={ref}>异步入口</button><Dialog open={open} onOpenChange={setOpen} returnFocusRef={ref} title="异步预览" description="等待数据后打开" footer={<button onClick={()=>setOpen(false)}>取消预览</button>}>预览内容</Dialog></>;
}
describe('异步弹窗入口焦点',()=>{
 it('打开时焦点在body也能返回明确入口，原默认恢复策略保留',async()=>{
  render(<AsyncOpened/>);await screen.findByRole('dialog');fireEvent.click(screen.getByText('取消预览'));
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByText('异步入口')));
 });
});
