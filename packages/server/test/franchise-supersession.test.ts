/**
 * v1.8.4：Franchise Identity Supersession（迁移已被取代的家族成员）。
 *
 * 覆盖：
 * - 正例：真实事故形态（confirmed Franchise + 指向 rebuild duplicate 的 stale 链接）
 *   → 成员身份迁移 → 家族保持 confirmed → stale-link / counter-drift = 0 → 重复候选收敛；
 * - 反例：缺少生命周期谱系 / 普通 overlap / live 身份 / 非 confirmed 家族全部拒绝；
 * - Contract：frozen confirmed 家族不再提供注定失败的 generic recompute repair；
 *   没有谱系证据时明确标记为需要人工治理。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { franchiseGovernanceRequestSchema } from '@bangumi-analyzer/shared';
import { saveConfig } from '../src/config.js';
import { all, dataVersion, one, run } from '../src/db/index.js';
import { getFranchiseDetail, listFranchises } from '../src/db/query.js';
import { confirmFranchise, recomputeSeries } from '../src/db/series.js';
import { supersedeFranchiseMember } from '../src/db/franchiseGovernance.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import {
  buildFranchiseGovernancePreview,
  runFranchiseGovernance,
} from '../src/diagnostics/franchiseGovernance.js';
import { resetDatabase } from './helpers.js';

const TS = '2026-01-01T00:00:00.000Z';
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
  run(
    `INSERT INTO entity_events (entity_kind, entity_id, kind, payload, created_at)
     VALUES ('series', :id, 'created', :payload, :ts)`,
    { id, payload: JSON.stringify({ members: memberIds }), ts: FUTURE_TS },
  );
  return id;
}

function seriesIdOf(key: string): number {
  return Number(one<{ id: number }>('SELECT id FROM series_entities WHERE key = :key', { key })!.id);
}

/**
 * 构造真实事故形态：
 * confirmed Franchise（links = S1 + duplicate）→ duplicate 被 v1.8.3 身份恢复回收
 * → 家族冻结、stale 链接、同身份 provisional 重复候选。
 */
function seedFrozenSupersessionFixture(): {
  franchiseKey: string;
  duplicateKey: string;
  restoredKey: string;
  anchorKey: string;
} {
  seedSubject(1, '爱上火车');
  seedSubject(2, '爱上火车-Last Run!!');
  seedRelation(1, 2, '不同版本');
  seedRelation(2, 1, '不同版本');
  recomputeSeries();

  const franchiseKey = listFranchises()[0]!.key;
  confirmFranchise(franchiseKey);
  const series = new Map(
    all<{ key: string; title: string }>(
      `SELECT key, title FROM series_entities WHERE state <> 'stale'`,
    ).map((row) => [row.title, row.key] as const),
  );
  const anchorKey = series.get('爱上火车')!;
  const restoredKey = series.get('爱上火车-Last Run!!')!;

  // 1) 收藏消失 → 原 Series 变 stale，家族冻结
  run('DELETE FROM collections WHERE subject_id = 2');
  recomputeSeries();
  expect(
    one<{ state: string }>('SELECT state FROM series_entities WHERE key = :key', { key: restoredKey })!
      .state,
  ).toBe('stale');

  // 2) 模拟事故期间的重建：live duplicate 接管家族链接
  const duplicateKey = 'sr_dup_9001';
  const duplicateId = insertDuplicateLiveEntity(duplicateKey, '爱上火车-Last Run!!', [2]);
  run(
    `UPDATE franchise_series SET series_id = :duplicateId
      WHERE franchise_id = :franchiseId AND series_id = :seriesId`,
    { duplicateId, franchiseId: seriesIdOfFranchise(franchiseKey), seriesId: seriesIdOf(restoredKey) },
  );

  // 3) 收藏回归 → v1.8.3 恢复原身份并回收副本
  run(
    `INSERT INTO collections (subject_id, subject_type, type, rate, first_seen_at, synced_at)
     VALUES (2, 2, 2, 0, :ts, :ts)`,
    { ts: TS },
  );
  recomputeSeries();

  return { franchiseKey, duplicateKey, restoredKey, anchorKey };
}

function seriesIdOfFranchise(key: string): number {
  return Number(
    one<{ id: number }>('SELECT id FROM franchise_entities WHERE key = :key', { key })!.id,
  );
}

function issueById(report: ReturnType<typeof getDiagnosticsReport>, id: string) {
  return report.issues.find((entry) => entry.id === id);
}

describe('v1.8.4 Franchise identity supersession', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });

  it.each(['history', 'version'] as const)('冻结身份迁移的 %s 写入失败时保留全部谱系与链接，重试可验证', (fault) => {
    const fixture = seedFrozenSupersessionFixture();
    const input = { kind: 'supersede-franchise-member' as const, franchiseKey: fixture.franchiseKey, seriesKey: fixture.duplicateKey, reason: 'synthetic migration' };
    const tables = ['subjects', 'collections', 'subject_relations', 'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'franchise_member_exclusions', 'entity_aliases', 'candidate_decisions', 'entity_events', 'meta'];
    const snapshot = () => tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    const before = snapshot();
    expect(buildFranchiseGovernancePreview(input).allowed).toBe(true);
    expect(snapshot()).toEqual(before);
    const version = dataVersion();
    run(fault === 'history'
      ? `CREATE TRIGGER audit_migration_failure BEFORE INSERT ON entity_events WHEN NEW.kind='member_superseded' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`
      : `CREATE TRIGGER audit_migration_failure BEFORE INSERT ON meta WHEN NEW.key='data_version' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    try {
      expect(() => runFranchiseGovernance(input)).toThrow('injected migration failure');
      expect(snapshot()).toEqual(before);
    } finally { run('DROP TRIGGER audit_migration_failure'); }
    expect(runFranchiseGovernance(input).verification.verified).toBe(true);
    expect(dataVersion()).toBe(version + 1);
    expect(getFranchiseDetail(fixture.franchiseKey)!.state).toBe('confirmed');
    expect(getFranchiseDetail(fixture.franchiseKey)!.series.map((entry) => entry.key).sort()).toEqual([fixture.anchorKey, fixture.restoredKey].sort());
    const events = all('SELECT * FROM entity_events ORDER BY id');
    recomputeSeries();
    recomputeSeries();
    expect(all('SELECT * FROM entity_events ORDER BY id')).toEqual(events);
    expect(dataVersion()).toBe(version + 1);
    expect(getFranchiseDetail(fixture.franchiseKey)!.identityConflicts).toHaveLength(0);
  });

  it('正例：真实事故形态 → 迁移成员身份，家族保持 confirmed，stale-link / counter-drift 清零', () => {
    const fixture = seedFrozenSupersessionFixture();
    invalidateDiagnosticsReport();

    // 现场：confirmed 家族链接 stale duplicate + 同身份的 provisional 重复候选
    const detailBefore = getFranchiseDetail(fixture.franchiseKey)!;
    expect(detailBefore.state).toBe('confirmed');
    expect(detailBefore.identityConflicts).toHaveLength(1);
    expect(detailBefore.identityConflicts[0]).toMatchObject({
      fromSeriesKey: fixture.duplicateKey,
      toSeriesKey: fixture.restoredKey,
      reason: 'superseded',
    });

    // Contract：不再提供注定失败的 generic recompute repair
    const before = getDiagnosticsReport({ refresh: true });
    for (const id of ['franchise.stale-link', 'franchise.counter-drift']) {
      const issue = issueById(before, id)!;
      expect(issue).toBeTruthy();
      expect(issue.severity).toBe('error');
      expect(issue.actions.some((action) => action.kind === 'repair')).toBe(false);
      const link = issue.actions.find((action) => action.kind === 'link');
      expect(link?.kind === 'link' && link.href === `/franchises/${fixture.franchiseKey}`).toBe(true);
      expect(issue.waiting?.kind).toBe('manual-review');
    }

    // Preview：只读且明确展示 from → to 与生命周期证据
    const preview = buildFranchiseGovernancePreview({
      kind: 'supersede-franchise-member',
      franchiseKey: fixture.franchiseKey,
      seriesKey: fixture.duplicateKey,
    });
    expect(preview.allowed).toBe(true);
    expect(preview.preview?.current).toContain(fixture.duplicateKey);
    expect(preview.preview?.current).toContain(fixture.restoredKey);
    expect(preview.preview?.derivedChanges.join(' ')).toContain(fixture.restoredKey);

    // Execute + Verify
    const result = runFranchiseGovernance({
      kind: 'supersede-franchise-member',
      franchiseKey: fixture.franchiseKey,
      seriesKey: fixture.duplicateKey,
      reason: 'v1.8.3 身份恢复：sr_dup_9001 是恢复身份的事故重建副本',
    });
    expect(result.verification.verified).toBe(true);
    expect(result.verification.partial).toBe(false);
    const labels = result.verification.checks.map((check) => check.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        '身份迁移决定已写入 provenance',
        'Franchise 保持已确认',
        '成员身份已迁移（旧身份移除 / 恢复身份就位）',
        '同一身份没有重复活跃家族',
      ]),
    );

    // 家族保持 confirmed，成员变为恢复身份
    const detailAfter = getFranchiseDetail(fixture.franchiseKey)!;
    expect(detailAfter.state).toBe('confirmed');
    expect(detailAfter.series.map((entry) => entry.key).sort()).toEqual(
      [fixture.anchorKey, fixture.restoredKey].sort(),
    );
    expect(detailAfter.identityConflicts).toHaveLength(0);

    // provenance：事件 + 链接 evidence（跨 recompute 保留）
    const event = one<{ payload: string }>(
      `SELECT payload FROM entity_events
        WHERE entity_kind = 'franchise' AND kind = 'member_superseded'
        ORDER BY id DESC LIMIT 1`,
    )!;
    const payload = JSON.parse(event.payload) as {
      from: { key: string };
      to: { key: string };
      provenance: { mergedEventId: number };
    };
    expect(payload.from.key).toBe(fixture.duplicateKey);
    expect(payload.to.key).toBe(fixture.restoredKey);
    expect(payload.provenance.mergedEventId).toBeGreaterThan(0);
    const linkEvidence = JSON.parse(
      one<{ evidence: string }>(
        `SELECT evidence FROM franchise_series
          WHERE franchise_id = :id AND series_id = :seriesId`,
        { id: seriesIdOfFranchise(fixture.franchiseKey), seriesId: seriesIdOf(fixture.restoredKey) },
      )!.evidence,
    ) as { supersededFrom?: { key: string } };
    expect(linkEvidence.supersededFrom?.key).toBe(fixture.duplicateKey);

    // 重复候选进入非活跃状态（不依赖「理论上会 stale」）
    const duplicates = all<{ key: string; state: string }>(
      `SELECT f.key, f.state FROM franchise_series fs
         JOIN franchise_entities f ON f.id = fs.franchise_id
        WHERE fs.series_id = :seriesId AND f.state <> 'stale'`,
      { seriesId: seriesIdOf(fixture.restoredKey) },
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.key).toBe(fixture.franchiseKey);

    // 稳定性：再次 recompute 不退化（保持 confirmed + 无 stale 链接）
    recomputeSeries();
    invalidateDiagnosticsReport();
    const after = getDiagnosticsReport({ refresh: true });
    expect(issueById(after, 'franchise.stale-link')).toBeFalsy();
    expect(issueById(after, 'franchise.counter-drift')).toBeFalsy();
    const stable = getFranchiseDetail(fixture.franchiseKey)!;
    expect(stable.state).toBe('confirmed');
    expect(stable.series.map((entry) => entry.key).sort()).toEqual(
      [fixture.anchorKey, fixture.restoredKey].sort(),
    );
  });

  it('身份迁移的重建失败时不留下新链接、迁移事件或治理版本', () => {
    const fixture = seedFrozenSupersessionFixture();
    const tables = ['franchise_entities', 'franchise_series', 'franchise_member_exclusions', 'series_entities', 'series_entity_members', 'entity_aliases', 'candidate_decisions', 'entity_events', 'meta'];
    const before = Object.fromEntries(tables.map((table) => [table, all(`SELECT * FROM ${table} ORDER BY rowid`)]));
    run(`CREATE TRIGGER audit_supersession_failure BEFORE UPDATE ON series_entities BEGIN SELECT RAISE(ABORT, 'fixture supersession rebuild failure'); END`);
    try {
      expect(() => supersedeFranchiseMember(fixture.franchiseKey, fixture.duplicateKey)).toThrow('fixture supersession rebuild failure');
      for (const table of tables) expect(all(`SELECT * FROM ${table} ORDER BY rowid`)).toEqual(before[table]);
    } finally { run('DROP TRIGGER audit_supersession_failure'); }
  });

  it('hideNsfw=ON：身份迁移验证读取完整数据口径，不因可见性过滤而误判失败', () => {
    const fixture = seedFrozenSupersessionFixture();
    // 把恢复身份的成员设为 NSFW：当前可见口径下成员会被隐藏
    run('UPDATE subjects SET nsfw = 1 WHERE id = 2');
    saveConfig({ hideNsfw: true });
    recomputeSeries();
    invalidateDiagnosticsReport();

    const result = runFranchiseGovernance({
      kind: 'supersede-franchise-member',
      franchiseKey: fixture.franchiseKey,
      seriesKey: fixture.duplicateKey,
    });
    expect(result.verification.verified).toBe(true);
    const apiCheck = result.verification.checks.find((check) => check.layer === 'api')!;
    expect(apiCheck.ok).toBe(true);
    expect(apiCheck.detail).toContain('完整数据');
    // 数据层：链接仍然存在（隐藏只影响可见投影）
    const fr18 = getFranchiseDetail(fixture.franchiseKey, { visibility: 'real' })!;
    expect(fr18.series.map((entry) => entry.key).sort()).toEqual(
      [fixture.anchorKey, fixture.restoredKey].sort(),
    );
  });

  it('反例：live 身份 / 缺少谱系 / 非 confirmed 家族全部拒绝', () => {
    const fixture = seedFrozenSupersessionFixture();

    // live 身份（原 Series 已恢复）不能作为 from
    const livePreview = buildFranchiseGovernancePreview({
      kind: 'supersede-franchise-member',
      franchiseKey: fixture.franchiseKey,
      seriesKey: fixture.restoredKey,
    });
    expect(livePreview.allowed).toBe(false);
    expect(livePreview.message).toContain('live');

    // 缺少 lifecycle 谱系的 stale 身份不能迁移
    const bare = run(
      `INSERT INTO series_entities (key, state, title, title_state, title_source, title_candidates,
                                    core_signature, created_at, updated_at)
       VALUES ('sr_bare_stale', 'stale', '无谱系旧身份', 'provisional', 'fallback', '[]', '', :ts, :ts)`,
      { ts: TS },
    );
    run(
      `INSERT INTO franchise_series (franchise_id, series_id, state, evidence)
       VALUES (:franchiseId, :seriesId, 'confirmed', '{}')`,
      { franchiseId: seriesIdOfFranchise(fixture.franchiseKey), seriesId: Number(bare.lastInsertRowid) },
    );
    const barePreview = buildFranchiseGovernancePreview({
      kind: 'supersede-franchise-member',
      franchiseKey: fixture.franchiseKey,
      seriesKey: 'sr_bare_stale',
    });
    expect(barePreview.allowed).toBe(false);
    expect(barePreview.message).toContain('谱系');
    const bareResult = supersedeFranchiseMember(fixture.franchiseKey, 'sr_bare_stale');
    expect(bareResult.ok).toBe(false);
    expect(bareResult.code).toBe('no_supersession');
  });

  it('反例：普通 overlap / 伪造 merged 谱系不能通过强身份一致性', () => {
    // to：live series，成员 [10,11,12,13]
    seedSubject(10, '测试系列 A');
    seedSubject(11, '测试系列 B');
    seedSubject(12, '测试系列 C');
    seedSubject(13, '测试系列 D');
    seedRelation(10, 11, '续集');
    seedRelation(11, 10, '前传');
    seedRelation(11, 12, '续集');
    seedRelation(12, 11, '前传');
    seedRelation(12, 13, '续集');
    seedRelation(13, 12, '前传');
    recomputeSeries();
    const liveKey = all<{ key: string }>(
      `SELECT key FROM series_entities WHERE state <> 'stale' ORDER BY member_count DESC LIMIT 1`,
    )[0]!.key;
    const liveId = seriesIdOf(liveKey);

    // from：stale series，最后已知成员只有 [10,11]（普通 overlap，不是同一身份）
    const stale = run(
      `INSERT INTO series_entities (key, state, title, title_state, title_source, title_candidates,
                                    core_signature, created_at, updated_at)
       VALUES ('sr_overlap_stale', 'stale', '弱重叠旧身份', 'provisional', 'fallback', '[]', '', :ts, :ts)`,
      { ts: TS },
    );
    const staleId = Number(stale.lastInsertRowid);
    run(
      `INSERT INTO entity_events (entity_kind, entity_id, kind, payload, created_at)
       VALUES ('series', :id, 'unmatched', '{"key":"sr_overlap_stale","members":[10,11]}', :ts)`,
      { id: staleId, ts: TS },
    );
    run(
      `INSERT INTO entity_aliases (alias_key, entity_kind, entity_id, reason, created_at)
       VALUES ('sr_overlap_stale', 'series', :target, 'rebuilt-into', :ts)`,
      { target: liveId, ts: TS },
    );
    run(
      `INSERT INTO entity_events (entity_kind, entity_id, kind, payload, created_at)
       VALUES ('series', :id, 'merged', '{"absorbedKey":"sr_overlap_stale","rebuilt":true,"members":[10,11]}', :ts)`,
      { id: liveId, ts: TS },
    );
    const probe = run(
      `INSERT INTO franchise_entities (key, state, title, title_state, title_source, title_candidates, created_at, updated_at)
       VALUES ('fr_overlap_probe', 'confirmed', '弱重叠探针家族', 'resolved', 'brand:members', '[]', :ts, :ts)`,
      { ts: TS },
    );
    run(
      `INSERT INTO franchise_series (franchise_id, series_id, state, evidence)
       VALUES (:franchiseId, :seriesId, 'confirmed', '{}')`,
      { franchiseId: Number(probe.lastInsertRowid), seriesId: staleId },
    );
    const result = supersedeFranchiseMember('fr_overlap_probe', 'sr_overlap_stale');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('no_supersession');
    const preview = buildFranchiseGovernancePreview({
      kind: 'supersede-franchise-member',
      franchiseKey: 'fr_overlap_probe',
      seriesKey: 'sr_overlap_stale',
    });
    expect(preview.allowed).toBe(false);
    expect(preview.message).toContain('谱系');
  });

  it('Contract：请求结构不提供任意 from → to 输入', () => {
    const parsed = franchiseGovernanceRequestSchema.parse({
      kind: 'supersede-franchise-member',
      series: 'sr_401',
      to: 'sr_999',
    });
    expect(parsed.series).toBe('sr_401');
    expect('to' in parsed).toBe(false);
  });

  it('Contract：非 confirmed 家族的 stale 链接仍由 generic recompute 处理', () => {
    seedSubject(1, '候选家族 第一部');
    seedSubject(2, '候选家族 第二部');
    seedRelation(1, 2, '不同版本');
    seedRelation(2, 1, '不同版本');
    recomputeSeries();

    // 人工构造：候选（非 confirmed）家族 + 指向 stale Series 的链接
    const stale = run(
      `INSERT INTO series_entities (key, state, title, title_state, title_source, title_candidates,
                                    core_signature, created_at, updated_at)
       VALUES ('sr_candidate_stale', 'stale', '候选家族的旧身份', 'provisional', 'fallback', '[]', '', :ts, :ts)`,
      { ts: TS },
    );
    const candidate = run(
      `INSERT INTO franchise_entities (key, state, title, title_state, title_source, title_candidates, created_at, updated_at)
       VALUES ('fr_candidate_probe', 'candidate', '候选探针家族', 'provisional', 'fallback', '[]', :ts, :ts)`,
      { ts: TS },
    );
    run(
      `INSERT INTO franchise_series (franchise_id, series_id, state, evidence)
       VALUES (:franchiseId, :seriesId, 'candidate', '{}')`,
      { franchiseId: Number(candidate.lastInsertRowid), seriesId: Number(stale.lastInsertRowid) },
    );
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, 'franchise.stale-link')!;
    expect(issue).toBeTruthy();
    expect(issue.actions.some((action) => action.kind === 'repair')).toBe(true);
    expect(issue.waiting).toBeUndefined();
  });
});
