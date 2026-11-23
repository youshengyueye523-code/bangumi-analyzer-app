import { afterEach, beforeEach, expect, it } from 'vitest';
import { all, dataVersion, exec, one, run, transaction } from '../src/db/index.js';
import { saveConfig } from '../src/config.js';
import { getSeriesDetail, listSeries } from '../src/db/query.js';
import { inspectSeriesCollectionStatus, seriesCollectionStatusIssues, STATUS_DRIFT, STATUS_UNASSESSABLE } from '../src/db/seriesCollectionStatus.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { runDiagnosticsRepair } from '../src/diagnostics/repair.js';
import { captureProtectedSources } from '../src/diagnostics/sourceProtection.js';
import { resetDatabase } from './helpers.js';

const T = '2026-11-08T00:00:00Z';
function entity(id = 1, counts = '{}') {
  run(`INSERT INTO series_entities(id,key,title,title_state,title_source,state,status_counts,created_at,updated_at)
    VALUES(:id,:key,'Human title','manual','manual','confirmed',:counts,:t,:t)`, { id, key: `sr_fix_${id}`, counts, t: T });
}
function member(id: number, type = 2, series = 1, role = 'primary') {
  run(`INSERT INTO subjects(id,type,name,nsfw,raw,detail_state,relations_state,series_key,created_at,updated_at)
    VALUES(:id,2,:name,0,'{"older":"preserved"}','ok','ok',:key,:t,:t)`, { id, name: `SYNTHETIC_FIX_${id}`, key: `sr_fix_${series}`, t: T });
  run(`INSERT INTO collections(subject_id,type,raw,first_seen_at,synced_at) VALUES(:id,:type,'{"older":true}',:t,:t)`, { id, type, t: T });
  run(`INSERT INTO series_entity_members(series_id,subject_id,role,state,reason_code) VALUES(:series,:id,:role,:state,'anchor')`, { series, id, role, state: role === 'primary' ? 'confirmed' : 'candidate' });
}
function counters() {
  exec(`UPDATE series_entities SET member_count=(SELECT COUNT(*) FROM series_entity_members m WHERE m.series_id=series_entities.id AND role='primary'),
    collected_count=(SELECT COUNT(*) FROM series_entity_members m JOIN collections c ON c.subject_id=m.subject_id WHERE m.series_id=series_entities.id AND role='primary'),
    confirmed_count=(SELECT COUNT(*) FROM series_entity_members m WHERE m.series_id=series_entities.id AND role='primary' AND m.state='confirmed'),
    candidate_count=(SELECT COUNT(*) FROM series_entity_members m WHERE m.series_id=series_entities.id AND role='candidate')`);
}
function plan() {
  const action = getDiagnosticsReport({ refresh: true }).issues.find(i => i.id === STATUS_DRIFT)!.actions.find(a => a.kind === 'repair' && a.target === 'sr_fix_1')!;
  if (action.kind !== 'repair') throw Error('Missing production repair plan');
  return { issueId: STATUS_DRIFT, kind: action.repairKind, target: action.target!, value: action.value! };
}
beforeEach(() => { resetDatabase(); saveConfig({ hideNsfw: false }); invalidateDiagnosticsReport(); });
afterEach(() => { invalidateDiagnosticsReport(); });

it.each([1, 2, 3, 4, 5])('F01 candidate status %i remains evidence, never primary watch input', candidateType => {
  entity(1, '{"2":2}'); entity(2, JSON.stringify({ [candidateType]: 1 }));
  member(1, 1); member(2, 2); member(3, candidateType, 2);
  run(`INSERT INTO series_entity_members(series_id,subject_id,role,state,reason_code) VALUES(1,3,'candidate','candidate','derivative:番外篇')`);
  counters();
  run(`INSERT INTO candidate_decisions(entity_kind,entity_id,candidate_kind,candidate_key,candidate_title,decision,reason,evidence,created_at,updated_at)
    VALUES('series',1,'title','rejected','Rejected title','rejected','Human reason','Original evidence',:t,:t)`, { t: T });
  const sources = captureProtectedSources(), members = all('SELECT * FROM series_entity_members'), decisions = all('SELECT * FROM candidate_decisions');
  const version = dataVersion(), result = runDiagnosticsRepair(plan());
  expect(result.ok).toBe(true); expect(result.verification.partial).toBe(false); expect(dataVersion()).toBe(version + 1);
  const detail = getSeriesDetail('sr_fix_1')!;
  expect(detail.statusCounts).toEqual({ '1': 1, '2': 1 });
  expect(detail.watch).toMatchObject({ wish: 1, watched: 1, watching: 0, onHold: 0, dropped: 0, collectedCount: 2, candidateCount: 1, knownMembers: 2 });
  expect(detail.members.find(m => m.subjectId === 3)).toMatchObject({ role: 'candidate', state: 'candidate', collected: true });
  expect(listSeries({ includeSingletons: true }).find(s => s.key === 'sr_fix_1')!.statusCounts).toEqual(detail.statusCounts);
  expect(all('SELECT * FROM series_entity_members')).toEqual(members); expect(all('SELECT * FROM candidate_decisions')).toEqual(decisions);
  expect(captureProtectedSources()).toEqual(sources); expect(one<{ title: string }>('SELECT title FROM series_entities WHERE id=1')!.title).toBe('Human title');
  expect(inspectSeriesCollectionStatus().driftCount).toBe(0);
});

it('F01 candidate NSFW does not hide primary series or enter watch; hidden primary still hides whole series', () => {
  entity(1, '{"2":2}'); entity(2, '{"3":1}'); member(1, 1); member(2, 2); member(3, 3, 2);
  run(`INSERT INTO series_entity_members(series_id,subject_id,role,state) VALUES(1,3,'candidate','candidate')`); counters();
  run('UPDATE subjects SET nsfw=1 WHERE id=3'); saveConfig({ hideNsfw: true });
  expect(runDiagnosticsRepair(plan()).ok).toBe(true); expect(getSeriesDetail('sr_fix_1')!.watch.watching).toBe(0);
  expect(getSeriesDetail('sr_fix_2')).toBeNull();
  run('UPDATE subjects SET nsfw=1 WHERE id=1'); expect(getSeriesDetail('sr_fix_1')).toBeNull();
  saveConfig({ hideNsfw: false }); expect(getSeriesDetail('sr_fix_1')!.watch.collectedCount).toBe(2);
});

it.each([1, 6, 11, 37])('F02 blocking member at sorted position %i is traceable beyond normal context', bad => {
  entity(); transaction(() => { for (let id = 37; id >= 1; id--) member(id, id === bad ? 99 : 2); });
  const scan = inspectSeriesCollectionStatus(), p = scan.blockedSamples[0]!;
  expect(scan).toMatchObject({ membersScanned: 37, blockedCount: 1, driftCount: 0 });
  expect(p.blockingMemberCount).toBe(1); expect(p.blockingEvidence).toHaveLength(1);
  expect(JSON.parse(p.blockingEvidence[0]!)).toMatchObject({ subjectId: String(bad), collectionType: '99', storage: 'integer', reasons: ['非法收藏状态'] });
  const issue = seriesCollectionStatusIssues(scan).find(i => i.id === STATUS_UNASSESSABLE)!;
  expect(issue.actions).toEqual([]); expect(issue.evidence[1]!.value).toContain('阻断成员证据完整：展示 1/1，未展示 0');
  expect(issue.evidence[1]!.value).toContain(`"subjectId":"${bad}"`); expect(issue.waitingFor).toBeTruthy();
});

it('F02 multiple causes on one member are named; invalid members, not cause strings, form the denominator', () => {
  entity(); entity(2); member(1, 99);
  exec('PRAGMA foreign_keys=OFF'); run('DELETE FROM subjects WHERE id=1'); exec('PRAGMA foreign_keys=ON');
  run(`INSERT INTO series_entity_members(series_id,subject_id,role,state) VALUES(2,1,'primary','confirmed')`);
  const p = inspectSeriesCollectionStatus('sr_fix_1').blockedSamples[0]!;
  expect(p.blockingMemberCount).toBe(1);
  expect(JSON.parse(p.blockingEvidence[0]!).reasons).toEqual(['缺失本地Subject', '非法收藏状态', '重复live primary归属']);
  expect(JSON.parse(p.blockingEvidence[0]!)).toMatchObject({ localSubjectId: null, collectionSubjectId: '1', duplicatePrimarySubjectId: '1' });
});

it('F02 multiple blockers exceed the bounded sample with exact omitted counts', () => {
  entity(); for (let id = 1; id <= 40; id++) member(id, id % 2 === 0 && id <= 24 ? 99 : 2);
  const scan = inspectSeriesCollectionStatus(), p = scan.blockedSamples[0]!;
  expect(p.blockingMemberCount).toBe(12); expect(p.blockingEvidence).toHaveLength(10);
  expect(p.blockingEvidence.map(e => JSON.parse(e).subjectId)).toEqual(Array.from({ length: 10 }, (_, i) => String((i + 1) * 2)));
  const issue = seriesCollectionStatusIssues(scan)[0]!;
  expect(issue.evidence[1]!.value).toContain('阻断成员证据已截断：展示 10/12，未展示 2'); expect(issue.actions).toEqual([]);
});

it.each([false, true])('F02 6000 members: bounded output and full verdict, blockers=%s', blocked => {
  entity(1, blocked ? '{}' : '{"2":6000}');
  transaction(() => { for (let id = 1; id <= 6000; id++) member(id, blocked && id > 5988 ? 99 : 2); });
  const scan = inspectSeriesCollectionStatus(), issues = seriesCollectionStatusIssues(scan);
  expect(scan.membersScanned).toBe(6000); expect(scan.blockedCount).toBe(blocked ? 1 : 0); expect(scan.driftCount).toBe(0);
  if (blocked) {
    const p = scan.blockedSamples[0]!; expect(p.memberCount).toBe(6000); expect(p.blockingMemberCount).toBe(12);
    expect(p.evidence).toHaveLength(10); expect(p.blockingEvidence).toHaveLength(10);
    expect(JSON.parse(p.blockingEvidence[0]!).subjectId).toBe('5989'); expect(JSON.stringify(issues).length).toBeLessThan(10_000);
    expect(issues[0]!.evidence[1]!.value).toContain('未展示 2');
  } else expect(issues).toEqual([]);
});

it('F02 bounded Series samples disclose aggregate truncation; no fake repair', () => {
  transaction(() => { for (let id = 1; id <= 25; id++) { entity(id); member(id, 99, id); } });
  const scan = inspectSeriesCollectionStatus(), issue = seriesCollectionStatusIssues(scan)[0]!;
  expect(scan.blockedCount).toBe(25); expect(scan.blockedSamples).toHaveLength(20);
  expect(issue.evidence[0]!.value).toContain('展示 20 个，未展示 5 个'); expect(issue.actions).toEqual([]);
  const source = captureProtectedSources();
  expect(() => runDiagnosticsRepair({ issueId: STATUS_UNASSESSABLE, kind: 'recompute-derived' })).toThrow();
  expect(captureProtectedSources()).toEqual(source);
});
