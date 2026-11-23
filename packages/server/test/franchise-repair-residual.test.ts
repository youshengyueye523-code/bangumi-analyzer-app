import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig } from '../src/config.js';
import { all, one, run, openDatabase, closeDatabase, dataVersion } from '../src/db/index.js';
import { recomputeSeries, confirmFranchise, rejectFranchiseCandidate } from '../src/db/series.js';
import * as q from '../src/db/query.js';
import * as search from '../src/db/ipSearch.js';
import { runFranchiseGovernance } from '../src/diagnostics/franchiseGovernance.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import * as reports from '../src/diagnostics/report.js';

import { runDiagnosticsRepair } from './repairPreview.js';

const dir = mkdtempSync(join(tmpdir(), 'gov005-residual-cases-')),
  results: any[] = [];
const states = ['candidate', 'confirmed', 'rejected'] as const,
  TS = '2026-10-25T00:00:00Z';
let n = 0,
  current: any;
const tables = [
  'subjects',
  'collections',
  'subject_relations',
  'series_entities',
  'series_entity_members',
  'franchise_entities',
  'franchise_series',
  'entity_events',
  'candidate_decisions',
  'entity_aliases',
  'franchise_member_exclusions',
  'meta',
];
const snapshot = () => tables.map((t) => all(`SELECT * FROM ${t} ORDER BY rowid`));
const raw = () => snapshot().slice(0, 3);
function seed(state: (typeof states)[number]) {
  for (const [id, name, nsfw, collected] of [
    [410, '银杉私密根', 1, true],
    [411, '银杉侧枝', 0, false],
    [420, '明湾航路', 0, true],
    [800, '无关诱饵甲', 0, true],
    [801, '无关诱饵乙', 0, true],
    [802, '无关诱饵丙', 0, true],
  ] as const) {
    run(
      `INSERT INTO subjects(id,name,name_cn,aliases,nsfw,detail_state,year,format,tag_names,cover_url,created_at,updated_at) VALUES(?,?,?,?,?,'ok',2023,'TV','[]',?,?,?)`,
      [
        id,
        name,
        name,
        JSON.stringify([`独立别名-${id}`]),
        nsfw,
        `https://example.invalid/${id}.jpg`,
        TS,
        TS,
      ],
    );
    if (collected)
      run(
        `INSERT INTO collections(subject_id,subject_type,type,rate,first_seen_at,synced_at) VALUES(?,2,2,7,?,?)`,
        [id, TS, TS],
      );
  }
  for (const [a, b, r, name] of [
    [410, 411, '续集', '银杉侧枝'],
    [411, 410, '前传', '银杉私密根'],
    [411, 412, '续集', '隐关系银叶'],
    [420, 421, '续集', '可见关系蓝叶'],
    [410, 420, '不同演绎', '明湾航路'],
    [420, 410, '不同演绎', '银杉私密根'],
    [800, 801, '续集', '无关诱饵乙'],
    [801, 802, '续集', '无关诱饵丙'],
  ] as const)
    run(
      `INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at) VALUES(?,?,?,2,?,?,?)`,
      [a, b, r, name, name, TS],
    );
  recomputeSeries();
  const f = one<any>(`SELECT id,key FROM franchise_entities WHERE state<>'stale'`)!;
  expect(f).toBeTruthy();
  if (state === 'confirmed') confirmFranchise(f.key);
  if (state === 'rejected') rejectFranchiseCandidate(f.key, '独立合法否决');
  expect(
    runFranchiseGovernance({
      kind: 'adopt-franchise-title',
      franchiseKey: f.key,
      title: '独立核验家族',
      reason: '隔离独审',
    }).verification.verified,
  ).toBe(true);
  const sr = (id: number) =>
    one<any>(
      `SELECT e.id,e.key,e.title FROM series_entities e JOIN series_entity_members m ON m.series_id=e.id WHERE m.subject_id=? AND e.state<>'stale'`,
      [id],
    )!;
  return { ...f, hidden: sr(410), visible: sr(420), decoy: sr(800) };
}
function drift(f: any) {
  run('UPDATE franchise_entities SET collected_count=77 WHERE id=?', [f.id]);
  invalidateDiagnosticsReport();
  expect(
    getDiagnosticsReport({ refresh: true }).issues.some((i) => i.id === 'franchise.counter-drift'),
  ).toBe(true);
}
const execute = () =>
  runDiagnosticsRepair({ issueId: 'franchise.counter-drift', kind: 'recompute-derived' });
function expectSafetyRollback() {
  const before = snapshot(), version = dataVersion();
  expect(execute).toThrow(/允许写集/);
  expect(snapshot()).toEqual(before);
  expect(dataVersion()).toBe(version);
  current.rollbackVerified = true;
}
function scenario(name: string, fn: () => void) {
  it(name, () => {
    current = { name, passed: false };
    try {
      fn();
      current.passed = true;
    } catch (e: any) {
      current.error = { message: e.message, stack: e.stack };
      throw e;
    } finally {
      results.push(current);
    }
  });
}
beforeEach(() => {
  closeDatabase();
  const file = join(dir, `${++n}.db`);
  openDatabase({ file });
  saveConfig({ hideNsfw: false });
  invalidateDiagnosticsReport();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (current) {
    current.integrity = one('PRAGMA integrity_check');
    current.foreignKeys = all('PRAGMA foreign_key_check');
  }
  expect(one('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' });
  expect(all('PRAGMA foreign_key_check')).toEqual([]);
  closeDatabase();
});
afterAll(() => {
  if (process.env.AUDIT_RESULTS_FILE)
    writeFileSync(process.env.AUDIT_RESULTS_FILE, JSON.stringify({ dir, results }, null, 2));
});
for (const state of states) {
  describe(`residual ${state}`, () => {
    for (const identity of ['key', 'canonicalKey', 'both'] as const)
      scenario(`identity-${state}-${identity}`, () => {
        const f = seed(state);
        drift(f);
        run(
          `INSERT INTO franchise_entities(key,title,state,created_at,updated_at) VALUES('fr_other','独立核验家族','candidate',?,?)`,
          [TS, TS],
        );
        const actual = q.getFranchiseDetail(f.key)!;
        vi.spyOn(q, 'getFranchiseDetail').mockReturnValue({
          ...actual,
          ...(identity !== 'canonicalKey' ? { key: 'fr_other' } : {}),
          ...(identity !== 'key' ? { canonicalKey: 'fr_other' } : {}),
        });
        const result = execute();
        current.result = result;
        expect(result.verification.verified).toBe(false);
        expect(result.verification.partial).toBe(true);
        expect(result.verification.checks.find((c) => c.layer === 'api')?.ok).toBe(false);
      });
    scenario(`canonical-alias-${state}`, () => {
      const f = seed(state);
      run(
        `INSERT INTO entity_aliases(alias_key,entity_kind,entity_id,created_at) VALUES('old_fr','franchise',?,?)`,
        [f.id, TS],
      );
      const detail = q.getFranchiseDetail('old_fr')!;
      expect(detail.key).toBe(f.key);
      expect(detail.canonicalKey).toBe(f.key);
      expect(detail.aliasedFrom).toBe('old_fr');
      drift(f);
      const report = getDiagnosticsReport({ refresh: true }),
        issue = report.issues.find((i) => i.id === 'franchise.counter-drift')!;
      vi.spyOn(reports, 'getDiagnosticsReport').mockReturnValueOnce({
        ...report,
        issues: [
          {
            ...issue,
            id: 'test.alias',
            affected: [
              { kind: 'franchise', key: 'old_fr', label: 'alias', href: '/franchises/old_fr' },
            ] as any,
          },
        ],
      });
      const result = runDiagnosticsRepair({ issueId: 'test.alias', kind: 'recompute-derived' });
      current.result = result;
      expect(result.verification.verified).toBe(true);
    });
    for (const hidden of [false, true])
      scenario(`state-${state}-${hidden}`, () => {
        const f = seed(state);
        if (hidden) {
          run('UPDATE subjects SET nsfw=1 WHERE id IN (410,420)');
          saveConfig({ hideNsfw: true });
        }
        drift(f);
        run(
          `CREATE TRIGGER residual_fault AFTER UPDATE ON franchise_entities WHEN NEW.id=${f.id} BEGIN UPDATE franchise_entities SET state='${state === 'candidate' ? 'rejected' : 'candidate'}' WHERE id=NEW.id; END`,
        );
        expectSafetyRollback();
        run('DROP TRIGGER residual_fault');
      });
  });
}
for (const fault of ['delete-decision', 'reason', 'evidence', 'decision', 'old-event'] as const)
  scenario(`rejection-provenance-${fault}`, () => {
    const f = seed('rejected');
    drift(f);
    const sql =
      fault === 'delete-decision'
        ? `DELETE FROM candidate_decisions WHERE entity_kind='franchise' AND entity_id=${f.id}`
        : fault === 'old-event'
          ? `DELETE FROM entity_events WHERE entity_kind='franchise' AND entity_id=${f.id} AND kind='rejected'`
          : `UPDATE candidate_decisions SET ${fault === 'decision' ? "decision='superseded'" : fault === 'reason' ? "reason='tampered'" : "evidence='{}'"} WHERE entity_kind='franchise' AND entity_id=${f.id}`;
    run(
      `CREATE TRIGGER residual_fault AFTER UPDATE ON franchise_entities WHEN NEW.id=${f.id} BEGIN ${sql}; END`,
    );
    expectSafetyRollback();
  });
scenario('preexisting-rejected-without-decision', () => {
  const f = seed('rejected');
  run("DELETE FROM candidate_decisions WHERE entity_kind='franchise' AND entity_id=?", [f.id]);
  drift(f);
  expectSafetyRollback();
});
scenario('confirmed-link-demotion', () => {
  const f = seed('confirmed');
  drift(f);
  run(
    `CREATE TRIGGER residual_fault AFTER INSERT ON franchise_series WHEN NEW.franchise_id=${f.id} BEGIN UPDATE franchise_series SET state='candidate' WHERE franchise_id=NEW.franchise_id AND series_id=NEW.series_id; END`,
  );
  expectSafetyRollback();
});
scenario('candidate-cannot-acquire-confirmation', () => {
  const f = seed('candidate');
  drift(f);
  run(
    `CREATE TRIGGER residual_fault AFTER UPDATE ON franchise_entities WHEN NEW.id=${f.id} BEGIN UPDATE franchise_entities SET state='confirmed' WHERE id=NEW.id; END`,
  );
  expectSafetyRollback();
});
for (const fault of ['delete', 'revoke', 'evidence'] as const)
  scenario(`exclusion-${fault}`, () => {
    const f = seed('candidate');
    run(
      `INSERT INTO franchise_member_exclusions(franchise_id,series_id,state,reason,evidence,created_at) VALUES(?,?,'active','keep decision','{"source":"manual"}',?)`,
      [f.id, f.decoy.id, TS],
    );
    drift(f);
    const sql =
      fault === 'delete'
        ? `DELETE FROM franchise_member_exclusions WHERE franchise_id=${f.id}`
        : `UPDATE franchise_member_exclusions SET ${fault === 'revoke' ? "state='revoked'" : "evidence='{}'"} WHERE franchise_id=${f.id}`;
    run(
      `CREATE TRIGGER residual_fault AFTER UPDATE ON franchise_entities WHEN NEW.id=${f.id} BEGIN ${sql}; END`,
    );
    expectSafetyRollback();
  });
scenario('legal-inferred-state-evolution', () => {
  const f = seed('candidate');
  run("UPDATE franchise_entities SET state='contested' WHERE id=?", [f.id]);
  drift(f);
  const result = execute();
  current.result = result;
  expect(one<any>('SELECT state FROM franchise_entities WHERE id=?', [f.id])!.state).not.toBe(
    'contested',
  );
  expect(result.verification.verified).toBe(true);
});
scenario('legal-rejection-reopens-with-new-member-and-new-event', () => {
  const f = seed('rejected');
  for (const [a, b] of [
    [420, 800],
    [800, 420],
  ])
    run(
      `INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at) VALUES(?,?,'不同演绎',2,'新成员证据','新成员证据',?)`,
      [a, b, TS],
    );
  drift(f);
  const result = execute();
  current.result = result;
  expect(one<any>('SELECT state FROM franchise_entities WHERE id=?', [f.id])!.state).not.toBe(
    'rejected',
  );
  expect(result.verification.verified).toBe(true);
});
scenario('old-reopen-event-cannot-justify-state-fault', () => {
  const f = seed('rejected');
  run(
    `INSERT INTO entity_events(entity_kind,entity_id,kind,payload,created_at) VALUES('franchise',?,'candidate_reopened','{"added":[999]}',?)`,
    [f.id, TS],
  );
  drift(f);
  run(
    `CREATE TRIGGER residual_fault AFTER UPDATE ON franchise_entities WHEN NEW.id=${f.id} BEGIN UPDATE franchise_entities SET state='candidate' WHERE id=NEW.id; END`,
  );
  expectSafetyRollback();
});
scenario('legal-confirmed-unmatched-preserved', () => {
  const f = seed('confirmed');
  run("DELETE FROM subject_relations WHERE relation='不同演绎'");
  drift(f);
  const result = execute();
  current.result = result;
  expect(one<any>('SELECT state FROM franchise_entities WHERE id=?', [f.id])!.state).toBe(
    'confirmed',
  );
  expect(result.verification.verified).toBe(true);
});
for (const eventFault of ['missing-new', 'wrong-payload'] as const)
  scenario(`reopen-event-${eventFault}`, () => {
    const f = seed('rejected');
    run(
      `INSERT INTO entity_events(entity_kind,entity_id,kind,payload,created_at) VALUES('franchise',?,'candidate_reopened',?,?)`,
      [f.id, JSON.stringify({ added: [f.decoy.id] }), TS],
    );
    for (const [a, b] of [
      [420, 800],
      [800, 420],
    ])
      run(
        `INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at) VALUES(?,?,'不同演绎',2,'新成员证据','新成员证据',?)`,
        [a, b, TS],
      );
    drift(f);
    run(
      `CREATE TRIGGER residual_fault AFTER INSERT ON entity_events WHEN NEW.entity_kind='franchise' AND NEW.entity_id=${f.id} AND NEW.kind='candidate_reopened' BEGIN ${eventFault === 'missing-new' ? 'DELETE FROM entity_events WHERE id=NEW.id' : 'UPDATE entity_events SET payload=\'{"added":[999]}\' WHERE id=NEW.id'}; END`,
    );
    expectSafetyRollback();
  });
scenario('legal-conflict-member-returns-as-candidate', () => {
  const f = seed('confirmed');
  for (const [a, b] of [
    [420, 800],
    [800, 420],
  ])
    run(
      `INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at) VALUES(?,?,'不同演绎',2,'第三成员','第三成员',?)`,
      [a, b, TS],
    );
  recomputeSeries();
  confirmFranchise(f.key);
  run(
    "DELETE FROM subject_relations WHERE relation='不同演绎' AND (subject_id=800 OR related_id=800)",
  );
  recomputeSeries();
  expect(
    all<any>('SELECT state FROM franchise_series WHERE franchise_id=?', [f.id]).some(
      (l) => l.state === 'conflict',
    ),
  ).toBe(true);
  for (const [a, b] of [
    [420, 800],
    [800, 420],
  ])
    run(
      `INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at) VALUES(?,?,'不同演绎',2,'恢复关系','恢复关系',?)`,
      [a, b, TS],
    );
  drift(f);
  const result = execute();
  current.result = result;
  expect(result.verification.verified).toBe(true);
});
scenario('confirmed-conflict-cannot-disappear', () => {
  const f = seed('confirmed');
  for (const [a, b] of [
    [420, 800],
    [800, 420],
  ])
    run(
      `INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at) VALUES(?,?,'不同演绎',2,'第三成员','第三成员',?)`,
      [a, b, TS],
    );
  recomputeSeries();
  confirmFranchise(f.key);
  run(
    "DELETE FROM subject_relations WHERE relation='不同演绎' AND (subject_id=800 OR related_id=800)",
  );
  recomputeSeries();
  expect(
    all<any>('SELECT state FROM franchise_series WHERE franchise_id=?', [f.id]).some(
      (l) => l.state === 'conflict',
    ),
  ).toBe(true);
  drift(f);
  run(
    `CREATE TRIGGER residual_fault AFTER INSERT ON franchise_series WHEN NEW.franchise_id=${f.id} AND NEW.state='conflict' BEGIN DELETE FROM franchise_series WHERE franchise_id=NEW.franchise_id AND series_id=NEW.series_id; END`,
  );
  expectSafetyRollback();
});
