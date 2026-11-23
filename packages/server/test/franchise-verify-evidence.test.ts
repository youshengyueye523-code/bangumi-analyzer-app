import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.js';
import { all, dataVersion, one, run } from '../src/db/index.js';
import { confirmFranchise, recomputeSeries, rejectFranchiseCandidate } from '../src/db/series.js';
import { getFranchiseDetail } from '../src/db/query.js';
import { buildFranchiseGovernancePreview, runFranchiseGovernance } from '../src/diagnostics/franchiseGovernance.js';
import { invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { resetDatabase } from './helpers.js';

const TS = '2026-10-13T00:00:00.000Z';
const TITLE = '本次人工名称';
const STATES = ['candidate', 'confirmed', 'rejected'] as const;
function seed(state: typeof STATES[number]) {
  for (const [id, title] of [[1, '星海航线'], [2, '夜灯回廊']] as const) {
    run(`INSERT INTO subjects(id,name,name_cn,aliases,year,format,nsfw,tag_names,created_at,updated_at)
         VALUES(?,?,?,'[]',2020,'TV',0,'[]',?,?)`, [id,title,title,TS,TS]);
    run(`INSERT INTO collections(subject_id,subject_type,type,rate,first_seen_at,synced_at)
         VALUES(?,2,2,7,?,?)`, [id,TS,TS]);
  }
  for (const [a,b] of [[1,2],[2,1]]) run(`INSERT INTO subject_relations(subject_id,related_id,relation,type,name,name_cn,created_at)
    VALUES(?,?,'不同演绎',2,'','',?)`, [a,b,TS]);
  recomputeSeries();
  const f = one<{id:number;key:string}>("SELECT id,key FROM franchise_entities WHERE state <> 'stale'")!;
  if (state === 'confirmed') confirmFranchise(f.key);
  if (state === 'rejected') rejectFranchiseCandidate(f.key, '合法否决');
  expect(getFranchiseDetail(f.key)!.state).toBe(state);
  return f;
}
const input = (key: string, reason = '本次理由') => ({kind:'adopt-franchise-title' as const,franchiseKey:key,title:TITLE,reason});
const raw = () => ['subjects','collections','subject_relations'].map(t=>all(`SELECT * FROM ${t} ORDER BY rowid`));
const events = () => all('SELECT * FROM entity_events ORDER BY id');
function corruptCandidate(id: number, value: unknown) {
  const json = JSON.stringify(value).replaceAll("'", "''");
  run(`CREATE TRIGGER corrupt_manual AFTER UPDATE OF title ON franchise_entities
       WHEN NEW.id=${id} AND NEW.title='${TITLE}' BEGIN
       UPDATE franchise_entities SET title_candidates='${json}' WHERE id=NEW.id; END`);
}
const full = {title:TITLE,source:'manual',state:'manual',evidence:'人工确认'};

describe.each(STATES)('本次名称Verify来源与历史：%s', state => {
  beforeEach(() => { resetDatabase();saveConfig({hideNsfw:false});invalidateDiagnosticsReport(); });
  afterEach(() => {
    for (const name of ['corrupt_manual','erase_current','corrupt_payload']) run(`DROP TRIGGER IF EXISTS ${name}`);
  });

  it.each([
    ['缺少state/evidence', [{title:TITLE,source:'manual'}]],
    ['evidence类型错误', [{...full,evidence:7}]],
    ['manual来源但非manual状态', [{...full,state:'resolved'}]],
    ['显式无效候选', [{...full,valid:false}]],
    ['合法候选混入异常对象', [full,null]],
  ])('%s不能提供本次有效provenance，异常原文保留', (_label, value) => {
    const f=seed(state),beforeRaw=raw(),members=getFranchiseDetail(f.key)!.series.map(s=>s.key),version=dataVersion();
    const request=input(f.key);
    expect(buildFranchiseGovernancePreview(request).allowed).toBe(true);
    expect(dataVersion()).toBe(version);
    corruptCandidate(f.id,value);
    const result=runFranchiseGovernance(request);
    expect(result.verification.verified).toBe(false);
    expect(result.verification.partial).toBe(true);
    expect(result.verification.checks.find(c=>c.label==='人工名称 provenance')!.ok).toBe(false);
    expect(result.verification.checks.find(c=>c.label==='治理历史已记录')!.ok).toBe(true);
    expect(one<{title_candidates:string}>('SELECT title_candidates FROM franchise_entities WHERE id=?',[f.id])!.title_candidates).toBe(JSON.stringify(value));
    expect(getFranchiseDetail(f.key)!.title).toBe(TITLE);
    expect(getFranchiseDetail(f.key)!.state).toBe(state);
    expect(getFranchiseDetail(f.key)!.series.map(s=>s.key)).toEqual(members);
    expect(dataVersion()).toBe(version+1);
    expect(raw()).toEqual(beforeRaw);
  });

  it('既有完整结构但无optional字段的manual候选兼容详情与Verify', () => {
    const f=seed(state);corruptCandidate(f.id,[full]);
    const result=runFranchiseGovernance(input(f.key));
    expect(getFranchiseDetail(f.key)!.titleCandidates).toEqual([full]);
    expect(result.verification.verified).toBe(true);
    expect(result.verification.checks.filter(c=>!c.ok)).toEqual([]);
  });

  it.each(['不同理由','完全相同载荷'])('旧同名事件不能替代本次缺失事件：%s', variant => {
    const f=seed(state),request=input(f.key,'相同理由');
    expect(runFranchiseGovernance(request).verification.verified).toBe(true);
    // 第二次合法写入使历史from/fromState/to/reason与后续同名操作也完全相同。
    expect(runFranchiseGovernance(request).verification.verified).toBe(true);
    const beforeEvents=events(),beforeRaw=raw(),version=dataVersion();
    run(`CREATE TRIGGER erase_current AFTER INSERT ON entity_events
         WHEN NEW.entity_kind='franchise' AND NEW.entity_id=${f.id} AND NEW.kind='title_manual'
         BEGIN DELETE FROM entity_events WHERE id=NEW.id; END`);
    const result=runFranchiseGovernance(input(f.key,variant==='不同理由'?'本次新理由':'相同理由'));
    expect(result.verification.verified).toBe(false);
    expect(result.verification.partial).toBe(true);
    expect(result.verification.checks.find(c=>c.label==='治理历史已记录')!.ok).toBe(false);
    expect(result.verification.checks.find(c=>c.label==='人工名称 provenance')!.ok).toBe(true);
    expect(events()).toEqual(beforeEvents);
    expect(raw()).toEqual(beforeRaw);
    expect(dataVersion()).toBe(version+1);
    expect(getFranchiseDetail(f.key)!.state).toBe(state);
    run('DROP TRIGGER erase_current');
    const retryVersion=dataVersion(),retried=runFranchiseGovernance(request);
    expect(retried.verification.verified).toBe(true);
    expect(dataVersion()).toBe(retryVersion+1);
    expect(events().slice(0,beforeEvents.length)).toEqual(beforeEvents);
    expect(events().length).toBe(beforeEvents.length+1);
  });

  it.each(['reason','fromState','mode'])('本次事件%s不匹配也必须partial', field => {
    const f=seed(state);
    run(`CREATE TRIGGER corrupt_payload AFTER INSERT ON entity_events
         WHEN NEW.entity_kind='franchise' AND NEW.entity_id=${f.id} AND NEW.kind='title_manual'
         BEGIN UPDATE entity_events SET payload=json_set(payload,'$.${field}','不匹配') WHERE id=NEW.id; END`);
    const result=runFranchiseGovernance(input(f.key));
    expect(result.verification.verified).toBe(false);
    expect(result.verification.checks.find(c=>c.label==='治理历史已记录')!.ok).toBe(false);
    expect(result.verification.checks.find(c=>c.label==='人工名称 provenance')!.ok).toBe(true);
  });
});
