/**
 * v1.6.1：候选治理（Reject / Confirm）+ Mutation Contract。
 *
 * 重点验证：
 * - 否决是真实治理状态（写入 candidate_decisions），不是 UI 隐藏；
 * - 否决保留 provenance（候选、来源、决定时间、证据快照）；
 * - 重建 / 同步后否决不会被静默改回，问题不再作为待处理出现；
 * - 出现新证据时否决失效，候选可以重新进入评估；
 * - 所有治理 mutation 都推进数据版本并让诊断立刻反映真实状态。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { all, dataVersion, one, run } from '../src/db/index.js';
import {
  confirmFranchise,
  rejectFranchiseCandidate,
  rejectSeriesTitleCandidate,
  reopenFranchiseCandidate,
  reopenSeriesTitleCandidate,
  recomputeSeries,
} from '../src/db/series.js';
import { listGovernanceHistory } from '../src/db/history.js';
import { getFranchiseDetail, getSeriesDetail, listFranchises, listSeries } from '../src/db/query.js';
import { searchSeriesEntities } from '../src/db/ipSearch.js';
import { lastMutation, recordMutation } from '../src/db/mutation.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { runDiagnosticsRepair } from '../src/diagnostics/repair.js';
import { resetDatabase } from './helpers.js';

const TS = '2026-01-01T00:00:00.000Z';

function seedSubject(id: number, nameCn: string): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, aliases, year, format, nsfw, tag_names, created_at, updated_at)
     VALUES (:id, :name, :nameCn, '[]', 2010, 'TV', 0, '[]', :ts, :ts)`,
    { id, name: nameCn, nameCn, ts: TS },
  );
  run(
    `INSERT INTO collections (subject_id, subject_type, type, rate, first_seen_at, synced_at)
     VALUES (:id, 2, 2, 0, :ts, :ts)`,
    { id, ts: TS },
  );
}

function seedRelation(from: number, to: number, relation: string): void {
  run(
    `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
     VALUES (:from, :to, :relation, 2, '', '', :ts)`,
    { from, to, relation, ts: TS },
  );
}

/** 一个会产生 Franchise 候选的图：series1(1,2) + series2(3) 由「不同演绎」连接。 */
function seedFranchiseCandidate(): string {
  seedSubject(1, '家族作品');
  seedSubject(2, '家族作品 第二季');
  seedRelation(1, 2, '续集');
  seedRelation(2, 1, '前传');
  seedSubject(3, '家族作品 新作');
  seedRelation(1, 3, '不同演绎');
  seedRelation(3, 1, '不同演绎');
  recomputeSeries();
  return listFranchises()[0]!.key;
}

function seedSeries(): string {
  seedSubject(1, '测试系列');
  seedSubject(2, '测试系列 第二季');
  seedRelation(1, 2, '续集');
  seedRelation(2, 1, '前传');
  recomputeSeries();
  return listSeries({ includeSingletons: true })[0]!.key;
}

describe('候选治理：Franchise', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });

  it('待确认候选同时提供确认与否决；否决写入真实治理状态并保留证据', () => {
    const key = seedFranchiseCandidate();
    invalidateDiagnosticsReport();
    const report = getDiagnosticsReport({ refresh: true });
    const issue = report.issues.find((entry) => entry.id === `franchise.awaiting-review:${key}`)!;
    expect(issue.severity).toBe('needs-review');
    const repairKinds = issue.actions
      .filter((action) => action.kind === 'repair')
      .map((action) => (action.kind === 'repair' ? action.repairKind : ''));
    expect(repairKinds).toContain('confirm-franchise');
    expect(repairKinds).toContain('reject-franchise-candidate');

    const beforeVersion = dataVersion();
    const result = runDiagnosticsRepair({
      issueId: issue.id,
      kind: 'reject-franchise-candidate',
      target: key,
    });

    // 验证覆盖治理 / API / 搜索 / detector / 缓存
    const layers = result.verification.checks.map((check) => check.layer);
    expect(layers).toContain('governance');
    expect(layers).toContain('api');
    expect(layers).toContain('search');
    expect(layers).toContain('detector');
    expect(result.verification.verified).toBe(true);

    // 真实治理状态
    expect(getFranchiseDetail(key)!.state).toBe('rejected');
    expect(dataVersion()).toBeGreaterThan(beforeVersion);
    expect(lastMutation().scope).toBe('governance');

    // provenance：决定 + 证据快照保留
    const decision = one<{ candidate_title: string; evidence: string; reason: string }>(
      `SELECT d.candidate_title, d.evidence, d.reason FROM candidate_decisions d
        JOIN franchise_entities f ON f.id = d.entity_id
       WHERE d.entity_kind = 'franchise' AND d.decision = 'rejected' AND f.key = :key`,
      { key },
    );
    expect(decision?.candidate_title).toBe(key);
    expect(decision?.evidence).toContain('previousState');
    const events = all<{ kind: string }>(
      `SELECT kind FROM entity_events WHERE entity_kind = 'franchise' AND kind = 'rejected'`,
    );
    expect(events.length).toBeGreaterThan(0);

    // detector：不再作为待处理候选
    const after = getDiagnosticsReport({ refresh: true });
    expect(after.issues.some((entry) => entry.id === issue.id)).toBe(false);
    // 证据保留：家族仍然存在且可以搜索到
    expect(getFranchiseDetail(key)!.series.length).toBeGreaterThan(0);
  });

  it('同向重复否决 Franchise 与标题是完整 no-op，不改投影理由、历史或版本', () => {
    const franchiseKey = seedFranchiseCandidate();
    rejectFranchiseCandidate(franchiseKey, 'first franchise reason');
    const franchiseBefore = one('SELECT * FROM franchise_entities WHERE key=:key', { key: franchiseKey });
    const beforeEvents = all('SELECT * FROM entity_events ORDER BY id');
    const beforeDecisions = all('SELECT * FROM candidate_decisions ORDER BY id');
    const beforeVersion = dataVersion();
    expect(rejectFranchiseCandidate(franchiseKey, 'second reason').ok).toBe(true);
    expect(one('SELECT * FROM franchise_entities WHERE key=:key', { key: franchiseKey })).toEqual(franchiseBefore);
    expect(all('SELECT * FROM entity_events ORDER BY id')).toEqual(beforeEvents);
    expect(all('SELECT * FROM candidate_decisions ORDER BY id')).toEqual(beforeDecisions);
    expect(dataVersion()).toBe(beforeVersion);

    resetDatabase();
    const seriesKey = seedSeries();
    const title = getSeriesDetail(seriesKey)!.title;
    rejectSeriesTitleCandidate(seriesKey, title, 'first title reason');
    const seriesBefore = one('SELECT * FROM series_entities WHERE key=:key', { key: seriesKey });
    const titleEvents = all('SELECT * FROM entity_events ORDER BY id');
    const titleVersion = dataVersion();
    expect(rejectSeriesTitleCandidate(seriesKey, title, 'second title reason').ok).toBe(true);
    expect(one('SELECT * FROM series_entities WHERE key=:key', { key: seriesKey })).toEqual(seriesBefore);
    expect(all('SELECT * FROM entity_events ORDER BY id')).toEqual(titleEvents);
    expect(dataVersion()).toBe(titleVersion);
  });

  it('否决之后重建不会静默改回候选；确认可以覆盖否决（用户改主意）', () => {
    const key = seedFranchiseCandidate();
    rejectFranchiseCandidate(key, '测试');
    recomputeSeries();
    expect(getFranchiseDetail(key)!.state).toBe('rejected');
    recomputeSeries();
    expect(getFranchiseDetail(key)!.state).toBe('rejected');

    // 已否决的候选不再出现在待处理问题里，因此不能通过数据中枢确认
    expect(() =>
      runDiagnosticsRepair({
        issueId: `franchise.awaiting-review:${key}`,
        kind: 'confirm-franchise',
        target: key,
      }),
    ).toThrowError(/已不存在/);
    // 但家族页面自身的确认入口仍然可用（既有治理能力）
    expect(confirmFranchise(key)).toBe(true);
    expect(getFranchiseDetail(key)!.state).toBe('confirmed');
  });

  it('出现新证据（新成员）时否决失效，候选重新进入评估', () => {
    const key = seedFranchiseCandidate();
    rejectFranchiseCandidate(key, '测试');
    expect(getFranchiseDetail(key)!.state).toBe('rejected');

    // 新证据：新的 Series 通过「不同演绎」加入同一家族
    seedSubject(4, '家族作品 外传');
    seedRelation(4, 3, '不同演绎');
    seedRelation(3, 4, '不同演绎');
    recomputeSeries();

    expect(getFranchiseDetail(key)!.state).not.toBe('rejected');
    const reopened = all<{ kind: string }>(
      `SELECT kind FROM entity_events WHERE entity_kind = 'franchise' AND kind = 'candidate_reopened'`,
    );
    expect(reopened.length).toBeGreaterThan(0);
    // 重新进入待评估：detector 再次把它列为待人工确认
    invalidateDiagnosticsReport();
    const report = getDiagnosticsReport({ refresh: true });
    expect(report.issues.some((entry) => entry.id.startsWith('franchise.awaiting-review'))).toBe(true);
  });

  it('否决可逆：重新评估把家族放回候选状态，旧否决标记为 superseded', () => {
    const key = seedFranchiseCandidate();
    rejectFranchiseCandidate(key, '测试否决');
    expect(getFranchiseDetail(key)!.state).toBe('rejected');

    const reopened = reopenFranchiseCandidate(key, '重新评估');
    expect(reopened.ok).toBe(true);
    expect(getFranchiseDetail(key)!.state).toBe('candidate');

    const decision = one<{ decision: string; reason: string }>(
      `SELECT d.decision, d.reason FROM candidate_decisions d
        JOIN franchise_entities f ON f.id = d.entity_id
       WHERE d.entity_kind = 'franchise' AND d.candidate_kind = 'franchise' AND f.key = :key`,
      { key },
    );
    expect(decision?.decision).toBe('superseded');
    expect(decision?.reason).toBe('重新评估');

    // 重新进入待评估：detector 再次把它列为待人工确认
    invalidateDiagnosticsReport();
    const report = getDiagnosticsReport({ refresh: true });
    expect(report.issues.some((entry) => entry.id === `franchise.awaiting-review:${key}`)).toBe(true);
  });
});

describe('候选治理：标题候选', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });

  it('否决当前展示标题：候选退出竞争、展示标题重新选择、搜索别名同步', () => {
    const key = seedSeries();
    const detail = getSeriesDetail(key)!;
    const current = detail.title;
    const beforeVersion = dataVersion();
    const result = rejectSeriesTitleCandidate(key, current, '测试：否决当前标题');
    expect(result.ok).toBe(true);
    expect(dataVersion()).toBeGreaterThan(beforeVersion);

    const after = getSeriesDetail(key)!;
    const rejected = after.titleCandidates.find((candidate) => candidate.title === current)!;
    expect(rejected.rejected).toBe(true);
    expect(rejected.valid).toBe(false);
    expect(after.title).not.toBe(current);

    // 否决决定与证据快照保留
    const decision = one<{ evidence: string; decision: string }>(
      `SELECT evidence, decision FROM candidate_decisions
        WHERE entity_kind = 'series' AND candidate_kind = 'title' AND candidate_title = :title`,
      { title: current },
    );
    expect(decision?.decision).toBe('rejected');
    expect(decision?.evidence).toContain('support');

    // 重建后否决仍然有效（不会被自动改回）
    recomputeSeries();
    const rebuilt = getSeriesDetail(key)!;
    expect(rebuilt.titleCandidates.find((candidate) => candidate.title === current)?.valid).toBe(
      false,
    );
  });

  it('数据中枢：结构可疑候选提供「否决」动作，执行后问题真正消失', () => {
    const key = seedSeries();
    const detail = getSeriesDetail(key)!;
    // 人工注入一个结构可疑候选（括号未闭合），模拟真实数据里的污染候选
    const polluted = [
      ...detail.titleCandidates,
      {
        title: '测试系列 (ビスク',
        source: 'brand:members',
        state: 'provisional',
        evidence: '测试注入',
        valid: true,
        support: 2,
        coverage: 0.5,
      },
    ];
    run('UPDATE series_entities SET title_candidates = :json WHERE key = :key', {
      json: JSON.stringify(polluted),
      key,
    });
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = report.issues.find((entry) => entry.id === 'titles.candidate-structural')!;
    expect(issue).toBeTruthy();
    const action = issue.actions.find(
      (entry) => entry.kind === 'repair' && entry.repairKind === 'reject-title-candidate',
    );
    expect(action).toBeTruthy();
    if (!action || action.kind !== 'repair') throw new Error('missing reject action');
    expect(action.value).toBe('测试系列 (ビスク');

    const result = runDiagnosticsRepair({
      issueId: issue.id,
      kind: 'reject-title-candidate',
      target: key,
      value: action.value,
    });
    expect(result.verification.verified).toBe(true);
    const layers = result.verification.checks.map((entry) => entry.layer);
    expect(layers).toContain('governance');
    expect(layers).toContain('search');
    expect(layers).toContain('detector');

    // 搜索别名排除 + 决定保留
    expect(
      searchSeriesEntities('测试系列 (ビスク').items.some((item) => item.key === key),
    ).toBe(false);
    const rejected = getSeriesDetail(key)!.titleCandidates.find(
      (candidate) => candidate.title === '测试系列 (ビスク',
    )!;
    expect(rejected.valid).toBe(false);
    expect(rejected.rejected).toBe(true);
  });

  it.each(['完整', '旧数字字符串', '缺来源但数值可信'])('标题候选：出现更强证据时旧否决自动 superseded：%s', (format) => {
    // 三成员系列，最初只有 2 个成员共享品牌前缀 → support 2 / coverage 2/3
    seedSubject(1, '测试系列');
    seedSubject(2, '测试系列 第二季');
    seedSubject(3, '无关作品');
    seedRelation(1, 2, '续集');
    seedRelation(2, 1, '前传');
    seedRelation(2, 3, '续集');
    seedRelation(3, 2, '前传');
    recomputeSeries();
    const key = listSeries({ includeSingletons: true })[0]!.key;
    const current = getSeriesDetail(key)!.title;
    const rejected = rejectSeriesTitleCandidate(key, current, '测试：先否决');
    expect(rejected.ok).toBe(true);
    if (format !== '完整') {
      const row = one<{ evidence: string }>("SELECT evidence FROM candidate_decisions WHERE candidate_kind='title'")!;
      const evidence = JSON.parse(row.evidence);
      evidence.support = String(evidence.support);
      evidence.coverage = String(evidence.coverage);
      if (format === '缺来源但数值可信') delete evidence.sources;
      run("UPDATE candidate_decisions SET evidence=:raw WHERE candidate_kind='title'", { raw: JSON.stringify(evidence) });
    }
    // 否决后候选退出竞争
    expect(
      getSeriesDetail(key)!.titleCandidates.find((candidate) => candidate.title === current)!.valid,
    ).toBe(false);

    // 更强的证据：第三个成员也改为同一品牌 → support 3 / coverage 3/3
    run(`UPDATE subjects SET name = :name, name_cn = :name WHERE id = 3`, {
      name: `${current} 第三季`,
    });
    recomputeSeries();

    const decision = one<{ decision: string; reason: string }>(
      `SELECT d.decision, d.reason FROM candidate_decisions d
        JOIN series_entities e ON e.id = d.entity_id
       WHERE d.entity_kind = 'series' AND d.candidate_kind = 'title' AND e.key = :key`,
      { key },
    );
    expect(decision?.decision).toBe('superseded');
    const reopened = all<{ kind: string }>(
      `SELECT kind FROM entity_events WHERE entity_kind = 'series' AND kind = 'candidate_reopened'`,
    );
    expect(reopened.length).toBeGreaterThan(0);
    // 候选重新参与竞争（不再被标记为 rejected）
    const candidate = getSeriesDetail(key)!.titleCandidates.find(
      (entry) => entry.title === current,
    )!;
    expect(candidate.rejected ?? false).toBe(false);
  });

  it('合法否决后的连续重算不记录 from=to 的虚假标题变更', () => {
    const key = seedSeries();
    const title = getSeriesDetail(key)!.title;
    expect(rejectSeriesTitleCandidate(key, title, 'keep rejection').ok).toBe(true);
    const events = all('SELECT * FROM entity_events ORDER BY id');
    const version = dataVersion();
    recomputeSeries();
    recomputeSeries();
    expect(all('SELECT * FROM entity_events ORDER BY id')).toEqual(events);
    expect(dataVersion()).toBe(version);
  });

  it.each(['null', '{}', '[]', 'not-json', '{"support":null,"coverage":null}',
    '{"support":false,"coverage":{},"sources":[null]}', '{"support":1e309,"coverage":-1}',
    '{"support":"","coverage":"","sources":null}'])('旧否决证据 %s 不能被解释为新证据而自动复活候选', (raw) => {
    const key = seedSeries();
    const title = getSeriesDetail(key)!.title;
    expect(rejectSeriesTitleCandidate(key, title, 'original rejection').ok).toBe(true);
    run("UPDATE candidate_decisions SET evidence=:raw WHERE entity_kind='series' AND candidate_kind='title'", { raw });
    const decisions = all('SELECT * FROM candidate_decisions ORDER BY id');
    const events = all('SELECT * FROM entity_events ORDER BY id');
    const version = dataVersion();
    recomputeSeries();
    recomputeSeries();
    expect(all('SELECT * FROM candidate_decisions ORDER BY id')).toEqual(decisions);
    expect(all('SELECT * FROM entity_events ORDER BY id')).toEqual(events);
    expect(dataVersion()).toBe(version);
    expect(getSeriesDetail(key)!.titleCandidates.find((entry) => entry.title === title)).toMatchObject({ valid: false, rejected: true });
    const issue = getDiagnosticsReport({ refresh: true }).issues.find((entry) => entry.id === 'titles.rejected-candidates');
    expect(issue?.evidence.some((entry) => String(entry.value).includes('历史证据不完整'))).toBe(true);
    // 人工 Reopen 仍可明确裁决，并将无法解析的原始证据字符串保留在新证据里。
    expect(reopenSeriesTitleCandidate(key, title, 'explicit reopen').ok).toBe(true);
    const evidence = one<{ evidence: string }>('SELECT evidence FROM candidate_decisions')!.evidence;
    expect(JSON.parse(evidence).previousEvidence).toBe(raw);
    expect(dataVersion()).toBe(version + 1);
  });

  it('标题候选手动重新进入评估：旧否决保留为 superseded，候选回到竞争且不会变成 manual', () => {
    const key = seedSeries();
    const detail = getSeriesDetail(key)!;
    const target = detail.titleCandidates.find((candidate) => candidate.valid !== false)!.title;
    expect(rejectSeriesTitleCandidate(key, target, '测试：否决').ok).toBe(true);

    const beforeVersion = dataVersion();
    const result = reopenSeriesTitleCandidate(key, target, '测试：重新进入评估');
    expect(result.ok).toBe(true);
    expect(dataVersion()).toBeGreaterThan(beforeVersion);
    expect(lastMutation().scope).toBe('governance');

    // 候选回到竞争；旧否决保留并标记 superseded
    const after = getSeriesDetail(key)!;
    const candidate = after.titleCandidates.find((entry) => entry.title === target)!;
    expect(candidate.valid).toBe(true);
    expect(candidate.rejected ?? false).toBe(false);
    expect(after.titleState).not.toBe('manual');
    const decision = one<{ decision: string; evidence: string; reason: string }>(
      `SELECT d.decision, d.evidence, d.reason FROM candidate_decisions d
        JOIN series_entities e ON e.id = d.entity_id
       WHERE d.entity_kind = 'series' AND d.candidate_kind = 'title' AND e.key = :key`,
      { key },
    );
    expect(decision?.decision).toBe('superseded');
    expect(decision?.reason).toBe('测试：重新进入评估');
    expect(decision?.evidence).toContain('previousRejectReason');

    // recompute 后依然有效（不会静默复活成 rejected，也不会变成 manual）
    recomputeSeries();
    const rebuilt = getSeriesDetail(key)!;
    expect(rebuilt.titleCandidates.find((entry) => entry.title === target)?.valid).toBe(true);
    expect(rebuilt.titleState).not.toBe('manual');

    // 重新否决仍然有效（upsert 回 rejected）
    expect(rejectSeriesTitleCandidate(key, target, '再次否决').ok).toBe(true);
    const rejectedAgain = one<{ decision: string }>(
      `SELECT d.decision FROM candidate_decisions d
        JOIN series_entities e ON e.id = d.entity_id
       WHERE d.entity_kind = 'series' AND d.candidate_kind = 'title' AND e.key = :key`,
      { key },
    );
    expect(rejectedAgain?.decision).toBe('rejected');
  });

  it('治理历史：来自 entity_events 与 candidate_decisions，含 actor / 决定 / 证据，且只读', () => {
    const key = seedSeries();
    const current = getSeriesDetail(key)!.title;
    rejectSeriesTitleCandidate(key, current, '测试：历史记录');
    reopenSeriesTitleCandidate(key, current, '测试：历史重开');
    seedSubject(3, '历史家族 甲');
    seedSubject(4, '历史家族 乙');
    seedRelation(3, 4, '不同演绎');
    seedRelation(4, 3, '不同演绎');
    recomputeSeries();
    confirmFranchise(listFranchises()[0]!.key);

    const history = listGovernanceHistory({ limit: 50 });
    expect(history.total).toBeGreaterThan(0);
    expect(history.entries.length).toBeGreaterThan(0);
    // 时间倒序
    const times = history.entries.map((entry) => entry.at);
    expect([...times].sort((a, b) => (a < b ? 1 : -1))).toEqual(times);
    // 用户决定 + 系统事件都有 actor 标注
    expect(history.entries.some((entry) => entry.actor === 'user')).toBe(true);
    expect(history.entries.some((entry) => entry.actor === 'system')).toBe(true);
    // 标题候选的否决与重开都出现在历史里，并带证据快照
    const rejected = history.entries.find((entry) => entry.kind === 'candidate_rejected');
    const reopened = history.entries.find((entry) => entry.kind === 'candidate_reopened');
    expect(rejected?.summary).toContain('否决标题候选');
    expect(rejected?.candidate?.title).toBe(current);
    expect(reopened?.summary).toContain('重新进入评估');
    const decision = history.entries.find((entry) => entry.source === 'candidate_decision');
    expect(decision?.evidence).toContain('previousRejectReason');
    expect(decision?.stateChange).toContain('superseded');
    // 实体信息可解析（用于跳转）
    expect(history.entries.some((entry) => entry.entityKey === key)).toBe(true);
    // 筛选：只看 Series
    const seriesOnly = listGovernanceHistory({ entityKind: 'series', limit: 50 });
    expect(seriesOnly.entries.every((entry) => entry.entityKind === 'series')).toBe(true);
  });
});

describe('候选 Repair：历史与版本故障组合', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });

  const kinds = ['confirm-franchise', 'reject-franchise-candidate', 'adopt-title-candidate', 'reject-title-candidate', 'reopen-title-candidate'] as const;
  for (const fault of ['history', 'version'] as const) {
    it.each(kinds)(`%s 的 ${fault} 写入失败必须原子回滚，重试只推进一次版本`, (kind) => {
      if (kind === 'confirm-franchise' || kind === 'reject-franchise-candidate') {
        seedFranchiseCandidate();
      } else {
        const key = seedSeries();
        const detail = getSeriesDetail(key)!;
        if (kind === 'adopt-title-candidate') {
          run('UPDATE series_entities SET title=:title WHERE key=:key', { title: '测试系列 (ビスク', key });
        } else if (kind === 'reject-title-candidate') {
          run('UPDATE series_entities SET title_candidates=:json WHERE key=:key', {
            json: JSON.stringify([...detail.titleCandidates, { title: '测试系列 (ビスク', source: 'brand:members', state: 'provisional', evidence: 'synthetic', valid: true, support: 2, coverage: 0.5 }]), key,
          });
        } else {
          expect(rejectSeriesTitleCandidate(key, detail.title, 'original reason').ok).toBe(true);
        }
      }
      const tables = ['subjects', 'collections', 'subject_relations', 'series', 'series_members', 'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'franchise_member_exclusions', 'entity_aliases', 'candidate_decisions', 'entity_events', 'meta'];
      const snapshot = () => tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
      const before = snapshot();
      const report = getDiagnosticsReport({ refresh: true });
      const issue = report.issues.find((entry) => entry.actions.some((action) => action.kind === 'repair' && action.repairKind === kind))!;
      expect(issue).toBeTruthy();
      const action = issue.actions.find((entry) => entry.kind === 'repair' && entry.repairKind === kind)!;
      if (action.kind !== 'repair') throw new Error('missing repair');
      expect(action.preview).toBeTruthy();
      expect(snapshot()).toEqual(before); // Preview / report 只读。
      const request = { issueId: issue.id, kind, target: action.target, value: action.value };
      const version = dataVersion();
      run(fault === 'history'
        ? `CREATE TRIGGER audit_candidate_failure BEFORE INSERT ON entity_events BEGIN SELECT RAISE(ABORT, 'injected candidate failure'); END`
        : `CREATE TRIGGER audit_candidate_failure BEFORE INSERT ON meta WHEN NEW.key='data_version' BEGIN SELECT RAISE(ABORT, 'injected candidate failure'); END`);
      try {
        expect(() => runDiagnosticsRepair(request)).toThrow('injected candidate failure');
        expect(snapshot()).toEqual(before);
        expect(getDiagnosticsReport({ refresh: true }).issues.some((entry) => entry.id === issue.id)).toBe(true);
      } finally { run('DROP TRIGGER audit_candidate_failure'); }
      const result = runDiagnosticsRepair(request);
      expect(result.verification.verified).toBe(true);
      expect(dataVersion()).toBe(version + 1);
      // 已处理动作不能借陈旧 Preview 再次写入治理历史或推进版本。
      const after = snapshot();
      expect(() => runDiagnosticsRepair(request)).toThrow();
      expect(snapshot()).toEqual(after);
    });
  }
});

describe('Mutation Contract', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });

  it('recordMutation 推进数据版本、失效诊断缓存并记录来源', () => {
    seedSeries();
    getDiagnosticsReport({ refresh: true });
    const before = dataVersion();
    const mutation = recordMutation('governance', 'test mutation');
    expect(mutation.dataVersion).toBe(before + 1);
    expect(mutation.invalidated).toContain('diagnostics-report');
    expect(lastMutation().scope).toBe('governance');
    expect(lastMutation().detail).toBe('test mutation');
    // 缓存已失效：不 refresh 也会重新检测
    const report = getDiagnosticsReport();
    expect(report.dataVersion).toBe(before + 1);
    expect(report.lastMutation.scope).toBe('governance');
  });

  it('新数据进入后自动进入检测范围（scope 随数据变化）', () => {
    seedSeries();
    const before = getDiagnosticsReport({ refresh: true });
    expect(before.scope.subjects).toBe(2);

    seedSubject(3, '新进入的作品');
    seedRelation(1, 3, '续集');
    seedRelation(3, 1, '前传');
    recomputeSeries();
    recordMutation('sync', 'new subjects');

    const after = getDiagnosticsReport();
    expect(after.scope.subjects).toBe(3);
    expect(after.dataVersion).toBeGreaterThan(before.dataVersion);
    expect(after.lastMutation.scope).toBe('sync');
  });
});
