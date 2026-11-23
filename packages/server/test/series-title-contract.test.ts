import { beforeEach, describe, expect, it } from 'vitest';
import { one, run } from '../src/db/index.js';
import {
  applySeriesTitleOverride,
  recomputeSeries,
  resetSeriesTitleOverride,
} from '../src/db/series.js';
import { getSeriesDetail, listSeries } from '../src/db/query.js';
import { getDiagnosticsReport } from '../src/diagnostics/report.js';
import { resolveTitle } from '../src/series/title.js';
import { resetDatabase } from './helpers.js';

function seedSubject(
  id: number,
  nameCn: string,
  options: { year?: number; format?: string; collected?: boolean; tags?: string[] } = {},
): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, year, format, tag_names, created_at, updated_at)
     VALUES (:id, :name, :nameCn, :year, :format, :tags, :ts, :ts)`,
    {
      id,
      name: nameCn,
      nameCn,
      year: options.year ?? 2000 + (id % 25),
      format: options.format ?? 'TV',
      tags: JSON.stringify(options.tags ?? []),
      ts: '2026-11-23T00:00:00.000Z',
    },
  );
  if (options.collected !== false) {
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, first_seen_at, synced_at)
       VALUES (:id, 2, 2, 8, :ts, :ts)`,
      { id, ts: '2026-11-23T00:00:00.000Z' },
    );
  }
}

function seedRelation(
  from: number,
  to: number,
  relation: string,
  toName = '',
): void {
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:from, :to, :relation, 2, :name, :nameCn, :ts)`,
    { from, to, relation, name: toName, nameCn: toName, ts: '2026-11-23T00:00:00.000Z' },
  );
}

describe('Series 自动标题判定产品契约（Stage 2.6）', () => {
  beforeEach(() => resetDatabase());

  it('稳定单成员系列自动确定为 resolved，保留 anchor 来源且不伪装为 manual', () => {
    seedSubject(101, '独立原创动画', { year: 2024 });
    recomputeSeries();

    const list = listSeries({ includeSingletons: true });
    expect(list).toHaveLength(1);
    const detail = getSeriesDetail(list[0]!.key)!;
    expect(detail.title).toBe('独立原创动画');
    expect(detail.titleState).toBe('resolved');
    expect(detail.titleSource).toBe('anchor');
    expect(detail.titleConfirmedAt).toBeNull();

    const report = getDiagnosticsReport({ refresh: true });
    expect(report.issues.find((i) => i.id === 'titles.provisional')).toBeUndefined();
    expect(report.issues.filter((i) => i.detector === 'titles.resolver' && i.severity === 'uncertain')).toHaveLength(0);
  });

  it('稳定多成员系列：核心成员一致但含大量未收藏衍生成员时，仍自动确定为 resolved（哆啦A梦/少女与战车模式）', () => {
    seedSubject(201, '少女与战车', { year: 2012, tags: ['少女与战车'] });
    seedSubject(202, '少女与战车 剧场版', { year: 2015, tags: ['少女与战车'] });
    seedSubject(203, '少女与战车 最终章 第1话', { year: 2017, tags: ['少女与战车'] });
    seedSubject(204, '少女与战车 最终章 第2话', { year: 2019, tags: ['少女与战车'] });
    seedSubject(205, '少女与战车 最终章 第3话', { year: 2021, tags: ['少女与战车'] });
    seedRelation(201, 202, '续集');
    seedRelation(202, 203, '续集');
    seedRelation(203, 204, '续集');
    seedRelation(204, 205, '续集');
    // 附带 6 个未收藏衍生成员，不应稀释核心成员品牌共识
    for (let i = 1; i <= 6; i += 1) {
      seedRelation(201, 250 + i, '番外篇', `大洗女子学园衍生短片 ${i}`);
    }
    recomputeSeries();

    const detail = getSeriesDetail(listSeries({ includeSingletons: true })[0]!.key)!;
    expect(detail.title).toBe('少女与战车');
    expect(detail.titleState).toBe('resolved');
    expect(detail.titleSource).toBe('brand:members');
    expect(getDiagnosticsReport({ refresh: true }).issues.find((i) => i.id === 'titles.provisional')).toBeUndefined();
  });

  it('含拉丁品牌、闭合括号与空格差异的系列不会被结构过滤误伤（FLCL / 攻壳机动队 / 括号标题）', () => {
    const flcl = resolveTitle({
      members: [
        { title: 'FLCL', core: true, tags: [] },
        { title: 'FLCL Alternative', core: true, tags: [] },
      ],
      tagFrequency: new Map(),
      rareTagLimit: 10,
      isExcludedTag: () => true,
      anchorTitle: 'FLCL Alternative',
      singleton: false,
      fallbackLabel: '未确认',
    });
    expect(flcl.title).toBe('FLCL');
    expect(flcl.state).toBe('resolved');

    const gits = resolveTitle({
      members: [
        { title: '攻壳机动队 STAND ALONE COMPLEX', core: true, tags: ['攻壳机动队'] },
        { title: '攻壳机动队 S.A.C. 2nd GIG', core: true, tags: ['攻壳机动队'] },
        { title: '攻壳机动队 S.A.C. Solid State Society', core: true, tags: ['攻壳机动队'] },
        { title: '攻壳机动队 STAND ALONE COMPLEX 笑面男', core: true, tags: [] },
      ],
      tagFrequency: new Map([['攻壳机动队', 3]]),
      rareTagLimit: 10,
      isExcludedTag: () => false,
      anchorTitle: '攻壳机动队 STAND ALONE COMPLEX',
      singleton: false,
      fallbackLabel: '未确认',
    });
    expect(gits.title).toBe('攻壳机动队');
    expect(gits.state).toBe('resolved');

    const bracket = resolveTitle({
      members: [
        { title: '我们不可能成为恋人！绝对不行。 (※似乎可行？)', core: true, tags: [] },
        { title: '我们不可能成为恋人！绝对不行。 (※似乎可行？) 〜再次闪耀！〜', core: true, tags: [] },
      ],
      tagFrequency: new Map(),
      rareTagLimit: 10,
      isExcludedTag: () => true,
      anchorTitle: '我们不可能成为恋人！绝对不行。 (※似乎可行？)',
      singleton: false,
      fallbackLabel: '未确认',
    });
    expect(bracket.title).toBe('我们不可能成为恋人！绝对不行。 (※似乎可行？)');
    expect(bracket.state).toBe('resolved');
  });

  it('真正证据不足与稀疏 relation-only 场景仍保持 provisional（不强行确定）', () => {
    // 场景 A：多成员完全不同标题、无共同品牌标签
    seedSubject(301, '麻辣教师GTO', { year: 1999 });
    seedSubject(302, '湘南纯爱组', { year: 1994 });
    seedRelation(302, 301, '续集');
    seedRelation(301, 302, '前传');

    // 场景 B：大量未收藏 relation-only 短片且仅有 2 部带标签（类猫和老鼠稀疏场景）
    seedSubject(401, '猫的协奏曲', { year: 1947, tags: ['猫和老鼠'] });
    seedSubject(402, '猫和老鼠（1965年电视版）', { year: 1965, tags: ['猫和老鼠'] });
    seedRelation(401, 402, '全集');
    const distinctShorts = [
      '扬基都德鼠',
      '老鼠的麻烦',
      '请安静！',
      '小孤儿',
      '两个火枪鼠',
      '老鼠约翰',
      '甜蜜的家',
      '圣诞前夜',
      '午夜零食',
      '保龄球之夜',
      '夏日海滩',
      '冬季溜冰',
    ];
    distinctShorts.forEach((shortTitle, idx) => {
      seedRelation(401, 451 + idx, '全集', shortTitle);
    });

    recomputeSeries();

    const allSeries = listSeries({ includeSingletons: true });
    expect(allSeries).toHaveLength(2);
    for (const s of allSeries) {
      expect(s.titleState).toBe('provisional');
    }
    const report = getDiagnosticsReport({ refresh: true });
    const provisional = report.issues.find((i) => i.id === 'titles.provisional');
    expect(provisional?.affectedCount).toBe(2);
  });

  it('候选存在实质冲突时判定为 contested，并在数据中枢报 titles.contested', () => {
    const contested = resolveTitle({
      members: [
        { title: '星际迷航 第一部', core: true, tags: ['太空史诗系列'] },
        { title: '星际迷航 第二部', core: true, tags: ['太空史诗系列'] },
        { title: '银河传说 特别篇', core: true, tags: ['太空史诗系列'] },
        { title: '未知外传', core: false, tags: [] },
      ],
      tagFrequency: new Map([['太空史诗系列', 3]]),
      rareTagLimit: 10,
      isExcludedTag: () => false,
      anchorTitle: '星际迷航 第一部',
      singleton: false,
      fallbackLabel: '未确认',
    });
    expect(contested.state).toBe('contested');

    // 数据库与诊断联动：写入 contested 后数据中枢明确提示 titles.contested
    seedSubject(501, '冲突作品A', { year: 2020 });
    recomputeSeries();
    const key = listSeries({ includeSingletons: true })[0]!.key;
    run(`UPDATE series_entities SET title_state = 'contested' WHERE key = :key`, { key });
    const report = getDiagnosticsReport({ refresh: true });
    const issue = report.issues.find((i) => i.id === 'titles.contested');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('needs-review');
    expect(issue!.affectedCount).toBe(1);
  });

  it('用户可随时修改自动确定标题，人工锁跨同步保留且不重复写入 proposed 候选', () => {
    seedSubject(601, '自动系列', { year: 2021 });
    seedSubject(602, '自动系列 第二季', { year: 2022 });
    seedRelation(601, 602, '续集');
    recomputeSeries();

    const key = listSeries({ includeSingletons: true })[0]!.key;
    expect(getSeriesDetail(key)!.titleState).toBe('resolved');

    // 用户随时覆盖自动确定的标题
    const override = applySeriesTitleOverride(key, { mode: 'custom', title: '我的自定义系列名' });
    expect(override.ok).toBe(true);

    // 后续同步新增成员：人工锁不可被覆盖，且系统建议不重复写入
    seedSubject(603, '自动系列 第三季', { year: 2023 });
    seedRelation(602, 603, '续集');
    recomputeSeries();

    const locked = getSeriesDetail(key)!;
    expect(locked.title).toBe('我的自定义系列名');
    expect(locked.titleState).toBe('manual');
    const brandCands = locked.titleCandidates.filter((c) => c.title === '自动系列' && c.source === 'brand:members');
    expect(brandCands).toHaveLength(1);

    // 恢复自动解析后回到自动确定态
    expect(resetSeriesTitleOverride(key).ok).toBe(true);
    const restored = getSeriesDetail(key)!;
    expect(restored.title).toBe('自动系列');
    expect(restored.titleState).toBe('resolved');
  });

  it('同步后证据增强可从 provisional 自动升级为 resolved（历史已解决不计入当前不确定），重复同步幂等', () => {
    // 初始仅 2 个不同名成员 → provisional
    seedSubject(701, '新系列起点', { year: 2020 });
    seedSubject(702, '番外别名', { year: 2021 });
    seedRelation(701, 702, '续集');
    recomputeSeries();

    const key = listSeries({ includeSingletons: true })[0]!.key;
    expect(getSeriesDetail(key)!.titleState).toBe('provisional');
    expect(getDiagnosticsReport({ refresh: true }).issues.find((i) => i.id === 'titles.provisional')?.affectedCount).toBe(1);

    // 新同步补充了系列续作 → 核心成员 3/4 共享「新系列起点」→ 自动升级 resolved
    seedSubject(703, '新系列起点 第二季', { year: 2022 });
    seedSubject(704, '新系列起点 第三季', { year: 2023 });
    seedRelation(702, 703, '续集');
    seedRelation(703, 704, '续集');
    recomputeSeries();

    expect(getSeriesDetail(key)!.titleState).toBe('resolved');
    const report = getDiagnosticsReport({ refresh: true });
    expect(report.issues.find((i) => i.id === 'titles.provisional')).toBeUndefined();
    const titlesMod = report.modules.find((m) => m.id === 'titles')!;
    expect(titlesMod.details.some((line) => line.includes('含历史已解决 1 个'))).toBe(true);

    // 重复同步幂等：不新增 title_changed 事件，不产生虚假待确认项
    const eventsBefore = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entity_events WHERE entity_kind = 'series' AND kind = 'title_changed'`,
    )!.n;
    recomputeSeries();
    const eventsAfter = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entity_events WHERE entity_kind = 'series' AND kind = 'title_changed'`,
    )!.n;
    expect(eventsAfter).toBe(eventsBefore);
    expect(getSeriesDetail(key)!.titleState).toBe('resolved');
  });
});
