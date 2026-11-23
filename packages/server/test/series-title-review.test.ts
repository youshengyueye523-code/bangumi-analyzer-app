import { beforeEach, describe, expect, it } from 'vitest';
import { all, dataVersion, one, run } from '../src/db/index.js';
import {
  applySeriesTitleOverride,
  recomputeSeries,
  resetSeriesTitleOverride,
  rejectSeriesTitleCandidate,
  reopenSeriesTitleCandidate,
} from '../src/db/series.js';
import { getSeriesDetail, listSeries } from '../src/db/query.js';
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
      year: options.year ?? 2000 + (id % 20),
      format: options.format ?? 'TV',
      tags: JSON.stringify(options.tags ?? []),
      ts: '2026-01-01T00:00:00.000Z',
    },
  );
  if (options.collected !== false) {
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, first_seen_at, synced_at)
       VALUES (:id, 2, 2, 0, :ts, :ts)`,
      { id, ts: '2026-01-01T00:00:00.000Z' },
    );
  }
}

function seedRelation(from: number, to: number, relation: string): void {
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:from, :to, :relation, 2, '', '', :ts)`,
    { from, to, relation, ts: '2026-01-01T00:00:00.000Z' },
  );
}

function seedSimpleSeries(): string {
  seedSubject(1, '测试系列');
  seedSubject(2, '测试系列 第二季');
  seedRelation(1, 2, '续集');
  seedRelation(2, 1, '前传');
  recomputeSeries();
  return listSeries({ includeSingletons: true })[0]!.key;
}

describe('Title Review / Manual Override', () => {
  beforeEach(() => resetDatabase());

  it.each(['{}', '[null]', '[{"title":123}]'])('异常候选 %s 可只读查看；治理拒绝且不丢弃历史证据', (raw) => {
    const key = seedSimpleSeries();
    run('UPDATE series_entities SET title_candidates=:raw WHERE key=:key', { raw, key });
    const tables = ['series_entities', 'candidate_decisions', 'entity_events', 'meta'];
    const before = tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    expect(getSeriesDetail(key)!.titleCandidates).toEqual([]);
    for (const action of [
      () => applySeriesTitleOverride(key, { mode: 'custom', title: '新的人工名称' }),
      () => applySeriesTitleOverride(key, { mode: 'candidate', title: '123' }),
      () => rejectSeriesTitleCandidate(key, '123'),
      () => reopenSeriesTitleCandidate(key, '123'),
    ]) {
      expect(action().ok).toBe(false);
      expect(tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(before);
    }
  });

  it('合法历史候选缺少可选 valid/support/coverage 时仍可查看和人工采用', () => {
    const key = seedSimpleSeries();
    const candidate = { title: '合法历史候选', source: 'brand:members', state: 'provisional', evidence: '历史夹具证据' };
    run('UPDATE series_entities SET title_candidates=:raw WHERE key=:key', { raw: JSON.stringify([candidate]), key });
    expect(getSeriesDetail(key)!.titleCandidates).toEqual([candidate]);
    expect(applySeriesTitleOverride(key, { mode: 'candidate', title: candidate.title }).ok).toBe(true);
    expect(getSeriesDetail(key)).toMatchObject({ title: candidate.title, titleState: 'manual' });
  });

  it.each(['reset', 'reject', 'reopen'] as const)('标题治理 %s 重建故障不改变裁决、历史或数据版本', (action) => {
    const key = seedSimpleSeries();
    const title = getSeriesDetail(key)!.title;
    if (action === 'reset') applySeriesTitleOverride(key, { mode: 'custom', title: 'manual fixture' });
    if (action === 'reopen') rejectSeriesTitleCandidate(key, title, 'original evidence');
    const before = one<{ revision: number } & Record<string, unknown>>('SELECT * FROM series_entities WHERE key=:key', { key })!;
    const version = dataVersion();
    const events = one<{ n: number }>('SELECT COUNT(*) AS n FROM entity_events')!.n;
    run(`CREATE TRIGGER audit_title_failure BEFORE UPDATE ON series_entities
         WHEN NEW.revision > ${Number(before.revision) + 1}
         BEGIN SELECT RAISE(ABORT, 'injected title rebuild failure'); END`);
    try {
      expect(() => action === 'reset' ? resetSeriesTitleOverride(key)
        : action === 'reject' ? rejectSeriesTitleCandidate(key, title, 'fixture reject')
          : reopenSeriesTitleCandidate(key, title, 'fixture reopen')).toThrow('injected title rebuild failure');
      expect(one('SELECT * FROM series_entities WHERE key=:key', { key })).toEqual(before);
      expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM entity_events')!.n).toBe(events);
      expect(dataVersion()).toBe(version);
    } finally { run('DROP TRIGGER audit_title_failure'); }
  });

  it('采用候选后成为 manual confirmed，并在重建后保持不变', () => {
    const key = seedSimpleSeries();
    const before = getSeriesDetail(key)!;
    expect(before.titleState).toBe('resolved');

    const adopted = applySeriesTitleOverride(key, { mode: 'candidate', title: before.title });
    expect(adopted.ok).toBe(true);
    const manual = getSeriesDetail(key)!;
    expect(manual.title).toBe(before.title);
    expect(manual.titleState).toBe('manual');
    expect(manual.titleConfirmedAt).not.toBeNull();

    // 新成员 + 新关系：自动 resolver 不得覆盖人工确认
    seedSubject(3, '完全不同的名字');
    seedRelation(1, 3, '续集');
    seedRelation(3, 1, '前传');
    recomputeSeries();

    const after = getSeriesDetail(key)!;
    expect(after.title).toBe(before.title);
    expect(after.titleState).toBe('manual');
    expect(after.titleConfirmedAt).not.toBeNull();
  });

  it('自定义标题持久化，且重建 / 新增成员后仍保持', () => {
    const key = seedSimpleSeries();
    const result = applySeriesTitleOverride(key, { mode: 'custom', title: '人工确认的作品名' });
    expect(result.ok).toBe(true);

    recomputeSeries();
    const first = getSeriesDetail(key)!;
    expect(first.title).toBe('人工确认的作品名');
    expect(first.titleState).toBe('manual');

    seedSubject(4, '测试系列 第三季');
    seedRelation(1, 4, '续集');
    seedRelation(4, 1, '前传');
    recomputeSeries();

    const second = getSeriesDetail(key)!;
    expect(second.title).toBe('人工确认的作品名');
    expect(second.titleState).toBe('manual');
    // 人工确认的候选始终保留在候选列表里，作为 provenance
    expect(second.titleCandidates.some((candidate) => candidate.source === 'manual')).toBe(true);
  });

  it('确认当前名称：automatic resolved → manual confirmed', () => {
    const key = seedSimpleSeries();
    expect(getSeriesDetail(key)!.titleState).toBe('resolved');
    const result = applySeriesTitleOverride(key, { mode: 'confirm-current' });
    expect(result.ok).toBe(true);
    expect(getSeriesDetail(key)!.titleState).toBe('manual');
  });

  it('provisional 可以确认当前名称，也可以保持不动等待新证据', () => {
    seedSubject(1, '起点作品甲');
    seedSubject(2, '完全不同名的续作乙');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();
    const key = listSeries({ includeSingletons: true })[0]!.key;
    expect(getSeriesDetail(key)!.titleState).toBe('provisional');

    // 不做任何人工操作：重建后依然是 provisional
    recomputeSeries();
    expect(getSeriesDetail(key)!.titleState).toBe('provisional');

    const confirmed = applySeriesTitleOverride(key, { mode: 'confirm-current' });
    expect(confirmed.ok).toBe(true);
    expect(getSeriesDetail(key)!.titleState).toBe('manual');
  });

  it('人工确认后出现更强候选时只产生 proposal，不覆盖标题', () => {
    const key = seedSimpleSeries();
    applySeriesTitleOverride(key, { mode: 'custom', title: '人工确认的作品名' });

    seedSubject(5, '人工确认的作品名 第二季');
    seedSubject(6, '人工确认的作品名 第三季');
    seedRelation(1, 5, '续集');
    seedRelation(5, 1, '前传');
    seedRelation(5, 6, '续集');
    recomputeSeries();

    const detail = getSeriesDetail(key)!;
    expect(detail.title).toBe('人工确认的作品名');
    expect(detail.titleState).toBe('manual');
    const proposals = detail.titleCandidates.filter(
      (candidate) => candidate.source !== 'manual' && candidate.title !== detail.title,
    );
    expect(proposals.length).toBeGreaterThan(0);
  });

  it('恢复自动解析：清除人工确认并回到自动结果', () => {
    const key = seedSimpleSeries();
    applySeriesTitleOverride(key, { mode: 'custom', title: '人工确认的作品名' });
    expect(getSeriesDetail(key)!.titleState).toBe('manual');

    const reset = resetSeriesTitleOverride(key);
    expect(reset.ok).toBe(true);
    const detail = getSeriesDetail(key)!;
    expect(detail.titleState).not.toBe('manual');
    expect(detail.title).not.toBe('人工确认的作品名');
    expect(detail.titleConfirmedAt).toBeNull();
  });

  it('非法输入被拒绝：空标题 / 超长 / 控制字符 / 不存在的候选', () => {
    const key = seedSimpleSeries();
    expect(applySeriesTitleOverride(key, { mode: 'custom', title: '   ' }).ok).toBe(false);
    expect(applySeriesTitleOverride(key, { mode: 'custom', title: 'x'.repeat(121) }).ok).toBe(false);
    expect(applySeriesTitleOverride(key, { mode: 'custom', title: '含\n换行' }).ok).toBe(false);
    const unknown = applySeriesTitleOverride(key, { mode: 'candidate', title: '不存在的候选' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('unknown_candidate');
    // 失败不能留下人工确认痕迹
    expect(getSeriesDetail(key)!.titleState).not.toBe('manual');
  });
});
