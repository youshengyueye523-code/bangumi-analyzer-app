import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileSnapshotSummary } from '@bangumi-analyzer/shared';
import { describe, expect, it, vi } from 'vitest';
import { SnapshotPanel } from './SnapshotPanel.js';

const snapshot = {
  id: 1, stageLabel: '阶段甲', createdAt: '2026-10-11T00:00:00Z', visibility: 'real',
  note: '', source: '', rankFrom: null, rankTo: null, collectionCount: 2, ratedCount: 1,
  averageRate: 8, candidateCount: null, hasCandidateList: false,
} satisfies ProfileSnapshotSummary;
const defaults = { snapshots: [], compare: null, compareReason: '需要两个阶段', creating: false, onCreate: async () => {}, onDelete: async () => {} };

describe('阶段快照失败反馈', () => {
  it('各字段由可见标签命名，点击标签可聚焦对应字段', async () => {
    render(<SnapshotPanel {...defaults} />);const user = userEvent.setup();await user.click(screen.getByText('保存当前阶段'));
    for (const name of ['阶段名称', '备注（可选）', '数据来源（可选）', 'Rank 起始（可选）', 'Rank 结束（可选）', '候选清单（可选）']) {
      const input = screen.getByRole('textbox', { name });
      await user.click(screen.getByText(name, { exact: true }));expect(document.activeElement).toBe(input);
    }
  });
  it.each([
    { label: 'Rank 起始（可选）', value: 'abc', field: 'rankFrom' },
    { label: 'Rank 结束（可选）', value: 'Infinity', field: 'rankTo' },
  ])('$label 非有限数字不被当成空值提交，纠正后保留合法数字', async ({ label, value, field }) => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<SnapshotPanel {...defaults} onCreate={onCreate} />);const user = userEvent.setup();await user.click(screen.getByText('保存当前阶段'));
    const input = screen.getByRole('textbox', { name: label });await user.type(input, value);await user.click(screen.getByText('保存快照'));
    await screen.findByRole('alert');expect(onCreate).not.toHaveBeenCalled();expect((input as HTMLInputElement).value).toBe(value);
    await user.clear(input);await user.type(input, '10');await user.click(screen.getByText('保存快照'));await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onCreate.mock.calls[0]?.[0][field]).toBe(10);
  });
  it('创建失败保留输入，明确提示并可重试成功，不产生未处理拒绝', async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new Error('保存失败')).mockResolvedValue(undefined);
    render(<SnapshotPanel {...defaults} onCreate={onCreate} />);
    const user = userEvent.setup();
    await user.click(screen.getByText('保存当前阶段'));
    const dialog = screen.getByRole('dialog'), input = within(dialog).getByPlaceholderText('第 1 阶段');
    await user.type(input, '重试阶段');await user.click(within(dialog).getByText('保存快照'));
    await within(dialog).findByRole('alert');
    expect((input as HTMLInputElement).value).toBe('重试阶段');
    await user.click(within(dialog).getByText('重试'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[1]?.[0].stageLabel).toBe('重试阶段');
  });

  it('删除等待期间禁止重复操作，失败保留快照并可重试同一ID', async () => {
    let reject!: (error: Error) => void;
    const onDelete = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
    render(<SnapshotPanel {...defaults} snapshots={[snapshot]} onDelete={onDelete} />);
    const user = userEvent.setup(), button = screen.getByRole('button', { name: '删除快照 阶段甲' });
    await user.click(button);expect((button as HTMLButtonElement).disabled).toBe(true);
    reject(new Error('删除失败'));
    await screen.findByRole('alert');expect(screen.getByText('阶段甲')).toBeDefined();
    await user.click(screen.getByText('重试'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(onDelete.mock.calls).toEqual([[1], [1]]);
  });

  it('读取失败不伪装空快照或永久等待，列表和比较可分别重试', async () => {
    const snapshotsRetry = vi.fn(), compareRetry = vi.fn();
    render(<SnapshotPanel {...defaults} snapshotsError={new Error('历史读取失败')} onRetrySnapshots={snapshotsRetry} compareError={new Error('比较读取失败')} onRetryCompare={compareRetry} />);
    expect(screen.queryByText(/还没有阶段快照/)).toBeNull();
    expect(screen.queryByText(/等待下一阶段复盘数据/)).toBeNull();
    const user = userEvent.setup(), alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    await user.click(within(alerts[0]!).getByText('重试'));await user.click(within(alerts[1]!).getByText('重试'));
    expect(snapshotsRetry).toHaveBeenCalledTimes(1);expect(compareRetry).toHaveBeenCalledTimes(1);
  });
});
