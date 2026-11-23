/**
 * v1.8.3：Entity Identity Lifecycle（B2 / B3）测试。
 *
 * 覆盖：
 * - 同成员集合回归 → 恢复原实体 key（而不是新建）；
 * - 真实事故形态：stale 身份 + rebuild duplicate → 恢复旧身份、回收副本；
 * - manual title 与治理决定不因投影重建丢失；
 * - alias 生命周期对账：沿谱系重定向 / 无后继退役 + 事件留痕；
 * - 弱身份匹配不触发 revival（宁可新建 provisional）；
 * - Repair 闭环：Preview 列出承诺范围，Execute 后 detector 通过。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { all, one, run } from '../src/db/index.js';
import { getSeriesDetail } from '../src/db/query.js';
import {
  applySeriesTitleOverride,
  planEntityLifecycle,
  recomputeSeries,
  resolveEntityKey,
} from '../src/db/series.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { runDiagnosticsRepair } from '../src/diagnostics/repair.js';
import { saveConfig } from '../src/config.js';
import { resetDatabase } from './helpers.js';

const TS = '2026-01-01T00:00:00.000Z';
/** 比运行时创建的实体更晚的时间，用于模拟「事故期间重建出来的同身份实体」。 */
const FUTURE_TS = '2030-01-01T00:00:00.000Z';

function seedSubject(id: number, nameCn: string, collected = true): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, year, format, tag_names, created_at, updated_at)
     VALUES (:id, :name, :nameCn, 2019, 'TV', '[]', :ts, :ts)`,
    { id, name: nameCn, nameCn, ts: TS },
  );
  if (collected) {
    run(
      `INSERT INTO collections (subject_id, subject_type, type, rate, first_seen_at, synced_at)
       VALUES (:id, 2, 2, 0, :ts, :ts)`,
      { id, ts: TS },
    );
  }
}

function seedRelation(from: number, to: number, relation: string): void {
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:from, :to, :relation, 2, '', '', :ts)`,
    { from, to, relation, ts: TS },
  );
}

function seedChain(ids: number[]): void {
  ids.forEach((id) => seedSubject(id, `测试系列 第${id}部`));
  for (let index = 0; index < ids.length - 1; index += 1) {
    seedRelation(ids[index]!, ids[index + 1]!, '续集');
    seedRelation(ids[index + 1]!, ids[index]!, '前传');
  }
}

function dropCollection(id: number): void {
  run('DELETE FROM collections WHERE subject_id = :id', { id });
}

function restoreCollection(id: number): void {
  run(
    `INSERT INTO collections (subject_id, subject_type, type, rate, first_seen_at, synced_at)
     VALUES (:id, 2, 2, 0, :ts, :ts)`,
    { id, ts: TS },
  );
}

function seriesRows(): Array<{ id: number; key: string; state: string; title: string; title_state: string }> {
  return all(
    'SELECT id, key, state, title, title_state FROM series_entities ORDER BY id',
  );
}

function insertStaleRow(key: string, title: string): number {
  const inserted = run(
    `INSERT INTO series_entities (key, state, title, title_state, title_source, title_candidates,
                                  core_signature, created_at, updated_at)
     VALUES (:key, 'stale', :title, 'provisional', 'fallback', '[]', '', :ts, :ts)`,
    { key, title, ts: TS },
  );
  return Number(inserted.lastInsertRowid);
}

/** 模拟事故期间 buggy 引擎产出的「同成员、新 key」的 live 实体。 */
function insertDuplicateLiveEntity(key: string, title: string, memberIds: number[]): number {
  const inserted = run(
    `INSERT INTO series_entities (key, state, title, title_state, title_source, title_candidates,
                                  core_signature, member_count, confirmed_count, candidate_count,
                                  collected_count, created_at, updated_at, revision)
     VALUES (:key, 'stable', :title, 'provisional', 'anchor', '[]', '',
             :count, :count, 0, :count, :ts, :ts, 1)`,
    { key, title, count: memberIds.length, ts: FUTURE_TS },
  );
  const id = Number(inserted.lastInsertRowid);
  memberIds.forEach((subjectId, position) => {
    run(
      `INSERT INTO series_entity_members (series_id, subject_id, role, state, reason_code, position)
       VALUES (:seriesId, :subjectId, 'primary', 'confirmed', 'anchor', :position)`,
      { seriesId: id, subjectId, position },
    );
  });
  return id;
}

function aliasRow(aliasKey: string) {
  return one<{ entity_id: number; reason: string }>(
    'SELECT entity_id, reason FROM entity_aliases WHERE alias_key = :key AND entity_kind = :kind',
    { key: aliasKey, kind: 'series' },
  );
}

describe('v1.8.3 实体身份生命周期', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });

  it('同成员集合回归：恢复原 key 与 manual 标题，而不是新建实体', () => {
    seedChain([1, 2, 3, 4]);
    recomputeSeries();
    const before = seriesRows().find((row) => row.state !== 'stale')!;
    applySeriesTitleOverride(before.key, { mode: 'custom', title: '手工命名系列' });

    // 模拟事故：全部收藏消失 → 实体 stale（旧 key 进入历史）
    [1, 2, 3, 4].forEach(dropCollection);
    recomputeSeries();
    expect(seriesRows().find((row) => row.id === before.id)!.state).toBe('stale');

    // 收藏回归 → 必须恢复原身份，而不是创建新 key
    [1, 2, 3, 4].forEach(restoreCollection);
    recomputeSeries();

    const after = seriesRows().find((row) => row.id === before.id)!;
    expect(after.state).not.toBe('stale');
    expect(after.key).toBe(before.key);
    expect(after.title).toBe('手工命名系列');
    expect(after.title_state).toBe('manual');
    expect(seriesRows().filter((row) => row.state !== 'stale')).toHaveLength(1);
    expect(
      all("SELECT id FROM entity_events WHERE entity_id = :id AND kind = 'restored'", {
        id: before.id,
      }),
    ).toHaveLength(1);
    expect(getSeriesDetail(before.key)!.title).toBe('手工命名系列');
  });

  it('真实事故形态：stale 身份 + rebuild duplicate → 恢复旧身份并回收副本', () => {
    seedChain([1, 2, 3, 4]);
    recomputeSeries();
    const original = seriesRows().find((row) => row.state !== 'stale')!;
    applySeriesTitleOverride(original.key, { mode: 'custom', title: '拔作岛风格系列' });

    [1, 2, 3, 4].forEach(dropCollection);
    recomputeSeries();
    expect(seriesRows().find((row) => row.id === original.id)!.state).toBe('stale');

    // 事故期间被 buggy 引擎重建出来的同成员实体（新 key、provisional）
    const duplicateId = insertDuplicateLiveEntity('sr_9001', '未确认系列（4 部）', [1, 2, 3, 4]);

    [1, 2, 3, 4].forEach(restoreCollection);
    recomputeSeries();

    const revived = seriesRows().find((row) => row.id === original.id)!;
    expect(revived.state).not.toBe('stale');
    expect(revived.key).toBe(original.key);
    expect(revived.title_state).toBe('manual');
    expect(revived.title).toBe('拔作岛风格系列');

    const duplicate = seriesRows().find((row) => row.id === duplicateId)!;
    expect(duplicate.state).toBe('stale');
    expect(aliasRow('sr_9001')?.entity_id).toBe(original.id);

    // 只有一个 live 身份，subjects.series_key 归属恢复后的 key
    expect(seriesRows().filter((row) => row.state !== 'stale')).toHaveLength(1);
    expect(
      Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM subjects WHERE series_key = :key`,
          { key: original.key },
        )?.n ?? 0,
      ),
    ).toBe(4);
    // alias 生命周期不变量
    expect(
      Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM entity_aliases a
            WHERE (a.entity_kind = 'series' AND NOT EXISTS (
                     SELECT 1 FROM series_entities e WHERE e.id = a.entity_id AND e.state <> 'stale'))`,
        )?.n ?? 0,
      ),
    ).toBe(0);
  });

  it('alias 对账：沿谱系找到 live 后继时重定向，并留 alias_redirected 事件', () => {
    seedSubject(1, '测试系列 第一部');
    seedSubject(2, '测试系列 第二部');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    recomputeSeries();
    const live = seriesRows().find((row) => row.state !== 'stale')!;

    const staleId = insertStaleRow('sr_stale_target', '历史实体');
    run(
      `INSERT INTO entity_aliases (alias_key, entity_kind, entity_id, reason, created_at)
       VALUES ('sr_stale_target', 'series', :target, 'combined-into', :ts)`,
      { target: live.id, ts: TS },
    );
    run(
      `INSERT INTO entity_aliases (alias_key, entity_kind, entity_id, reason, created_at)
       VALUES ('sr_legacy_key', 'series', :target, 'legacy-key', :ts)`,
      { target: staleId, ts: TS },
    );

    recomputeSeries();

    expect(aliasRow('sr_legacy_key')?.entity_id).toBe(live.id);
    expect(
      all(
        `SELECT id FROM entity_events
          WHERE kind = 'alias_redirected' AND payload LIKE '%"aliasKey":"sr_legacy_key"%'`,
      ),
    ).toHaveLength(1);
  });

  it('alias 对账：无合法 live 后继时退役，并留 alias_retired 事件', () => {
    seedSubject(1, '测试系列 第一部');
    recomputeSeries();
    run(
      `INSERT INTO entity_aliases (alias_key, entity_kind, entity_id, reason, created_at)
       VALUES ('sr_ghost', 'series', 999999, 'legacy-key', :ts)`,
      { ts: TS },
    );

    recomputeSeries();

    expect(aliasRow('sr_ghost')).toBeUndefined();
    expect(
      all(
        `SELECT id FROM entity_events
          WHERE kind = 'alias_retired' AND payload LIKE '%"aliasKey":"sr_ghost"%'`,
      ),
    ).toHaveLength(1);
  });

  it('弱身份匹配（低 jaccard）不触发 revival，宁可新建 provisional', () => {
    const weakId = insertStaleRow('sr_weak', '弱匹配历史实体');
    run(
      `INSERT INTO entity_events (entity_kind, entity_id, kind, payload, created_at)
       VALUES ('series', :id, 'unmatched', '{"key":"sr_weak","title":"弱匹配历史实体","members":[1,2]}', :ts)`,
      { id: weakId, ts: TS },
    );
    seedChain([1, 2, 3, 4]);

    recomputeSeries();

    const weak = seriesRows().find((row) => row.id === weakId)!;
    expect(weak.state).toBe('stale');
    const live = seriesRows().filter((row) => row.state !== 'stale');
    expect(live).toHaveLength(1);
    expect(live[0]!.key).not.toBe('sr_weak');
  });

  it('Repair 闭环：Preview 列出恢复 / 退役，Execute 后 detector 通过、manual 标题保留', () => {
    seedChain([1, 2, 3, 4]);
    recomputeSeries();
    const original = seriesRows().find((row) => row.state !== 'stale')!;
    applySeriesTitleOverride(original.key, { mode: 'custom', title: '保留我的人工标题' });

    [1, 2, 3, 4].forEach(dropCollection);
    recomputeSeries();
    insertDuplicateLiveEntity('sr_9002', '未确认系列（4 部）', [1, 2, 3, 4]);
    // 旧书签：指向 stale 身份的 alias + 一个无后继的幽灵 alias
    run(
      `INSERT INTO entity_aliases (alias_key, entity_kind, entity_id, reason, created_at)
       VALUES ('sr_old_bookmark', 'series', :target, 'combined-into', :ts)`,
      { target: original.id, ts: TS },
    );
    run(
      `INSERT INTO entity_aliases (alias_key, entity_kind, entity_id, reason, created_at)
       VALUES ('sr_ghost_bookmark', 'series', 999998, 'legacy-key', :ts)`,
      { ts: TS },
    );
    [1, 2, 3, 4].forEach(restoreCollection);
    invalidateDiagnosticsReport();

    const before = getDiagnosticsReport({ refresh: true });
    const issue = before.issues.find((entry) => entry.id === 'orphan.alias');
    expect(issue).toBeTruthy();
    const action = issue!.actions.find(
      (entry) => entry.kind === 'repair' && entry.repairKind === 'recompute-derived',
    );
    if (!action || action.kind !== 'repair') throw new Error('missing repair action');
    expect(action.preview.derivedChanges.join(' ')).toContain('恢复历史实体');
    expect(action.preview.derivedChanges.join(' ')).toContain('退役 alias');

    // 计划与预览同源：恢复 1 个身份、退役 1 条 alias
    const plan = planEntityLifecycle();
    expect(plan.revivals.map((item) => item.key)).toEqual([original.key]);
    expect(plan.aliasRetirements.map((item) => item.aliasKey)).toEqual(['sr_ghost_bookmark']);

    const result = runDiagnosticsRepair({ issueId: issue!.id, kind: 'recompute-derived' });
    expect(result.verification.verified).toBe(true);
    expect(result.verification.partial).toBe(false);
    const labels = result.verification.checks.map((check) => check.label);
    expect(labels).toEqual(
      expect.arrayContaining(['alias 生命周期不变量', '执行范围与预览一致', '历史身份恢复', 'alias 退役留痕']),
    );
    expect(result.report.issues.some((entry) => entry.id === 'orphan.alias')).toBe(false);

    // manual 标题保留、旧书签可解析、幽灵 alias 已退役
    const revived = seriesRows().find((row) => row.id === original.id)!;
    expect(revived.state).not.toBe('stale');
    expect(revived.title_state).toBe('manual');
    expect(revived.title).toBe('保留我的人工标题');
    expect(resolveEntityKey('series', 'sr_old_bookmark')?.key).toBe(original.key);
    expect(aliasRow('sr_ghost_bookmark')).toBeUndefined();
  });
});
