/**
 * 数据中枢（v1.6.0）测试。
 *
 * 重点验证：
 * - 发现真实问题（计数漂移 / 归属投影漂移 / 缓存标记漂移 / 待确认家族）；
 * - 不把 provisional 当成错误；
 * - 修复闭环：预览 → 执行 → 重新检测 → 问题真正消失 → API 口径一致；
 * - 无法人工修复的问题不会伪造修复按钮。
 */
import type { FastifyInstance } from 'fastify';
import type { DiagnosticsRepairResult, DiagnosticsReport } from '@bangumi-analyzer/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as searchReads from '../src/db/ipSearch.js';
import * as apiReads from '../src/db/query.js';
import * as diagnosticReads from '../src/diagnostics/report.js';
import { buildApp } from '../src/app.js';
import { saveConfig, paths } from '../src/config.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, one, run, dataVersion } from '../src/db/index.js';
import {
  getFranchiseDetail,
  getSeriesDetail,
  getSubjectDetail,
  listFranchises,
  listSeries,
} from '../src/db/query.js';
import { recomputeSeries, rejectSeriesTitleCandidate } from '../src/db/series.js';
import { searchSeriesEntities } from '../src/db/ipSearch.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from '../src/diagnostics/report.js';
import { runDiagnosticsRepair } from './repairPreview.js';
import { genericRecomputePlan } from '../src/diagnostics/genericPlan.js';
import { CoverCache } from '../src/images/coverCache.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, resetDatabase, testConfig } from './helpers.js';

const TS = '2026-01-01T00:00:00.000Z';

function hideNsfw(value: boolean): void {
  saveConfig({ hideNsfw: value });
}

function seedSubject(
  id: number,
  nameCn: string,
  options: { nsfw?: boolean; collected?: boolean } = {},
): void {
  run(
    `INSERT INTO subjects (id, name, name_cn, aliases, year, format, nsfw, tag_names, created_at, updated_at)
     VALUES (:id, :name, :nameCn, '[]', 2010, 'TV', :nsfw, '[]', :ts, :ts)`,
    { id, name: nameCn, nameCn, nsfw: options.nsfw ? 1 : 0, ts: TS },
  );
  if (options.collected !== false) {
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

function seedSeries(): string {
  seedSubject(1, '测试系列');
  seedSubject(2, '测试系列 第二季');
  seedRelation(1, 2, '续集');
  seedRelation(2, 1, '前传');
  recomputeSeries();
  return listSeries({ includeSingletons: true })[0]!.key;
}

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

function issueById(report: ReturnType<typeof getDiagnosticsReport>, id: string) {
  return report.issues.find((issue) => issue.id === id);
}

describe('数据中枢：检测', () => {
  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
    invalidateDiagnosticsReport();
  });

  it('健康数据：没有 error，provisional 只作为「当前不确定」信息', () => {
    seedSeries();
    const key = listSeries({ includeSingletons: true })[0]!.key;
    // 把标题改成暂定，验证 provisional 不会被当成错误
    run(`UPDATE series_entities SET title_state = 'provisional' WHERE key = :key`, { key });
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    expect(report.summary.error).toBe(0);
    expect(report.scope.series).toBe(1);
    expect(report.scope.subjects).toBe(2);
    const provisional = issueById(report, 'titles.provisional');
    expect(provisional).toBeTruthy();
    expect(provisional!.severity).toBe('uncertain');
    expect(provisional!.actions.every((action) => action.kind === 'link')).toBe(true);
    // 存储与数据库模块必须通过
    expect(report.modules.find((module) => module.id === 'storage')!.status).toBe('ok');
  });

  it('计数漂移被发现，并带证据与修复动作', () => {
    const key = seedSeries();
    run(`UPDATE series_entities SET member_count = 99 WHERE key = :key`, { key });
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, 'series.counter-drift');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('error');
    expect(issue!.evidence.some((row) => row.value.includes('1'))).toBe(true);
    expect(issue!.actions.some((action) => action.kind === 'repair')).toBe(true);
    expect(report.summary.error).toBeGreaterThan(0);
  });

  it('归属投影漂移被发现（subjects.series_key 与成员表不一致）', () => {
    seedSeries();
    run(`UPDATE subjects SET series_key = 'sr_not_real' WHERE id = 1`);
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, 'series.key-drift');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('error');
    expect(issue!.affectedCount).toBe(1);
    expect(issue!.evidence[0]?.value).toBe('1 条');
    expect(issue!.affected.map((item) => item.href)).toEqual(['/subjects/1']);
    expect(issue!.impact.some((entry) => entry.kind === 'projection')).toBe(true);
  });

  it('归属缓存为空：只计真实缺失的作品，且可定位到条目', () => {
    const key = seedSeries();
    run('UPDATE subjects SET series_key = NULL WHERE id = 2');
    const issue = issueById(getDiagnosticsReport({ refresh: true }), 'series.key-drift')!;
    expect(issue.affectedCount).toBe(1);
    expect(issue.affected).toEqual([
      expect.objectContaining({ href: '/subjects/2', detail: expect.stringContaining(key) }),
    ]);
  });

  it('家族候选是「待人工确认」，不是错误', () => {
    const franchiseKey = seedFranchiseCandidate();
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, `franchise.awaiting-review:${franchiseKey}`);
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('needs-review');
    const repairAction = issue!.actions.find((action) => action.kind === 'repair');
    expect(repairAction && repairAction.kind === 'repair' && repairAction.repairKind).toBe(
      'confirm-franchise',
    );
    expect(report.summary.error).toBe(0);
  });

  it('单 Series 家族使用实际可用链接，不信任派生计数', () => {
    const key = seedFranchiseCandidate();
    const id = one<{ id: number }>('SELECT id FROM franchise_entities WHERE key = :key', { key })!.id;
    const links = all<{ series_id: number }>(
      'SELECT series_id FROM franchise_series WHERE franchise_id = :id ORDER BY series_id', { id },
    );
    expect(links).toHaveLength(2);
    const singleId = `franchise.single-series:${key}`;

    run('UPDATE franchise_entities SET series_count = 1 WHERE id = :id', { id });
    const two = getDiagnosticsReport({ refresh: true });
    expect(getFranchiseDetail(key)!.series).toHaveLength(2);
    expect(issueById(two, singleId)).toBeUndefined();
    expect(issueById(two, 'franchise.counter-drift')).toBeDefined();

    run('DELETE FROM franchise_series WHERE franchise_id = :id AND series_id = :sid', {
      id, sid: links[1]!.series_id,
    });
    run('UPDATE franchise_entities SET series_count = 0 WHERE id = :id', { id });
    const oneLive = issueById(getDiagnosticsReport({ refresh: true }), singleId)!;
    expect(getFranchiseDetail(key)!.series).toHaveLength(1);
    expect(oneLive.evidence).toContainEqual({ label: '系列数', value: '1' });

    run("UPDATE series_entities SET state = 'stale' WHERE id = :sid", { sid: links[0]!.series_id });
    const stale = getDiagnosticsReport({ refresh: true });
    expect(getFranchiseDetail(key)!.series).toHaveLength(0);
    expect(issueById(stale, singleId)).toBeUndefined();
    expect(issueById(stale, 'franchise.stale-link')).toBeDefined();
  });

  it('封面缓存标记与文件不一致会被发现', () => {
    seedSubject(1, '有封面的作品');
    run(
      `UPDATE subjects SET cover_cached_at = :ts, cover_path = 'missing-file.jpg' WHERE id = 1`,
      { ts: TS },
    );
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, 'cover.cache-drift');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('error');
  });

  it('NSFW 开关关闭时不检查可见性；开启后执行真实读取路径验证', () => {
    seedSubject(1, '普通作品');
    seedSubject(2, 'NSFW 作品', { nsfw: true });
    recomputeSeries();
    invalidateDiagnosticsReport();

    const off = getDiagnosticsReport({ refresh: true });
    expect(off.modules.find((module) => module.id === 'visibility')!.status).toBe('skipped');

    hideNsfw(true);
    const on = getDiagnosticsReport({ refresh: true });
    const module = on.modules.find((entry) => entry.id === 'visibility')!;
    expect(module.status).toBe('ok');
    expect(module.details.some((detail) => detail.includes('隐藏'))).toBe(true);
    expect(issueById(on, 'visibility.subject-leak')).toBeUndefined();
  });

  it('报告默认走缓存，refresh 强制重新检测', () => {
    seedSeries();
    const first = getDiagnosticsReport({ refresh: true });
    const second = getDiagnosticsReport();
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second).toBe(first);
    const third = getDiagnosticsReport({ refresh: true });
    // refresh 会绕过缓存重新检测：返回新的报告对象
    expect(third).not.toBe(first);
    expect(third.generatedAt >= first.generatedAt).toBe(true);
  });
});

describe('数据中枢：修复闭环', () => {
  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
    invalidateDiagnosticsReport();
  });

  it('已存详情不等于收藏：合法未收藏成员不报漂移，真实计数故障仍能检测和完整修复', () => {
    seedSubject(1, '测试系列');seedSubject(2, '测试系列 第二季', { collected: false });seedSubject(3, '另一种演绎');
    run("UPDATE subjects SET detail_state='ok'");
    seedRelation(1, 2, '续集');seedRelation(2, 1, '前传');seedRelation(1, 3, '不同演绎');seedRelation(3, 1, '不同演绎');recomputeSeries();
    const franchise = listFranchises()[0]!;
    const series = getSubjectDetail(1)!.series!;
    const stored = one<{ member_count: number; collected_count: number }>('SELECT member_count,collected_count FROM series_entities WHERE key=:key', { key: series.key })!;
    expect(stored).toEqual({ member_count: 2, collected_count: 1 });
    expect(one<{ series_key: string | null }>('SELECT series_key FROM subjects WHERE id=2')!.series_key).toBeNull();
    const invalidIds = ['series.key-drift', 'series.counter-drift', 'franchise.counter-drift'];
    expect(getDiagnosticsReport({ refresh: true }).issues.filter((issue) => invalidIds.includes(issue.id))).toEqual([]);
    const raw = [all('SELECT * FROM subjects'), all('SELECT * FROM collections'), all('SELECT * FROM subject_relations')];
    const members = getFranchiseDetail(franchise.key)!.series.map((entry) => entry.key);
    run('UPDATE series_entities SET member_count=member_count+1 WHERE key=:key', { key: series.key });
    run('UPDATE franchise_entities SET collected_count=collected_count+1 WHERE key=:key', { key: franchise.key });
    const broken = getDiagnosticsReport({ refresh: true });
    expect(broken.issues.some((issue) => issue.id === 'series.counter-drift')).toBe(true);
    expect(broken.issues.some((issue) => issue.id === 'franchise.counter-drift')).toBe(true);
    const result = runDiagnosticsRepair({ issueId: 'series.counter-drift', kind: 'recompute-derived' });
    expect(result.verification.verified).toBe(true);
    expect(result.report.issues.filter((issue) => invalidIds.includes(issue.id))).toEqual([]);
    expect([all('SELECT * FROM subjects'), all('SELECT * FROM collections'), all('SELECT * FROM subject_relations')]).toEqual(raw);
    expect(getFranchiseDetail(franchise.key)!.series.map((entry) => entry.key)).toEqual(members);
  });

  it.each(['throw', 'partial'] as const)('标题采纳后 Verify %s：区分回滚与真实部分成功，重试不重复历史', (failure) => {
    const key = seedSeries();
    const complete = getSeriesDetail(key)!.titleCandidates.find((candidate) => candidate.valid !== false)!.title;
    run('UPDATE series_entities SET title=:title WHERE key=:key', { title: `${complete} (ビスク`, key });
    const issue = issueById(getDiagnosticsReport({ refresh: true }), 'titles.display-truncated')!;
    const action = issue.actions.find((entry) => entry.kind === 'repair' && entry.repairKind === 'adopt-title-candidate')!;
    if (action.kind !== 'repair') throw new Error('missing title action');
    const request = { issueId: issue.id, kind: 'adopt-title-candidate' as const, target: action.target!, value: action.value! };
    const tables = ['subjects', 'collections', 'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'candidate_decisions', 'entity_events', 'entity_aliases', 'meta'];
    const capture = () => tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    const before = capture(); const version = dataVersion(); const read = apiReads.getSeriesDetail;
    const spy = vi.spyOn(apiReads, 'getSeriesDetail').mockImplementation((...args) => {
      if (dataVersion() <= version) return read(...args);
      if (failure === 'throw') throw new Error('injected title verify failure');
      return null;
    });
    try {
      if (failure === 'throw') {
        expect(() => runDiagnosticsRepair(request)).toThrow('injected title verify failure');
        expect(capture()).toEqual(before); expect(dataVersion()).toBe(version);
      } else {
        const result = runDiagnosticsRepair(request);
        expect(result.ok).toBe(false);
        expect(result.verification).toMatchObject({ verified: false, partial: true });
        expect(result.verification.checks).toContainEqual(expect.objectContaining({ layer: 'api', ok: false }));
        expect(dataVersion()).toBe(version + 1);
      }
    } finally { spy.mockRestore(); invalidateDiagnosticsReport(); }
    if (failure === 'throw') expect(runDiagnosticsRepair(request).ok).toBe(true);
    expect(getSeriesDetail(key)).toMatchObject({ title: complete, titleState: 'manual' });
    expect(dataVersion()).toBe(version + 1);
    const after = capture();
    expect(() => runDiagnosticsRepair(request)).toThrow('该问题已不存在');
    expect(capture()).toEqual(after);
  });

  it('封面缓存清理后 Detector 抛错回滚标记；重试成功不推进核心版本', () => {
    seedSubject(1, '缓存故障夹具');
    run("UPDATE subjects SET cover_path='missing-round12.jpg',cover_cached_at=:ts WHERE id=1", { ts: TS });
    const request = { issueId: 'cover.cache-drift', kind: 'clear-cover-cache' as const };
    const before = all('SELECT * FROM subjects'); const version = dataVersion();
    const read = diagnosticReads.getDiagnosticsReport;
    const spy = vi.spyOn(diagnosticReads, 'getDiagnosticsReport').mockImplementation((...args) => {
      if (one<{ cover_path: string | null }>('SELECT cover_path FROM subjects WHERE id=1')?.cover_path === null)
        throw new Error('injected cache detector failure');
      return read(...args);
    });
    try {
      expect(() => runDiagnosticsRepair(request)).toThrow('injected cache detector failure');
      expect(all('SELECT * FROM subjects')).toEqual(before); expect(dataVersion()).toBe(version);
    } finally { spy.mockRestore(); invalidateDiagnosticsReport(); }
    expect(runDiagnosticsRepair(request).ok).toBe(true);
    expect(one('SELECT cover_path,cover_cached_at FROM subjects WHERE id=1')).toEqual({ cover_path: null, cover_cached_at: null });
    expect(dataVersion()).toBe(version);
    const after = all('SELECT * FROM subjects');
    expect(() => runDiagnosticsRepair(request)).toThrow('该问题已不存在');
    expect(all('SELECT * FROM subjects')).toEqual(after);
  });

  it.each(['confirm-franchise', 'reject-franchise-candidate'] as const)('%s 提交后 API 验证抛错必须完整回滚，重试和重复请求不得重复写历史', (kind) => {
    const key = seedFranchiseCandidate();
    const request = { issueId: `franchise.awaiting-review:${key}`, kind, target: key };
    const tables = ['subjects', 'collections', 'series_entities', 'series_entity_members',
      'franchise_entities', 'franchise_series', 'candidate_decisions', 'entity_events', 'meta'];
    const capture = () => tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    const before = capture();
    const version = dataVersion();
    const read = apiReads.getFranchiseDetail;
    const spy = vi.spyOn(apiReads, 'getFranchiseDetail').mockImplementation((...args) => {
      if (dataVersion() > version) throw new Error('injected verify failure');
      return read(...args);
    });
    try {
      expect(() => runDiagnosticsRepair(request)).toThrow('injected verify failure');
      expect(capture()).toEqual(before);
      expect(dataVersion()).toBe(version);
    } finally { spy.mockRestore(); invalidateDiagnosticsReport(); }
    expect(runDiagnosticsRepair(request).ok).toBe(true);
    expect(dataVersion()).toBe(version + 1);
    const after = capture();
    expect(() => runDiagnosticsRepair(request)).toThrow('该问题已不存在');
    expect(capture()).toEqual(after);
  });

  it('重建完成后 Detector 抛错也回滚；恢复后重试一次提交', () => {
    const key = seedSeries();
    run('UPDATE series_entities SET member_count=99 WHERE key=:key', { key });
    const version = dataVersion();
    const tables = ['subjects', 'collections', 'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'entity_events', 'meta'];
    const capture = () => tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    const before = capture();
    const read = diagnosticReads.getDiagnosticsReport;
    const spy = vi.spyOn(diagnosticReads, 'getDiagnosticsReport').mockImplementation((...args) => {
      if (dataVersion() > version) throw new Error('injected detector failure');
      return read(...args);
    });
    try {
      expect(() => runDiagnosticsRepair({ issueId: 'series.counter-drift', kind: 'recompute-derived' })).toThrow('injected detector failure');
      expect(capture()).toEqual(before);
      expect(dataVersion()).toBe(version);
    } finally { spy.mockRestore(); }
    expect(runDiagnosticsRepair({ issueId: 'series.counter-drift', kind: 'recompute-derived' }).ok).toBe(true);
    expect(dataVersion()).toBe(version + 1);
  });

  it.each(['search', 'api'] as const)('重建写入成功后 %s 验证不通过，必须诚实返回 partial 和失败层', (layer) => {
    const key = seedSeries();
    run('UPDATE series_entities SET member_count=99 WHERE key=:key', { key });
    const version = dataVersion();
    const raw = all('SELECT * FROM collections ORDER BY subject_id');
    const read = apiReads.getSeriesDetail;
    const search = searchReads.searchSeriesEntities;
    const spy = layer === 'api'
      ? vi.spyOn(apiReads, 'getSeriesDetail').mockImplementation((...args) => dataVersion() > version ? null : read(...args))
      : vi.spyOn(searchReads, 'searchSeriesEntities').mockImplementation((...args) => ({ ...search(...args), items: dataVersion() > version ? [] : search(...args).items }));
    try {
      const result = runDiagnosticsRepair({ issueId: 'series.counter-drift', kind: 'recompute-derived' });
      expect(result.ok).toBe(false);
      expect(result.verification).toMatchObject({ verified: false, partial: true });
      expect(result.verification.checks.some((check) => check.layer === layer && !check.ok)).toBe(true);
      expect(result.verification.summary).toContain(layer);
      expect(one('SELECT member_count FROM series_entities WHERE key=:key', { key })).toEqual({ member_count: 2 });
      expect(all('SELECT * FROM collections ORDER BY subject_id')).toEqual(raw);
      expect(dataVersion()).toBe(version + 1);
    } finally { spy.mockRestore(); }
    expect(getSeriesDetail(key)).toBeTruthy();
    expect(searchSeriesEntities(getSeriesDetail(key)!.title).items.some((entry) => entry.key === key)).toBe(true);
  });

  it('计数漂移：预览 → 执行 → 重新检测 → 问题消失，且真实数据已修复', () => {
    const key = seedSeries();
    run(`UPDATE series_entities SET member_count = 99 WHERE key = :key`, { key });
    invalidateDiagnosticsReport();

    const before = getDiagnosticsReport({ refresh: true });
    const issue = issueById(before, 'series.counter-drift')!;
    const action = issue.actions.find((entry) => entry.kind === 'repair');
    expect(action && action.kind === 'repair').toBeTruthy();
    if (!action || action.kind !== 'repair') throw new Error('missing repair action');

    // 预览必须说明改什么、影响什么、不碰什么
    expect(action.preview.current).toContain('1');
    expect(action.preview.derivedChanges.length).toBeGreaterThan(0);
    expect(action.preview.chain.length).toBeGreaterThan(0);
    expect(action.preview.untouched.join(' ')).toContain('Collection');

    const result = runDiagnosticsRepair({
      issueId: issue.id,
      kind: action.repairKind,
    });
    expect(result.ok).toBe(true);
    expect(result.verification.verified).toBe(true);
    expect(result.verification.partial).toBe(false);
    expect(result.verification.resolvedIssueIds).toContain(issue.id);
    expect(result.report.issues.some((entry) => entry.id === issue.id)).toBe(false);

    // 真实数据库已修复
    const row = one<{ member_count: number }>(
      'SELECT member_count FROM series_entities WHERE key = :key',
      { key },
    );
    expect(Number(row?.member_count)).toBe(2);
  });

  it('归属投影漂移：修复后 subjects.series_key 与 API 口径一致', () => {
    const key = seedSeries();
    run(`UPDATE subjects SET series_key = 'sr_not_real' WHERE id = 1`);
    invalidateDiagnosticsReport();

    const before = getDiagnosticsReport({ refresh: true });
    const issue = issueById(before, 'series.key-drift')!;
    const result = runDiagnosticsRepair({ issueId: issue.id, kind: 'recompute-derived' });
    expect(result.verification.verified).toBe(true);

    // API 口径：作品详情的系列入口与 Series 实体一致
    const detail = getSubjectDetail(1)!;
    expect(detail.series?.key).toBe(key);
    const stored = one<{ series_key: string | null }>(
      'SELECT series_key FROM subjects WHERE id = 1',
    );
    expect(stored?.series_key).toBe(key);
    // 搜索投影运行时读取标题，因此同步生效
    expect(listSeries({ includeSingletons: true }).some((entry) => entry.key === key)).toBe(true);
  });

  it('家族候选：确认后状态变为 confirmed，问题消失', () => {
    const franchiseKey = seedFranchiseCandidate();
    invalidateDiagnosticsReport();

    const before = getDiagnosticsReport({ refresh: true });
    const issue = issueById(before, `franchise.awaiting-review:${franchiseKey}`)!;
    expect(getFranchiseDetail(franchiseKey)!.state).toBe('candidate');

    const result = runDiagnosticsRepair({
      issueId: issue.id,
      kind: 'confirm-franchise',
      target: franchiseKey,
    });
    expect(result.verification.verified).toBe(true);
    expect(result.verification.checks.some((check) => check.label.includes('家族治理状态'))).toBe(true);
    // 真实状态 + API 校验
    expect(getFranchiseDetail(franchiseKey)!.state).toBe('confirmed');
    expect(result.report.issues.some((entry) => entry.id === issue.id)).toBe(false);
  });

  it('封面缓存标记：只清除文件缺失的标记，已存在的文件不受影响', () => {
    seedSubject(1, '缺文件');
    seedSubject(2, '有文件');
    run(`UPDATE subjects SET cover_cached_at = :ts, cover_path = 'missing.jpg' WHERE id = 1`, {
      ts: TS,
    });
    run(`UPDATE subjects SET cover_cached_at = :ts, cover_path = 'kept.jpg' WHERE id = 2`, {
      ts: TS,
    });
    invalidateDiagnosticsReport();
    writeFileSync(join(paths.coverDir, 'kept.jpg'), 'fixture cover file');
    const version = dataVersion();

    const before = getDiagnosticsReport({ refresh: true });
    const issue = issueById(before, 'cover.cache-drift')!;
    const result = runDiagnosticsRepair({ issueId: issue.id, kind: 'clear-cover-cache' });
    expect(result.verification.verified).toBe(true);
    expect(dataVersion()).toBe(version);

    const rows = all<{ id: number; cover_path: string | null }>(
      'SELECT id, cover_path FROM subjects ORDER BY id',
    );
    expect(rows.find((row) => row.id === 1)?.cover_path).toBeNull();
    expect(rows.find((row) => row.id === 2)?.cover_path).toBe('kept.jpg');
    expect(rows.length).toBe(2);
  });

  it('不可人工修复的问题不会伪造修复按钮（provisional 只有跳转）', () => {
    const key = seedSeries();
    run(`UPDATE series_entities SET title_state = 'provisional' WHERE key = :key`, { key });
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, 'titles.provisional')!;
    expect(issue.actions.some((action) => action.kind === 'repair')).toBe(false);
    expect(() =>
      runDiagnosticsRepair({ issueId: issue.id, kind: 'recompute-derived' }),
    ).toThrowError(/不支持/);
  });

  it('修复不存在的问题会明确报错，不会假装成功', () => {
    seedSeries();
    expect(() =>
      runDiagnosticsRepair({ issueId: 'series.counter-drift', kind: 'recompute-derived' }),
    ).toThrowError(/已不存在/);
  });
});

describe('数据中枢：覆盖增强（v1.6.1）', () => {
  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
    invalidateDiagnosticsReport();
  });

  it('搜索可达性：展示标题为空 / 无法命中自己时报告不可达', () => {
    const key = seedSeries();
    run(`UPDATE series_entities SET title = '' WHERE key = :key`, { key });
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, 'search.unreachable');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('error');
    expect(issue!.affected.some((entry) => entry.href === `/series/${key}`)).toBe(true);
    expect(report.modules.find((module) => module.id === 'reachability')!.status).toBe('error');
  });

  it('孤儿检测：空 Series / 空 Franchise / 无收藏 Subject / 失效别名', () => {
    run(
      `INSERT INTO series_entities (key, state, title, title_state, title_source, title_candidates, created_at, updated_at)
       VALUES ('sr_orphan', 'stable', '孤儿系列', 'resolved', 'brand:members', '[]', :ts, :ts)`,
      { ts: TS },
    );
    run(
      `INSERT INTO franchise_entities (key, state, title, title_state, title_source, title_candidates, created_at, updated_at)
       VALUES ('fr_orphan', 'candidate', '孤儿家族', 'provisional', 'brand:members', '[]', :ts, :ts)`,
      { ts: TS },
    );
    seedSubject(9, '没有收藏行的作品', { collected: false });
    run(
      `INSERT INTO entity_aliases (alias_key, entity_kind, entity_id, reason, created_at)
       VALUES ('bgm_dead_alias', 'series', 999999, 'test', :ts)`,
      { ts: TS },
    );
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    expect(issueById(report, 'orphan.series')).toBeTruthy();
    expect(issueById(report, 'orphan.franchise')).toBeTruthy();
    expect(issueById(report, 'franchise.single-series:fr_orphan')).toBeUndefined();
    expect(issueById(report, 'orphan.subject')).toBeTruthy();
    expect(issueById(report, 'orphan.alias')).toBeTruthy();
    // 空 Series / 空 Franchise 提供重建修复
    expect(
      issueById(report, 'orphan.series')!.actions.some(
        (action) => action.kind === 'repair' && action.repairKind === 'recompute-derived',
      ),
    ).toBe(true);
    // 无收藏行的 Subject 不能自动删除，只说明等待人工确认
    expect(issueById(report, 'orphan.subject')!.actions).toHaveLength(0);
    expect(issueById(report, 'orphan.subject')!.waiting?.label).toContain('不能自动修复');
  });

  it('已否决候选仍标记为有效 → stale projection 被报告为确定错误', () => {
    const key = seedSeries();
    const title = getSeriesDetail(key)!.title;
    const rejected = rejectSeriesTitleCandidate(key, title, '测试：否决');
    expect(rejected.ok).toBe(true);

    // 模拟「治理状态已更新、投影没跟上」：把被否决候选改回 valid=true
    const row = one<{ title_candidates: string }>(
      'SELECT title_candidates FROM series_entities WHERE key = :key',
      { key },
    )!;
    const candidates = JSON.parse(row.title_candidates) as Array<Record<string, unknown>>;
    const stale = candidates.map((candidate) =>
      candidate.rejected === true ? { ...candidate, valid: true } : candidate,
    );
    run('UPDATE series_entities SET title_candidates = :json WHERE key = :key', {
      json: JSON.stringify(stale),
      key,
    });
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, 'titles.rejected-stale');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('error');
    expect(
      issue!.actions.some(
        (action) => action.kind === 'repair' && action.repairKind === 'recompute-derived',
      ),
    ).toBe(true);
  });

  it('展示标题截断：成员里有完整候选时报告为可疑并给出采纳动作', () => {
    const key = seedSeries();
    const detail = getSeriesDetail(key)!;
    const complete = detail.titleCandidates.find((candidate) => candidate.valid !== false)!.title;
    // 模拟 resolver 产出的截断标题（真实数据里出现过「攻壳机动队 S」「(※似乎可行」）
    run(`UPDATE series_entities SET title = :title WHERE key = :key`, {
      title: `${complete} (ビスク`,
      key,
    });
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, 'titles.display-truncated');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('suspicious');
    const adopt = issue!.actions.find(
      (action) => action.kind === 'repair' && action.repairKind === 'adopt-title-candidate',
    );
    expect(adopt).toBeTruthy();
    if (!adopt || adopt.kind !== 'repair') throw new Error('missing adopt action');
    expect(adopt.preview.chain.length).toBeGreaterThan(0);
    expect(adopt.preview.directlyChanges.join(' ')).toContain('canonical title');
  });

  it('展示标题截断：采纳完整候选形成独立闭环（source → search → API → detector）', () => {
    const key = seedSeries();
    const complete = getSeriesDetail(key)!.titleCandidates.find(
      (candidate) => candidate.valid !== false,
    )!.title;
    run(
      `UPDATE series_entities SET title = :title, title_state = 'resolved' WHERE key = :key`,
      { title: `${complete} (ビスク`, key },
    );
    invalidateDiagnosticsReport();

    const before = getDiagnosticsReport({ refresh: true });
    const issue = issueById(before, 'titles.display-truncated')!;
    const adopt = issue.actions.find(
      (action) => action.kind === 'repair' && action.repairKind === 'adopt-title-candidate',
    );
    if (!adopt || adopt.kind !== 'repair') throw new Error('missing adopt action');

    const result = runDiagnosticsRepair({
      issueId: issue.id,
      kind: 'adopt-title-candidate',
      target: adopt.target!,
      value: adopt.value!,
    });
    expect(result.verification.verified).toBe(true);
    expect(result.verification.partial).toBe(false);
    const layers = result.verification.checks.map((check) => check.layer);
    expect(layers).toEqual(
      expect.arrayContaining(['source', 'projection', 'search', 'api', 'cache', 'detector']),
    );

    // 真实 source-of-truth：manual confirmed
    const after = getSeriesDetail(adopt.target!)!;
    expect(after.title).toBe(adopt.value);
    expect(after.titleState).toBe('manual');
    // 搜索立即按新标题命中
    expect(
      searchSeriesEntities(adopt.value!).items.some((item) => item.key === adopt.target),
    ).toBe(true);
    // detector 不再报告该问题
    expect(result.report.issues.some((entry) => entry.id === 'titles.display-truncated')).toBe(
      false,
    );
  });

  it('被否决的标题候选进入只读清单，并提供「重新进入评估」修复动作', () => {
    const key = seedSeries();
    const target = getSeriesDetail(key)!.titleCandidates.find(
      (candidate) => candidate.valid !== false,
    )!.title;
    rejectSeriesTitleCandidate(key, target, '测试：进入清单');
    invalidateDiagnosticsReport();

    const report = getDiagnosticsReport({ refresh: true });
    const issue = issueById(report, 'titles.rejected-candidates')!;
    expect(issue).toBeTruthy();
    expect(issue.severity).toBe('info');
    expect(issue.affected.some((entity) => entity.detail === target)).toBe(true);
    const reopen = issue.actions.find(
      (action) => action.kind === 'repair' && action.repairKind === 'reopen-title-candidate',
    );
    if (!reopen || reopen.kind !== 'repair') throw new Error('missing reopen action');
    expect(reopen.value).toBe(target);

    const result = runDiagnosticsRepair({
      issueId: issue.id,
      kind: 'reopen-title-candidate',
      target: reopen.target!,
      value: reopen.value!,
    });
    expect(result.verification.verified).toBe(true);
    expect(result.verification.partial).toBe(false);
    const layers = result.verification.checks.map((check) => check.layer);
    expect(layers).toEqual(
      expect.arrayContaining(['source', 'governance', 'projection', 'search', 'cache', 'detector']),
    );
    expect(result.verification.checks.some((check) => check.label.includes('不会静默变为人工确认'))).toBe(
      true,
    );
    // 重新进入评估后清单里不再有该候选
    expect(
      result.report.issues
        .find((entry) => entry.id === 'titles.rejected-candidates')
        ?.affected.some((entity) => entity.detail === target) ?? false,
    ).toBe(false);
  });

  it('缓存层写入边界：翻译与封面模块明确说明不推进数据版本', () => {
    seedSeries();
    const report = getDiagnosticsReport({ refresh: true });
    const translation = report.modules.find((module) => module.id === 'translation')!;
    const collections = report.modules.find((module) => module.id === 'collections')!;
    expect(translation.details.some((detail) => detail.includes('缓存层写入'))).toBe(true);
    expect(collections.details.some((detail) => detail.includes('缓存层操作'))).toBe(true);
  });
});

describe('数据中枢：HTTP 接口', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const client = new FakeBangumiClient({});
    const engine = new SyncEngine({ client, getConfig: () => testConfig() });
    app = await buildApp({
      deps: { client, engine, coverCache: new CoverCache(client) },
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetDatabase();
    hideNsfw(false);
    invalidateDiagnosticsReport();
  });

  it('GET /api/diagnostics 返回完整报告', async () => {
    seedSeries();
    const response = await app.inject({ method: 'GET', url: '/api/diagnostics?refresh=1' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.scope.series).toBe(1);
    expect(Array.isArray(body.modules)).toBe(true);
    expect(body.modules.length).toBeGreaterThanOrEqual(8);
  });

  it('POST /api/diagnostics/repairs 执行修复并返回验证结果', async () => {
    const key = seedSeries();
    run(`UPDATE series_entities SET member_count = 42 WHERE key = :key`, { key });
    invalidateDiagnosticsReport();

    const response = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/repairs',
      payload: { issueId: 'series.counter-drift', kind: 'recompute-derived', value: genericRecomputePlan().token },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.verification.verified).toBe(true);
    expect(body.report.issues.some((issue: { id: string }) => issue.id === 'series.counter-drift')).toBe(
      false,
    );
  });

  it.each([false, true])('标题采纳的检测复验按完整目标定位（目标仍有异常=%s）', async (targetStillHasIssue) => {
    const key = seedSeries();
    seedSubject(3, '合成对照系列');
    recomputeSeries();
    const peer = `${key}0`;
    const peerOriginal = getSubjectDetail(3)!.series!.key;
    expect(peerOriginal).not.toBe(key);
    run('UPDATE series_entities SET key = :peer WHERE key = :peerOriginal', { peer, peerOriginal });
    run('UPDATE subjects SET series_key = :peer WHERE id = 3', { peer });
    const complete = getSeriesDetail(key)!.titleCandidates.find((candidate) => candidate.valid)!.title;
    for (const seriesKey of [key, peer]) {
      run("UPDATE series_entities SET title = title || ' (' WHERE key = :seriesKey", { seriesKey });
    }
    if (targetStillHasIssue) {
      const candidates = getSeriesDetail(key)!.titleCandidates;
      run('UPDATE series_entities SET title_candidates = :candidates WHERE key = :key', {
        key, candidates: JSON.stringify([...candidates, {
          title: '合成剩余坏候选 (', valid: true, state: 'provisional', source: 'anchor', evidence: '合成测试',
        }]),
      });
    }
    const report = (await app.inject({ method: 'GET', url: '/api/diagnostics?refresh=1' })).json<DiagnosticsReport>();
    const issue = issueById(report, 'titles.display-truncated')!;
    expect(issue!.affected.map((item) => item.href)).toEqual([`/series/${key}?review=1`, `/series/${peer}?review=1`]);
    const adopt = issue.actions.find((action) => action.kind === 'repair' && action.target === key);
    if (adopt?.kind !== 'repair') throw new Error('missing exact target repair');
    expect(adopt.value).toBe(complete);
    const reply = await app.inject({
      method: 'POST', url: '/api/diagnostics/repairs',
      payload: { issueId: issue.id, kind: adopt.repairKind, target: adopt.target, value: adopt.value },
    });
    expect(reply.statusCode).toBe(200);
    const result = reply.json<DiagnosticsRepairResult>();
    expect(result.verification).toMatchObject({ verified: !targetStillHasIssue, partial: targetStillHasIssue });
    expect(result.verification.checks).toContainEqual(expect.objectContaining({ layer: 'detector', ok: !targetStillHasIssue }));
    expect(issueById(result.report, 'titles.display-truncated')?.affected.map((item) => item.href)).toEqual([`/series/${peer}?review=1`]);
    const detail = await app.inject({ method: 'GET', url: `/api/series/${key}` });
    expect(detail.json()).toMatchObject({ title: complete, titleState: 'manual' });
  });

  it('非法参数与不存在的问题：400 / 404，且不修改数据', async () => {
    seedSeries();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/repairs',
      payload: { issueId: '', kind: 'nope' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('invalid_repair_request');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/repairs',
      payload: { issueId: 'series.counter-drift', kind: 'recompute-derived' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('issue_not_found');
  });

  it('Title Review 修改标题后：诊断缓存立即失效，新状态马上可见', async () => {
    const key = seedSeries();
    run(`UPDATE series_entities SET title_state = 'provisional' WHERE key = :key`, { key });
    invalidateDiagnosticsReport();

    const before = await app.inject({ method: 'GET', url: '/api/diagnostics?refresh=1' });
    expect(
      before.json().issues.some((issue: { id: string }) => issue.id === 'titles.provisional'),
    ).toBe(true);

    // 通过既有治理入口人工确认标题
    const override = await app.inject({
      method: 'POST',
      url: `/api/series/${encodeURIComponent(key)}/title`,
      payload: { mode: 'confirm-current' },
    });
    expect(override.statusCode).toBe(200);

    // 不带 refresh 的读取也必须反映最新状态（缓存已随治理变更失效）
    const after = await app.inject({ method: 'GET', url: '/api/diagnostics' });
    expect(
      after.json().issues.some((issue: { id: string }) => issue.id === 'titles.provisional'),
    ).toBe(false);
  });

  it('标题候选：否决 → 重新进入评估 HTTP 往返（真实治理状态）', async () => {
    const key = seedSeries();
    const target = getSeriesDetail(key)!.titleCandidates.find(
      (candidate) => candidate.valid !== false,
    )!.title;

    const reject = await app.inject({
      method: 'POST',
      url: `/api/series/${encodeURIComponent(key)}/title/candidates/reject`,
      payload: { title: target },
    });
    expect(reject.statusCode).toBe(200);

    const reopen = await app.inject({
      method: 'POST',
      url: `/api/series/${encodeURIComponent(key)}/title/candidates/reopen`,
      payload: { title: target },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json().series.titleState).not.toBe('manual');
    const candidate = reopen
      .json()
      .series.titleCandidates.find((entry: { title: string }) => entry.title === target);
    expect(candidate.valid).toBe(true);
    expect(candidate.rejected ?? false).toBe(false);
  });

  it('GET /api/diagnostics/history 返回只读治理历史', async () => {
    const key = seedSeries();
    await app.inject({
      method: 'POST',
      url: `/api/series/${encodeURIComponent(key)}/title`,
      payload: { mode: 'confirm-current' },
    });

    const response = await app.inject({ method: 'GET', url: '/api/diagnostics/history?limit=10' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBeGreaterThan(0);
    expect(
      body.entries.some(
        (entry: { kind: string; actor: string }) =>
          entry.kind === 'title_manual' && entry.actor === 'user',
      ),
    ).toBe(true);
    // 只读：历史接口只有 GET，没有写入端点
    const write = await app.inject({
      method: 'POST',
      url: '/api/diagnostics/history',
      payload: { kind: 'rejected' },
    });
    expect(write.statusCode).toBe(404);
  });
});
