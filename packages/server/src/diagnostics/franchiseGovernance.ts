/**
 * Franchise 成员 / 名称治理：Repair Preview → Execute → Verify（v1.7.0）。
 *
 * 与数据中枢共用同一套契约与验证语义：
 * - DiagnosticRepairPreview：当前状态 → 未来状态 → 原因 / 来源 → 直接修改 / 自动派生 / 不会修改 → 影响链；
 * - 执行后逐层验证（source / governance / projection / search / api / cache / detector），
 *   任何一层未通过都不得标记为 verified；
 * - mutation 由数据库层统一走 recordMutation（数据版本 + 缓存失效）。
 *
 * 动作边界：
 *   exclude-franchise-member  移出错误成员（≠ Split）
 *   reopen-franchise-member   撤销排除，按当前证据重新评估（≠ 强制加回）
 *   adopt-franchise-title     人工命名（source-of-truth：manual title）
 *   reset-franchise-title     恢复自动解析（清除人工名称）
 */
import type {
  DiagnosticRepairPreview,
  DiagnosticsRepairCheck,
  FranchiseGovernanceKind,
  FranchiseGovernancePreviewResponse,
  FranchiseGovernanceResult,
} from '@bangumi-analyzer/shared';
import { ApiError, FRANCHISE_GOVERNANCE_LABEL } from '@bangumi-analyzer/shared';
import { all, dataVersion, one, transaction } from '../db/index.js';
import { titleCandidatesForMutation } from '../db/titleCandidates.js';
import { franchiseAverageRateSql } from '../db/franchiseAverage.js';
import { isFranchiseHidden, getFranchiseDetail } from '../db/query.js';
import {
  adoptFranchiseTitle,
  excludeFranchiseMember,
  franchiseGovernanceSnapshot,
  reopenFranchiseMember,
  resetFranchiseTitle,
  supersedeFranchiseMember,
} from '../db/franchiseGovernance.js';
import { findSeriesSupersession, resolveEntityKey, recomputeSeries } from '../db/series.js';
import { searchFranchiseEntities } from '../db/ipSearch.js';
import { getDiagnosticsReport, invalidateDiagnosticsReport } from './report.js';
import { verificationFromChecks } from './repair.js';
import { captureProtectedSources, enforceProtectedSources, protectedSourcesCheck } from './sourceProtection.js';

const FRANCHISE_STATE_LABEL: Record<string, string> = {
  candidate: '候选家族',
  provisional: '暂定家族',
  confirmed: '已确认家族',
  contested: '存在争议',
  rejected: '已否决',
};

const TITLE_STATE_LABEL: Record<string, string> = {
  resolved: '确定',
  provisional: '推测',
  unresolved: '未确认',
  contested: '有争议',
  manual: '人工确认',
};

function stateLabel(state: string): string {
  return FRANCHISE_STATE_LABEL[state] ?? state;
}

function titleStateLabel(state: string): string {
  return TITLE_STATE_LABEL[state] ?? state;
}

/** 治理动作不会修改的原始事实（预览与验证使用同一份表述）。 */
const UNTOUCHED_RAW = [
  'Subject / Collection（评分 / 进度 / 状态）',
  'Relation 原始关系数据',
  '原始 Bangumi 数据',
];

export interface FranchiseGovernanceInput {
  kind: FranchiseGovernanceKind;
  franchiseKey: string;
  /** exclude / reopen 的目标成员（Series key）。 */
  seriesKey?: string;
  /** adopt-franchise-title 的人工名称。 */
  title?: string;
  reason?: string;
}

interface FranchiseRow {
  id: number;
  key: string;
  title: string;
  title_state: string;
  title_source: string;
  state: string;
  series_count: number;
  title_candidates: string;
}

function loadFranchise(key: string): { resolvedKey: string; row: FranchiseRow } | null {
  const resolved = resolveEntityKey('franchise', key);
  if (!resolved) return null;
  const row = one<FranchiseRow>(
    `SELECT id, key, title, title_state, title_source, state, series_count, title_candidates
       FROM franchise_entities WHERE id = :id`,
    { id: resolved.id },
  );
  return row ? { resolvedKey: resolved.key, row } : null;
}

function loadMember(
  franchiseId: number,
  seriesKey: string,
): { seriesId: number; key: string; title: string; linkState: string } | null {
  const series = resolveEntityKey('series', seriesKey);
  if (!series) return null;
  const row = one<{ key: string; title: string }>(
    'SELECT key, title FROM series_entities WHERE id = :id',
    { id: series.id },
  );
  const link = one<{ state: string }>(
    'SELECT state FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId',
    { id: franchiseId, seriesId: series.id },
  );
  if (!row || !link) return null;
  return { seriesId: series.id, key: row.key, title: row.title, linkState: String(link.state) };
}

function activeExclusion(franchiseId: number, seriesId: number): { id: number; reason: string; created_at: string } | null {
  return (
    one<{ id: number; reason: string; created_at: string }>(
      `SELECT id, reason, created_at FROM franchise_member_exclusions
        WHERE franchise_id = :id AND series_id = :seriesId AND state = 'active'
        ORDER BY id DESC LIMIT 1`,
      { id: franchiseId, seriesId },
    ) ?? null
  );
}

function latestEvent(
  franchiseId: number,
  kind: string,
): { id: number; payload: string; created_at: string } | null {
  return (
    one<{ id: number; payload: string; created_at: string }>(
      `SELECT id, payload, created_at FROM entity_events
        WHERE entity_kind = 'franchise' AND entity_id = :id AND kind = :kind
        ORDER BY id DESC LIMIT 1`,
      { id: franchiseId, kind },
    ) ?? null
  );
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function candidateTitles(json: string): Array<{ title: string; source: string }> {
  try {
    const parsed = JSON.parse(json || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => entry as { title?: unknown; source?: unknown })
      .filter((entry) => typeof entry?.title === 'string')
      .map((entry) => ({ title: String(entry.title), source: String(entry.source ?? '') }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ Preview */

function basePreview(kind: FranchiseGovernanceKind): FranchiseGovernancePreviewResponse {
  return { kind, label: FRANCHISE_GOVERNANCE_LABEL[kind], allowed: true, message: '', preview: null };
}

function notAllowed(kind: FranchiseGovernanceKind, message: string): FranchiseGovernancePreviewResponse {
  return {
    kind,
    label: FRANCHISE_GOVERNANCE_LABEL[kind],
    allowed: false,
    message,
    preview: null,
  };
}

export function buildFranchiseGovernancePreview(
  input: FranchiseGovernanceInput,
): FranchiseGovernancePreviewResponse {
  const loaded = loadFranchise(input.franchiseKey);
  if (!loaded) return notAllowed(input.kind, '未找到该作品家族');
  const { row } = loaded;

  switch (input.kind) {
    case 'exclude-franchise-member': {
      const seriesKey = input.seriesKey ?? '';
      const series = resolveEntityKey('series', seriesKey);
      if (!series) return notAllowed(input.kind, '未找到该系列');
      if (activeExclusion(row.id, series.id)) {
        return notAllowed(input.kind, '该系列已经被移出这个家族');
      }
      const member = loadMember(row.id, seriesKey);
      if (!member) return notAllowed(input.kind, '该系列当前不属于这个家族，无需移出');
      const memberCount = Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM franchise_series
            WHERE franchise_id = :id AND state <> 'conflict'`,
          { id: row.id },
        )?.n ?? 0,
      );
      if (memberCount <= 1) {
        return notAllowed(
          input.kind,
          '这是该家族最后一个成员：移出后家族将不再包含任何系列，请改用「否决该家族」。',
        );
      }
      return {
        ...basePreview(input.kind),
        preview: {
          current: `家族「${row.title}」（${row.key}，${stateLabel(row.state)}）当前包含 ${memberCount} 个系列；「${member.title}」是其中一员（链接状态 ${member.linkState}）。`,
          next: `家族成员不再包含「${member.title}」；家族回到「等待人工重新评估」的状态，不会自动变成已确认。`,
          reason: `你否决了「Series「${member.title}」属于 Franchise「${row.title}」」这一 membership 推断。`,
          source: '用户在家族页面移出成员（写入成员排除治理记录与当时的证据快照）。',
          directlyChanges: [
            `成员排除治理记录：${row.key} × ${member.key}（含时间 / 原因 / 证据快照）`,
            'Franchise 治理状态：已确认 / 已否决 → 等待人工重新评估',
          ],
          derivedChanges: [
            'Franchise 成员链接与计数（按「当前证据 − 人工排除」重算）',
            'Franchise 名称按剩余成员的当前证据重新解析（人工确认的名称保持不动）',
            'Franchise / Series 搜索投影（被移出的系列不再命中该家族）',
            'Series 详情中的家族入口',
            '数据中枢诊断报告与治理历史',
          ],
          untouched: [
            'Series identity 与成员构成',
            ...UNTOUCHED_RAW,
            '其他 Franchise 及其成员',
          ],
          chain: [
            { layer: 'governance', label: '写入成员排除', detail: 'franchise_member_exclusions 记录 Franchise × Series、原因与证据快照' },
            { layer: 'projection', label: '重建家族成员', detail: 'recomputeSeries 按当前证据减去人工排除，重算链接与计数' },
            { layer: 'search', label: '搜索投影', detail: '被移出的系列不再作为该家族的命中来源' },
            { layer: 'api', label: 'API / UI', detail: '家族详情、系列详情的家族入口立即反映最新归属' },
            { layer: 'cache', label: '缓存失效', detail: '数据版本推进，统计与诊断报告重新检测' },
            { layer: 'governance', label: '等待人工确认', detail: '修正后的家族不会自动确认，需要你重新评估后决定' },
          ],
        },
      };
    }
    case 'reopen-franchise-member': {
      const seriesKey = input.seriesKey ?? '';
      const series = resolveEntityKey('series', seriesKey);
      if (!series) return notAllowed(input.kind, '未找到该系列');
      const exclusion = activeExclusion(row.id, series.id);
      if (!exclusion) return notAllowed(input.kind, '该系列当前没有被移出这个家族');
      const seriesRow = one<{ key: string; title: string }>(
        'SELECT key, title FROM series_entities WHERE id = :id',
        { id: series.id },
      );
      const title = seriesRow?.title ?? seriesKey;
      return {
        ...basePreview(input.kind),
        preview: {
          current: `「${title}」（${seriesRow?.key ?? seriesKey}）当前被移出家族「${row.title}」：排除于 ${exclusion.created_at}${exclusion.reason ? `，原因：${exclusion.reason}` : ''}。`,
          next: '排除标记为已撤销；该系列是否重新属于这个家族，完全由当前证据重新评估决定（不强制加回，也不会自动确认）。',
          reason: '你撤销了此前的成员排除决定，让当前 resolver 重新评估 membership。',
          source: '用户在家族页面撤销成员排除（原排除记录保留为 revoked provenance）。',
          directlyChanges: ['该 Franchise × Series 的排除状态：active → revoked（原因与时间保留）'],
          derivedChanges: [
            'Franchise 成员链接与计数（重新执行当前 resolver / projection）',
            'Franchise 名称按当前成员的证据重新解析（人工确认的名称保持不动）',
            'Franchise / Series 搜索投影',
            '数据中枢诊断报告与治理历史',
          ],
          untouched: [
            'Series identity 与成员构成',
            ...UNTOUCHED_RAW,
            '其他 Franchise 及其成员',
          ],
          chain: [
            { layer: 'governance', label: '撤销成员排除', detail: '排除记录标记为 revoked，原 reason / 证据快照继续保留' },
            { layer: 'projection', label: '重新评估成员', detail: 'recomputeSeries 只按当前证据决定是否纳入，不强制加回' },
            { layer: 'search', label: '搜索投影', detail: '搜索结果与真实成员关系保持一致' },
            { layer: 'api', label: 'API / UI', detail: '家族详情、成员列表立即反映最新归属' },
            { layer: 'cache', label: '缓存失效', detail: '数据版本推进，统计与诊断报告重新检测' },
          ],
        },
      };
    }
    case 'supersede-franchise-member': {
      const fromKey = input.seriesKey ?? '';
      const from = one<{ id: number; key: string; title: string; state: string }>(
        'SELECT id, key, title, state FROM series_entities WHERE key = :key',
        { key: fromKey },
      );
      if (!from) return notAllowed(input.kind, '未找到该系列');
      if (from.state !== 'stale') {
        return notAllowed(input.kind, '该系列当前是 live 身份，不存在需要迁移的被取代成员。');
      }
      if (row.state !== 'confirmed') {
        return notAllowed(
          input.kind,
          '只有已确认的家族需要手动迁移被取代的成员身份；未确认家族的成员链接由重建自动收敛。',
        );
      }
      const link = one<{ state: string }>(
        `SELECT state FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId`,
        { id: row.id, seriesId: from.id },
      );
      if (!link) return notAllowed(input.kind, '该系列当前不属于这个家族');
      const supersession = findSeriesSupersession(from.key);
      if (!supersession) {
        return notAllowed(
          input.kind,
          '缺少可验证的身份谱系（rebuilt-into alias / merged 事件 / 成员一致性），不能迁移成员身份。',
        );
      }
      const to = supersession.to;
      const targetExists = Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId`,
          { id: row.id, seriesId: to.id },
        )?.n ?? 0,
      );
      if (targetExists > 0) {
        return notAllowed(input.kind, `家族已经包含恢复后的身份「${to.title}」，无需迁移。`);
      }
      const otherLive = all<{ key: string; title: string; state: string }>(
        `SELECT f.key, f.title, f.state FROM franchise_series fs
           JOIN franchise_entities f ON f.id = fs.franchise_id
          WHERE fs.series_id = :seriesId AND f.id <> :id AND f.state <> 'stale'`,
        { seriesId: to.id, id: row.id },
      );
      const memberCount = Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM franchise_series fs WHERE fs.franchise_id = :id`,
          { id: row.id },
        )?.n ?? 0,
      );
      return {
        ...basePreview(input.kind),
        preview: {
          current:
            `家族「${row.title}」（${row.key}，已确认）当前链接 ${memberCount} 个系列，` +
            `其中「${from.title}」（${from.key}）已被身份恢复取代：${from.key} 是 ${to.key} 的事故重建副本` +
            `（生命周期证据：alias ${supersession.provenance.aliasReason}、merged 事件 #${supersession.provenance.mergedEventId}` +
            `${supersession.provenance.restoredEventId ? `、restored 事件 #${supersession.provenance.restoredEventId}` : ''}）。`,
          next:
            `家族成员身份从 ${from.key} 迁移到 ${to.key}（同一真实 Series 的恢复身份）；` +
            `家族保持 confirmed，不重新裁决；后续重算按恢复后的成员集合匹配。`,
          reason:
            `已通过只读生命周期校验：${from.key}（stale）→ ${to.key}（live）的谱系明确，` +
            `成员集合一致性为「${supersession.members.exact ? '完全一致' : '高度一致'}」（overlap ${supersession.members.overlap}/${supersession.members.union}）。` +
            '这是身份更正，不是成员增减，也不是重新判断家族。',
          source: '用户在家族页面执行「迁移已被取代的家族成员」（仅在有机器可验证谱系时可用）。',
          directlyChanges: [
            `Franchise 成员链接：${row.key} × ${from.key} → ${row.key} × ${to.key}（继承链接状态 ${link.state}）`,
            '成员链接 evidence 写入 supersededFrom provenance（跨重算保留）',
          ],
          derivedChanges: [
            `Franchise 成员集合：${row.key} 变为 ${to.key} + 其余 live 成员`,
            'Franchise 计数（series_count / known_count / collected_count / average_rate）按 live 成员重算',
            'Franchise / Series 搜索投影与家族详情',
            otherLive.length > 0
              ? `其他引用该身份的活跃家族（${otherLive.map((entry) => `${entry.key}［${stateLabel(entry.state)}］`).join('、')}）：未确认的重复家族会在重算后转为非活跃；已确认的重复家族仍需单独人工治理`
              : '没有其他活跃家族引用该身份',
            '数据中枢诊断报告与治理历史',
          ],
          untouched: [
            'Series identity 与其成员构成（只改家族侧链接）',
            ...UNTOUCHED_RAW,
            '其他 Franchise 及其成员',
            'Franchise 名称与治理状态（保持 confirmed）',
          ],
          chain: [
            {
              layer: 'governance',
              label: '写入身份迁移',
              detail: 'franchise_series 链接替换 + supersededFrom provenance + member_superseded 事件',
            },
            {
              layer: 'projection',
              label: '重建家族投影',
              detail: 'recomputeSeries 按恢复后的成员集合匹配，家族保持 confirmed（confirmedPinned）',
            },
            {
              layer: 'projection',
              label: '计数与 stale 链接',
              detail: 'stale 链接消失，计数按 live 成员重算，不再产生 counter drift',
            },
            {
              layer: 'search',
              label: '搜索投影',
              detail: '家族与系列搜索命中保持一致；重复候选不再作为活跃家族出现',
            },
            {
              layer: 'api',
              label: 'API / UI',
              detail: '家族详情显示恢复后的成员 Series，旧身份不再作为成员出现',
            },
            {
              layer: 'cache',
              label: '缓存失效',
              detail: '数据版本推进，统计与诊断报告重新检测',
            },
          ],
        },
      };
    }
    case 'adopt-franchise-title': {
      if (!titleCandidatesForMutation(row.title_candidates)) {
        return notAllowed(input.kind, '历史候选证据结构异常，已保留原始数据并停止名称写入');
      }
      if (/[\u0000-\u001f\u007f]/.test(input.title ?? '')) return notAllowed(input.kind, '名称不能包含控制字符');
      const nextTitle = String(input.title ?? '').trim().replace(/\s{2,}/g, ' ');
      if (!nextTitle) return notAllowed(input.kind, '请先输入一个名称');
      if (nextTitle.length > 120) return notAllowed(input.kind, '名称不能超过 120 个字符');
      return {
        ...basePreview(input.kind),
        preview: {
          current: `家族「${row.key}」当前名称：${row.title}（${titleStateLabel(row.title_state)} · 来源 ${row.title_source}）`,
          next: `「${nextTitle}」并标记为人工确认（manual）：自动 resolver 之后只能提出候选，不得覆盖。`,
          reason: '当前名称是 fallback / 暂定结果，或你想要一个稳定的人类可读名称。',
          source: '用户在家族页面设置名称（复用 Title Review / Manual Override 语义）。',
          directlyChanges: ['Franchise canonical title：title / title_state=manual / title_source=manual', '名称候选 provenance（manual 候选）'],
          derivedChanges: [
            'Franchise 列表 / 详情 / Series 详情的家族入口显示新名称',
            'Franchise 搜索投影（可见时新名称可被搜索命中；隐私隐藏时不暴露）',
            '数据中枢诊断报告与治理历史',
          ],
          untouched: [
            'Franchise 成员构成与治理状态',
            'Series identity 与成员构成',
            ...UNTOUCHED_RAW,
          ],
          chain: [
            { layer: 'governance', label: '写入人工名称', detail: 'franchise_entities.title → manual，保留候选 provenance' },
            { layer: 'projection', label: '名称投影', detail: '重建不会覆盖 manual 名称（重算后保持不变）' },
            { layer: 'search', label: '搜索投影', detail: '按执行时的隐私状态验证：可见时新名称可被命中，隐藏时不得暴露' },
            { layer: 'api', label: 'API / UI', detail: 'Franchise 列表 / 详情 / 系列入口显示新名称' },
            { layer: 'cache', label: '缓存失效', detail: '数据版本推进，统计与诊断报告重新检测' },
          ],
        },
      };
    }
    case 'reset-franchise-title': {
      if (row.title_state !== 'manual') {
        return notAllowed(input.kind, '当前名称不是人工设置状态，无需恢复自动解析');
      }
      return {
        ...basePreview(input.kind),
        preview: {
          current: `家族「${row.key}」当前名称由人工设置：「${row.title}」（manual）。`,
          next: '清除人工名称，立即按当前成员证据重新解析（结果可能是确定 / 推测 / 未确认）。',
          reason: '不再需要人工固定这个名称，让 resolver 重新接管。',
          source: '用户在家族页面恢复自动解析（复用 Title Review 的 reset 语义）。',
          directlyChanges: ['清除 manual 名称与 manual 候选', 'Franchise 名称按当前证据重新推导'],
          derivedChanges: [
            'Franchise 列表 / 详情 / Series 详情的家族入口显示解析结果',
            'Franchise 搜索投影按新名称生效',
            '数据中枢诊断报告与治理历史',
          ],
          untouched: [
            'Franchise 成员构成与治理状态',
            'Series identity 与成员构成',
            ...UNTOUCHED_RAW,
          ],
          chain: [
            { layer: 'governance', label: '清除人工名称', detail: 'manual 候选移除，名称回到自动解析来源' },
            { layer: 'projection', label: '重新解析名称', detail: '与重建共用同一套 resolver 规则' },
            { layer: 'search', label: '搜索投影', detail: '搜索按最新名称与候选生效' },
            { layer: 'api', label: 'API / UI', detail: 'Franchise 列表 / 详情显示解析结果' },
            { layer: 'cache', label: '缓存失效', detail: '数据版本推进，统计与诊断报告重新检测' },
          ],
        },
      };
    }
    default: {
      const exhaustive: never = input.kind;
      return notAllowed(exhaustive, '未知的治理动作');
    }
  }
}

/* ------------------------------------------------------------ Execute + Verify */

function searchHitVia(
  franchiseKey: string,
  text: string,
): { hit: boolean; viaText: boolean } {
  const needle = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!needle) return { hit: false, viaText: false };
  const items = searchFranchiseEntities(text, { limit: 100 }).items;
  const hit = items.find((item) => item.key === franchiseKey);
  if (!hit) return { hit: false, viaText: false };
  const viaText = hit.matchReasons.some(
    (reason) => reason.text.trim().toLowerCase().replace(/\s+/g, '') === needle,
  );
  return { hit: true, viaText };
}

function detectorChecks(
  franchiseKey: string,
  expectedState: string,
  report: ReturnType<typeof getDiagnosticsReport>,
): DiagnosticsRepairCheck[] {
  const counterDrift = report.issues.some((issue) => issue.id === 'franchise.counter-drift');
  const staleLink = report.issues.some((issue) => issue.id === 'franchise.stale-link');
  const awaiting = report.issues.some(
    (issue) => issue.id === `franchise.awaiting-review:${franchiseKey}`,
  );
  const shouldAwait = ['candidate', 'provisional', 'contested'].includes(expectedState);
  return [
    {
      layer: 'detector',
      label: '重新检测：家族派生数据一致',
      ok: !counterDrift && !staleLink,
      detail: !counterDrift && !staleLink
        ? '重新检测未发现 Franchise 计数漂移或 stale 链接'
        : `Franchise 派生数据仍有问题（counter-drift=${counterDrift} / stale-link=${staleLink}）`,
    },
    {
      layer: 'detector',
      label: '重新检测：治理状态与数据中枢一致',
      ok: shouldAwait === awaiting,
      detail: shouldAwait
        ? `当前状态 ${expectedState}：数据中枢${awaiting ? '已' : '未'}把该家族列为等待人工确认`
        : `当前状态 ${expectedState}：数据中枢不再把它列为待确认候选`,
    },
  ];
}

function cacheCheck(versionBefore: number): DiagnosticsRepairCheck {
  const versionAfter = dataVersion();
  return {
    layer: 'cache',
    label: '数据版本 / 缓存失效',
    ok: versionAfter > versionBefore,
    detail: `dataVersion ${versionBefore} → ${versionAfter}（stats / diagnostics 已失效）`,
  };
}

function apiDetailCheck(
  franchiseKey: string,
  verify: (detail: NonNullable<ReturnType<typeof getFranchiseDetail>>) => boolean,
  visibility: 'visible' | 'real' = 'visible',
): DiagnosticsRepairCheck {
  const detail = getFranchiseDetail(franchiseKey, { visibility });
  if (!detail) {
    const hidden = isFranchiseHidden(franchiseKey);
    return {
      layer: 'api',
      label: 'Franchise API',
      ok: hidden,
      detail: hidden
        ? `GET /api/franchises/${franchiseKey} → 当前隐私设置下隐藏（数据仍然存在）`
        : `GET /api/franchises/${franchiseKey} 无结果`,
    };
  }
  const ok = verify(detail);
  return {
    layer: 'api',
    label: 'Franchise API',
    ok,
    detail: ok
      ? `GET /api/franchises/${franchiseKey}（${visibility === 'real' ? '完整数据' : '当前可见'}口径）→ ${detail.title}（${detail.seriesCount} 个系列）`
      : `GET /api/franchises/${franchiseKey}（${visibility === 'real' ? '完整数据' : '当前可见'}口径）返回内容与数据库不一致`,
  };
}

function throwGovernanceError(message: string, code: string): never {
  throw new ApiError(message, {
    code,
    status: code === 'franchise_not_found' || code === 'series_not_found' ? 404 : 400,
    dataIntact: true,
  });
}

export function runFranchiseGovernance(input: FranchiseGovernanceInput): FranchiseGovernanceResult {
  // 验证包含额外派生重建；失败时须连同治理写入、provenance 与版本一起回滚。
  try {
    return transaction(() => executeFranchiseGovernance(input));
  } catch (error) {
    // Reports observed inside a rolled-back transaction cannot remain authoritative.
    invalidateDiagnosticsReport();
    throw error;
  }
}

function executeFranchiseGovernance(input: FranchiseGovernanceInput): FranchiseGovernanceResult {
  const before = getDiagnosticsReport({ refresh: true });
  const versionBefore = dataVersion();
  const sourcesBefore = captureProtectedSources();
  const checks: DiagnosticsRepairCheck[] = [];
  const initial = loadFranchise(input.franchiseKey);
  if (!initial) throwGovernanceError('未找到该作品家族', 'franchise_not_found');
  const franchiseKey = initial.resolvedKey;
  const stateBefore = initial.row.state;

  switch (input.kind) {
    case 'exclude-franchise-member': {
      const seriesKey = input.seriesKey ?? '';
      const member = loadMember(initial.row.id, seriesKey);
      const result = excludeFranchiseMember(franchiseKey, seriesKey, input.reason ?? '');
      if (!result.ok) throwGovernanceError(result.message, result.code);
      const snapshot = franchiseGovernanceSnapshot(initial.row.id);
      const exclusion = member ? activeExclusion(initial.row.id, member.seriesId) : null;
      const event = latestEvent(initial.row.id, 'member_excluded');
      const payload = event ? parsePayload(event.payload) : {};
      checks.push({
        layer: 'governance',
        label: '成员排除决定已写入（含证据快照）',
        ok: Boolean(exclusion),
        detail: exclusion
          ? `franchise_member_exclusions #${exclusion.id}（${exclusion.created_at}）`
          : '未找到生效的排除记录',
      });
      checks.push({
        layer: 'governance',
        label: '治理历史已记录',
        ok: Boolean(event) && payload.seriesKey === (member?.key ?? seriesKey),
        detail: event
          ? `entity_events #${event.id}：member_excluded（${String(payload.seriesTitle ?? '')}）`
          : '未找到 member_excluded 事件',
      });
      checks.push({
        layer: 'projection',
        label: '成员链接已移除',
        ok: Boolean(snapshot) && Boolean(member) && !snapshot!.memberSeriesIds.includes(member!.seriesId),
        detail: snapshot && member
          ? `当前成员 ${snapshot.memberSeriesIds.length} 个系列；已移出 ${member.key}`
          : '家族或成员不存在',
      });
      checks.push({
        layer: 'projection',
        label: '家族计数与链接一致',
        ok: seriesCountDrift(franchiseKey) === 0,
        detail: `series_count=${storedSeriesCount(franchiseKey)} / 实际链接=${linkCount(franchiseKey)}`,
      });
      checks.push({
        layer: 'governance',
        label: '不会自动确认',
        ok: Boolean(snapshot) && snapshot!.state !== 'confirmed' && snapshot!.state === result.state,
        detail: `治理状态 ${stateBefore} → ${snapshot?.state ?? 'missing'}（修正成员构成不等于确认）`,
      });
      const seriesTitle = member?.title ?? '';
      const search = searchHitVia(franchiseKey, seriesTitle);
      checks.push({
        layer: 'search',
        label: '被移出的系列不再命中该家族',
        ok: !search.viaText,
        detail: search.viaText
          ? `搜索「${seriesTitle}」仍会把 ${franchiseKey} 作为命中结果`
          : `搜索「${seriesTitle}」不再通过该系列命中 ${franchiseKey}`,
      });
      checks.push(
        apiDetailCheck(
          franchiseKey,
          (detail) => !detail.series.some((entry) => entry.key === (member?.key ?? seriesKey)),
        ),
      );
      checks.push(cacheCheck(versionBefore));
      checks.push(...detectorChecks(franchiseKey, snapshot?.state ?? '', getDiagnosticsReport({ refresh: true })));
      break;
    }
    case 'reopen-franchise-member': {
      const seriesKey = input.seriesKey ?? '';
      const series = resolveEntityKey('series', seriesKey);
      if (!series) throwGovernanceError('未找到该系列', 'series_not_found');
      const exclusionBefore = activeExclusion(initial.row.id, series.id);
      const result = reopenFranchiseMember(franchiseKey, seriesKey, input.reason ?? '');
      if (!result.ok) throwGovernanceError(result.message, result.code);
      const revoked = one<{
        state: string;
        reason: string;
        revoked_at: string | null;
        revoked_reason: string | null;
      }>(
        `SELECT state, reason, revoked_at, revoked_reason FROM franchise_member_exclusions
          WHERE franchise_id = :id AND series_id = :seriesId
          ORDER BY id DESC LIMIT 1`,
        { id: initial.row.id, seriesId: series.id },
      );
      const event = latestEvent(initial.row.id, 'member_reopened');
      const payload = event ? parsePayload(event.payload) : {};
      checks.push({
        layer: 'governance',
        label: '排除已撤销（原 provenance 保留）',
        ok:
          Boolean(revoked) &&
          revoked!.state === 'revoked' &&
          Boolean(revoked!.revoked_at) &&
          revoked!.reason === (exclusionBefore?.reason ?? ''),
        detail: revoked
          ? `state=${revoked.state} / revokedAt=${revoked.revoked_at ?? 'missing'} / 原原因保留：${revoked.reason || '（未填写）'}`
          : '未找到排除记录',
      });
      checks.push({
        layer: 'governance',
        label: '撤销事件已记录',
        ok: Boolean(event) && payload.trigger === 'manual',
        detail: event
          ? `entity_events #${event.id}：member_reopened（人工撤销）`
          : '未找到 member_reopened 事件',
      });
      const beforeRecompute = franchiseGovernanceSnapshot(initial.row.id);
      const memberNow = Boolean(beforeRecompute?.memberSeriesIds.includes(series.id));
      recomputeSeries();
      const afterRecompute = franchiseGovernanceSnapshot(initial.row.id);
      const memberAfter = Boolean(afterRecompute?.memberSeriesIds.includes(series.id));
      checks.push({
        layer: 'projection',
        label: '成员由当前证据决定（重建幂等）',
        ok: memberNow === memberAfter && memberNow === result.isMember,
        detail: `重建后${memberAfter ? '重新属于' : '不属于'}该家族（不强制加回，不会自动确认）`,
      });
      checks.push({
        layer: 'governance',
        label: '不会自动确认',
        ok: Boolean(afterRecompute) && afterRecompute!.state !== 'confirmed' && afterRecompute!.state === result.state,
        detail: `治理状态 ${stateBefore} → ${afterRecompute?.state ?? 'missing'}`,
      });
      const memberRow = one<{ title: string }>('SELECT title FROM series_entities WHERE id = :id', {
        id: series.id,
      });
      const search = searchHitVia(franchiseKey, memberRow?.title ?? '');
      checks.push({
        layer: 'search',
        label: '搜索结果与当前成员关系一致',
        ok: memberAfter ? search.hit : !search.viaText,
        detail: memberAfter
          ? `当前属于该家族：搜索「${memberRow?.title ?? ''}」命中 ${franchiseKey}`
          : `当前不属于该家族：搜索「${memberRow?.title ?? ''}」不再命中 ${franchiseKey}`,
      });
      checks.push(
        apiDetailCheck(
          franchiseKey,
          (detail) => detail.series.some((entry) => entry.key === series.key) === memberAfter,
        ),
      );
      checks.push(cacheCheck(versionBefore));
      checks.push(
        ...detectorChecks(franchiseKey, afterRecompute?.state ?? '', getDiagnosticsReport({ refresh: true })),
      );
      break;
    }
    case 'supersede-franchise-member': {
      const fromKey = input.seriesKey ?? '';
      const fromRow = one<{ id: number; key: string; title: string; state: string }>(
        'SELECT id, key, title, state FROM series_entities WHERE key = :key',
        { key: fromKey },
      );
      if (!fromRow) throwGovernanceError('未找到该系列', 'series_not_found');
      const supersessionBefore = findSeriesSupersession(fromRow.key);
      if (!supersessionBefore) {
        throwGovernanceError(
          '缺少可验证的身份谱系（rebuilt-into / merged / 成员一致性），不能迁移成员身份。',
          'no_supersession',
        );
      }
      const result = supersedeFranchiseMember(franchiseKey, fromKey, input.reason ?? '');
      if (!result.ok) {
        throwGovernanceError(result.message ?? '无法迁移成员身份', result.code ?? 'supersede_failed');
      }

      const to = supersessionBefore.to;
      const snapshot = franchiseGovernanceSnapshot(initial.row.id);
      const event = latestEvent(initial.row.id, 'member_superseded');
      const payload = event ? parsePayload(event.payload) : {};
      const payloadFrom = (payload.from ?? {}) as Record<string, unknown>;
      const payloadTo = (payload.to ?? {}) as Record<string, unknown>;
      const payloadProvenance = (payload.provenance ?? {}) as Record<string, unknown>;
      checks.push({
        layer: 'governance',
        label: '身份迁移决定已写入 provenance',
        ok:
          Boolean(event) &&
          payloadFrom.key === fromKey &&
          payloadTo.key === to.key &&
          Number(payloadProvenance.mergedEventId ?? 0) ===
            supersessionBefore.provenance.mergedEventId,
        detail: event
          ? `entity_events #${event.id}：member_superseded（${fromKey} → ${to.key}，merged #${supersessionBefore.provenance.mergedEventId}）`
          : '未找到 member_superseded 事件',
      });
      checks.push({
        layer: 'source',
        label: 'Franchise 保持已确认',
        ok: snapshot?.state === 'confirmed',
        detail: `治理状态 ${stateBefore} → ${snapshot?.state ?? 'missing'}（身份更正 ≠ 重新裁决）`,
      });

      const fromLinkAfter = Number(
        one<{ n: number }>(
          'SELECT COUNT(*) AS n FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId',
          { id: initial.row.id, seriesId: fromRow.id },
        )?.n ?? 0,
      );
      const toLinkAfter = one<{ state: string; evidence: string }>(
        'SELECT state, evidence FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId',
        { id: initial.row.id, seriesId: to.id },
      );
      const supersededEvidence = toLinkAfter
        ? parsePayload(toLinkAfter.evidence).supersededFrom
        : undefined;
      checks.push({
        layer: 'projection',
        label: '成员身份已迁移（旧身份移除 / 恢复身份就位）',
        ok:
          fromLinkAfter === 0 &&
          Boolean(toLinkAfter) &&
          toLinkAfter!.state !== 'conflict' &&
          Boolean(supersededEvidence),
        detail:
          `旧链接 ${fromKey}：${fromLinkAfter} 条；新链接 ${to.key}：` +
          `${toLinkAfter ? `state=${toLinkAfter.state}` : 'missing'}；` +
          `supersededFrom provenance ${supersededEvidence ? '已保留（跨重算）' : '缺失'}`,
      });
      const counterConsistent = Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM franchise_entities f WHERE f.id = :id AND (
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
          { id: initial.row.id },
        )?.n ?? 0,
      );
      checks.push({
        layer: 'projection',
        label: 'Franchise 派生计数与 live 成员一致',
        ok: counterConsistent === 0,
        detail: `series_count=${storedSeriesCount(franchiseKey)} / 实际链接=${linkCount(franchiseKey)}；known/collected/average 与 live 成员一致`,
      });
      const staleLinksAfter = Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM franchise_series fs
             JOIN franchise_entities f ON f.id = fs.franchise_id
             JOIN series_entities e ON e.id = fs.series_id
            WHERE f.state <> 'stale' AND e.state = 'stale'`,
        )?.n ?? 0,
      );
      checks.push({
        layer: 'detector',
        label: '活跃家族中的 stale 链接已清零',
        ok: staleLinksAfter === 0,
        detail: `stale 链接：${staleLinksAfter} 条`,
      });

      /*
       * 同身份重复家族：不假设「理论上会 stale」，直接读取真实状态与产品读取路径。
       */
      const duplicates = all<{ key: string; state: string; title: string }>(
        `SELECT f.key, f.state, f.title FROM franchise_series fs
           JOIN franchise_entities f ON f.id = fs.franchise_id
          WHERE fs.series_id = :seriesId AND f.id <> :id AND f.state <> 'stale'`,
        { seriesId: to.id, id: initial.row.id },
      );
      const duplicateDetails = duplicates.map((entry) => {
        const detail = getFranchiseDetail(entry.key);
        const searchHit = searchFranchiseEntities(entry.title, { limit: 100 }).items.some(
          (item) => item.key === entry.key,
        );
        return `${entry.key}（${entry.state}，API ${detail ? '可见' : '不可见'}，搜索 ${searchHit ? '命中' : '未命中'}）`;
      });
      checks.push({
        layer: 'projection',
        label: '同一身份没有重复活跃家族',
        ok: duplicates.length === 0,
        detail:
          duplicates.length === 0
            ? `没有其他活跃家族引用 ${to.key}（重复候选已进入非活跃状态）`
            : `${duplicateDetails.join('、')}：需要单独人工治理`,
      });
      checks.push(
        apiDetailCheck(
          franchiseKey,
          (detail) =>
            detail.series.some((entry) => entry.key === to.key) &&
            !detail.series.some((entry) => entry.key === fromKey),
          /*
           * 身份迁移验证读取「完整数据」口径：当前可见口径可能把 NSFW 成员过滤掉，
           * 那属于 visibility 语义，不是身份投影不一致。
           */
          'real',
        ),
      );
      const searchAfter = searchHitVia(franchiseKey, initial.row.title);
      checks.push({
        layer: 'search',
        label: 'Franchise 搜索仍然可达',
        ok: searchAfter.hit,
        detail: searchAfter.hit
          ? `搜索「${initial.row.title}」命中 ${franchiseKey}`
          : `搜索「${initial.row.title}」没有命中 ${franchiseKey}`,
      });
      checks.push(cacheCheck(versionBefore));
      checks.push(
        ...detectorChecks(
          franchiseKey,
          snapshot?.state ?? '',
          getDiagnosticsReport({ refresh: true }),
        ),
      );
      break;
    }
    case 'adopt-franchise-title': {
      // 外层 BEGIN IMMEDIATE 内的事件水位：旧同名事件不能替代本次追加的历史。
      const eventIdBefore = one<{ id: number }>('SELECT COALESCE(MAX(id), 0) AS id FROM entity_events')!.id;
      const result = adoptFranchiseTitle(franchiseKey, input.title ?? '', input.reason ?? '');
      if (!result.ok) throwGovernanceError(result.message, result.code);
      const snapshot = franchiseGovernanceSnapshot(initial.row.id);
      recomputeSeries();
      const afterRecompute = franchiseGovernanceSnapshot(initial.row.id);
      const candidatesAfter = titleCandidatesForMutation(
        one<{ title_candidates: string }>(
          'SELECT title_candidates FROM franchise_entities WHERE id = :id',
          { id: initial.row.id },
        )?.title_candidates ?? '[]',
      );
      const event = one<{ id: number; payload: string; created_at: string }>(
        `SELECT id, payload, created_at FROM entity_events
          WHERE entity_kind = 'franchise' AND entity_id = :id AND kind = 'title_manual'
            AND id > :eventIdBefore ORDER BY id DESC LIMIT 1`,
        { id: initial.row.id, eventIdBefore },
      );
      const payload = event ? parsePayload(event.payload) : {};
      checks.push({
        layer: 'source',
        label: 'Franchise canonical title',
        ok:
          Boolean(snapshot) &&
          snapshot!.title === result.title &&
          snapshot!.titleState === 'manual' &&
          snapshot!.titleSource === 'manual',
        detail: `title=${snapshot?.title ?? 'missing'} / state=${snapshot?.titleState ?? 'missing'} / source=${snapshot?.titleSource ?? 'missing'}`,
      });
      checks.push({
        layer: 'governance',
        label: '人工名称 provenance',
        ok:
          candidatesAfter !== null && candidatesAfter.some(
            (candidate) => candidate.source === 'manual' && candidate.state === 'manual' &&
              candidate.valid !== false && candidate.title === result.title,
          ),
        detail: candidatesAfter === null
          ? '候选证据结构异常，原始证据保留；不能确认本次有效 manual 来源'
          : `完整候选列表中的本次有效 manual 来源（${candidatesAfter.length} 个候选）`,
      });
      checks.push({
        layer: 'governance',
        label: '治理历史已记录',
        ok: Boolean(event) && payload.to === result.title && payload.from === result.previousTitle &&
          payload.fromState === initial.row.title_state && payload.mode === 'custom' &&
          payload.reason === (input.reason ?? ''),
        detail: event
          ? `entity_events #${event.id}：title_manual（${String(payload.from ?? '')} → ${String(payload.to ?? '')}）`
          : '未找到本次 Execute 新增的 title_manual 事件（旧历史不能替代）',
      });
      checks.push({
        layer: 'projection',
        label: '重建后人工名称不反弹',
        ok:
          Boolean(afterRecompute) &&
          afterRecompute!.title === result.title &&
          afterRecompute!.titleState === 'manual',
        detail: `重建后 title=${afterRecompute?.title ?? 'missing'} / state=${afterRecompute?.titleState ?? 'missing'}`,
      });
      const search = searchFranchiseEntities(result.title, { limit: 100 }).items.some(
        (item) => item.key === franchiseKey,
      );
      // 读取重算后的当前隐私状态，不能沿用 Preview 时的可见性假设。
      const hidden = isFranchiseHidden(franchiseKey);
      checks.push({
        layer: 'search',
        label: '搜索投影',
        ok: hidden ? !search : search,
        detail: hidden
          ? search
            ? '当前隐私设置下应隐藏，但搜索仍返回目标家族'
            : '当前隐私设置下隐藏，搜索未暴露目标家族'
          : search
            ? `搜索「${result.title}」可以命中 ${franchiseKey}`
            : `搜索「${result.title}」没有命中 ${franchiseKey}`,
      });
      checks.push(
        apiDetailCheck(
          franchiseKey,
          (detail) => detail.title === result.title && detail.titleState === 'manual',
        ),
      );
      checks.push(cacheCheck(versionBefore));
      checks.push({
        layer: 'governance',
        label: '名称治理不改变成员治理状态',
        ok: afterRecompute?.state === stateBefore,
        detail: `治理状态 ${stateBefore} → ${afterRecompute?.state ?? 'missing'}（名称与成员分离）`,
      });
      checks.push(
        ...detectorChecks(franchiseKey, afterRecompute?.state ?? '', getDiagnosticsReport({ refresh: true })),
      );
      break;
    }
    case 'reset-franchise-title': {
      const result = resetFranchiseTitle(franchiseKey, input.reason ?? '');
      if (!result.ok) throwGovernanceError(result.message, result.code);
      const snapshot = franchiseGovernanceSnapshot(initial.row.id);
      const candidatesAfter = candidateTitles(
        one<{ title_candidates: string }>(
          'SELECT title_candidates FROM franchise_entities WHERE id = :id',
          { id: initial.row.id },
        )?.title_candidates ?? '[]',
      );
      recomputeSeries();
      const afterRecompute = franchiseGovernanceSnapshot(initial.row.id);
      const event = latestEvent(initial.row.id, 'title_reset');
      const payload = event ? parsePayload(event.payload) : {};
      checks.push({
        layer: 'source',
        label: '名称回到自动解析',
        ok: Boolean(snapshot) && snapshot!.titleState !== 'manual' && snapshot!.title === result.title,
        detail: `title=${snapshot?.title ?? 'missing'} / state=${snapshot?.titleState ?? 'missing'} / source=${snapshot?.titleSource ?? 'missing'}`,
      });
      checks.push({
        layer: 'governance',
        label: '人工候选已清除',
        ok: !candidatesAfter.some((candidate) => candidate.source === 'manual'),
        detail: `当前候选 ${candidatesAfter.length} 个，不含 manual 候选`,
      });
      checks.push({
        layer: 'governance',
        label: '治理历史已记录',
        ok: Boolean(event) && payload.to === result.title,
        detail: event
          ? `entity_events #${event.id}：title_reset（${String(payload.from ?? '')} → ${String(payload.to ?? '')}）`
          : '未找到 title_reset 事件',
      });
      checks.push({
        layer: 'projection',
        label: '重建后名称稳定（resolver 接管）',
        ok:
          Boolean(afterRecompute) &&
          afterRecompute!.title === snapshot!.title &&
          afterRecompute!.titleState === snapshot!.titleState,
        detail: `重建后 title=${afterRecompute?.title ?? 'missing'} / state=${afterRecompute?.titleState ?? 'missing'}`,
      });
      const search = searchFranchiseEntities(snapshot?.title ?? '', { limit: 100 }).items.some(
        (item) => item.key === franchiseKey,
      );
      checks.push({
        layer: 'search',
        label: '搜索投影',
        ok: search,
        detail: search
          ? `搜索「${snapshot?.title ?? ''}」可以命中 ${franchiseKey}`
          : `搜索「${snapshot?.title ?? ''}」没有命中 ${franchiseKey}`,
      });
      checks.push(
        apiDetailCheck(franchiseKey, (detail) => detail.title === snapshot?.title),
      );
      checks.push(cacheCheck(versionBefore));
      checks.push({
        layer: 'governance',
        label: '名称治理不改变成员治理状态',
        ok: afterRecompute?.state === stateBefore,
        detail: `治理状态 ${stateBefore} → ${afterRecompute?.state ?? 'missing'}（名称与成员分离）`,
      });
      checks.push(
        ...detectorChecks(franchiseKey, afterRecompute?.state ?? '', getDiagnosticsReport({ refresh: true })),
      );
      break;
    }
    default: {
      const exhaustive: never = input.kind;
      throwGovernanceError(`未知的治理动作：${String(exhaustive)}`, 'unknown_governance_action');
    }
  }

  const after = getDiagnosticsReport({ refresh: true });
  const sourceCheck = protectedSourcesCheck(sourcesBefore);
  enforceProtectedSources(sourceCheck);
  checks.push(sourceCheck);
  const verification = verificationFromChecks(checks, before, after);
  return {
    ok: verification.verified,
    repair: {
      kind: input.kind,
      label: FRANCHISE_GOVERNANCE_LABEL[input.kind],
      target: franchiseKey,
      ...(input.kind === 'exclude-franchise-member' ||
      input.kind === 'reopen-franchise-member' ||
      input.kind === 'supersede-franchise-member'
        ? input.seriesKey
          ? { value: input.seriesKey }
          : {}
        : input.title
          ? { value: input.title }
          : {}),
    },
    verification,
    report: after,
  };
}

/** 家族当前链接数（与详情 / 计数投影一致的读取路径）。 */
function linkCount(franchiseKey: string): number {
  return Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM franchise_series fs
        JOIN franchise_entities f ON f.id = fs.franchise_id
       WHERE f.key = :key`,
      { key: franchiseKey },
    )?.n ?? 0,
  );
}

/** franchise_entities.series_count（派生计数）。 */
function storedSeriesCount(franchiseKey: string): number {
  return Number(
    one<{ n: number }>('SELECT series_count AS n FROM franchise_entities WHERE key = :key', {
      key: franchiseKey,
    })?.n ?? 0,
  );
}

function seriesCountDrift(franchiseKey: string): number {
  return storedSeriesCount(franchiseKey) === linkCount(franchiseKey) ? 0 : 1;
}

