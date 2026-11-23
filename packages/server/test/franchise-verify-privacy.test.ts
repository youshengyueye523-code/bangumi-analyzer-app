import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { saveConfig } from '../src/config.js';
import { all, closeDatabase, dataVersion, one, openDatabase, run } from '../src/db/index.js';
import { confirmFranchise, recomputeSeries, rejectFranchiseCandidate } from '../src/db/series.js';
import { getFranchiseDetail, isFranchiseHidden } from '../src/db/query.js';
import * as search from '../src/db/ipSearch.js';
import { buildFranchiseGovernancePreview, runFranchiseGovernance } from '../src/diagnostics/franchiseGovernance.js';
import { invalidateDiagnosticsReport } from '../src/diagnostics/report.js';

const TS = '2026-10-24T00:00:00.000Z';
const TITLE = '隔离人工星河';
const STATES = ['candidate', 'confirmed', 'rejected'] as const;
let sequence = 0;
const request = (key: string) => ({ kind: 'adopt-franchise-title' as const, franchiseKey: key, title: TITLE, reason: '隐私回归' });
const raw = () => ['subjects', 'collections', 'subject_relations'].map(t => all(`SELECT * FROM ${t} ORDER BY rowid`));
const snapshot = () => ['franchise_entities', 'franchise_series', 'entity_events', 'meta'].map(t => all(`SELECT * FROM ${t} ORDER BY rowid`));
function seed(state: typeof STATES[number]) {
  for (const [id, title] of [[1, '隐私灯塔'], [2, '隐私远岸'], [3, '隐私灯塔 第二季']] as const) {
    run(`INSERT INTO subjects(id,name,name_cn,aliases,year,format,nsfw,tag_names,detail_state,created_at,updated_at)
      VALUES(?,?,?,'[]',2020,'TV',1,'[]','ok',?,?)`, [id, title, title, TS, TS]);
    // Subject 3 is locally known, but has no Collection.
    if (id !== 3) run(`INSERT INTO collections(subject_id,subject_type,type,rate,first_seen_at,synced_at)
      VALUES(?,2,2,7,?,?)`, [id, TS, TS]);
  }
  for (const [a, b] of [[1, 2], [2, 1]]) run(`INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at)
    VALUES(?,?,'不同演绎',2,'','',?)`, [a, b, TS]);
  for (const [a, b, relation] of [[1, 3, '续集'], [3, 1, '前传']] as const) run(`INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at)
    VALUES(?,?,?,2,'','',?)`, [a, b, relation, TS]);
  recomputeSeries();
  const f = one<{ id: number; key: string }>("SELECT id,key FROM franchise_entities WHERE state <> 'stale'")!;
  if (state === 'confirmed') confirmFranchise(f.key);
  if (state === 'rejected') rejectFranchiseCandidate(f.key, '合法否决');
  return f;
}
function expectVerified(result: ReturnType<typeof runFranchiseGovernance>) {
  expect(result.verification.checks.filter(c => !c.ok)).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.verification.verified).toBe(true);
  expect(result.verification.partial).toBe(false);
}

describe.each(STATES)('GOV-FINAL-003 当前隐私与名称 Verify：%s', state => {
  beforeEach(() => {
    closeDatabase();
    openDatabase({ file: join(process.env.BANGUMI_DATA_DIR!, `privacy-${++sequence}.db`) });
    saveConfig({ hideNsfw: false });
    invalidateDiagnosticsReport();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expect(one<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check).toBe('ok');
    expect(all('PRAGMA foreign_key_check')).toEqual([]);
    closeDatabase();
  });

  it.each([false, true])('合法命名 hideNsfw=%s；来源、当前事件与成员状态仍验证', hidden => {
    const f = seed(state), beforeRaw = raw(), members = all('SELECT * FROM franchise_series ORDER BY rowid');
    saveConfig({ hideNsfw: hidden });
    const before = snapshot(), version = dataVersion();
    const preview = buildFranchiseGovernancePreview(request(f.key));
    expect(preview.allowed).toBe(true);
    expect(snapshot()).toEqual(before);
    expectVerified(runFranchiseGovernance(request(f.key)));
    expect(one('SELECT title,title_state,title_source,state,collected_count FROM franchise_entities WHERE id=?', [f.id]))
      .toEqual({ title: TITLE, title_state: 'manual', title_source: 'manual', state, collected_count: 2 });
    expect(all('SELECT * FROM franchise_series ORDER BY rowid')).toEqual(members);
    expect(dataVersion()).toBe(version + 1);
    expect(raw()).toEqual(beforeRaw);
    expect(search.searchFranchiseEntities(TITLE).items.some(i => i.key === f.key)).toBe(!hidden);
    expect(getFranchiseDetail(f.key) === null).toBe(hidden);
  });

  it.each([false, true])('Preview 后切换隐私，Execute 读取当前状态：此前 hidden=%s', beforeHidden => {
    const f = seed(state);
    saveConfig({ hideNsfw: beforeHidden });
    const before = snapshot();
    const preview = buildFranchiseGovernancePreview(request(f.key));
    expect(preview.allowed).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(preview.preview!.chain.find(c => c.layer === 'search')!.detail).toContain('隐私');
    saveConfig({ hideNsfw: !beforeHidden });
    expectVerified(runFranchiseGovernance(request(f.key)));
    expect(isFranchiseHidden(f.key)).toBe(!beforeHidden);
    expect(search.searchFranchiseEntities(TITLE).items.some(i => i.key === f.key)).toBe(beforeHidden);
  });

  it('仍有可见 Series 的混合家族必须搜索命中', () => {
    const f = seed(state);
    run('UPDATE subjects SET nsfw=0 WHERE id IN (1,3)');
    saveConfig({ hideNsfw: true });
    expect(isFranchiseHidden(f.key)).toBe(false);
    expectVerified(runFranchiseGovernance(request(f.key)));
    const hit = search.searchFranchiseEntities(TITLE).items.find(i => i.key === f.key)!;
    expect(hit).toBeDefined();
    expect(JSON.stringify(hit)).not.toContain('隐私远岸');
  });

  it.each([false, true])('搜索结果被故障替换时不能假成功：hidden=%s', hidden => {
    const f = seed(state);
    expectVerified(runFranchiseGovernance(request(f.key)));
    const visible = search.searchFranchiseEntities(TITLE);
    saveConfig({ hideNsfw: hidden });
    vi.spyOn(search, 'searchFranchiseEntities').mockReturnValue(hidden ? visible : { query: TITLE, total: 0, items: [] });
    const result = runFranchiseGovernance(request(f.key));
    expect(result.ok).toBe(false);
    expect(result.verification.partial).toBe(true);
    expect(result.verification.checks.filter(c => !c.ok).map(c => c.label)).toEqual(['搜索投影']);
    if (hidden) {
      const detail = result.verification.checks.find(c => c.layer === 'search')!.detail;
      for (const secret of [TITLE, f.key, '隐私灯塔', '隐私远岸']) expect(detail).not.toContain(secret);
    }
  });

  it.each(['manual', 'event', 'payload', 'title', 'abort'] as const)('隐藏不能掩盖真实缺陷：%s', fault => {
    const f = seed(state);
    saveConfig({ hideNsfw: true });
    const before = snapshot(), version = dataVersion();
    if (fault === 'manual') run(`CREATE TRIGGER fault AFTER UPDATE OF title ON franchise_entities WHEN NEW.id=${f.id}
      BEGIN UPDATE franchise_entities SET title_candidates='[]' WHERE id=NEW.id; END`);
    if (fault === 'title') run(`CREATE TRIGGER fault AFTER UPDATE OF title ON franchise_entities WHEN NEW.id=${f.id} AND NEW.title='${TITLE}'
      BEGIN UPDATE franchise_entities SET title='错误名称' WHERE id=NEW.id; END`);
    if (fault === 'event') run(`CREATE TRIGGER fault AFTER INSERT ON entity_events WHEN NEW.kind='title_manual'
      BEGIN DELETE FROM entity_events WHERE id=NEW.id; END`);
    if (fault === 'payload') run(`CREATE TRIGGER fault AFTER INSERT ON entity_events WHEN NEW.kind='title_manual'
      BEGIN UPDATE entity_events SET payload=json_set(payload,'$.reason','错误理由') WHERE id=NEW.id; END`);
    if (fault === 'abort') {
      run(`CREATE TRIGGER fault BEFORE INSERT ON entity_events WHEN NEW.kind='title_manual'
        BEGIN SELECT RAISE(ABORT,'隔离提交故障'); END`);
      expect(() => runFranchiseGovernance(request(f.key))).toThrow('隔离提交故障');
      expect(snapshot()).toEqual(before);
      expect(dataVersion()).toBe(version);
    } else {
      const result = runFranchiseGovernance(request(f.key));
      expect(result.ok).toBe(false);
      expect(result.verification.partial).toBe(true);
      const label = fault === 'manual' ? '人工名称 provenance' : fault === 'title' ? 'Franchise canonical title' : '治理历史已记录';
      expect(result.verification.checks.find(c => c.label === label)!.ok).toBe(false);
      expect(result.verification.checks.find(c => c.layer === 'search')!.ok).toBe(true);
      expect(dataVersion()).toBe(version + 1);
    }
    expect(search.searchFranchiseEntities(TITLE).items).toEqual([]);
    expect(getFranchiseDetail(f.key)).toBeNull();
  });
});
