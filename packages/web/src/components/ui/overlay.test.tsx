import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Dialog } from './overlay.js';

function Harness() {
  const [open, setOpen] = useState(false), [showTrigger, setShowTrigger] = useState(true);
  return <>
    {showTrigger ? <button onClick={() => setOpen(true)}>打开窗口</button> : null}
    <Dialog open={open} onOpenChange={setOpen} title="测试窗口" description="键盘焦点回归"
      footer={<><button onClick={() => setShowTrigger(false)}>移除入口</button><button onClick={() => setOpen(false)}>取消</button></>}>
      <input aria-label="内容" />
    </Dialog>
  </>;
}
describe('受控弹窗焦点', () => {
  it('Esc关闭后返回实际入口，键盘焦点保持在弹窗内', async () => {
    render(<Harness />);const user = userEvent.setup(), trigger = screen.getByText('打开窗口');
    await user.click(trigger);await screen.findByRole('dialog');
    await user.click(screen.getByText('取消'));await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard('{Enter}');await screen.findByRole('dialog');
    await user.tab();expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it('入口已被移除时不尝试恢复到脱离文档的节点', async () => {
    render(<Harness />);const user = userEvent.setup(), trigger = screen.getByText('打开窗口');
    await user.click(trigger);await user.click(screen.getByText('移除入口'));expect(trigger.isConnected).toBe(false);
    await user.keyboard('{Escape}');await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).not.toBe(trigger);
  });
});
