/**
 * 数据中枢修复执行（v1.6.0 建立，v1.6.1 增强）。
 *
 * 标准闭环：
 *   读取问题 → 匹配修复动作 → 执行（真实 source-of-truth / 治理状态修改）
 *   → recordMutation（数据版本 + 缓存失效）→ 重新运行检测
 *   → 按「真实受影响层」逐层验证（source / projection / search / api / detector）
 *   → 返回结果；任何一层未通过都不得标记为 verified。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DiagnosticsRepairCheck,
  DiagnosticsRepairRequest,
  DiagnosticsRepairResult,
  DiagnosticsReport,
  DiagnosticsVerification,
} from '@bangumi-analyzer/shared';
import { ApiError } from '@bangumi-analyzer/shared';
import { paths } from '../config.js';
import { all, dataVersion, getMeta, one, run, transaction } from '../db/index.js';
import { findDecision } from '../db/candidates.js';
import { franchiseAverageRateSql } from '../db/franchiseAverage.js';
import { recordMutation, type MutationResult } from '../db/mutation.js';
import { inspectSeriesCollectionStatus, recomputeSeriesCollectionStatus, STATUS_DRIFT } from '../db/seriesCollectionStatus.js';
import { getFranchiseDetail, getSeriesDetail, isFranchiseHidden, isSeriesHidden } from '../db/query.js';
import { titleCandidatesForMutation } from '../db/titleCandidates.js';
import { publicFranchiseTitle, publicSeriesTitle } from '../db/visibility.js';
import {
  applySeriesTitleOverride,
  captureEntityEventWrites,
  type EntityEventWrite,
  confirmFranchise,
  planEntityLifecycle,
  recomputeSeries,
  rejectFranchiseCandidate,
  rejectSeriesTitleCandidate,
  reopenSeriesTitleCandidate,
  resolveEntityKey,
} from '../db/series.js';
import { searchFranchiseEntities, searchSeriesEntities } from '../db/ipSearch.js';
import { parseJsonColumn } from '../util.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from './report.js';
import { captureProtectedSources, enforceProtectedSources, protectedSourcesCheck } from './sourceProtection.js';
import { assertGenericRecomputePlan, genericProtectedState, genericEventsPreserved } from './genericPlan.js';
import { LINK_DRIFT, inspectFranchiseLinkCounts, recomputeFranchiseLinkCounts } from '../db/franchiseLinkCounts.js';
import { countSeriesKeyDrift } from './seriesKeyDrift.js';

type CheckLayer = DiagnosticsRepairCheck['layer'];

function check(layer: CheckLayer, label: string, ok: boolean, detail: string): DiagnosticsRepairCheck {
  return { layer, label, ok, detail };
}

/**
 * 由逐层检查结果生成验证结论。
 *
 * 数据中枢修复（runDiagnosticsRepair）与 Franchise 治理动作
 * （franchiseGovernance）共用同一套判定：任何一层未通过都不得标记为 verified。
 */
export function verificationFromChecks(
  checks: DiagnosticsRepairCheck[],
  before: DiagnosticsReport,
  after: DiagnosticsReport,
): DiagnosticsVerification {
  const afterIds = new Set(after.issues.map((entry) => entry.id));
  const verified = checks.every((entry) => entry.ok);
  const failedLayers = [...new Set(checks.filter((entry) => !entry.ok).map((entry) => entry.layer))];
  return {
    verified,
    partial: !verified,
    summary: verified
      ? '修复完成，并已通过重新检测与各受影响层（source / projection / search / API）验证。'
      : `修复部分成功：${failedLayers.join(' / ')} 层未通过验证。若持续出现，请报告为需要开发排查的问题。`,
    resolvedIssueIds: before.issues
      .filter((entry) => !afterIds.has(entry.id))
      .map((entry) => entry.id),
    remainingIssueIds: after.issues.map((entry) => entry.id),
    checks,
  };
}

function seriesCounterDriftKeys(): string[] {
  return all<{ key: string }>(
      `SELECT e.key FROM series_entities e WHERE e.state <> 'stale' AND (
         e.member_count <> (SELECT COUNT(*) FROM series_entity_members m WHERE m.series_id = e.id AND m.role = 'primary')
         OR e.candidate_count <> (SELECT COUNT(*) FROM series_entity_members m WHERE m.series_id = e.id AND m.role = 'candidate')
         OR e.confirmed_count <> (SELECT COUNT(*) FROM series_entity_members m WHERE m.series_id = e.id AND m.role = 'primary' AND m.state = 'confirmed')
         OR e.collected_count <> (SELECT COUNT(*) FROM series_entity_members m JOIN collections c ON c.subject_id = m.subject_id WHERE m.series_id = e.id AND m.role = 'primary')
       )`,
    ).map((row) => row.key);
}
function seriesCounterDriftCount(): number {
  return seriesCounterDriftKeys().length;
}

function franchiseCounterDriftKeys(): string[] {
  return all<{ key: string }>(
      `SELECT f.key FROM franchise_entities f WHERE f.state <> 'stale' AND (
         f.series_count <> (SELECT COUNT(*) FROM franchise_series fs WHERE fs.franchise_id = f.id)
         OR f.known_count <> (SELECT COUNT(DISTINCT m.subject_id)
              FROM franchise_series fs JOIN series_entity_members m ON m.series_id = fs.series_id
             WHERE fs.franchise_id = f.id AND m.role = 'primary')
         OR f.collected_count <> (SELECT COUNT(DISTINCT m.subject_id)
              FROM franchise_series fs
              JOIN series_entity_members m ON m.series_id = fs.series_id
              JOIN collections c ON c.subject_id = m.subject_id
             WHERE fs.franchise_id = f.id AND m.role = 'primary')
         OR f.average_rate IS NOT ${franchiseAverageRateSql('f', 'real')}
       )`,
    ).map((row) => row.key);
}
function franchiseCounterDriftCount(): number {
  return franchiseCounterDriftKeys().length;
}

/** v1.8.3（B2）：悬空 alias 数 —— alias 必须始终指向 live 实体。 */
function danglingAliasCount(): number {
  return Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entity_aliases a
        WHERE (a.entity_kind = 'series' AND NOT EXISTS (
                 SELECT 1 FROM series_entities e WHERE e.id = a.entity_id AND e.state <> 'stale'))
           OR (a.entity_kind = 'franchise' AND NOT EXISTS (
                 SELECT 1 FROM franchise_entities f WHERE f.id = a.entity_id AND f.state <> 'stale'))`,
    )?.n ?? 0,
  );
}

/** Search 层验证：实体必须能被自己的展示标题搜到（与产品搜索同一套逻辑）。 */
function searchCheckForSeries(key: string, hidden = false): DiagnosticsRepairCheck {
  const row = one<{ title: string }>('SELECT title FROM series_entities WHERE key = :key', { key });
  if (!row) return check('search', 'Search projection', false, `Series ${key} 不存在`);
  const hit = searchSeriesEntities(row.title, { limit: 100 }).items.some((item) => item.key === key);
  return check(
    'search',
    'Search projection',
    hidden ? !hit : hit,
    hidden ? (hit ? '隐私隐藏的系列仍被搜索返回' : '隐私隐藏的系列未被搜索暴露')
      : hit ? `搜索「${row.title}」可以命中 ${key}` : `搜索「${row.title}」没有命中 ${key}`,
  );
}

function searchCheckForFranchise(key: string, hidden = false): DiagnosticsRepairCheck {
  const row = one<{ title: string }>('SELECT title FROM franchise_entities WHERE key = :key', {
    key,
  });
  if (!row) return check('search', 'Search projection', false, `Franchise ${key} 不存在`);
  const hit = searchFranchiseEntities(row.title, { limit: 100 }).items.some((item) => item.key === key);
  return check(
    'search',
    'Search projection',
    hidden ? !hit : hit,
    hidden ? (hit ? '隐私隐藏的家族仍被搜索返回' : '隐私隐藏的家族未被搜索暴露')
      : hit ? `搜索「${row.title}」可以命中 ${key}` : `搜索「${row.title}」没有命中 ${key}`,
  );
}

function recomputeTargets(
  before: ReturnType<typeof getDiagnosticsReport>,
  issueId: string,
): Array<{ kind: 'series' | 'franchise'; key: string }> {
  if (issueId === 'series.counter-drift') return seriesCounterDriftKeys().map((key) => ({ kind: 'series', key }));
  if (issueId === 'franchise.counter-drift') return franchiseCounterDriftKeys().map((key) => ({ kind: 'franchise', key }));
  const issue = before.issues.find((entry) => entry.id === issueId);
  const targets = new Map<string, { kind: 'series' | 'franchise'; key: string }>();
  for (const entry of issue?.affected ?? []) {
    const match = entry.href?.match(/^\/(series|franchises)\/([^/?#]+)/);
    if (match) {
      const kind = match[1] === 'series' ? 'series' : 'franchise';
      const key = decodeURIComponent(match[2]!);
      targets.set(`${kind}:${key}`, { kind, key });
    }
  }
  return [...targets.values()];
}

/* ------------------------------------------------------------ 修复执行 */

/** Only membership governance is frozen here; inferred states and link evidence may evolve. */
function franchiseGovernanceSnapshot(id: number) {
  const entity = one<{ id: number; key: string; state: string }>('SELECT id,key,state FROM franchise_entities WHERE id=:id', { id });
  return {
    entity,
    rejection: entity ? findDecision('franchise', id, 'franchise', entity.key) : undefined,
    links: all<{ series_id: number; state: string }>(
      'SELECT series_id,state FROM franchise_series WHERE franchise_id=:id ORDER BY series_id', { id }),
    decisions: all(`SELECT * FROM candidate_decisions WHERE entity_kind='franchise'
      AND entity_id=:id AND candidate_kind='franchise' ORDER BY id`, { id }),
    exclusions: all('SELECT * FROM franchise_member_exclusions WHERE franchise_id=:id ORDER BY id', { id }),
    events: all<{ id: number; kind: string; payload: string }>(
      "SELECT * FROM entity_events WHERE entity_kind='franchise' AND entity_id=:id ORDER BY id", { id }),
  };
}

function franchiseGovernancePreserved(
  before: ReturnType<typeof franchiseGovernanceSnapshot>,
  after: ReturnType<typeof franchiseGovernanceSnapshot>,
): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!before.entity || !after.entity || !same(before.decisions, after.decisions) ||
    !same(before.exclusions, after.exclusions) ||
    !before.events.every((event) => after.events.some((row) => row.id === event.id && same(event, row)))) return false;
  if (before.entity.state === 'rejected' && before.rejection?.decision !== 'rejected') return false;

  const priorIds = new Set(before.links.map((link) => link.series_id));
  const added = after.links.filter((link) => !priorIds.has(link.series_id)).map((link) => link.series_id);
  const watermark = before.events.at(-1)?.id ?? 0;
  const newEvent = (kind: string, matches: (payload: Record<string, unknown>) => boolean) =>
    after.events.some((event) => {
      if (event.id <= watermark || event.kind !== kind) return false;
      const payload = parseJsonColumn<Record<string, unknown> | null>(event.payload, null);
      return Boolean(payload && !Array.isArray(payload) && matches(payload));
    });
  const automatic = ['candidate', 'provisional', 'contested'];
  const stateOk = before.entity.state === 'confirmed' ? after.entity.state === 'confirmed'
    : before.entity.state === 'rejected' ? after.entity.state === 'rejected' || (
      automatic.includes(after.entity.state) && added.length > 0 &&
      newEvent('candidate_reopened', (payload) => {
        const ids = payload.added;
        return Array.isArray(ids) && ids.length === added.length && added.every((id) => ids.includes(id));
      }))
    : automatic.includes(after.entity.state);

  // Confirmed members may become conflicts when graph evidence disappears, never silently disappear
  // or become candidates. New inferred members cannot acquire human confirmation during recompute.
  const linksOk = before.links.filter((link) => ['confirmed', 'conflict'].includes(link.state)).every((link) => {
    const next = after.links.find((row) => row.series_id === link.series_id);
    if (link.state === 'conflict') return Boolean(next && ['conflict', ...automatic].includes(next.state));
    return next?.state === link.state || (link.state === 'confirmed' && next?.state === 'conflict' &&
      newEvent('conflict', (payload) => payload.seriesId === link.series_id));
  }) && after.links.filter((link) => link.state === 'confirmed').every((link) =>
    before.links.some((prior) => prior.series_id === link.series_id && prior.state === 'confirmed'));
  return stateOk && linksOk;
}

function executeRecomputeDerived(
  before: ReturnType<typeof getDiagnosticsReport>,
  issueId: string,
): { checks: DiagnosticsRepairCheck[]; mutation: MutationResult } {
  /*
   * v1.8.3：Preview 与 Execute 共用同一份身份生命周期计划。
   * 先固化 Preview 承诺的范围，执行后逐项核对；Execute 不得超出承诺。
   */
  const plan = planEntityLifecycle();
  const targets = recomputeTargets(before, issueId).map((target) => {
    const resolved = resolveEntityKey(target.kind, target.key);
    return {
      ...target,
      governance: target.kind === 'franchise' && resolved
        ? { id: resolved.id, snapshot: franchiseGovernanceSnapshot(resolved.id) } : null,
      before: resolved ? one<{ title: string; title_state: string; title_source: string; title_candidates: string }>(
        `SELECT title,title_state,title_source,title_candidates FROM ${target.kind === 'series' ? 'series_entities' : 'franchise_entities'} WHERE id=:id`,
        { id: resolved.id },
      ) : undefined,
    };
  });
  const result = recomputeSeries();
  const mutation = recordMutation('repair', 'recompute-derived');
  const keyDrift = countSeriesKeyDrift();
  const checks: DiagnosticsRepairCheck[] = [
    check(
      'projection',
      'Series / Franchise 重建结果',
      true,
      `${result.series} 个 Series · ${result.franchises} 个 Franchise · ${result.members} 个正式成员` +
        `（身份恢复 ${result.revived} · 回收重建副本 ${result.rebuiltAbsorbed} · alias 重定向 ${result.aliasesRedirected} · alias 退役 ${result.aliasesRetired}）`,
    ),
    check(
      'projection',
      'alias 生命周期不变量',
      danglingAliasCount() === 0,
      `悬空 alias：${danglingAliasCount()} 条（必须为 0）`,
    ),
    check('source', '归属缓存一致性', keyDrift === 0, `不一致：${keyDrift} 条`),
    check(
      'projection',
      'Series 计数一致性',
      seriesCounterDriftCount() === 0,
      `不一致：${seriesCounterDriftCount()} 个`,
    ),
    check(
      'projection',
      'Franchise 派生字段一致性',
      franchiseCounterDriftCount() === 0,
      `不一致：${franchiseCounterDriftCount()} 个`,
    ),
    check(
      'cache',
      '数据版本 / 缓存失效',
      mutation.dataVersion > 0,
      `dataVersion → ${mutation.dataVersion}（stats / diagnostics 已失效）`,
    ),
  ];

  // 计划 vs 实际：验证 Execute 只执行了 Preview 承诺的范围。
  checks.push(
    check(
      'projection',
      '执行范围与预览一致',
      result.revived === plan.revivals.length &&
        result.rebuiltAbsorbed === plan.rebuiltDuplicates.length &&
        result.aliasesRedirected === plan.aliasRedirects.length &&
        result.aliasesRetired === plan.aliasRetirements.length,
      `预览：恢复 ${plan.revivals.length} / 回收 ${plan.rebuiltDuplicates.length} / 重定向 ${plan.aliasRedirects.length} / 退役 ${plan.aliasRetirements.length}；` +
        `实际：恢复 ${result.revived} / 回收 ${result.rebuiltAbsorbed} / 重定向 ${result.aliasesRedirected} / 退役 ${result.aliasesRetired}`,
    ),
  );

  // 恢复的历史身份：key 不变、回到 live、manual 标题与裁决未丢失。
  if (plan.revivals.length > 0) {
    const details: string[] = [];
    const revivalOk = plan.revivals.every((item) => {
      const row = one<{ key: string; state: string; title: string; title_state: string }>(
        'SELECT key, state, title, title_state FROM series_entities WHERE id = :id',
        { id: item.id },
      );
      const ok = Boolean(row) &&
        row!.state !== 'stale' &&
        row!.key === item.key &&
        (item.titleState !== 'manual' || (row!.title_state === 'manual' && row!.title === item.title));
      details.push(
        `${item.key}（${row?.state ?? 'missing'}${item.titleState === 'manual' ? '，manual 标题保留' : ''}）`,
      );
      return ok;
    });
    checks.push(check('projection', '历史身份恢复', revivalOk, details.join('、')));
  }

  // 重定向后的 alias：必须能解析到 live 实体。
  if (plan.aliasRedirects.length > 0) {
    const unresolved = plan.aliasRedirects.filter(
      (item) => !resolveEntityKey(item.entityKind, item.aliasKey),
    );
    checks.push(
      check(
        'projection',
        'alias 重定向解析',
        unresolved.length === 0,
        unresolved.length === 0
          ? `${plan.aliasRedirects.length} 条重定向全部解析到 live 实体`
          : `未解析：${unresolved.map((item) => item.aliasKey).join('、')}`,
      ),
    );
  }

  // 退役 alias：行已移除，且 alias_retired 事件留痕。
  if (plan.aliasRetirements.length > 0) {
    const stillPresent = plan.aliasRetirements.filter(
      (item) =>
        Number(
          one<{ n: number }>(
            'SELECT COUNT(*) AS n FROM entity_aliases WHERE alias_key = :key AND entity_kind = :kind',
            { key: item.aliasKey, kind: item.entityKind },
          )?.n ?? 0,
        ) > 0,
    );
    const missingEvents = plan.aliasRetirements.filter(
      (item) =>
        Number(
          one<{ n: number }>(
            `SELECT COUNT(*) AS n FROM entity_events
              WHERE kind = 'alias_retired' AND payload LIKE :pattern`,
            { pattern: `%"aliasKey":"${item.aliasKey}"%` },
          )?.n ?? 0,
        ) === 0,
    );
    checks.push(
      check(
        'projection',
        'alias 退役留痕',
        stillPresent.length === 0 && missingEvents.length === 0,
        `退役 ${plan.aliasRetirements.length} 条（残留 ${stillPresent.length} · 缺事件 ${missingEvents.length}）`,
      ),
    );
  }

  // Real source verification and current privacy projection are separate layers.
  // Use actual pre-repair targets; never substitute an unrelated largest Series.
  for (const target of targets) {
    const resolved = resolveEntityKey(target.kind, target.key);
    const publicTitle = target.kind === 'series' ? publicSeriesTitle('e') : publicFranchiseTitle('e');
    const row = resolved ? one<{ title: string; public_title: string; title_state: string; title_source: string; title_candidates: string }>(
      `SELECT e.title,${publicTitle} AS public_title,e.title_state,e.title_source,e.title_candidates
       FROM ${target.kind === 'series' ? 'series_entities' : 'franchise_entities'} e WHERE e.id=:id AND e.state<>'stale'`,
      { id: resolved.id },
    ) : undefined;
    const candidates = row ? titleCandidatesForMutation(row.title_candidates) : null;
    const manual = target.before?.title_state === 'manual';
    const priorCandidates = target.before ? titleCandidatesForMutation(target.before.title_candidates) : null;
    const sourceOk = Boolean(row) && (!manual || (
      target.before!.title_source === 'manual' && priorCandidates !== null && priorCandidates.some((candidate) =>
        candidate.title === target.before!.title && candidate.source === 'manual' && candidate.state === 'manual' && candidate.valid !== false) &&
      row!.title === target.before!.title && row!.title_state === 'manual' && row!.title_source === 'manual' &&
      candidates !== null && candidates.some((candidate) => candidate.title === row!.title &&
        candidate.source === 'manual' && candidate.state === 'manual' && candidate.valid !== false)
    ));
    checks.push(check('source', target.kind === 'series' ? 'Series 名称来源' : 'Franchise 名称来源', sourceOk,
      sourceOk ? '真实实体及必要人工名称来源保持一致' : '真实实体或必要人工名称来源不一致'));
    if (target.kind === 'franchise') {
      const governanceOk = Boolean(target.governance && resolved && resolved.id === target.governance.id &&
        franchiseGovernancePreserved(target.governance.snapshot, franchiseGovernanceSnapshot(resolved.id)));
      checks.push(check('governance', 'Franchise 成员治理事实', governanceOk,
        governanceOk ? '人工成员状态、决定及排除来源保留；推断演变符合治理契约'
          : '人工成员状态、决定、排除来源或状态演变与治理契约不一致'));
    }
    const hidden = target.kind === 'series' ? isSeriesHidden(target.key) : isFranchiseHidden(target.key);
    const canonicalKey = resolved?.key ?? target.key;
    checks.push(target.kind === 'series' ? searchCheckForSeries(canonicalKey, hidden) : searchCheckForFranchise(canonicalKey, hidden));
    const detail = target.kind === 'series' ? getSeriesDetail(target.key) : getFranchiseDetail(target.key);
    const apiOk = hidden ? detail === null : Boolean(detail && resolved &&
      detail.key === resolved.key && detail.canonicalKey === resolved.key && detail.title === row?.public_title);
    checks.push(
      check(
        'api',
        target.kind === 'series' ? 'Series API' : 'Franchise API',
        apiOk,
        hidden ? (apiOk ? '当前隐私设置下隐藏，详情未暴露' : '当前隐私设置下应隐藏，但详情仍返回目标')
          : apiOk ? '可见目标详情与真实数据一致' : '可见目标详情缺失或与真实数据不一致',
      ),
    );
  }
  return { checks, mutation };
}

/** The resolver writes globally even when the diagnostic issue has only Series targets. */
function globalFranchiseGovernancePreserved(before: ReturnType<typeof franchiseGovernanceSnapshot>[]): boolean {
  const prior = new Map(before.filter(b => b.entity).map(b => [b.entity!.key, b]));
  const current = all<{id:number;key:string;state:string}>("SELECT id,key,state FROM franchise_entities WHERE state<>'stale'");
  const locked = before.filter(b => b.entity && ['confirmed','rejected'].includes(b.entity.state));
  if (!locked.every(b => {
    const entity = current.find(row => row.key === b.entity!.key);
    return entity && entity.id === b.entity!.id && franchiseGovernancePreserved(b, franchiseGovernanceSnapshot(entity.id));
  })) return false;
  // Automatic recompute cannot create human confirmation/rejection, even off-target.
  return current.every(row => {
    const b = prior.get(row.key);
    if (['confirmed','rejected'].includes(row.state) && b?.entity?.state !== row.state) return false;
    const links = all<{series_id:number}>("SELECT series_id FROM franchise_series WHERE franchise_id=:id AND state='confirmed'", {id:row.id});
    return links.every(link => b?.links.some(old => old.series_id === link.series_id && old.state === 'confirmed'));
  });
}

function executeConfirmFranchise(target: string): DiagnosticsRepairCheck[] {
  const versionBefore = dataVersion();
  const confirmed = confirmFranchise(target);
  if (!confirmed) {
    throw new ApiError('要确认的家族不存在，可能已经被重建', {
      code: 'franchise_not_found',
      status: 404,
      dataIntact: true,
      hint: '重新运行检测后查看最新状态。',
    });
  }
  const versionAfter = dataVersion();
  const detail = getFranchiseDetail(target);
  return [
    check('source', '家族治理状态', detail?.state === 'confirmed', `state=${detail?.state ?? 'missing'}`),
    check(
      'api',
      'Franchise API',
      Boolean(detail),
      `GET /api/franchises/${target} → ${detail?.title ?? '无结果'}`,
    ),
    searchCheckForFranchise(target),
    check(
      'cache',
      '数据版本 / 缓存失效',
      versionAfter > versionBefore,
      `dataVersion ${versionBefore} → ${versionAfter}（stats / diagnostics 已失效）`,
    ),
  ];
}

function executeRejectFranchise(target: string): DiagnosticsRepairCheck[] {
  const versionBefore = dataVersion();
  const result = rejectFranchiseCandidate(target, '数据中枢：用户否决该家族候选');
  if (!result.ok || !result.key) {
    throw new ApiError(result.message ?? '无法否决该家族候选', {
      code: result.code ?? 'reject_failed',
      status: result.code === 'not_found' ? 404 : 400,
      dataIntact: true,
    });
  }
  const versionAfter = dataVersion();
  const detail = getFranchiseDetail(result.key);
  const decision = one<{ id: number; evidence: string; reason: string }>(
    `SELECT d.id, d.evidence, d.reason FROM candidate_decisions d
      JOIN franchise_entities f ON f.id = d.entity_id
     WHERE d.entity_kind = 'franchise' AND d.candidate_kind = 'franchise'
       AND d.decision = 'rejected' AND f.key = :key`,
    { key: result.key },
  );
  return [
    check('source', '家族治理状态', detail?.state === 'rejected', `state=${detail?.state ?? 'missing'}`),
    check(
      'governance',
      '否决决定与证据保留',
      Boolean(decision),
      decision ? `candidate_decisions #${decision.id}（证据快照已保留）` : '未找到否决记录',
    ),
    check(
      'api',
      'Franchise API',
      Boolean(detail),
      `GET /api/franchises/${result.key} → ${detail?.title ?? '无结果'}`,
    ),
    searchCheckForFranchise(result.key),
    check(
      'cache',
      '数据版本 / 缓存失效',
      versionAfter > versionBefore,
      `dataVersion ${versionBefore} → ${versionAfter}（治理决定已写入）`,
    ),
  ];
}

function executeAdoptTitle(target: string, value: string): DiagnosticsRepairCheck[] {
  const versionBefore = dataVersion();
  const result = applySeriesTitleOverride(target, { mode: 'candidate', title: value });
  if (!result.ok) {
    throw new ApiError(result.message, {
      code: result.code,
      status: result.code === 'not_found' ? 404 : 400,
      dataIntact: true,
    });
  }
  const versionAfter = dataVersion();
  const detail = getSeriesDetail(result.key);
  const candidates = detail?.titleCandidates ?? [];
  const adopted = candidates.some((candidate) =>
    candidate.title === value && candidate.source === 'manual' &&
    candidate.state === 'manual' && candidate.valid === true && candidate.rejected !== true,
  );
  return [
    check(
      'source',
      'Series canonical title',
      detail?.title === value && detail?.titleState === 'manual',
      `title=${detail?.title ?? 'missing'} / state=${detail?.titleState ?? 'missing'}`,
    ),
    check(
      'projection',
      '候选列表 provenance',
      adopted,
      adopted ? `候选「${value}」有有效的人工确认来源` : `候选列表未找到「${value}」的有效人工确认来源`,
    ),
    searchCheckForSeries(result.key),
    check('api', 'Series API', Boolean(detail), `GET /api/series/${result.key} → ${detail?.title ?? '无结果'}`),
    check(
      'cache',
      '数据版本 / 缓存失效',
      versionAfter > versionBefore,
      `dataVersion ${versionBefore} → ${versionAfter}（人工确认已写入）`,
    ),
  ];
}

function executeRejectTitle(target: string, value: string): DiagnosticsRepairCheck[] {
  const versionBefore = dataVersion();
  const result = rejectSeriesTitleCandidate(target, value, '数据中枢：用户否决该标题候选');
  if (!result.ok || !result.key) {
    throw new ApiError(result.message ?? '无法否决该标题候选', {
      code: result.code ?? 'reject_failed',
      status: result.code === 'not_found' ? 404 : 400,
      dataIntact: true,
    });
  }
  const versionAfter = dataVersion();
  const row = one<{ id: number; title: string; title_candidates: string }>(
    'SELECT id, title, title_candidates FROM series_entities WHERE key = :key',
    { key: result.key },
  );
  const candidates = parseJsonColumn<Array<{ title?: unknown; valid?: unknown; rejected?: unknown }>>(
    row?.title_candidates ?? '[]',
    [],
  );
  const rejected = candidates.find((candidate) => String(candidate.title ?? '') === value);
  const decision = row ? findDecision('series', row.id, 'title', value) : undefined;
  return [
    check(
      'source',
      '候选否决状态',
      Boolean(rejected && rejected.valid === false && rejected.rejected === true),
      rejected ? `候选「${value}」已标记 rejected / valid=false` : '未找到该候选',
    ),
    check(
      'governance',
      '否决决定与证据保留',
      Boolean(decision && decision.decision === 'rejected'),
      decision
        ? `candidate_decisions #${decision.id}（reason=${decision.reason || '未填写'}）`
        : '未找到否决记录',
    ),
    check(
      'projection',
      '否决后的展示标题',
      Boolean(row) && row!.title !== value,
      row ? `当前展示标题：${row.title}` : 'Series 不存在',
    ),
    check(
      'search',
      '被否决候选不再作为搜索别名',
      Boolean(rejected && rejected.valid === false),
      `valid=${String(rejected?.valid)}（搜索别名要求 valid === true）`,
    ),
    searchCheckForSeries(result.key),
    check(
      'cache',
      '数据版本 / 缓存失效',
      versionAfter > versionBefore,
      `dataVersion ${versionBefore} → ${versionAfter}（否决决定已写入）`,
    ),
  ];
}

function executeReopenTitle(target: string, value: string): DiagnosticsRepairCheck[] {
  const versionBefore = dataVersion();
  const result = reopenSeriesTitleCandidate(target, value, '数据中枢：用户重新进入评估');
  if (!result.ok || !result.key) {
    throw new ApiError(result.message ?? '无法重新进入评估', {
      code: result.code ?? 'reopen_failed',
      status: result.code === 'not_found' ? 404 : 400,
      dataIntact: true,
    });
  }
  const versionAfter = dataVersion();
  const row = one<{ id: number; title: string; title_state: string; title_candidates: string }>(
    'SELECT id, title, title_state, title_candidates FROM series_entities WHERE key = :key',
    { key: result.key },
  );
  const candidates = parseJsonColumn<Array<{ title?: unknown; valid?: unknown; rejected?: unknown }>>(
    row?.title_candidates ?? '[]',
    [],
  );
  const candidate = candidates.find((entry) => String(entry.title ?? '') === value);
  const decision = row ? findDecision('series', row.id, 'title', value) : undefined;
  return [
    check(
      'source',
      '候选重新进入竞争',
      Boolean(candidate && candidate.valid === true && candidate.rejected !== true),
      candidate
        ? `候选「${value}」valid=${String(candidate.valid)} / rejected=${String(candidate.rejected ?? false)}`
        : '未找到该候选',
    ),
    check(
      'governance',
      '旧否决保留并标记失效',
      Boolean(decision && decision.decision === 'superseded'),
      decision
        ? `candidate_decisions #${decision.id} → superseded（原否决原因保留：${decision.reason || '未填写'}）`
        : '未找到否决记录',
    ),
    check(
      'projection',
      '展示标题按当前证据重新解析',
      Boolean(row),
      row ? `当前展示标题：${row.title}（state=${row.title_state}）` : 'Series 不存在',
    ),
    check(
      'source',
      '不会静默变为人工确认',
      Boolean(row) && row!.title_state !== 'manual',
      row ? `title_state=${row.title_state}（人工确认只能经由 Title Review）` : 'Series 不存在',
    ),
    check(
      'search',
      '候选重新作为搜索别名',
      searchSeriesEntities(value, { limit: 100 }).items.some((item) => item.key === result.key),
      `搜索「${value}」命中 ${result.key}`,
    ),
    searchCheckForSeries(result.key),
    check(
      'cache',
      '数据版本 / 缓存失效',
      versionAfter > versionBefore,
      `dataVersion ${versionBefore} → ${versionAfter}（治理决定已写入）`,
    ),
  ];
}

function executeClearCoverCache(): DiagnosticsRepairCheck[] {
  const versionBefore = dataVersion();
  const rows = all<{ id: number; cover_path: string | null }>(
    `SELECT id, cover_path FROM subjects
      WHERE cover_cached_at IS NOT NULL AND cover_path IS NOT NULL`,
  );
  const missing = rows.filter(
    (row) => row.cover_path && !existsSync(join(paths.coverDir, row.cover_path)),
  );
  transaction(() => {
    for (const row of missing) {
      run(`UPDATE subjects SET cover_path = NULL, cover_cached_at = NULL WHERE id = :id`, {
        id: row.id,
      });
    }
  });
  // Constitution §10.3：封面标记属于缓存层，重新检测读取实际 DB，核心版本保持不变。
  return [
    check('source', '清除的缓存标记', true, `${missing.length} 个条目（文件缺失）`),
    check('ui', '本地封面文件', true, 'data/covers 中存在的文件不会被删除'),
    check('cache', '缓存层写入边界', dataVersion() === versionBefore, `dataVersion ${versionBefore} → ${dataVersion()}（封面缓存标记，不改变核心语义）`),
  ];
}

/* --------------------------------------------------------------- 入口 */

export function runDiagnosticsRepair(request: DiagnosticsRepairRequest): DiagnosticsRepairResult {
  try {
    // 普通 false 检查仍返回 partial；抛出的执行/Verify/Detector 故障回滚所有写入。
    return transaction(() => executeDiagnosticsRepair(request));
  } catch (error) {
    invalidateDiagnosticsReport();
    if (error instanceof ApiError) throw error;
    throw new ApiError(`修复执行失败：${(error as Error).message}`, {
      code: 'repair_failed', status: 500, dataIntact: true,
      hint: '本次修复写入已回滚；可以重新运行检测后重试。',
    });
  }
}

function executeDiagnosticsRepair(request: DiagnosticsRepairRequest): DiagnosticsRepairResult {
  const sourcesBefore = captureProtectedSources();
  const generic = request.kind === 'recompute-derived' && ![STATUS_DRIFT, LINK_DRIFT].includes(request.issueId);
  const before = getDiagnosticsReport({ refresh: true });
  const issue = before.issues.find((entry) => entry.id === request.issueId);
  if (!issue) {
    throw new ApiError('该问题已不存在（可能已被修复或被重新检测合并）', {
      code: 'issue_not_found',
      status: 404,
      dataIntact: true,
      hint: '重新运行检测即可看到当前状态。',
    });
  }
  if (generic && issue.actions.some(a => a.kind === 'repair' && a.repairKind === 'recompute-derived')) {
    assertGenericRecomputePlan(request.value);
  }
  const action = issue.actions.find(
    (entry) =>
      entry.kind === 'repair' &&
      entry.repairKind === request.kind &&
      (entry.target ?? null) === (request.target ?? null) &&
      (entry.value ?? null) === (request.value ?? null),
  );
  if (!action || action.kind !== 'repair') {
    throw new ApiError('该问题不支持这个修复动作', {
      code: 'repair_not_allowed',
      status: 400,
      dataIntact: true,
    });
  }

  let checks: DiagnosticsRepairCheck[];
  const historyThrough = generic ? String(one<{n:number}>('SELECT COALESCE(MAX(id),0) AS n FROM entity_events')!.n) : undefined;
  const genericProtected = generic ? genericProtectedState(historyThrough) : null;
  const genericVersion = generic ? dataVersion() : null;
  let genericMutation: MutationResult | undefined;
  const governanceBefore = generic ? all<{id:number}>("SELECT id FROM franchise_entities WHERE state<>'stale' ORDER BY id")
    .map(row => franchiseGovernanceSnapshot(row.id)) : [];
  let eventWrites: EntityEventWrite[] = [];
  const assertWriteBoundary = () => {
    // Exempt column names are not authorization: require the exact one-step mutation intent,
    // independently of the database's potentially trigger-modified final metadata.
    const mutationMatches = genericVersion !== null && Number.isSafeInteger(genericVersion + 1) && genericVersion >= 0 &&
      genericMutation?.dataVersion === genericVersion + 1 &&
      getMeta('data_version') === String(genericVersion + 1) &&
      getMeta('last_mutation_scope') === 'repair' && getMeta('last_mutation_at') === genericMutation.at &&
      getMeta('last_mutation_detail') === 'recompute-derived';
    if (genericProtected !== null && (!mutationMatches || genericProtectedState(historyThrough) !== genericProtected ||
      !globalFranchiseGovernancePreserved(governanceBefore) || !genericEventsPreserved(eventWrites, historyThrough!))) {
      throw new ApiError('通用重算越过预览允许写集，本次事务已回滚；请重新检测并报告此问题', {
        code:'generic_recompute_write_violation',status:409,dataIntact:true,
        hint:'人工治理、来源及历史必须保持；未经授权的直接或间接写入不会提交。',
      });
    }
  };
  try {
    switch (request.kind) {
      case 'recompute-derived':
        checks = issue.id === LINK_DRIFT
          ? recomputeFranchiseLinkCounts(request.target ?? '', request.value ?? '')
          : issue.id === STATUS_DRIFT
          ? recomputeSeriesCollectionStatus(request.target ?? '', request.value ?? '')
            : (() => {
              const captured = captureEntityEventWrites(() => executeRecomputeDerived(before, issue.id));
              eventWrites = captured.events;
              genericMutation = captured.result.mutation;
              return captured.result.checks;
            })();
        break;
      case 'confirm-franchise':
        checks = executeConfirmFranchise(request.target ?? action.target ?? '');
        break;
      case 'reject-franchise-candidate':
        checks = executeRejectFranchise(request.target ?? action.target ?? '');
        break;
      case 'adopt-title-candidate':
        checks = executeAdoptTitle(
          request.target ?? action.target ?? '',
          request.value ?? action.value ?? '',
        );
        break;
      case 'reject-title-candidate':
        checks = executeRejectTitle(
          request.target ?? action.target ?? '',
          request.value ?? action.value ?? '',
        );
        break;
      case 'reopen-title-candidate':
        checks = executeReopenTitle(
          request.target ?? action.target ?? '',
          request.value ?? action.value ?? '',
        );
        break;
      case 'clear-cover-cache':
        checks = executeClearCoverCache();
        break;
      default: {
        const exhaustive: never = request.kind;
        throw new ApiError(`未知的修复类型：${String(exhaustive)}`, {
          code: 'unknown_repair',
          status: 400,
          dataIntact: true,
        });
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(`修复执行失败：${(error as Error).message}`, {
      code: 'repair_failed',
      status: 500,
      dataIntact: true,
      hint: '本地数据没有被删除；可以重新运行检测确认当前状态。',
    });
  }

  // Safety violations are not ordinary partial success: the outer transaction must roll back.
  assertWriteBoundary();
  // 重新检测：修复是否真的让问题消失，由真实数据决定
  const after = getDiagnosticsReport({ refresh: true });
  const afterIds = new Set(after.issues.map((entry) => entry.id));

  /*
   * detector 层验证按「本次修复的目标」判定：
   * - 聚合问题（例如「N 个 Series 标题疑似截断」）里，修复一个 Series 不应该因为其他
   *   Series 仍然存在问题而被判失败；目标 Series 必须从问题列表中消失。
   * - 目标型问题（家族候选等）仍然直接检查同一个 issue id。
   */
  const target = request.target ?? action.target ?? '';
  const value = request.value ?? action.value ?? '';
  /*
   * 标题类修复的目标判定：
   * - adopt / reject：目标必须离开「展示标题 / 结构可疑候选」问题；reject 后进入
   *   「已被人工否决」清单是预期治理状态，不算未解决。
   * - reopen：目标必须离开「已被人工否决」清单。
   */
  const titleIssueIds =
    request.kind === 'reopen-title-candidate'
      ? ['titles.rejected-candidates']
      : ['titles.display-truncated', 'titles.candidate-structural'];
  const titleRepair =
    request.kind === 'adopt-title-candidate' ||
    request.kind === 'reject-title-candidate' ||
    request.kind === 'reopen-title-candidate';
  const targetStillListed =
    titleRepair && target
      ? after.issues.some((entry) => {
          if (!titleIssueIds.includes(entry.id)) return false;
          return entry.affected.some((entity) => {
            if (entity.href?.split(/[?#]/, 1)[0] !== `/series/${target}`) return false;
            // reopen 是候选级操作：只有当同一候选仍被列出时才算未解决
            if (request.kind === 'reopen-title-candidate') {
              return Boolean(value) && entity.detail === value;
            }
            return true;
          });
        })
      : issue.id === STATUS_DRIFT && target
        ? (() => { const scan = inspectSeriesCollectionStatus(target); return scan.plans.length > 0 || scan.blockedSamples.length > 0; })()
        : issue.id === LINK_DRIFT && target
          ? (() => { const scan = inspectFranchiseLinkCounts(target); return scan.scanned !== 1 || scan.drift > 0 || scan.blocked > 0; })()
          : afterIds.has(issue.id);
  checks.push(
    check(
      'detector',
      '重新检测：目标问题',
      !targetStillListed,
      targetStillListed
        ? `目标 ${target || issue.id} 仍然出现在问题「${issue.title}」中`
        : target && !afterIds.has(issue.id)
          ? `问题「${issue.title}」已消失`
          : `目标 ${target || issue.id} 已从问题「${issue.title}」中移除（其他条目仍会各自报告）`,
    ),
  );

  const sourceCheck = protectedSourcesCheck(sourcesBefore);
  checks.push(sourceCheck);
  // Include indirect Verify/detector side effects, not just the engine's final counters.
  assertWriteBoundary();
  enforceProtectedSources(sourceCheck);
  if (genericProtected !== null) checks.push(check('source', '通用重算允许写集', true,
    '全局人工成员治理、来源、旧历史及精确系统事件追加已核验；越界会事务回滚'));
  const verification = verificationFromChecks(checks, before, after);

  return {
    ok: verification.verified,
    repair: {
      kind: request.kind,
      label: action.label,
      ...(request.target ?? action.target
        ? { target: String(request.target ?? action.target) }
        : {}),
      ...(request.value ?? action.value ? { value: String(request.value ?? action.value) } : {}),
    },
    verification,
    report: after,
  };
}
