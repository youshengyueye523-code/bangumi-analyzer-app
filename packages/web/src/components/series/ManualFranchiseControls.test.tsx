import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ManualFranchiseControls } from './ManualFranchiseControls.js';

const series = [
  { key: 'sr_1', title: '银河铁道' },
  { key: 'sr_2', title: '星のカービィ' },
  { key: 'sr_3', title: 'Cowboy Bebop' },
];
const franchises = [
  { key: 'fr_1', title: '宇宙列车家族', state: 'confirmed' },
  { key: 'fr_2', title: 'カービィの世界', state: 'candidate' },
  { key: 'fr_3', title: 'Cowboy Family', state: 'provisional' },
  { key: 'fr_4', title: '不能选择的否决家族', state: 'rejected' },
];
const endpoint = '/api/manual-franchises';

function mountControls(props: {family?:string;seriesKey?:string} = {}) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      if (path === endpoint + '/preview') return json({ token: 'mock-preview', affected: 2, choices: [] });
      if (path === endpoint) return json({ key: 'fr_created' });
    }
    if (path === '/api/series') return json({ series });
    if (path === '/api/franchises') return json({ franchises });
    throw new Error('Unexpected request: ' + path);
  }));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><MemoryRouter><Routes>
    <Route path="/" element={<ManualFranchiseControls {...props} />} />
    <Route path="/franchises/fr_created" element={<p>新家族详情</p>} />
  </Routes></MemoryRouter></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: props.family ? '管理人工归属' : props.seriesKey ? '指定家族' : '新建人工家族' }));
  return posts;
}

function setup() {
  const posts = mountControls();
  return {
    posts,
    list: within(screen.getByRole('group', { name: '选择至少两个系列' })),
    search: screen.getByRole('searchbox', { name: '搜索系列' }),
    preview: screen.getByRole<HTMLButtonElement>('button', { name: '预览新建' }),
    title: screen.getByRole('textbox', { name: '家族名称' }),
  };
}

afterEach(() => vi.unstubAllGlobals());

it('按中日英名称过滤，并在不同搜索结果间独立保留与取消选择', async () => {
  const { list, search, preview, title, posts } = setup();
  await list.findByRole('checkbox', { name: '银河铁道' });
  fireEvent.change(title, { target: { value: '测试家族' } });

  fireEvent.change(search, { target: { value: '河铁' } });
  expect(list.getAllByRole('checkbox')).toHaveLength(1);
  fireEvent.click(list.getByRole('checkbox', { name: '银河铁道' }));
  expect(screen.getByText('已选 1 个系列')).toBeTruthy();
  expect(preview.disabled).toBe(true);

  fireEvent.change(search, { target: { value: 'カービ' } });
  expect(list.getAllByRole('checkbox')).toHaveLength(1);
  fireEvent.click(list.getByRole('checkbox', { name: '星のカービィ' }));
  expect(screen.getByText('已选 2 个系列')).toBeTruthy();
  expect(preview.disabled).toBe(false);

  fireEvent.change(search, { target: { value: 'bEbO' } });
  expect(list.getAllByRole('checkbox')).toHaveLength(1);
  expect(list.getByRole('checkbox', { name: 'Cowboy Bebop' })).toBeTruthy();
  fireEvent.change(search, { target: { value: '没有此系列' } });
  expect(list.getByText('没有匹配的系列')).toBeTruthy();
  expect(screen.getByText('已选 2 个系列')).toBeTruthy();

  fireEvent.change(search, { target: { value: '' } });
  expect(list.getAllByRole('checkbox')).toHaveLength(3);
  expect(list.getAllByRole<HTMLInputElement>('checkbox', { checked: true }).map((item) => item.value)).toEqual(['sr_1', 'sr_2']);
  fireEvent.click(list.getByRole('checkbox', { name: '银河铁道' }));
  expect(list.getAllByRole<HTMLInputElement>('checkbox', { checked: true }).map((item) => item.value)).toEqual(['sr_2']);
  expect(screen.getByText('已选 1 个系列')).toBeTruthy();
  expect(preview.disabled).toBe(true);
  expect(posts).toEqual([]);
});

it('沿用新建预览与确认协议，原样传递跨搜索选中的唯一 Series 键', async () => {
  const { list, search, preview, title, posts } = setup();
  await list.findByRole('checkbox', { name: '银河铁道' });
  fireEvent.change(search, { target: { value: 'BEBOP' } });
  fireEvent.click(list.getByRole('checkbox', { name: 'Cowboy Bebop' }));
  fireEvent.change(search, { target: { value: '铁道' } });
  fireEvent.click(list.getByRole('checkbox', { name: '银河铁道' }));
  expect(preview.disabled).toBe(true);
  fireEvent.change(title, { target: { value: '模拟新建家族' } });
  expect(preview.disabled).toBe(false);
  const command = { action: 'create', title: '模拟新建家族', series: ['sr_3', 'sr_1'] };
  fireEvent.click(preview);
  const confirm = await screen.findByRole('button', { name: '确认执行' });
  expect(posts).toEqual([{ path: endpoint + '/preview', body: command }]);
  expect((search as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
  fireEvent.click(confirm);
  await screen.findByText('新家族详情');
  expect(posts[1]).toEqual({ path: endpoint, body: { command, token: 'mock-preview' } });
});

it('已有家族选择系列仍为单选，搜索不丢选择，清除与系列键预览正确', async () => {
  const posts = mountControls({ family: 'fr_18' });
  const list = within(screen.getByRole('radiogroup', { name: '选择要添加的系列' }));
  const search = screen.getByRole('searchbox', { name: '搜索系列' });
  const preview = screen.getByRole<HTMLButtonElement>('button', { name: '预览添加' });
  const clear = screen.getByRole<HTMLButtonElement>('button', { name: '清除选择' });
  await list.findByRole('radio', { name: '银河铁道' });
  expect(preview.disabled).toBe(true);
  expect(clear.disabled).toBe(true);
  fireEvent.change(search, { target: { value: '河铁' } });
  fireEvent.click(list.getByRole('radio', { name: '银河铁道' }));
  fireEvent.change(search, { target: { value: 'カービ' } });
  expect(screen.getByText('已选：银河铁道')).toBeTruthy();
  expect(list.getAllByRole('radio')).toHaveLength(1);
  fireEvent.click(list.getByRole('radio', { name: '星のカービィ' }));
  fireEvent.change(search, { target: { value: 'bEbO' } });
  expect(list.getByRole('radio', { name: 'Cowboy Bebop' })).toBeTruthy();
  fireEvent.change(search, { target: { value: '没有这样的系列' } });
  expect(list.getByText('没有匹配的系列')).toBeTruthy();
  fireEvent.change(search, { target: { value: '' } });
  expect(list.getAllByRole('radio')).toHaveLength(3);
  expect(list.getAllByRole<HTMLInputElement>('radio', { checked: true }).map((x) => x.value)).toEqual(['sr_2']);
  fireEvent.click(clear);
  expect(preview.disabled).toBe(true);
  expect(list.queryByRole('radio', { checked: true })).toBeNull();
  fireEvent.click(list.getByRole('radio', { name: 'Cowboy Bebop' }));
  fireEvent.click(preview);
  await screen.findByRole('button', { name: '确认执行' });
  expect(posts).toEqual([{ path: endpoint + '/preview', body: { action: 'attach', franchise: 'fr_18', series: 'sr_3' } }]);
  expect((search as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(list.getByRole<HTMLInputElement>('radio', { name: 'Cowboy Bebop' }).checked).toBe(true);
});

it('Series 指定家族保留过滤和单选，预览发送家族键而不是系列键', async () => {
  const posts = mountControls({ seriesKey: 'sr_99' });
  const list = within(screen.getByRole('radiogroup', { name: '目标家族' }));
  const search = screen.getByRole('searchbox', { name: '搜索家族' });
  const preview = screen.getByRole<HTMLButtonElement>('button', { name: '预览添加' });
  await list.findByRole('radio', { name: '宇宙列车家族' });
  expect(list.getAllByRole('radio')).toHaveLength(3);
  expect(list.queryByRole('radio', { name: '不能选择的否决家族' })).toBeNull();
  expect(preview.disabled).toBe(true);
  fireEvent.change(search, { target: { value: '列车' } });
  fireEvent.click(list.getByRole('radio', { name: '宇宙列车家族' }));
  fireEvent.change(search, { target: { value: 'カービ' } });
  expect(screen.getByText('已选：宇宙列车家族')).toBeTruthy();
  expect(list.getAllByRole('radio')).toHaveLength(1);
  fireEvent.change(search, { target: { value: 'bOy fa' } });
  fireEvent.click(list.getByRole('radio', { name: 'Cowboy Family' }));
  fireEvent.change(search, { target: { value: '' } });
  expect(list.getAllByRole<HTMLInputElement>('radio', { checked: true }).map((x) => x.value)).toEqual(['fr_3']);
  fireEvent.click(screen.getByRole('button', { name: '清除选择' }));
  expect(preview.disabled).toBe(true);
  fireEvent.click(list.getByRole('radio', { name: 'カービィの世界' }));
  fireEvent.click(preview);
  await screen.findByRole('button', { name: '确认执行' });
  expect(posts).toEqual([{ path: endpoint + '/preview', body: { action: 'attach', franchise: 'fr_2', series: 'sr_99' } }]);
});
