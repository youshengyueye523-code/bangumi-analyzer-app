import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TimelineNavigator } from './TimelineNavigator.js';
beforeEach(() => vi.stubGlobal('PointerEvent', MouseEvent));
afterEach(() => vi.unstubAllGlobals());
function show(length = 720) {
  const commit = vi.fn(), range = { first: length - 12, last: length - 1 };
  const view = render(<TimelineNavigator range={range} domain={{first:0,last:length-1}} grain="month" snapshot="1" onCommit={commit}/>);
  return { commit, range, ...view };
}
it.each([720,2400])('endpoint %i preview is isolated, release commits once and cancellation suppresses late release', n => {
  const {commit,range}=show(n),first=screen.getByRole('slider',{name:'范围起点'}),last=screen.getByRole('slider',{name:'范围终点'});
  fireEvent.pointerDown(first,{button:0});fireEvent.change(first,{target:{value:n-20}});
  expect(commit).not.toHaveBeenCalled();expect((last as HTMLInputElement).value).toBe(String(range.last));
  fireEvent.pointerUp(first);fireEvent.lostPointerCapture(first);expect(commit).toHaveBeenCalledTimes(1);expect(commit).toHaveBeenLastCalledWith({first:n-20,last:n-1});
  commit.mockClear();fireEvent.pointerDown(first,{button:0});fireEvent.change(first,{target:{value:n-30}});fireEvent.keyDown(first,{key:'Escape'});fireEvent.change(first,{target:{value:n-35}});fireEvent.pointerUp(first);expect(commit).not.toHaveBeenCalled();
});
it('whole-range pan clamps without shrinking and pointercancel restores the committed range',()=>{
  const {commit}=show(),pan=screen.getByRole('slider',{name:'整体平移范围'});
  vi.spyOn(pan,'getBoundingClientRect').mockReturnValue({width:400} as DOMRect);
  fireEvent.pointerDown(pan,{button:0,clientX:200});fireEvent.pointerMove(pan,{clientX:-500});expect(commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(pan);expect(commit).toHaveBeenLastCalledWith({first:0,last:11});
  commit.mockClear();fireEvent.pointerDown(pan,{button:0,clientX:200});fireEvent.pointerMove(pan,{clientX:150});fireEvent.pointerCancel(pan);fireEvent.pointerUp(pan);expect(commit).not.toHaveBeenCalled();
});
it('keyboard previews until keyup and cancels an in-progress gesture on data identity change',()=>{
  const {commit,rerender,range}=show(),pan=screen.getByRole('slider',{name:'整体平移范围'});
  fireEvent.keyDown(pan,{key:'ArrowLeft'});expect(commit).not.toHaveBeenCalled();fireEvent.keyUp(pan,{key:'ArrowLeft'});expect(commit).toHaveBeenLastCalledWith({first:707,last:718});
  commit.mockClear();fireEvent.pointerDown(pan,{button:0,clientX:10});
  rerender(<TimelineNavigator range={range} domain={{first:0,last:719}} grain="month" snapshot="2" onCommit={commit}/>);
  fireEvent.pointerUp(pan);expect(commit).not.toHaveBeenCalled();
});
