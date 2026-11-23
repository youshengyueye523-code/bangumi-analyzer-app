import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { SubjectListItem } from '@bangumi-analyzer/shared';
import { SubjectCard, SubjectRow } from './cards.js';

const item: SubjectListItem = {
  id: 253,
  name: 'Hyouka',
  nameCn: '冰菓',
  cover: 'https://lain.bgm.tv/pic/cover/l/1.jpg',
  coverCached: false,
  platform: 'TV',
  format: 'TV',
  date: '2012-04-22',
  year: 2012,
  month: 4,
  season: '春',
  yearQuarter: '2012Q2',
  totalEpisodes: 22,
  collectionType: 2,
  rate: 10,
  epStatus: 22,
  watchedEpisodes: 22,
  progress: 1,
  comment: '很好',
  userTags: [],
  bgmScore: 7.9,
  bgmRank: 100,
  ratingTotal: 12000,
  collectionTotal: 20000,
  delta: 2.1,
  tags: ['日常', '推理', '校园', '轻小说'],
  studios: ['京都动画'],
  directors: ['武本康弘'],
  collectionUpdatedAt: '2024-01-01T00:00:00+08:00',
  firstSeenAt: '2024-01-01T00:00:00Z',
  detailSyncedAt: '2024-01-02T00:00:00Z',
  seriesKey: 'bgm:253',
};

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('条目卡片与列表行', () => {
  it('卡片展示中文名、状态、评分与集数', () => {
    renderWithRouter(<SubjectCard item={item} />);
    expect(screen.getByText('冰菓')).toBeTruthy();
    expect(screen.getByText('Hyouka')).toBeTruthy();
    expect(screen.getByText('看过')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('2012')).toBeTruthy();
    expect(screen.getByText('22 集')).toBeTruthy();
    expect(screen.getByText('+2.1')).toBeTruthy();
  });

  it('卡片链接到详情页，并渲染封面代理地址', () => {
    renderWithRouter(<SubjectCard item={item} />);
    const links = screen.getAllByRole('link');
    expect(links.some((link) => link.getAttribute('href') === '/subjects/253')).toBe(true);
    const image = screen.getByAltText('冰菓 封面') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('/api/covers/253');
    expect(image.getAttribute('loading')).toBe('lazy');
  });

  it('没有筛选回调时标签只是文本，最多展示 3 个', () => {
    renderWithRouter(<SubjectCard item={item} />);
    expect(screen.getByText('日常')).toBeTruthy();
    expect(screen.getByText('推理')).toBeTruthy();
    expect(screen.getByText('校园')).toBeTruthy();
    expect(screen.queryByText('轻小说')).toBeNull();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '日常' })).toBeNull();
  });

  it('卡片详情与标签筛选为独立的键盘可操作控件', async () => {
    const user = userEvent.setup();
    const onTagClick = vi.fn();
    function Location() {
      const { pathname } = useLocation();
      return <output>{pathname}</output>;
    }
    renderWithRouter(<><SubjectCard item={item} onTagClick={onTagClick} /><Location /></>);
    const link = screen.getByRole('link');
    const tag = within(screen.getByRole('group', { name: '按标签筛选收藏库' })).getByRole('button', { name: '日常' });
    expect(tag.closest('a')).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(link);
    await user.tab();
    expect(document.activeElement).toBe(tag);
    await user.keyboard(' ');
    expect(onTagClick).toHaveBeenCalledExactlyOnceWith('日常');
    expect(screen.getByText('/', { exact: true })).toBeTruthy();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(link);
    await user.keyboard('{Enter}');
    expect(screen.getByText('/subjects/253', { exact: true })).toBeTruthy();
    expect(onTagClick).toHaveBeenCalledTimes(1);
  });

  it('未评分时不会显示 0 分', () => {
    renderWithRouter(<SubjectCard item={{ ...item, rate: 0, delta: null }} />);
    expect(screen.queryByText('0')).toBeNull();
    // 大众评分仍然展示
    expect(screen.getByText('7.9')).toBeTruthy();
  });

  it('列表行展示进度百分比与大众评分', () => {
    renderWithRouter(<SubjectRow item={{ ...item, progress: 0.5, watchedEpisodes: 11 }} />);
    expect(screen.getByText('冰菓')).toBeTruthy();
    expect(screen.getByText('11/22 集')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('大众 7.9')).toBeTruthy();
  });
});
