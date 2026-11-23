/**
 * Franchise 成员 / 名称治理（v1.7.0）。
 *
 * 只扩展 Franchise 的局部治理能力，不把 Analyzer 变成通用实体编辑器：
 *
 * - 成员移出（exclusion）：用户否决「Series X 属于 Franchise A」这一 membership 推断，
 *   写入 franchise_member_exclusions（真实 source-of-truth）并记录证据快照；
 *   重建时按「当前证据 − 人工排除」计算成员，resolver 不得静默加回；
 * - 撤销排除（reopen）：把排除标记为 revoked（保留 provenance），
 *   之后是否重新纳入完全由当前证据决定，不强制加回；
 * - 人工命名（adopt / reset）：复用 Title Review / Manual Override 语义，
 *   只修改 Franchise 的展示名与候选 provenance，不触碰成员构成。
 *
 * 三个语义边界：
 *   成员移出 ≠ Franchise Split
 *   撤销成员排除 ≠ 强制重新加入
 *   修正成员构成 ≠ 自动确认 Franchise
 */
import { nowIso, parseJsonColumn, toJson } from '../util.js';
import { ApiError } from '@bangumi-analyzer/shared';
import { activeManualAssignment } from './manualFranchiseProjection.js';
import { titleCandidatesForMutation } from './titleCandidates.js';
import { all, one, run, transaction } from './index.js';
import { recordMutation } from './mutation.js';
import {
  findSeriesSupersession,
  insertEvent,
  recomputeSeries,
  resolveEntityKey,
  resolveFranchiseTitle,
} from './series.js';
import type { TitleCandidate, TitleState } from '../series/title.js';

const TITLE_MAX_LENGTH = 120;

export interface FranchiseMemberExclusionRow {
  id: number;
  franchise_id: number;
  series_id: number;
  state: string;
  reason: string;
  evidence: string;
  actor: string;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface FranchiseMemberExclusionEntry {
  seriesKey: string;
  seriesTitle: string;
  state: 'active' | 'revoked';
  reason: string;
  evidence: string;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

/** Franchise 详情页展示用的排除记录（含已撤销的 provenance）。 */
export function listFranchiseMemberExclusions(franchiseId: number): FranchiseMemberExclusionEntry[] {
  const rows = all<
    FranchiseMemberExclusionRow & { series_key: string | null; series_title: string | null }
  >(
    `SELECT x.*, e.key AS series_key, e.title AS series_title
       FROM franchise_member_exclusions x
       LEFT JOIN series_entities e ON e.id = x.series_id
      WHERE x.franchise_id = :franchiseId
      ORDER BY x.state = 'active' DESC, x.created_at DESC, x.id DESC`,
    { franchiseId },
  );
  return rows.map((row) => ({
    seriesKey: row.series_key ?? `#${row.series_id}`,
    seriesTitle: row.series_title ?? `未知系列 #${row.series_id}`,
    state: row.state === 'active' ? 'active' : 'revoked',
    reason: row.reason,
    evidence: row.evidence,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  }));
}

export type FranchiseGovernanceFailureCode =
  | 'franchise_not_found'
  | 'series_not_found'
  | 'not_a_member'
  | 'already_excluded'
  | 'not_excluded'
  | 'last_member'
  | 'invalid_title'
  | 'not_manual';

export type FranchiseMemberResult =
  | {
      ok: true;
      franchiseKey: string;
      seriesKey: string;
      membership: 'excluded' | 'reopened';
      /** 操作后该系列是否仍/重新属于该家族（由当前证据决定）。 */
      isMember: boolean;
      state: string;
    }
  | { ok: false; code: FranchiseGovernanceFailureCode; message: string };

export type FranchiseTitleResult =
  | { ok: true; key: string; title: string; titleState: string; previousTitle: string }
  | { ok: false; code: FranchiseGovernanceFailureCode; message: string };

function memberCount(franchiseId: number): number {
  return Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM franchise_series
        WHERE franchise_id = :id AND state <> 'conflict'`,
      { id: franchiseId },
    )?.n ?? 0,
  );
}

function isMemberSeries(franchiseId: number, seriesId: number): boolean {
  return Boolean(
    one<{ n: number }>(
      `SELECT 1 AS n FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId`,
      { id: franchiseId, seriesId },
    ),
  );
}

/**
 * 移出家族成员：否决「Series X 属于 Franchise A」这一 membership 推断。
 *
 * - 写入 franchise_member_exclusions（真实治理状态，含证据快照），不是 UI 隐藏；
 * - 家族状态从 confirmed / rejected 回到待重新评估（candidate），绝不自动确认；
 * - 不删除 Series / Subject / Collection / Relation / identity，也不自动创建新家族。
 */
export function excludeFranchiseMember(
  franchiseKey: string,
  seriesKey: string,
  reason = '',
): FranchiseMemberResult {
  const franchise = resolveEntityKey('franchise', franchiseKey);
  if (!franchise) return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  const series = resolveEntityKey('series', seriesKey);
  if (!series) return { ok: false, code: 'series_not_found', message: '未找到该系列' };
  if (activeManualAssignment(series.id)?.franchise_id===franchise.id) {
    throw new ApiError('该成员由人工指定，请使用「撤销指定」。',{code:'manual_assignment_exists',status:409,dataIntact:true});
  }

  const franchiseRow = one<{ id: number; key: string; title: string; state: string }>(
    'SELECT id, key, title, state FROM franchise_entities WHERE id = :id',
    { id: franchise.id },
  );
  if (!franchiseRow) {
    return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  }
  const active = one<{ id: number }>(
    `SELECT id FROM franchise_member_exclusions
      WHERE franchise_id = :id AND series_id = :seriesId AND state = 'active'`,
    { id: franchiseRow.id, seriesId: series.id },
  );
  if (active) {
    return { ok: false, code: 'already_excluded', message: '该系列已经被移出这个家族' };
  }
  const link = one<{ state: string; evidence: string }>(
    `SELECT state, evidence FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId`,
    { id: franchiseRow.id, seriesId: series.id },
  );
  if (!link) {
    return { ok: false, code: 'not_a_member', message: '该系列当前不属于这个家族，无需移出' };
  }
  if (memberCount(franchiseRow.id) <= 1) {
    return {
      ok: false,
      code: 'last_member',
      message: '这是该家族最后一个成员：移出后家族将不再包含任何系列，请改用「否决该家族」。',
    };
  }

  const seriesRow = one<{ key: string; title: string }>(
    'SELECT key, title FROM series_entities WHERE id = :id',
    { id: series.id },
  );
  const members = all<{ key: string; title: string }>(
    `SELECT e.key, e.title FROM franchise_series fs
       JOIN series_entities e ON e.id = fs.series_id
      WHERE fs.franchise_id = :id AND fs.state <> 'conflict'
      ORDER BY fs.series_id`,
    { id: franchiseRow.id },
  );
  const timestamp = nowIso();
  const demote = franchiseRow.state === 'confirmed' || franchiseRow.state === 'rejected';

  transaction(() => {
    run(
      `INSERT INTO franchise_member_exclusions
         (franchise_id, series_id, state, reason, evidence, actor, created_at)
       VALUES (:franchiseId, :seriesId, 'active', :reason, :evidence, 'user', :ts)`,
      {
        franchiseId: franchiseRow.id,
        seriesId: series.id,
        reason,
        evidence: toJson({
          franchise: { key: franchiseRow.key, title: franchiseRow.title, state: franchiseRow.state },
          series: { key: seriesRow?.key ?? series.key, title: seriesRow?.title ?? '' },
          link: { state: link.state, evidence: parseJsonColumn<unknown>(link.evidence, {}) },
          members,
          decidedAt: timestamp,
        }),
        ts: timestamp,
      },
    );
    if (demote) {
      // 成员构成变了：之前的确认 / 否决不再对应现在的事实，回到可重新评估状态。
      run(
        `UPDATE franchise_entities
           SET state = 'candidate', updated_at = :ts, revision = revision + 1
         WHERE id = :id`,
        { id: franchiseRow.id, ts: timestamp },
      );
      run(
        `UPDATE franchise_series SET state = 'candidate'
          WHERE franchise_id = :id AND state = 'confirmed'`,
        { id: franchiseRow.id },
      );
    }
    insertEvent(
      'franchise',
      franchiseRow.id,
      'member_excluded',
      {
        seriesKey: seriesRow?.key ?? series.key,
        seriesTitle: seriesRow?.title ?? '',
        previousState: franchiseRow.state,
        reason,
      },
      timestamp,
    );
    recomputeSeries();
    recordMutation('governance', `exclude-franchise-member:${franchiseRow.key}/${series.key}`);
  });
  const after = one<{ state: string }>('SELECT state FROM franchise_entities WHERE id = :id', {
    id: franchiseRow.id,
  });
  return {
    ok: true,
    franchiseKey: franchiseRow.key,
    seriesKey: series.key,
    membership: 'excluded',
    isMember: isMemberSeries(franchiseRow.id, series.id),
    state: after?.state ?? franchiseRow.state,
  };
}

/**
 * 撤销成员排除：删除「当前生效的否决」，按当前最新证据重新评估 membership。
 *
 * - 原 exclusion 行保留为 revoked（reason / evidence / 时间不丢失）；
 * - 不强制把 Series 加回：是否重新纳入由 resolver 的当前证据决定；
 * - 不产生自动 Confirm，治理状态仍由用户决定。
 */
export interface FranchiseSupersedeResult {
  ok: boolean;
  code?:
    | 'franchise_not_found'
    | 'series_not_found'
    | 'not_confirmed'
    | 'not_a_member'
    | 'no_supersession'
    | 'target_already_member';
  message?: string;
  franchiseKey?: string;
  fromKey?: string;
  toKey?: string;
  state?: string;
}

/**
 * v1.8.4：迁移已被取代的家族成员（identity supersession）。
 *
 * 这是唯一允许的「成员身份更新」动作，且只表达一种被生命周期证据证明的情况：
 * `from` 是事故重建后被回收的旧身份，`to` 是同一真实 Series 的恢复身份。
 *
 * - 只作用于 **confirmed** Franchise（未确认家族的 stale 链接由重建自动收敛）；
 * - `to` 由 `findSeriesSupersession` 推导，**不接受用户输入**；
 * - 不做 Merge / Split / 任意成员分配；
 * - 保持 Franchise 的 confirmed 状态（身份更正，不是成员增减）。
 */
export function supersedeFranchiseMember(
  franchiseKey: string,
  fromSeriesKey: string,
  reason = '',
): FranchiseSupersedeResult {
  const franchise = resolveEntityKey('franchise', franchiseKey);
  if (!franchise) return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  const franchiseRow = one<{ id: number; key: string; title: string; state: string }>(
    'SELECT id, key, title, state FROM franchise_entities WHERE id = :id',
    { id: franchise.id },
  );
  if (!franchiseRow) return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  if (franchiseRow.state !== 'confirmed') {
    return {
      ok: false,
      code: 'not_confirmed',
      message: '只有已确认的家族需要手动迁移被取代的成员身份；未确认家族的成员链接由重建自动收敛。',
    };
  }

  const from = one<{ id: number; key: string; title: string; state: string }>(
    'SELECT id, key, title, state FROM series_entities WHERE key = :key',
    { key: fromSeriesKey },
  );
  if (!from) return { ok: false, code: 'series_not_found', message: '未找到该系列' };
  if (activeManualAssignment(from.id)?.franchise_id===franchise.id) {
    throw new ApiError('人工指定的旧身份须先明确撤销，再指定有效身份。',{code:'manual_assignment_exists',status:409,dataIntact:true});
  }
  const link = one<{ state: string }>(
    'SELECT state FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId',
    { id: franchiseRow.id, seriesId: from.id },
  );
  if (!link) return { ok: false, code: 'not_a_member', message: '该系列当前不属于这个家族' };

  const supersession = findSeriesSupersession(from.key);
  if (!supersession) {
    return {
      ok: false,
      code: 'no_supersession',
      message:
        '缺少可验证的身份谱系（rebuilt-into alias / merged 事件 / 成员一致性），不能迁移成员身份。',
    };
  }
  const to = supersession.to;
  const manualTarget=activeManualAssignment(to.id);
  if(manualTarget && manualTarget.franchise_id!==franchise.id) {
    throw new ApiError('新身份已有其他人工归属，不能静默搬移。',{code:'manual_assignment_exists',status:409,dataIntact:true});
  }
  const targetExists = Number(
    one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId',
      { id: franchiseRow.id, seriesId: to.id },
    )?.n ?? 0,
  );
  if (targetExists > 0) {
    return {
      ok: false,
      code: 'target_already_member',
      message: `家族已经包含恢复后的身份「${to.title}」，无需迁移。`,
    };
  }

  const timestamp = nowIso();
  const inheritedState = link.state === 'conflict' ? 'candidate' : link.state;
  transaction(() => {
    run('DELETE FROM franchise_series WHERE franchise_id = :id AND series_id = :seriesId', {
      id: franchiseRow.id,
      seriesId: from.id,
    });
    run(
      `INSERT INTO franchise_series (franchise_id, series_id, state, evidence)
       VALUES (:franchiseId, :seriesId, :state, :evidence)`,
      {
        franchiseId: franchiseRow.id,
        seriesId: to.id,
        state: inheritedState,
        evidence: toJson({
          supersededFrom: {
            key: from.key,
            id: from.id,
            title: from.title,
            reason: reason.slice(0, 240),
            supersededAt: timestamp,
            previousLinkState: link.state,
            lifecycle: {
              aliasReason: supersession.provenance.aliasReason,
              mergedEventId: supersession.provenance.mergedEventId,
              mergedAt: supersession.provenance.mergedAt,
              restoredEventId: supersession.provenance.restoredEventId,
            },
            members: supersession.members.members,
          },
        }),
      },
    );
    insertEvent(
      'franchise',
      franchiseRow.id,
      'member_superseded',
      {
        franchiseKey: franchiseRow.key,
        from: { key: from.key, id: from.id, title: from.title },
        to: { key: to.key, id: to.id, title: to.title },
        reason: reason.slice(0, 240),
        provenance: {
          aliasReason: supersession.provenance.aliasReason,
          mergedEventId: supersession.provenance.mergedEventId,
          mergedAt: supersession.provenance.mergedAt,
          restoredEventId: supersession.provenance.restoredEventId,
          members: supersession.members.members,
          exact: supersession.members.exact,
          high: supersession.members.high,
        },
      },
      timestamp,
    );
    recomputeSeries();
    recordMutation(
      'governance',
      `supersede-franchise-member:${franchiseRow.key}/${from.key}->${to.key}`,
    );
  });
  const after = one<{ state: string }>('SELECT state FROM franchise_entities WHERE id = :id', {
    id: franchiseRow.id,
  });
  return {
    ok: true,
    franchiseKey: franchiseRow.key,
    fromKey: from.key,
    toKey: to.key,
    state: after?.state ?? franchiseRow.state,
  };
}

/**
 * 撤销成员排除：删除「当前生效的否决」，按当前最新证据重新评估 membership。
 *
 * - 原 exclusion 行保留为 revoked（reason / evidence / 时间不丢失）；
 * - 不强制把 Series 加回：是否重新纳入由 resolver 的当前证据决定；
 * - 不产生自动 Confirm，治理状态仍由用户决定。
 */
export function reopenFranchiseMember(
  franchiseKey: string,
  seriesKey: string,
  reason = '',
): FranchiseMemberResult {
  const franchise = resolveEntityKey('franchise', franchiseKey);
  if (!franchise) return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  const series = resolveEntityKey('series', seriesKey);
  if (!series) return { ok: false, code: 'series_not_found', message: '未找到该系列' };
  const franchiseRow = one<{ id: number; key: string }>(
    'SELECT id, key FROM franchise_entities WHERE id = :id',
    { id: franchise.id },
  );
  if (!franchiseRow) {
    return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  }
  const exclusion = one<FranchiseMemberExclusionRow>(
    `SELECT * FROM franchise_member_exclusions
      WHERE franchise_id = :id AND series_id = :seriesId AND state = 'active'
      ORDER BY id DESC LIMIT 1`,
    { id: franchiseRow.id, seriesId: series.id },
  );
  if (!exclusion) {
    return { ok: false, code: 'not_excluded', message: '该系列当前没有被移出这个家族' };
  }
  const seriesRow = one<{ key: string; title: string }>(
    'SELECT key, title FROM series_entities WHERE id = :id',
    { id: series.id },
  );
  const timestamp = nowIso();

  transaction(() => {
    run(
      `UPDATE franchise_member_exclusions
         SET state = 'revoked', revoked_at = :ts, revoked_reason = :reason
       WHERE id = :id`,
      { id: exclusion.id, ts: timestamp, reason },
    );
    insertEvent(
      'franchise',
      franchiseRow.id,
      'member_reopened',
      {
        seriesKey: seriesRow?.key ?? series.key,
        seriesTitle: seriesRow?.title ?? '',
        reason,
        trigger: 'manual',
        previousReason: exclusion.reason,
        excludedAt: exclusion.created_at,
      },
      timestamp,
    );
    // 按当前证据重新评估：不强制加回，也不自动确认
    recomputeSeries();
    recordMutation('governance', `reopen-franchise-member:${franchiseRow.key}/${series.key}`);
  });
  const after = one<{ state: string }>('SELECT state FROM franchise_entities WHERE id = :id', {
    id: franchiseRow.id,
  });
  return {
    ok: true,
    franchiseKey: franchiseRow.key,
    seriesKey: series.key,
    membership: 'reopened',
    isMember: isMemberSeries(franchiseRow.id, series.id),
    state: after?.state ?? 'candidate',
  };
}

/**
 * 人工设置家族名称（复用 Title Review / Manual Override 语义）。
 *
 * - 只写 canonical title + provenance，不触碰成员构成；
 * - manual 状态下自动 resolver 只能提出候选，不得覆盖；
 * - 名称会立即进入列表 / 详情 / 搜索投影 / API。
 */
export function adoptFranchiseTitle(
  franchiseKey: string,
  title: string,
  reason = '',
): FranchiseTitleResult {
  const franchise = resolveEntityKey('franchise', franchiseKey);
  if (!franchise) return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  const row = one<{ id: number; key: string; title: string; title_state: string; title_candidates: string }>(
    'SELECT id, key, title, title_state, title_candidates FROM franchise_entities WHERE id = :id',
    { id: franchise.id },
  );
  if (!row) return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  const candidates = titleCandidatesForMutation(row.title_candidates);
  if (!candidates) return { ok: false, code: 'invalid_title', message: '历史候选证据结构异常，已保留原始数据并停止名称写入' };

  const rawInput = String(title ?? '');
  if (/[\u0000-\u001f\u007f]/.test(rawInput)) {
    return { ok: false, code: 'invalid_title', message: '名称不能包含控制字符' };
  }
  const nextTitle = rawInput.trim().replace(/\s{2,}/g, ' ');
  if (!nextTitle) return { ok: false, code: 'invalid_title', message: '名称不能为空' };
  if (nextTitle.length > TITLE_MAX_LENGTH) {
    return {
      ok: false,
      code: 'invalid_title',
      message: `名称不能超过 ${TITLE_MAX_LENGTH} 个字符`,
    };
  }

  const timestamp = nowIso();
  transaction(() => {
    const manualCandidate: TitleCandidate = {
      title: nextTitle,
      source: 'manual',
      state: 'manual',
      evidence: '人工确认',
      valid: true,
      support: 1,
      coverage: 0,
    };
    const kept = candidates.filter(
      (candidate) => !(candidate.source === 'manual' && candidate.title === nextTitle),
    );
    run(
      `UPDATE franchise_entities SET
         title = :title, title_state = 'manual', title_source = 'manual',
         title_candidates = :candidates, updated_at = :ts, revision = revision + 1
       WHERE id = :id`,
      { id: row.id, title: nextTitle, candidates: toJson([manualCandidate, ...kept]), ts: timestamp },
    );
    insertEvent(
      'franchise',
      row.id,
      'title_manual',
      { from: row.title, fromState: row.title_state, to: nextTitle, mode: 'custom', reason },
      timestamp,
    );
    // 立即重建：确认重算不会覆盖人工名称（也不改变成员构成）
    recomputeSeries();
    recordMutation('governance', `franchise-title-override:${row.key}`);
  });
  return {
    ok: true,
    key: row.key,
    title: nextTitle,
    titleState: 'manual',
    previousTitle: row.title,
  };
}

/**
 * 恢复自动解析：清除人工名称，立即用当前证据重新推导展示名。
 *
 * 只影响名称与候选 provenance，不修改成员构成 / Series / Subject / Relation。
 */
export function resetFranchiseTitle(franchiseKey: string, reason = ''): FranchiseTitleResult {
  const franchise = resolveEntityKey('franchise', franchiseKey);
  if (!franchise) return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  const row = one<{ id: number; key: string; title: string; title_state: string }>(
    'SELECT id, key, title, title_state FROM franchise_entities WHERE id = :id',
    { id: franchise.id },
  );
  if (!row) return { ok: false, code: 'franchise_not_found', message: '未找到该作品家族' };
  if (row.title_state !== 'manual') {
    return { ok: false, code: 'not_manual', message: '当前名称不是人工设置状态，无需恢复' };
  }
  const seriesIds = all<{ series_id: number }>(
    `SELECT series_id FROM franchise_series
      WHERE franchise_id = :id AND state <> 'conflict'
      ORDER BY series_id`,
    { id: row.id },
  ).map((entry) => Number(entry.series_id));

  // 用与重建完全相同的规则重新解析（existing 只用于稳定性比较，不带 manual 锁）
  const resolution = resolveFranchiseTitle(seriesIds, {
    title: row.title,
    state: 'provisional',
    source: 'auto',
  });
  const timestamp = nowIso();
  transaction(() => {
    run(
      `UPDATE franchise_entities SET
         title = :title, title_state = :titleState, title_source = :titleSource,
         title_candidates = :candidates, updated_at = :ts, revision = revision + 1
       WHERE id = :id`,
      {
        id: row.id,
        title: resolution.title,
        titleState: resolution.state,
        titleSource: resolution.source,
        candidates: toJson(
          resolution.proposed ? [...resolution.candidates, resolution.proposed] : resolution.candidates,
        ),
        ts: timestamp,
      },
    );
    insertEvent(
      'franchise',
      row.id,
      'title_reset',
      { from: row.title, to: resolution.title, reason },
      timestamp,
    );
    recomputeSeries();
    recordMutation('governance', `franchise-title-reset:${row.key}`);
  });
  return {
    ok: true,
    key: row.key,
    title: resolution.title,
    titleState: resolution.state,
    previousTitle: row.title,
  };
}

/** 当前治理状态（验证层读取真实状态用）。 */
export function franchiseGovernanceSnapshot(franchiseId: number): {
  state: string;
  title: string;
  titleState: TitleState;
  titleSource: string;
  memberSeriesIds: number[];
  activeExclusions: number[];
} | null {
  const row = one<{ state: string; title: string; title_state: TitleState; title_source: string }>(
    'SELECT state, title, title_state, title_source FROM franchise_entities WHERE id = :id',
    { id: franchiseId },
  );
  if (!row) return null;
  return {
    state: row.state,
    title: row.title,
    titleState: row.title_state,
    titleSource: row.title_source,
    memberSeriesIds: all<{ series_id: number }>(
      `SELECT series_id FROM franchise_series WHERE franchise_id = :id AND state <> 'conflict' ORDER BY series_id`,
      { id: franchiseId },
    ).map((entry) => Number(entry.series_id)),
    activeExclusions: all<{ series_id: number }>(
      `SELECT series_id FROM franchise_member_exclusions WHERE franchise_id = :id AND state = 'active'`,
      { id: franchiseId },
    ).map((entry) => Number(entry.series_id)),
  };
}
