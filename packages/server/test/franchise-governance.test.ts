/**
 * v1.7.0：Franchise 成员 / 名称治理。
 *
 * 重点验证：
 * - 成员移出是真实 source-of-truth（franchise_member_exclusions + 证据快照），不是 UI 隐藏；
 * - recompute 不会把被移出的成员静默加回来，也不会丢掉家族身份；
 * - 修正成员构成 ≠ 自动确认（状态回到可重新评估）；
 * - 撤销排除按当前证据重新评估，不强制加回、不自动确认，原 provenance 保留；
 * - 人工命名 / 恢复自动解析只影响名称与候选 provenance，不触碰成员构成；
 * - 治理动作复用数据中枢契约：Preview / Impact Chain / 分层 Verification / Mutation Contract / 治理历史。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { all, dataVersion, one, run } from '../src/db/index.js';
import {
  confirmFranchise,
  rejectFranchiseCandidate,
  recomputeSeries,
} from '../src/db/series.js';
import { listGovernanceHistory } from '../src/db/history.js';
import { getFranchiseDetail, getSeriesDetail, listFranchises, listSeries } from '../src/db/query.js';
import { searchFranchiseEntities } from '../src/db/ipSearch.js';
import { lastMutation } from '../src/db/mutation.js';
import { executeManualFranchise, previewManualFranchise, visibleManualAssignments } from '../src/db/manualFranchise.js';
import { adoptFranchiseTitle } from '../src/db/franchiseGovernance.js';
import {
  buildFranchiseGovernancePreview,
  runFranchiseGovernance,
} from '../src/diagnostics/franchiseGovernance.js';
import { invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
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

/** 三个 Series 由一个「不同演绎」连通分量组成的家族（成员归组可被人工修正）。 */
function seedFranchise(): {
  key: string;
  keepA: string;
  keepB: string;
  polluter: string;
  polluterTitle: string;
} {
  seedSubject(1, '孤岛之诗');
  seedSubject(2, '孤岛之诗 第二季');
  seedRelation(1, 2, '续集');
  seedRelation(2, 1, '前传');
  seedSubject(3, '深海回声');
  seedRelation(1, 3, '不同演绎');
  seedRelation(3, 1, '不同演绎');
  seedSubject(4, '异界奇谈');
  seedRelation(1, 4, '不同演绎');
  seedRelation(4, 1, '不同演绎');
  recomputeSeries();
  const franchise = listFranchises()[0]!;
  const series = new Map(
    listSeries({ includeSingletons: true }).map((entry) => [entry.title, entry.key]),
  );
  const polluter = series.get('异界奇谈')!;
  return {
    key: franchise.key,
    keepA: series.get('孤岛之诗')!,
    keepB: series.get('深海回声')!,
    polluter,
    polluterTitle: getSeriesDetail(polluter)!.title,
  };
}

function memberKeys(key: string): string[] {
  return (getFranchiseDetail(key)?.series ?? []).map((entry) => entry.key).sort();
}

describe('Franchise 成员治理：移出 / 撤销', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });

  it.each([true,false])('人工固定不改变自动候选证据（重算时自动依据保留=%s）', (keepAutomatic) => {
    const {key} = seedFranchise();
    expect(confirmFranchise(key)).toBe(true);
    seedSubject(5, '独立的附加演绎');
    seedRelation(1,5,'不同演绎');
    seedRelation(5,1,'不同演绎');
    recomputeSeries();
    const candidate=listSeries({includeSingletons:true}).find(s=>s.title==='独立的附加演绎')!.key;
    const link=()=>getFranchiseDetail(key)!.series.find(s=>s.key===candidate);
    expect(link()?.linkState).toBe('candidate');
    const add={action:'attach',franchise:key,series:candidate} as const;
    executeManualFranchise(add,previewManualFranchise(add).token);
    const assignment=visibleManualAssignments(key).items.find(a=>a.seriesKey===candidate)!.id;
    if(!keepAutomatic)run("DELETE FROM subject_relations WHERE (subject_id=5 OR related_id=5) AND relation='不同演绎'");
    recomputeSeries();
    expect(link()?.linkState).toBe('confirmed');
    const remove={action:'release',franchise:key,assignment} as const;
    executeManualFranchise(remove,previewManualFranchise(remove).token);
    expect(link()?.linkState).toBe(keepAutomatic?'candidate':undefined);
  });

  it.each(['{}', '[null]'])('异常历史家族候选 %s 不阻断只读详情；名称写入拒绝且保留证据', (raw) => {
    const fixture = seedFranchise();
    run('UPDATE franchise_entities SET title_candidates=:raw WHERE key=:key', { raw, key: fixture.key });
    const tables = ['franchise_entities', 'franchise_series', 'entity_events', 'meta'];
    const before = tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    expect(getFranchiseDetail(fixture.key)!.titleCandidates).toEqual([]);
    expect(buildFranchiseGovernancePreview({ kind: 'adopt-franchise-title', franchiseKey: fixture.key, title: '新的人工家族名称' }).allowed).toBe(false);
    expect(adoptFranchiseTitle(fixture.key, '新的人工家族名称').ok).toBe(false);
    expect(tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(before);
  });

  it('名称 Preview 与 Execute 均拒绝控制字符，不得把非法名称预览成可执行', () => {
    const fixture = seedFranchise();
    const input = { kind: 'adopt-franchise-title' as const, franchiseKey: fixture.key, title: '名称\u0001' };
    const version = dataVersion();
    expect(adoptFranchiseTitle(fixture.key, input.title).ok).toBe(false);
    expect(buildFranchiseGovernancePreview(input).allowed).toBe(false);
    expect(dataVersion()).toBe(version);
  });

  it('移出成员：写入真实治理状态 + 证据快照，重建不会静默加回，也不会自动确认', () => {
    const fixture = seedFranchise();
    confirmFranchise(fixture.key);
    expect(getFranchiseDetail(fixture.key)!.state).toBe('confirmed');
    const versionBefore = dataVersion();
    const subjectsBefore = one<{ n: number }>('SELECT COUNT(*) AS n FROM subjects')!.n;
    const seriesMemberCountBefore = getSeriesDetail(fixture.polluter)!.memberCount;
    invalidateDiagnosticsReport();

    const result = runFranchiseGovernance({
      kind: 'exclude-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: fixture.polluter,
      reason: '归组错误：与家族其他作品无关',
    });

    // 逐层验证：source / governance / projection / search / api / cache / detector
    const layers = [...new Set(result.verification.checks.map((entry) => entry.layer))];
    for (const layer of ['source', 'governance', 'projection', 'search', 'api', 'cache', 'detector']) {
      expect(layers).toContain(layer);
    }
    expect(result.verification.verified).toBe(true);
    expect(result.verification.checks.every((entry) => entry.ok)).toBe(true);

    // source-of-truth：排除记录 + 证据快照 + 治理历史
    const exclusion = one<{
      id: number;
      state: string;
      reason: string;
      evidence: string;
      created_at: string;
    }>(
      `SELECT x.id, x.state, x.reason, x.evidence, x.created_at
         FROM franchise_member_exclusions x
         JOIN franchise_entities f ON f.id = x.franchise_id
        WHERE f.key = :key AND x.state = 'active'`,
      { key: fixture.key },
    );
    expect(exclusion).toBeTruthy();
    expect(exclusion!.reason).toBe('归组错误：与家族其他作品无关');
    expect(exclusion!.evidence).toContain(fixture.polluter);
    expect(exclusion!.evidence).toContain('members');
    expect(exclusion!.created_at).toBeTruthy();
    expect(
      all<{ kind: string }>(
        `SELECT kind FROM entity_events WHERE entity_kind = 'franchise' AND kind = 'member_excluded'`,
      ).length,
    ).toBeGreaterThan(0);

    // projection：成员链接与计数
    expect(memberKeys(fixture.key)).toEqual([fixture.keepA, fixture.keepB].sort());
    const detail = getFranchiseDetail(fixture.key)!;
    expect(detail.seriesCount).toBe(2);
    expect(detail.exclusions.some((entry) => entry.seriesKey === fixture.polluter && entry.state === 'active')).toBe(true);

    // 修正成员构成 ≠ 自动确认
    expect(detail.state).not.toBe('confirmed');

    // 原始事实不变：Series identity / 成员 / Subject 数量
    expect(getSeriesDetail(fixture.polluter)!.memberCount).toBe(seriesMemberCountBefore);
    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM subjects')!.n).toBe(subjectsBefore);

    // recompute 不反弹
    recomputeSeries();
    recomputeSeries();
    expect(memberKeys(fixture.key)).toEqual([fixture.keepA, fixture.keepB].sort());
    expect(getFranchiseDetail(fixture.key)!.state).not.toBe('confirmed');

    // search：被移出的成员不再作为家族的命中来源
    expect(
      searchFranchiseEntities(fixture.polluterTitle, { limit: 100 }).items.some(
        (item) => item.key === fixture.key,
      ),
    ).toBe(false);
    expect(
      searchFranchiseEntities(getFranchiseDetail(fixture.key)!.title, { limit: 100 }).items.some(
        (item) => item.key === fixture.key,
      ),
    ).toBe(true);

    // cache / mutation contract
    expect(dataVersion()).toBeGreaterThan(versionBefore);
    expect(lastMutation().scope).toBe('governance');

    // 治理历史：用户决定 + 原因 + 证据快照
    const history = listGovernanceHistory({ entityKind: 'franchise', actor: 'user' });
    const entry = history.entries.find((row) => row.kind === 'member_excluded');
    expect(entry).toBeTruthy();
    expect(entry!.reason).toContain('归组错误');
    expect(entry!.candidate?.title).toBe(fixture.polluterTitle);
    expect(entry!.entityKey).toBe(fixture.key);
  });

  it('成员治理的派生重建失败时，排除、确认状态、历史和版本全部回滚', () => {
    const fixture = seedFranchise();
    confirmFranchise(fixture.key);
    const version = dataVersion();
    const events = one<{ n: number }>('SELECT COUNT(*) AS n FROM entity_events')!.n;
    run(`CREATE TRIGGER audit_governance_failure BEFORE UPDATE ON series_entities
         BEGIN SELECT RAISE(ABORT, 'injected governance rebuild failure'); END`);
    try {
      expect(() => runFranchiseGovernance({ kind: 'exclude-franchise-member',
        franchiseKey: fixture.key, seriesKey: fixture.polluter, reason: 'fixture exclusion',
      })).toThrow('injected governance rebuild failure');
      expect(one('SELECT id FROM franchise_member_exclusions')).toBeUndefined();
      expect(getFranchiseDetail(fixture.key)?.state).toBe('confirmed');
      expect(memberKeys(fixture.key)).toHaveLength(3);
      expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM entity_events')!.n).toBe(events);
      expect(dataVersion()).toBe(version);
    } finally { run('DROP TRIGGER audit_governance_failure'); }
  });

  it.each(['reopen', 'adopt', 'reset'] as const)('%s 重建失败时完整保留成员、名称、裁决与事件', (action) => {
    const fixture = seedFranchise();
    confirmFranchise(fixture.key);
    if (action === 'reopen') runFranchiseGovernance({ kind: 'exclude-franchise-member', franchiseKey: fixture.key, seriesKey: fixture.polluter });
    if (action === 'reset') runFranchiseGovernance({ kind: 'adopt-franchise-title', franchiseKey: fixture.key, title: 'manual fixture' });
    const tables = ['franchise_entities', 'franchise_series', 'franchise_member_exclusions', 'series_entities', 'series_entity_members', 'candidate_decisions', 'entity_events', 'meta'];
    const before = Object.fromEntries(tables.map((table) => [table, all(`SELECT * FROM ${table} ORDER BY rowid`)]));
    run(`CREATE TRIGGER audit_governance_failure BEFORE UPDATE ON series_entities BEGIN SELECT RAISE(ABORT, 'injected governance rebuild failure'); END`);
    try {
      expect(() => action === 'reopen'
        ? runFranchiseGovernance({ kind: 'reopen-franchise-member', franchiseKey: fixture.key, seriesKey: fixture.polluter })
        : action === 'adopt'
          ? runFranchiseGovernance({ kind: 'adopt-franchise-title', franchiseKey: fixture.key, title: 'new fixture title' })
          : runFranchiseGovernance({ kind: 'reset-franchise-title', franchiseKey: fixture.key })).toThrow('injected governance rebuild failure');
      for (const table of tables) expect(all(`SELECT * FROM ${table} ORDER BY rowid`)).toEqual(before[table]);
    } finally { run('DROP TRIGGER audit_governance_failure'); }
  });

  it.each(['reopen', 'adopt', 'reset'] as const)('%s 执行后验证重建失败时，已写入治理与版本仍须回滚', (action) => {
    const fixture = seedFranchise();
    confirmFranchise(fixture.key);
    if (action === 'reopen') runFranchiseGovernance({ kind: 'exclude-franchise-member', franchiseKey: fixture.key, seriesKey: fixture.polluter });
    if (action === 'reset') runFranchiseGovernance({ kind: 'adopt-franchise-title', franchiseKey: fixture.key, title: 'manual fixture' });
    const input = action === 'reopen'
      ? { kind: 'reopen-franchise-member' as const, franchiseKey: fixture.key, seriesKey: fixture.polluter }
      : action === 'adopt'
        ? { kind: 'adopt-franchise-title' as const, franchiseKey: fixture.key, title: 'new fixture title' }
        : { kind: 'reset-franchise-title' as const, franchiseKey: fixture.key };
    expect(buildFranchiseGovernancePreview(input).allowed).toBe(true);
    const tables = ['subjects', 'collections', 'subject_relations', 'franchise_entities', 'franchise_series', 'franchise_member_exclusions', 'series_entities', 'series_entity_members', 'candidate_decisions', 'entity_events', 'meta'];
    const before = tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    const version = dataVersion();
    // 第一轮重建可完成；仅在 mutation 已推进版本后的验证重建注入失败。
    run(`CREATE TRIGGER audit_verify_failure BEFORE UPDATE ON series_entities
         WHEN CAST((SELECT value FROM meta WHERE key='data_version') AS INTEGER) > ${version}
         BEGIN SELECT RAISE(ABORT, 'injected verification rebuild failure'); END`);
    try {
      expect(() => runFranchiseGovernance(input)).toThrow('injected verification rebuild failure');
      expect(tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(before);
    } finally { run('DROP TRIGGER audit_verify_failure'); }
    const retried = runFranchiseGovernance(input);
    expect(retried.verification.verified).toBe(true);
    expect(dataVersion()).toBe(version + 1);
    const stable = getFranchiseDetail(fixture.key)!;
    recomputeSeries();
    expect(getFranchiseDetail(fixture.key)!.series.map((entry) => entry.key)).toEqual(stable.series.map((entry) => entry.key));
    expect(getFranchiseDetail(fixture.key)!.title).toBe(stable.title);
    expect(dataVersion()).toBe(version + 1);
  });

  it('撤销排除：按当前证据重新纳入（不强制、不自动确认），原 provenance 保留', () => {
    const fixture = seedFranchise();
    const excluded = runFranchiseGovernance({
      kind: 'exclude-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: fixture.polluter,
      reason: '先移出',
    });
    expect(excluded.verification.verified).toBe(true);

    const reopened = runFranchiseGovernance({
      kind: 'reopen-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: fixture.polluter,
      reason: '再看一次证据',
    });
    expect(reopened.verification.verified).toBe(true);
    const layers = [...new Set(reopened.verification.checks.map((entry) => entry.layer))];
    expect(layers).toContain('governance');
    expect(layers).toContain('projection');
    expect(layers).toContain('search');
    expect(layers).toContain('api');
    expect(layers).toContain('cache');
    expect(layers).toContain('detector');

    // provenance：行仍在，reason / 时间保留，状态为 revoked
    const row = one<{ state: string; reason: string; revoked_at: string | null }>(
      `SELECT x.state, x.reason, x.revoked_at FROM franchise_member_exclusions x
         JOIN franchise_entities f ON f.id = x.franchise_id
        WHERE f.key = :key`,
      { key: fixture.key },
    )!;
    expect(row.state).toBe('revoked');
    expect(row.reason).toBe('先移出');
    expect(row.revoked_at).toBeTruthy();

    // 当前证据仍然支持 → resolver 重新纳入；但不会自动确认
    expect(memberKeys(fixture.key)).toContain(fixture.polluter);
    expect(getFranchiseDetail(fixture.key)!.state).not.toBe('confirmed');
    expect(
      searchFranchiseEntities(fixture.polluterTitle, { limit: 100 }).items.some(
        (item) => item.key === fixture.key,
      ),
    ).toBe(true);

    const history = listGovernanceHistory({ entityKind: 'franchise', actor: 'user' });
    const entry = history.entries.find((row) => row.kind === 'member_reopened');
    expect(entry).toBeTruthy();
    expect(entry!.summary).toContain('人工');
  });

  it('撤销排除但当前证据不再支持：不得强制加回', () => {
    const fixture = seedFranchise();
    runFranchiseGovernance({
      kind: 'exclude-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: fixture.polluter,
    });
    // 证据消失：删掉把该 Series 与家族连起来的「不同演绎」关系
    run(`DELETE FROM subject_relations WHERE relation = '不同演绎' AND (subject_id = 4 OR related_id = 4)`);
    recomputeSeries();

    const reopened = runFranchiseGovernance({
      kind: 'reopen-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: fixture.polluter,
    });
    expect(reopened.verification.verified).toBe(true);
    expect(memberKeys(fixture.key)).not.toContain(fixture.polluter);
    expect(
      searchFranchiseEntities(fixture.polluterTitle, { limit: 100 }).items.some(
        (item) => item.key === fixture.key,
      ),
    ).toBe(false);
  });

  it('拒绝移出最后一个成员（家族不允许变成空实体）', () => {
    const fixture = seedFranchise();
    for (const seriesKey of [fixture.polluter, fixture.keepB]) {
      const excluded = runFranchiseGovernance({
        kind: 'exclude-franchise-member',
        franchiseKey: fixture.key,
        seriesKey,
      });
      expect(excluded.verification.verified).toBe(true);
    }
    expect(memberKeys(fixture.key)).toEqual([fixture.keepA]);
    const preview = buildFranchiseGovernancePreview({
      kind: 'exclude-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: fixture.keepA,
    });
    expect(preview.allowed).toBe(false);
    expect(preview.message).toContain('最后一个成员');
    expect(() =>
      runFranchiseGovernance({
        kind: 'exclude-franchise-member',
        franchiseKey: fixture.key,
        seriesKey: fixture.keepA,
      }),
    ).toThrowError();
  });

  it('非成员 / 重复移出会被拒绝，并且不写治理记录', () => {
    const fixture = seedFranchise();
    const outsider = 'sr_missing';
    const notMember = buildFranchiseGovernancePreview({
      kind: 'exclude-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: outsider,
    });
    expect(notMember.allowed).toBe(false);
    runFranchiseGovernance({
      kind: 'exclude-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: fixture.polluter,
    });
    const again = buildFranchiseGovernancePreview({
      kind: 'exclude-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: fixture.polluter,
    });
    expect(again.allowed).toBe(false);
    expect(again.message).toContain('已经被移出');
    expect(
      Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM franchise_member_exclusions')!.n),
    ).toBe(1);
  });
});

describe('Franchise 名称治理：人工命名 / 恢复自动解析', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });

  it.each(['unconfirmed', 'confirmed', 'rejected'] as const)(
    '%s 家族的合法人工命名保留实际manual候选，重复重算不改变来源、成员、历史或版本',
    (membershipState) => {
      const fixture = seedFranchise();
      if (membershipState === 'confirmed') confirmFranchise(fixture.key);
      if (membershipState === 'rejected') rejectFranchiseCandidate(fixture.key, '隔离反例');
      const membersBefore = memberKeys(fixture.key);
      const rawBefore = [all('SELECT * FROM subjects'), all('SELECT * FROM collections'), all('SELECT * FROM subject_relations')];
      const stateBefore = getFranchiseDetail(fixture.key)!.state;
      const versionBefore = dataVersion();
      const input = { kind: 'adopt-franchise-title' as const, franchiseKey: fixture.key, title: '隔离人工家族名', reason: '来源保留回归' };
      const preview = buildFranchiseGovernancePreview(input);
      expect(preview.allowed).toBe(true);
      expect(dataVersion()).toBe(versionBefore);
      const result = runFranchiseGovernance(input);
      expect(result.verification.checks.filter((check) => !check.ok)).toEqual([]);
      expect(result.verification.verified).toBe(true);
      const stored = one<{ title_candidates: string }>('SELECT title_candidates FROM franchise_entities WHERE key=:key', { key: fixture.key })!;
      const manual = JSON.parse(stored.title_candidates).filter((candidate: { source: string }) => candidate.source === 'manual');
      expect(manual).toEqual([{ title: input.title, source: 'manual', state: 'manual', evidence: '人工确认', valid: true, support: 1, coverage: 0 }]);
      const events = all('SELECT * FROM entity_events');
      const versionAfter = dataVersion();
      expect(versionAfter).toBeGreaterThan(versionBefore);
      recomputeSeries();recomputeSeries();
      expect(getFranchiseDetail(fixture.key)!.title).toBe(input.title);
      expect(getFranchiseDetail(fixture.key)!.state).toBe(stateBefore);
      expect(memberKeys(fixture.key)).toEqual(membersBefore);
      expect([all('SELECT * FROM subjects'), all('SELECT * FROM collections'), all('SELECT * FROM subject_relations')]).toEqual(rawBefore);
      expect(dataVersion()).toBe(versionAfter);
      expect(all('SELECT * FROM entity_events')).toEqual(events);
      expect(JSON.parse(one<{ title_candidates: string }>('SELECT title_candidates FROM franchise_entities WHERE key=:key', { key: fixture.key })!.title_candidates).filter((candidate: { source: string }) => candidate.source === 'manual')).toEqual(manual);
    },
  );

  it('已确认但没有可靠名称的家族可以设置人工名称，重建不覆盖，且不改变成员治理状态', () => {
    const fixture = seedFranchise();
    confirmFranchise(fixture.key);
    const before = getFranchiseDetail(fixture.key)!;
    expect(before.titleState).toBe('unresolved');
    const membersBefore = memberKeys(fixture.key);
    invalidateDiagnosticsReport();

    const result = runFranchiseGovernance({
      kind: 'adopt-franchise-title',
      franchiseKey: fixture.key,
      title: '孤岛系列',
      reason: '确认成立但没有可靠标题',
    });
    expect(result.verification.verified).toBe(true);
    const layers = [...new Set(result.verification.checks.map((entry) => entry.layer))];
    expect(layers).toContain('source');
    expect(layers).toContain('governance');
    expect(layers).toContain('projection');
    expect(layers).toContain('search');
    expect(layers).toContain('api');
    expect(layers).toContain('cache');
    expect(layers).toContain('detector');

    const detail = getFranchiseDetail(fixture.key)!;
    expect(detail.title).toBe('孤岛系列');
    expect(detail.titleState).toBe('manual');
    expect(detail.titleSource).toBe('manual');
    expect(detail.state).toBe('confirmed');
    expect(detail.titleCandidates.some((candidate) => candidate.source === 'manual')).toBe(true);
    expect(memberKeys(fixture.key)).toEqual(membersBefore);
    expect(
      searchFranchiseEntities('孤岛系列', { limit: 100 }).items.some((item) => item.key === fixture.key),
    ).toBe(true);

    // recompute 不反弹
    recomputeSeries();
    expect(getFranchiseDetail(fixture.key)!.title).toBe('孤岛系列');
    expect(getFranchiseDetail(fixture.key)!.titleState).toBe('manual');

    const history = listGovernanceHistory({ entityKind: 'franchise', actor: 'user' });
    const entry = history.entries.find((row) => row.kind === 'title_manual');
    expect(entry).toBeTruthy();
    expect(entry!.summary).toContain('孤岛系列');
    expect(entry!.reason).toContain('可靠标题');
  });

  it('旧manual候选不能替代本次名称来源；验证失败如实partial，解除故障后显式重试恢复', () => {
    const fixture = seedFranchise();confirmFranchise(fixture.key);
    expect(runFranchiseGovernance({ kind: 'adopt-franchise-title', franchiseKey: fixture.key, title: '旧人工名' }).verification.verified).toBe(true);
    const members = memberKeys(fixture.key), version = dataVersion();
    const historyBefore = all('SELECT * FROM entity_events');
    run(`CREATE TRIGGER audit_drop_current_manual AFTER UPDATE ON franchise_entities
         WHEN NEW.title_state='manual' AND NEW.title='新人工名'
         BEGIN UPDATE franchise_entities SET title_candidates=(
           SELECT json_group_array(json(value)) FROM json_each(NEW.title_candidates)
           WHERE json_extract(value,'$.title')!='新人工名'
         ) WHERE id=NEW.id; END`);
    const input = { kind: 'adopt-franchise-title' as const, franchiseKey: fixture.key, title: '新人工名', reason: '明确重试' };
    try {
      const partial = runFranchiseGovernance(input);
      expect(partial.verification.verified).toBe(false);
      expect(partial.verification.partial).toBe(true);
      expect(partial.verification.checks.filter((check) => !check.ok).map((check) => check.label)).toEqual(['人工名称 provenance']);
      expect(getFranchiseDetail(fixture.key)!.title).toBe(input.title);
      expect(memberKeys(fixture.key)).toEqual(members);
      expect(dataVersion()).toBeGreaterThan(version);
      expect(all('SELECT * FROM entity_events').slice(0, historyBefore.length)).toEqual(historyBefore);
    } finally { run('DROP TRIGGER audit_drop_current_manual'); }
    const partialVersion = dataVersion(), partialHistory = all('SELECT * FROM entity_events');
    const retried = runFranchiseGovernance(input);
    expect(retried.verification.verified).toBe(true);
    expect(dataVersion()).toBeGreaterThan(partialVersion);
    expect(all('SELECT * FROM entity_events').slice(0, partialHistory.length)).toEqual(partialHistory);
    expect(getFranchiseDetail(fixture.key)!.titleCandidates.some((candidate) => candidate.source === 'manual' && candidate.title === input.title)).toBe(true);
  });

  it.each(['unconfirmed', 'confirmed', 'rejected'] as const)('%s 家族的缺失或异常旧manual来源不会由纯重算补造或清洗', (membershipState) => {
    const fixture = seedFranchise();
    if (membershipState === 'confirmed') confirmFranchise(fixture.key);
    if (membershipState === 'rejected') rejectFranchiseCandidate(fixture.key, '隔离反例');
    expect(adoptFranchiseTitle(fixture.key, '隔离人工名').ok).toBe(true);
    const version = dataVersion(), events = all('SELECT * FROM entity_events');
    for (const raw of ['[]', '[null,{"title":"历史来源","source":"manual"}]']) {
      run('UPDATE franchise_entities SET title_candidates=:raw WHERE key=:key', { raw, key: fixture.key });
      recomputeSeries();
      expect(one<{ title_candidates: string }>('SELECT title_candidates FROM franchise_entities WHERE key=:key', { key: fixture.key })!.title_candidates).toBe(raw);
      expect(dataVersion()).toBe(version);
      expect(all('SELECT * FROM entity_events')).toEqual(events);
      expect(getFranchiseDetail(fixture.key)!.title).toBe('隔离人工名');
    }
  });

  it('恢复自动解析：清除人工名称与 manual 候选，回到当前证据的结果，成员构成不变', () => {
    const fixture = seedFranchise();
    confirmFranchise(fixture.key);
    const fallbackTitle = getFranchiseDetail(fixture.key)!.title;
    runFranchiseGovernance({
      kind: 'adopt-franchise-title',
      franchiseKey: fixture.key,
      title: '孤岛系列',
    });
    const membersBefore = memberKeys(fixture.key);
    invalidateDiagnosticsReport();

    const result = runFranchiseGovernance({
      kind: 'reset-franchise-title',
      franchiseKey: fixture.key,
      reason: '不再需要人工固定',
    });
    expect(result.verification.verified).toBe(true);

    const detail = getFranchiseDetail(fixture.key)!;
    expect(detail.titleState).not.toBe('manual');
    expect(detail.title).toBe(fallbackTitle);
    expect(detail.titleCandidates.some((candidate) => candidate.source === 'manual')).toBe(false);
    expect(detail.state).toBe('confirmed');
    expect(memberKeys(fixture.key)).toEqual(membersBefore);

    // 重建幂等：名称完全由当前 resolver 决定
    recomputeSeries();
    expect(getFranchiseDetail(fixture.key)!.title).toBe(fallbackTitle);

    const history = listGovernanceHistory({ entityKind: 'franchise', actor: 'user' });
    expect(history.entries.some((row) => row.kind === 'title_reset')).toBe(true);
  });

  it('名称治理的 Preview 说明影响范围；非 manual 状态不能执行恢复自动解析', () => {
    const fixture = seedFranchise();
    const preview = buildFranchiseGovernancePreview({
      kind: 'adopt-franchise-title',
      franchiseKey: fixture.key,
      title: '新名称',
    });
    expect(preview.allowed).toBe(true);
    expect(preview.preview?.directlyChanges.length).toBeGreaterThan(0);
    expect(preview.preview?.derivedChanges.length).toBeGreaterThan(0);
    expect(preview.preview?.untouched.length).toBeGreaterThan(0);
    expect(preview.preview?.chain.some((step) => step.layer === 'search')).toBe(true);
    expect(preview.preview?.untouched.join(' ')).toContain('成员');

    const resetPreview = buildFranchiseGovernancePreview({
      kind: 'reset-franchise-title',
      franchiseKey: fixture.key,
    });
    expect(resetPreview.allowed).toBe(false);
    expect(() =>
      runFranchiseGovernance({ kind: 'reset-franchise-title', franchiseKey: fixture.key }),
    ).toThrowError();
  });
});

describe('候选决定 provenance（v1.7.0 Freeze Check）', () => {
  beforeEach(() => {
    resetDatabase();
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });

  it('恢复基线流程再次否决时不覆盖既有 decision provenance', () => {
    const fixture = seedFranchise();
    expect(rejectFranchiseCandidate(fixture.key, '第一次真实否决理由').ok).toBe(true);
    const before = one<{
      decision: string;
      reason: string;
      evidence: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT d.decision, d.reason, d.evidence, d.created_at, d.updated_at
         FROM candidate_decisions d
         JOIN franchise_entities f ON f.id = d.entity_id
        WHERE d.entity_kind = 'franchise' AND d.candidate_kind = 'franchise' AND f.key = :key`,
      { key: fixture.key },
    )!;
    expect(before.decision).toBe('rejected');
    expect(before.reason).toBe('第一次真实否决理由');

    // 模拟 E2E 基线恢复：成员移出把治理状态降级后，再用 /reject 恢复 rejected
    const excluded = runFranchiseGovernance({
      kind: 'exclude-franchise-member',
      franchiseKey: fixture.key,
      seriesKey: fixture.polluter,
      reason: 'E2E 恢复基线：撤销测试创建的成员排除',
    });
    expect(excluded.verification.verified).toBe(true);
    expect(getFranchiseDetail(fixture.key)!.state).not.toBe('rejected');
    expect(rejectFranchiseCandidate(fixture.key, 'E2E 恢复基线：恢复原有否决状态').ok).toBe(true);

    const after = one<{
      decision: string;
      reason: string;
      evidence: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT d.decision, d.reason, d.evidence, d.created_at, d.updated_at
         FROM candidate_decisions d
         JOIN franchise_entities f ON f.id = d.entity_id
        WHERE d.entity_kind = 'franchise' AND d.candidate_kind = 'franchise' AND f.key = :key`,
      { key: fixture.key },
    )!;

    // 治理状态正确恢复，但 provenance 保持第一次的真实决定
    expect(getFranchiseDetail(fixture.key)!.state).toBe('rejected');
    expect(after.decision).toBe('rejected');
    expect(after.reason).toBe('第一次真实否决理由');
    expect(after.evidence).toBe(before.evidence);
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toBe(before.updated_at);
    // 恢复流程本身仍然写入不可变事件历史
    const events = all<{ payload: string }>(
      `SELECT payload FROM entity_events
        WHERE entity_kind = 'franchise' AND kind = 'rejected' ORDER BY id`,
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[events.length - 1]!.payload).toContain('E2E 恢复基线');
  });
});
