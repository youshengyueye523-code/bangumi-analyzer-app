/**
 * v1.8 OD2：Franchise 平均我的评分。
 *
 * 口径：
 * - Real materialization：engine 写入 franchise_entities.average_rate（成员级 mean，去重，round 2）；
 * - Visible：hideNsfw=ON 时按当前可见成员现算，禁止用 Real 值展示 / 排序；
 * - list / detail 必须同源；drift 可检测、可修复；启动可补齐历史 NULL。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BangumiApiError } from '../src/bangumi/client.js';
import { saveConfig } from '../src/config.js';
import { franchiseAverageRateDriftCount } from '../src/db/franchiseAverage.js';
import { all, dataVersion, exec, one, run, setMeta } from '../src/db/index.js';
import { adoptFranchiseTitle } from '../src/db/franchiseGovernance.js';
import { getFranchiseDetail, listFranchises, listSeries } from '../src/db/query.js';
import { confirmFranchise, ensureSeriesEngine, recomputeSeries, rejectFranchiseCandidate } from '../src/db/series.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { runDiagnosticsRepair } from './repairPreview.js';
import {
  FakeBangumiClient,
  makeCollectionItem,
  makeSubject,
  resetDatabase,
  runSync,
} from './helpers.js';

const TS = '2026-01-01T00:00:00.000Z';

function hideNsfw(value: boolean): void {
  saveConfig({ hideNsfw: value });
}

function seedSubject(id: number, rate: number, nsfw = false): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, aliases, year, format, season, score, total_episodes, eps,
       nsfw, tag_names, studios, directors, originals, detail_state, created_at, updated_at)
     VALUES (:id, :name, :name, '[]', 2010, 'TV', 'spring', 7.5, 12, 12,
       :nsfw, '[]', '[]', '[]', '[]', 'ok', :ts, :ts)`,
    { id, name: `家族平均分 ${id}`, nsfw: nsfw ? 1 : 0, ts: TS },
  );
  run(
    `INSERT INTO collections (subject_id, subject_type, type, rate, ep_status, updated_at, first_seen_at, synced_at)
     VALUES (:id, 2, 2, :rate, 12, :ts, :ts, :ts)`,
    { id, rate, ts: TS },
  );
}

function seedRelation(from: number, to: number, relation: string): void {
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:from, :to, :relation, 2, '', '', :ts)`,
    { from, to, relation, ts: TS },
  );
}

/**
 * 家族：Series A = {1,2}（8 / 6）· Series B = {3}（2）· Series D = {4,5}（10 / 4，4 是 NSFW）。
 * Real 平均 = 30/5 = 6；Visible（整 D 隐藏）= 16/3 ≈ 5.33。
 */
function seedFranchise(): string {
  seedSubject(1, 8);
  seedSubject(2, 6);
  seedSubject(3, 2);
  seedSubject(4, 10, true);
  seedSubject(5, 4);
  seedRelation(1, 2, '续集');
  seedRelation(2, 1, '前传');
  seedRelation(1, 3, '不同演绎');
  seedRelation(3, 1, '不同演绎');
  seedRelation(1, 4, '不同演绎');
  seedRelation(4, 1, '不同演绎');
  seedRelation(4, 5, '续集');
  seedRelation(5, 4, '前传');
  recomputeSeries();
  const franchise = listFranchises()[0];
  if (!franchise) throw new Error('fixture 未生成 Franchise');
  return franchise.key;
}

function materializedAverage(key: string): number | null {
  const row = one<{ average_rate: number | null }>(
    'SELECT average_rate FROM franchise_entities WHERE key = :key',
    { key },
  );
  return row?.average_rate === null || row?.average_rate === undefined ? null : Number(row.average_rate);
}

describe('Franchise 平均评分（v1.8 OD2）', () => {
  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
    invalidateDiagnosticsReport();
  });

  it('Real materialization 由 engine 以成员级平均写入（去重、round 2）', () => {
    const key = seedFranchise();
    expect(materializedAverage(key)).toBe(6);
    expect(franchiseAverageRateDriftCount()).toBe(0);
  });

  it('旧非法评分与过期聚合不污染 Real/Visible 的列表、详情和排序样本，不改写源与投影', () => {
    const key = seedFranchise();
    run("UPDATE collections SET rate='garbage' WHERE subject_id=1");
    const before = all('SELECT * FROM franchise_entities');
    const version = dataVersion();
    expect(materializedAverage(key)).toBe(6); // 历史投影保留，真实合法来源 6/2/10/4。
    expect(listFranchises().find((row) => row.key === key)?.averageRate).toBe(5.5);
    expect(getFranchiseDetail(key)?.averageRate).toBe(5.5);
    expect(getFranchiseDetail(key)?.analysis.rating.average).toMatchObject({ value: 5.5, ratedCount: 4 });
    hideNsfw(true);
    expect(listFranchises().find((row) => row.key === key)?.averageRate).toBe(4);
    expect(getFranchiseDetail(key)?.averageRate).toBe(4);
    expect(getFranchiseDetail(key)?.analysis.rating.average).toMatchObject({ value: 4, ratedCount: 2 });
    expect(all('SELECT * FROM franchise_entities')).toEqual(before);
    expect(dataVersion()).toBe(version);
  });

  it('list / detail 同源；hideNsfw=ON 时按可见成员重算且不泄漏隐藏 Series 的评分', () => {
    const key = seedFranchise();

    const realList = listFranchises().find((entry) => entry.key === key);
    const realDetail = getFranchiseDetail(key);
    expect(realList?.averageRate).toBe(6);
    expect(realDetail?.averageRate).toBe(6);

    hideNsfw(true);
    const visibleList = listFranchises().find((entry) => entry.key === key);
    const visibleDetail = getFranchiseDetail(key);
    // 家族仍有可见 Series → 家族保留，但平均分只由可见成员（8 / 6 / 2）得出
    expect(visibleList).toBeTruthy();
    expect(visibleList?.averageRate).toBe(5.33);
    expect(visibleDetail?.averageRate).toBe(5.33);
    // 隐藏 Series D 不出现在详情成员里，也不得通过平均值泄露
    expect(visibleDetail?.series.every((entry) => entry.collectedCount <= 2)).toBe(true);
    expect(visibleList?.averageRate).not.toBe(6);

    hideNsfw(false);
    expect(listFranchises().find((entry) => entry.key === key)?.averageRate).toBe(6);
    expect(getFranchiseDetail(key)?.averageRate).toBe(6);
  });

  it('Series 的 rate 排序在隐藏口径下与其可见平均分恒等（整 Series 隐藏语义）', () => {
    seedFranchise();
    hideNsfw(true);
    const visible = listSeries({ sort: 'rate', includeSingletons: true });
    expect(visible.length).toBeGreaterThan(0);
    for (const entry of visible) {
      const row = one<{ average_rate: number | null }>(
        'SELECT average_rate FROM series_entities WHERE key = :key',
        { key: entry.key },
      );
      // 可见 Series 不含隐藏成员：materialization 与可见平均分恒等，排序不存在混口径
      expect(entry.averageRate).toBe(row?.average_rate === null ? null : Number(row?.average_rate));
    }
  });

  it('confirmed 家族冻结成员后证据缩小，聚合仍以正式保留链接为准', () => {
    const key = seedFranchise();
    confirmFranchise(key);
    const before = getFranchiseDetail(key)!;
    run('DELETE FROM subject_relations WHERE (subject_id=1 AND related_id=3) OR (subject_id=3 AND related_id=1)');
    recomputeSeries();
    const detail = getFranchiseDetail(key)!;
    expect(detail.state).toBe('confirmed');
    expect(detail.series.map((entry) => entry.key).sort()).toEqual(before.series.map((entry) => entry.key).sort());
    expect(detail.seriesCount).toBe(detail.series.length);
    expect(detail.knownCount).toBe(before.knownCount);
    expect(detail.averageRate).toBe(6);
    expect(franchiseAverageRateDriftCount()).toBe(0);
    const conflicts = one<{ n: number }>("SELECT COUNT(*) AS n FROM entity_events WHERE entity_kind='franchise' AND kind='conflict'")!.n;
    const evidence = one<{ evidence: string }>("SELECT evidence FROM franchise_series WHERE state='conflict'")!.evidence;
    recomputeSeries();
    expect(getFranchiseDetail(key)?.averageRate).toBe(6);
    expect(getFranchiseDetail(key)?.seriesCount).toBe(3);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM entity_events WHERE entity_kind='franchise' AND kind='conflict'")!.n).toBe(conflicts);
    expect(one<{ evidence: string }>("SELECT evidence FROM franchise_series WHERE state='conflict'")!.evidence).toBe(evidence);
  });

  it('confirmed 家族暂不匹配当前 graph 时，保留身份且评分变化仍重算', () => {
    const key = seedFranchise();
    confirmFranchise(key);
    run("DELETE FROM subject_relations WHERE relation='不同演绎'");
    run('UPDATE collections SET rate=9 WHERE subject_id=3');
    recomputeSeries();
    const detail = getFranchiseDetail(key)!;
    expect(detail.state).toBe('confirmed');
    expect(detail.seriesCount).toBe(3);
    expect(detail.averageRate).toBe(7.4);
    expect(franchiseAverageRateDriftCount()).toBe(0);
    const conflicts = all("SELECT * FROM entity_events WHERE entity_kind='franchise' AND kind='conflict_unmatched' ORDER BY id");
    expect(conflicts).toHaveLength(1);
    recomputeSeries();
    expect(getFranchiseDetail(key)?.averageRate).toBe(7.4);
    expect(all("SELECT * FROM entity_events WHERE entity_kind='franchise' AND kind='conflict_unmatched' ORDER BY id")).toEqual(conflicts);
    seedRelation(1, 3, '不同演绎');
    seedRelation(3, 1, '不同演绎');
    seedRelation(1, 4, '不同演绎');
    seedRelation(4, 1, '不同演绎');
    recomputeSeries();
    expect(all("SELECT * FROM entity_events WHERE kind='conflict_resolved'")).toHaveLength(1);
    recomputeSeries();
    expect(all("SELECT * FROM entity_events WHERE kind='conflict_resolved'")).toHaveLength(1);
    run("DELETE FROM subject_relations WHERE relation='不同演绎'");
    recomputeSeries();
    expect(all("SELECT * FROM entity_events WHERE kind='conflict_unmatched'")).toHaveLength(2);
  });

  it('drift 检测 → recompute-derived 修复 → 恢复', () => {
    const key = seedFranchise();
    run(`UPDATE franchise_entities SET average_rate = NULL WHERE key = :key`, { key });
    invalidateDiagnosticsReport();
    expect(franchiseAverageRateDriftCount()).toBe(1);

    const issue = getDiagnosticsReport({ refresh: true }).issues.find(
      (entry) => entry.id === 'franchise.counter-drift',
    );
    expect(issue).toBeTruthy();
    expect(issue?.affectedCount).toBe(1);

    const result = runDiagnosticsRepair({
      issueId: 'franchise.counter-drift',
      kind: 'recompute-derived',
    });
    expect(result.ok).toBe(true);
    expect(result.verification.verified).toBe(true);
    expect(materializedAverage(key)).toBe(6);
    expect(franchiseAverageRateDriftCount()).toBe(0);
    expect(
      result.report.issues.some((entry) => entry.id === 'franchise.counter-drift'),
    ).toBe(false);
  });

  it('启动恢复：历史 NULL / drift 会按 source 重建一次', () => {
    const key = seedFranchise();
    run(`UPDATE franchise_entities SET average_rate = 9.99 WHERE key = :key`, { key });

    expect(ensureSeriesEngine()).toBe(true);
    expect(materializedAverage(key)).toBe(6);
    // 幂等：恢复后不再重复重建
    expect(ensureSeriesEngine()).toBe(false);
  });

  it.each(['{}', '[null]', '{broken'])('冻结人工名称遇到异常候选 %s：保留证据和身份，均分修复但来源仍 partial', (raw) => {
    const key = seedFranchise();
    confirmFranchise(key);
    expect(adoptFranchiseTitle(key, '冻结人工家族').ok).toBe(true);
    run('UPDATE franchise_entities SET title_candidates=:raw WHERE key=:key', { raw, key });
    const links = all('SELECT * FROM franchise_series ORDER BY rowid');
    const events = all('SELECT * FROM entity_events ORDER BY rowid');
    const subjects = all('SELECT * FROM subjects ORDER BY id');
    const issue = getDiagnosticsReport({ refresh: true }).issues.find((entry) => entry.id === 'titles.franchise-candidates-invalid');
    expect(issue).toMatchObject({ affectedCount: 1, severity: 'needs-review', actions: [] });
    expect(() => recomputeSeries()).not.toThrow();
    expect(one<{ title_candidates: string }>('SELECT title_candidates FROM franchise_entities WHERE key=:key', { key })!.title_candidates).toBe(raw);
    for (let pass = 0; pass < 2; pass += 1) {
      run('UPDATE franchise_entities SET average_rate=NULL WHERE key=:key', { key });
      invalidateDiagnosticsReport();
      const version = dataVersion();
      const result = runDiagnosticsRepair({ issueId: 'franchise.counter-drift', kind: 'recompute-derived' });
      // Constitution §9.4：均分收敛不等于必要人工来源已验证；不能替异常证据制造全局绿灯。
      expect(result.ok).toBe(false);
      expect(result.verification).toMatchObject({ verified: false, partial: true });
      expect(result.verification.checks.filter((check) => !check.ok).map(({ layer, label, ok }) => ({ layer, label, ok })))
        .toEqual([{ layer: 'source', label: 'Franchise 名称来源', ok: false }]);
      expect(result.verification.resolvedIssueIds).toContain('franchise.counter-drift');
      expect(result.report.issues.some((entry) => entry.id === 'franchise.counter-drift')).toBe(false);
      expect(materializedAverage(key)).toBe(6);
      expect(franchiseAverageRateDriftCount()).toBe(0);
      expect(result.report.issues.some((entry) => entry.id === 'titles.franchise-candidates-invalid')).toBe(true);
      expect(dataVersion()).toBe(version + 1);
      expect(one<{ title_candidates: string }>('SELECT title_candidates FROM franchise_entities WHERE key=:key', { key })!.title_candidates).toBe(raw);
      expect(getFranchiseDetail(key)).toMatchObject({ title: '冻结人工家族', titleState: 'manual', state: 'confirmed', averageRate: 6 });
      expect(all('SELECT * FROM franchise_series ORDER BY rowid')).toEqual(links);
      expect(all('SELECT * FROM entity_events ORDER BY rowid')).toEqual(events);
      expect(all('SELECT * FROM subjects ORDER BY id')).toEqual(subjects);
      expect(adoptFranchiseTitle(key, '不可覆盖异常证据').ok).toBe(false);
      expect(() => runDiagnosticsRepair({ issueId: 'franchise.counter-drift', kind: 'recompute-derived' })).toThrow();
      expect(dataVersion()).toBe(version + 1);
    }
  });

  it('Repair 最终版本提交失败：派生、治理、原始数据和版本整体回滚', () => {
    const key = seedFranchise();
    confirmFranchise(key);
    expect(adoptFranchiseTitle(key, '保留治理名称').ok).toBe(true);
    run('UPDATE franchise_entities SET average_rate=NULL WHERE key=:key', { key });
    const tables = ['subjects', 'collections', 'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'franchise_member_exclusions', 'entity_events', 'candidate_decisions', 'entity_aliases', 'meta'];
    const before = tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    exec("CREATE TRIGGER audit_repair_version_failure BEFORE INSERT ON meta WHEN NEW.key='data_version' BEGIN SELECT RAISE(ABORT, 'repair version failure'); END");
    try {
      expect(() => runDiagnosticsRepair({ issueId: 'franchise.counter-drift', kind: 'recompute-derived' })).toThrow('repair version failure');
      expect(tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(before);
    } finally { exec('DROP TRIGGER audit_repair_version_failure'); }
    expect(runDiagnosticsRepair({ issueId: 'franchise.counter-drift', kind: 'recompute-derived' }).verification.verified).toBe(true);
  });

  it.each(['confirmed', 'rejected'])('冻结 %s 的非人工异常候选仍原样保留；合法重复候选不被去重', (state) => {
    const key = seedFranchise();
    if (state === 'confirmed') confirmFranchise(key);
    else expect(rejectFranchiseCandidate(key, '历史人工裁决').ok).toBe(true);
    const decisions = all('SELECT * FROM candidate_decisions ORDER BY id');
    for (const raw of ['{broken', '[null]', '[{"title":"旧候选","source":"brand:members","state":"provisional","evidence":"旧证据"},{"title":"旧候选","source":"brand:members","state":"provisional","evidence":"另一个来源"}]']) {
      run('UPDATE franchise_entities SET title_candidates=:raw WHERE key=:key', { key, raw });
      const title = getFranchiseDetail(key)!.title;
      recomputeSeries();
      recomputeSeries();
      expect(getFranchiseDetail(key)).toMatchObject({ state, title });
      expect(one<{ title_candidates: string }>('SELECT title_candidates FROM franchise_entities WHERE key=:key', { key })!.title_candidates).toBe(raw);
      expect(all('SELECT * FROM candidate_decisions ORDER BY id')).toEqual(decisions);
    }
  });

  it('Repair 中途重建写入失败仍整体回滚，移除故障后可安全重试', () => {
    const key = seedFranchise();
    confirmFranchise(key);
    run('UPDATE franchise_entities SET average_rate=NULL WHERE key=:key', { key });
    const tables = ['subjects', 'collections', 'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'entity_events', 'candidate_decisions', 'meta'];
    const before = tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    exec("CREATE TRIGGER audit_repair_rebuild_failure BEFORE INSERT ON franchise_series BEGIN SELECT RAISE(ABORT, 'repair rebuild failure'); END");
    try {
      expect(() => runDiagnosticsRepair({ issueId: 'franchise.counter-drift', kind: 'recompute-derived' })).toThrow('repair rebuild failure');
      expect(tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(before);
    } finally { exec('DROP TRIGGER audit_repair_rebuild_failure'); }
    expect(runDiagnosticsRepair({ issueId: 'franchise.counter-drift', kind: 'recompute-derived' }).verification.verified).toBe(true);
  });

  it('sync 在 apply 之后失败：不留下 stale 投影，并推进 dataVersion', async () => {
    const key = seedFranchise();
    // 本夹具模拟归属已确认的账号；未确认旧库应在同步前拒绝，另有专项回归。
    setMeta('collection_owner_uid', '1');
    const versionBefore = dataVersion();

    const ids = [1, 2, 3, 4, 5];
    const rates: Record<number, number> = { 1: 8, 2: 6, 3: 9, 4: 10, 5: 4 };
    const client = new FakeBangumiClient({
      collections: ids.map((id) => makeCollectionItem({ subject_id: id, rate: rates[id] })),
      subjects: Object.fromEntries(ids.map((id) => [id, makeSubject({ id, nsfw: id === 4 })])),
      subjectErrors: Object.fromEntries(
        ids.map((id) => [id, new BangumiApiError('network', '网络请求失败')]),
      ),
    });

    const status = await runSync(client, { forceDetail: true });
    expect(status.lastRun?.status).toBe('error');
    expect(dataVersion()).toBeGreaterThan(versionBefore);
    // 评分 3 已从 2 → 9，补偿重建后 materialization = (8+6+9+10+4)/5
    expect(materializedAverage(key)).toBe(7.4);
    expect(franchiseAverageRateDriftCount()).toBe(0);
  });
});
