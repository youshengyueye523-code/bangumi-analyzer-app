import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { all, dataVersion, one, run } from '../src/db/index.js';
import { adoptFranchiseTitle } from '../src/db/franchiseGovernance.js';
import { searchFranchiseEntities } from '../src/db/ipSearch.js';
import { getFranchiseDetail } from '../src/db/query.js';
import { confirmFranchise, recomputeSeries } from '../src/db/series.js';
import { runDiagnosticsRepair } from './repairPreview.js';
import { invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { resetDatabase } from './helpers.js';

const TITLE = '契约核查人工家族';
const TS = '2026-10-29T00:00:00.000Z';
const manual = { title: TITLE, source: 'manual', state: 'manual', evidence: '显式人工命名' };
const VALID = JSON.stringify([manual]);
const SOURCE_FAILURE = { layer: 'source', label: 'Franchise 名称来源', ok: false };
const protectedTables = ['subjects', 'collections', 'subject_relations', 'franchise_series',
  'entity_events', 'candidate_decisions', 'franchise_member_exclusions', 'entity_aliases'];
const facts = () => protectedTables.map(table => all(`SELECT * FROM ${table} ORDER BY rowid`));

// 独立小夹具：两个互为不同演绎的单成员 Series，4/8 分；不复用旧均分测试的五成员夹具。
function seed(hidden: boolean): string {
  for (const [id, title, rate] of [[3101, '北岸灯塔', 4], [3102, '远港航程', 8]] as const) {
    run(`INSERT INTO subjects(id,name,name_cn,aliases,year,format,nsfw,tag_names,detail_state,created_at,updated_at)
      VALUES(?,?,?,'[]',2024,'TV',?,'[]','ok',?,?)`, [id, title, title, Number(hidden), TS, TS]);
    run(`INSERT INTO collections(subject_id,subject_type,type,rate,first_seen_at,synced_at)
      VALUES(?,2,2,?,?,?)`, [id, rate, TS, TS]);
  }
  for (const [a, b] of [[3101, 3102], [3102, 3101]]) {
    run(`INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at)
      VALUES(?,?,'不同演绎',2,'','',?)`, [a, b, TS]);
  }
  recomputeSeries();
  const f = one<{ key: string }>("SELECT key FROM franchise_entities WHERE state<>'stale'")!;
  expect(confirmFranchise(f.key)).toBeTruthy();
  expect(adoptFranchiseTitle(f.key, TITLE).ok).toBe(true);
  // 完整旧格式无 optional 字段仍合法，不把缺可选字段误判成损坏。
  run('UPDATE franchise_entities SET title_candidates=? WHERE key=?', [VALID, f.key]);
  saveConfig({ hideNsfw: hidden });
  return f.key;
}

function repair(key: string, expectedRaw: string, hidden: boolean, verified: boolean, protectedChange = false) {
  run('UPDATE franchise_entities SET average_rate=NULL WHERE key=?', [key]);
  invalidateDiagnosticsReport();
  const before = facts(), version = dataVersion();
  const identity = one('SELECT id,key,state,title,title_state,title_source FROM franchise_entities WHERE key=?', [key]);
  if (protectedChange) {
    const stored = one('SELECT * FROM franchise_entities WHERE key=?', [key]);
    expect(() => runDiagnosticsRepair({ issueId: 'franchise.counter-drift', kind: 'recompute-derived' })).toThrow(/允许写集/);
    expect(facts()).toEqual(before);
    expect(one('SELECT * FROM franchise_entities WHERE key=?', [key])).toEqual(stored);
    expect(dataVersion()).toBe(version);
    return;
  }
  const result = runDiagnosticsRepair({ issueId: 'franchise.counter-drift', kind: 'recompute-derived' });
  expect(result.ok).toBe(verified);
  expect(result.verification).toMatchObject({ verified, partial: !verified });
  expect(result.verification.checks.filter(check => !check.ok).map(({ layer, label, ok }) => ({ layer, label, ok })))
    .toEqual(verified ? [] : [SOURCE_FAILURE]);
  expect(result.verification.resolvedIssueIds).toContain('franchise.counter-drift');
  expect(result.report.issues.some(issue => issue.id === 'franchise.counter-drift')).toBe(false);
  expect(one('SELECT id,key,state,title,title_state,title_source FROM franchise_entities WHERE key=?', [key])).toEqual(identity);
  expect(one('SELECT average_rate,title_candidates FROM franchise_entities WHERE key=?', [key]))
    .toEqual({ average_rate: 6, title_candidates: expectedRaw });
  expect(facts()).toEqual(before);
  expect(dataVersion()).toBe(version + 1);
  expect(searchFranchiseEntities(TITLE).items.some(item => item.key === key)).toBe(!hidden);
  if (hidden) expect(getFranchiseDetail(key)).toBeNull();
  else expect(getFranchiseDetail(key)).toMatchObject({ key, canonicalKey: key, title: TITLE, state: 'confirmed', averageRate: 6 });
  expect(one<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check).toBe('ok');
  expect(all('PRAGMA foreign_key_check')).toEqual([]);
}

describe.each([false, true])('Franchise Repair 必要名称来源契约 hidden=%s', hidden => {
  beforeEach(() => { resetDatabase(); saveConfig({ hideNsfw: false }); invalidateDiagnosticsReport(); });
  afterEach(() => { run('DROP TRIGGER IF EXISTS contract_candidate_fault'); });

  it('完整 manual 来源：目标修复且所有必要层通过；合法隐藏不导致假失败', () => {
    repair(seed(hidden), VALID, hidden, true);
  });

  it.each([
    ['非数组', '{}'],
    ['异常成员', '[null]'],
    ['不可解析', '{broken'],
    ['空来源', '[]'],
    ['来源同名但已无效', JSON.stringify([{ ...manual, valid: false }])],
    ['结构合法但名称不匹配', JSON.stringify([{ ...manual, title: '另一个名称' }])],
    ['结构合法但不是人工状态', JSON.stringify([{ ...manual, state: 'resolved' }])],
    ['合法当前候选不能掩盖异常旧项', JSON.stringify([manual, null])],
  ])('%s：修复均分不等于来源已验证，原证据及治理事实保留', (_label, raw) => {
    const key = seed(hidden);
    run('UPDATE franchise_entities SET title_candidates=? WHERE key=?', [raw, key]);
    repair(key, raw, hidden, false);
  });

  it.each(['during', 'prior'] as const)('%s 来源缺失：不能只验证修复前或只验证修复后', phase => {
    const key = seed(hidden);
    const beforeRaw = phase === 'prior' ? '{}' : VALID;
    const afterRaw = phase === 'prior' ? VALID : '{}';
    run('UPDATE franchise_entities SET title_candidates=? WHERE key=?', [beforeRaw, key]);
    // 真实重算写入时注入；仅更新候选，不抛异常，不用 mock 替代真实 Verify。
    run(`CREATE TRIGGER contract_candidate_fault AFTER UPDATE OF average_rate ON franchise_entities
      WHEN NEW.key='${key}' AND NEW.average_rate IS NOT NULL BEGIN
      UPDATE franchise_entities SET title_candidates='${afterRaw.replaceAll("'", "''")}' WHERE key=NEW.key; END`);
    repair(key, afterRaw, hidden, false, true);
  });
});
