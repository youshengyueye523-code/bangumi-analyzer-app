import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FranchiseGovernanceDialog } from './FranchiseGovernance.js';
import { WITHHELD_EVIDENCE } from '../../lib/evidenceDisplay.js';

const state = vi.hoisted(() => ({
  query: { data: null as unknown, isLoading: false, isFetching: false, error: null as Error | null, refetch: vi.fn() },
  mutation: { isPending: false, error: null, mutate: vi.fn() },
}));
vi.mock('../../lib/queries.js', () => ({
  useFranchiseGovernancePreview: () => state.query,
  useFranchiseGovernance: () => state.mutation,
}));
const preview = { current: '人工名称', next: '自动名称', reason: '用户恢复', source: '人工决定', directlyChanges: [], derivedChanges: [], untouched: [], chain: [] };
function show() { return render(<FranchiseGovernanceDialog franchiseKey="fixture" target={{ kind: 'reset-franchise-title' }} onClose={vi.fn()} />); }
describe('治理预览就绪边界', () => {
  beforeEach(() => { vi.clearAllMocks(); state.query.data = { allowed: true, preview }; state.query.isFetching = false; state.query.error = null; });
  it('已有允许缓存但重新读取期间不能执行', () => {
    state.query.isFetching = true; show();
    const execute = screen.getByRole('button', { name: '执行修复' }) as HTMLButtonElement;
    expect(execute.disabled).toBe(true); fireEvent.click(execute); expect(state.mutation.mutate).not.toHaveBeenCalled();
  });
  it('已有允许缓存但读取失败不能执行，提供显式重试', () => {
    state.query.error = new Error('读取失败'); show();
    const execute = screen.getByRole('button', { name: '执行修复' }) as HTMLButtonElement;
    expect(execute.disabled).toBe(true); fireEvent.click(execute); expect(state.mutation.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' })); expect(state.query.refetch).toHaveBeenCalledOnce();
  });
  it('当前预览允许且无读取错误时仍可执行', () => {
    show(); const execute = screen.getByRole('button', { name: '执行修复' }) as HTMLButtonElement;
    expect(execute.disabled).toBe(false); fireEvent.click(execute); expect(state.mutation.mutate).toHaveBeenCalledOnce();
  });
  it('保护计划保留可见内容、禁用执行，而且不再提供旧模式入口', () => {
    state.query.data = { allowed: true, preview: {
      ...preview, current: WITHHELD_EVIDENCE, directlyChanges: [WITHHELD_EVIDENCE, '公开影响'], requiresRealEvidence: true,
    } };
    show();
    expect(screen.getByText('自动名称')).toBeTruthy();
    expect(screen.getByText('公开影响')).toBeTruthy();
    expect(screen.getByText(/受保护的历史引用，当前不可执行/)).toBeTruthy();
    const execute = screen.getByRole<HTMLButtonElement>('button', { name: '执行修复' });
    expect(execute.disabled).toBe(true);
    expect(screen.queryByText(/完整审计证据|默认显示安全审计摘要/)).toBeNull();
    fireEvent.click(execute);
    expect(state.mutation.mutate).not.toHaveBeenCalled();
  });
  it('拒绝展示意外返回的 Real 预览', () => {
    state.query.data = { allowed: true, presentation: { version: 1, mode: 'real', privacyApplied: false }, preview };
    show();
    expect(screen.getByText(/预览响应不符合当前隐私展示要求/)).toBeTruthy();
    expect(screen.queryByText('人工名称')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '执行修复' }).disabled).toBe(true);
  });
});
