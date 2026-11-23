import { supportsQualitySchema } from '../db/schema.js';
/**
 * 数据中枢检测器（v1.6.0）。
 *
 * 设计原则：
 * - 只报告有真实数据依据的问题（provisional / unresolved / empty 都不是 error）；
 * - 每条问题都带证据（具体数字与样本）、影响范围（下游 projection / API / UI）；
 * - 能修的问题给出修复动作（repair + preview），不能修的说明等待什么外部条件；
 * - 检测 SQL 与产品真实读取路径保持一致（例如 NSFW 直接跑产品的 listSeries / listSubjects）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DiagnosticAction,
  DiagnosticIssue,
  DiagnosticModule,
  DiagnosticRepairPreview,
} from '@bangumi-analyzer/shared';
import { paths } from '../config.js';
import { activeRejections, candidateKeyOf, decisionEvidence } from '../db/candidates.js';
import { all, integrityCheck, one, schemaVersion, dataVersion } from '../db/index.js';
import { franchiseAverageRateSql } from '../db/franchiseAverage.js';
import { lastMutation } from '../db/mutation.js';
import { titleCandidatesForMutation } from '../db/titleCandidates.js';
import { getFranchiseDetail, listFranchises, listSeries, listSubjects } from '../db/query.js';
import { franchiseSearchSelfCheck, seriesSearchSelfCheck } from '../db/ipSearch.js';
import {
  findSeriesSupersession,
  planEntityLifecycle,
  type EntityLifecyclePlan,
} from '../db/series.js';
import type { Detector, DetectorContext, DetectorResult } from './types.js';
import { inspectForeignKeys } from './foreignKeys.js';
import { inspectSourceSnapshots } from './sourceSnapshots.js';
import { inspectSeriesCollectionStatus, seriesCollectionStatusIssues } from '../db/seriesCollectionStatus.js';
import { inspectFranchiseLinkCounts, franchiseLinkCountIssues } from '../db/franchiseLinkCounts.js';
import { inspectSyncEvidence, syncEvidenceIssues } from './syncEvidence.js';
import { countSeriesKeyDrift, sampleSeriesKeyDrift } from './seriesKeyDrift.js';
import { syncFailureExplanation } from '../sync/failureExplanation.js';

/** 「重建派生数据」的通用预览（各问题填充 current 后使用）。 */
function recomputePreview(current: string): DiagnosticRepairPreview {
  return {
    current,
    next: '按当前真实数据重新计算全部派生投影（Series / Franchise / subjects.series_key / 计数）',
    reason: '派生数据必须与 source-of-truth（Subjects / Collections / Relations / 人工确认标题）保持一致',
    source: '重新运行 Series / Franchise 引擎（recomputeSeries）',
    directlyChanges: ['派生投影（系统自动重算，不需要人工维护）'],
    derivedChanges: [
      'Series 实体与成员计数',
      'Franchise 对账与链接',
      'subjects.series_key 归属缓存',
      'Series / Franchise 搜索投影（运行时读取，自动生效）',
      'API / UI 中的系列与家族页面',
    ],
    untouched: [
      'Subject 本体（标题之外的身份字段）',
      'Collection（评分 / 进度 / 状态）',
      'Relation（官方关系原始数据）',
      '人工确认的标题（manual 状态不参与自动重命名）',
    ],
    chain: [
      { layer: 'source', label: '真实数据', detail: 'Subjects / Collections / Relations / 人工确认标题保持不动' },
      { layer: 'projection', label: 'Series / Franchise 引擎重建', detail: '按当前证据重新计算成员归属、计数与家族链接' },
      { layer: 'projection', label: '归属缓存更新', detail: 'subjects.series_key 与派生计数写回数据库' },
      { layer: 'search', label: '搜索投影生效', detail: '搜索在查询时读取最新标题与成员，不需要重建索引' },
      { layer: 'api', label: 'API / UI', detail: 'Series / Franchise 列表与详情立即读到新结果' },
      { layer: 'cache', label: '缓存失效', detail: '数据版本推进，统计与数据中枢报告缓存失效' },
    ],
  };
}

/**
 * v1.8.3（B2）：alias 生命周期修复预览。
 *
 * 预览直接来自与 Execute 共用的只读计划（planEntityLifecycle）：
 * 将恢复哪些历史实体、重定向哪些 alias、退役哪些 alias，以及每项依据。
 */
function aliasLifecyclePreview(
  deadAliases: Array<Record<string, unknown>>,
  plan: EntityLifecyclePlan | null,
): DiagnosticRepairPreview {
  const base = recomputePreview(`${deadAliases.length} 个旧 key 别名指向失效实体`);
  if (!plan) return base;
  const lines: string[] = [];
  for (const item of plan.revivals) {
    lines.push(
      `恢复历史实体 ${item.key}「${item.title}」（依据：历史成员与新解析成员高度一致，${item.members} 个成员）`,
    );
  }
  for (const item of plan.rebuiltDuplicates) {
    lines.push(`回收同身份重建副本 ${item.key} → 由 ${item.toKey} 继续承担该身份`);
  }
  for (const item of plan.aliasRedirects) {
    lines.push(`重定向 alias ${item.aliasKey} → ${item.toKey}（沿合并 / 拆分谱系找到 live 后继）`);
  }
  for (const item of plan.aliasRetirements) {
    lines.push(`退役 alias ${item.aliasKey}（无合法 live 后继；旧 key 之后诚实 404，事件留痕）`);
  }
  if (lines.length === 0) {
    lines.push('没有可执行的 alias 生命周期变更（重新检测确认当前状态）');
  }
  return {
    ...base,
    next: `按身份一致性恢复 ${plan.revivals.length} 个历史实体、重定向 ${plan.aliasRedirects.length} 条、退役 ${plan.aliasRetirements.length} 条别名`,
    reason:
      'entity_aliases 是派生解析投影，必须始终指向 live 实体；历史身份优先按成员证据恢复，无法合法重定向时明确退役，而不是保留悬空 alias',
    derivedChanges: [...base.derivedChanges, ...lines],
  };
}

/** 内联预览统一走这里，保证 chain 的 layer 收窄到契约枚举。 */
function preview(input: DiagnosticRepairPreview): DiagnosticRepairPreview {
  return input;
}

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

/** 解析 title_candidates JSON（容错：无法解析时返回空列表，由 unparsable 检测项负责报告）。 */
function parseCandidateList(value: unknown): Array<{ title: string; valid: boolean }> {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => entry as { title?: unknown; valid?: unknown })
      .filter((entry) => typeof entry?.title === 'string')
      .map((entry) => ({ title: String(entry.title), valid: entry.valid === true }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ 存储与同步 */

const storageDetector: Detector = (): DetectorResult => {
  const quickCheck = integrityCheck();
  const foreignKeys = inspectForeignKeys();
  const mutation = lastMutation();
  const subjects = toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM subjects')?.n);
  const collections = toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM collections')?.n);
  const relations = toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM subject_relations')?.n);
  const issues: DiagnosticIssue[] = [];

  if (quickCheck !== 'ok') {
    issues.push({
      id: 'storage.integrity',
      detector: 'storage.database',
      category: '存储与数据库',
      severity: 'error',
      title: 'SQLite 完整性检查未通过',
      explanation:
        '数据库文件存在结构性问题。这类问题无法由数据中枢在应用内安全修复，请先到「设置 → 数据管理」创建备份，再使用历史备份恢复或交由开发排查。',
      evidence: [{ label: 'PRAGMA quick_check', value: quickCheck }],
      impact: [
        { kind: 'storage', label: '本地数据库文件' },
        { kind: 'api', label: '所有读取接口' },
        { kind: 'ui', label: '全部页面' },
      ],
      affected: [{ label: 'data/bangumi.db' }],
      affectedCount: 1,
      actions: [],
      waitingFor: '需要人工备份 / 恢复或开发排查，数据中枢不会自动改动数据库文件',
    });
  }

  if (foreignKeys.violationCount > 0) {
    issues.push({
      id: 'storage.foreign-key-violations', detector: 'storage.database', category: '存储与数据库', severity: 'error',
      title: '存在违反已声明外键的记录',
      explanation: '子记录引用的父记录在本地不存在，违反 SQLite 已声明的约束；quick_check 通过也不能排除此问题。数量按失效引用计，一行可违反多个外键，不等于作品数。没有声明外键的 relation-only 与历史引用不据此判错。',
      evidence: [{label:'检查依据',value:'SQLite foreign_key_check 与当前声明的外键定义'}, {label:'处理边界',value:'缺父记录不能证明应补父或删子；不提供自动修复'}],
      impact: [{kind:'storage',label:'本地引用完整性'}, {kind:'projection',label:'依赖引用的派生投影'}, {kind:'api',label:'关联查询可能漏项'}],
      affected: [], affectedCount: foreignKeys.violationCount, actions: [], foreignKeys,
      waiting: {kind:'manual-review',label:'需要人工核查或补取可靠来源',detail:'先保留备份和证据，核实缺失父记录及来源。不能仅为减少异常数删除子记录、补造父记录或覆盖人工决定；经授权处理后须强制重新检测。'},
    });
  }
  return {
    module: {
      id: 'storage',
      label: '存储与数据库',
      description: 'SQLite quick_check、已声明外键、schema 版本与数据规模',
      status: quickCheck !== 'ok' || foreignKeys.violationCount > 0 ? 'error' : foreignKeys.foreignKeysEnabled ? 'ok' : 'attention',
      foreignKeys,
      checked: subjects + collections + relations,
      details: [
        `quick_check = ${quickCheck}`,
        `schema 版本 ${schemaVersion()}`,
        `数据版本 ${dataVersion()}`,
        `${subjects} Subjects · ${collections} Collections · ${relations} Relations`,
        `最近一次数据变更：${mutation.scope ?? '暂无记录'}${mutation.at ? ` · ${mutation.at}` : ''}`,
      ],
    },
    issues,
  };
};

const syncDetector: Detector = (): DetectorResult => {
  const latest = one<{
    id: number;
    mode: string;
    status: string;
    phase: string;
    started_at: string;
    finished_at: string | null;
    error: string | null;
    warnings: string;
  }>(
    `SELECT id, mode, status, phase, started_at, finished_at, error, warnings
     FROM sync_runs ORDER BY id DESC LIMIT 1`,
  );
  const recent = toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM sync_runs')?.n);
  const issues: DiagnosticIssue[] = [];
  const details: string[] = [];
  let status: DiagnosticModule['status'] = 'ok';

  if (latest) {
    details.push(
      `最近一次同步：#${latest.id} ${latest.mode} · ${latest.status} · ${latest.finished_at ?? latest.started_at}`,
    );
    if (latest.status === 'error') {
      status = 'attention';
      issues.push({
        id: 'sync.last-failed',
        detector: 'sync.state',
        category: '同步状态',
        severity: 'external',
        title: '最近一次同步失败',
        explanation: syncFailureExplanation(latest.warnings),
        evidence: [
          { label: `同步 #${latest.id}`, value: `${latest.status} / ${latest.phase}` },
          { label: '错误', value: latest.error ?? '未知错误' },
        ],
        impact: [{ kind: 'api', label: '同步未完整完成，需按本次提交与恢复记录核查' }],
        affected: [{ label: `同步记录 #${latest.id}` }],
        affectedCount: 1,
        actions: [
          {
            kind: 'link',
            label: '到设置页重新同步',
            href: '/settings?tab=bangumi',
            hint: '同步是外部数据入口，数据中枢不会自动发起网络请求',
          },
        ],
        waitingFor: '核查本次提交与派生恢复状态，再处理错误或重新同步',
        waiting: {
          kind: 'none',
          label: '需要核查同步结果',
          detail: '失败可能发生在来源提交之前或之后；数据中枢不会自动重新同步或撤销已提交来源。',
        },
      });
    }
    if (
      latest.status === 'running' &&
      Date.now() - Date.parse(latest.started_at) > 30 * 60 * 1000
    ) {
      status = 'attention';
      issues.push({
        id: 'sync.stuck',
        detector: 'sync.state',
        category: '同步状态',
        severity: 'suspicious',
        title: '同步长时间没有结束',
        explanation:
          '同步记录停留在运行状态超过 30 分钟。可能是进程被关闭或网络请求挂起；取消该次同步后重新发起即可，已写入的数据保持有效。',
        evidence: [
          { label: `同步 #${latest.id}`, value: `${latest.status} / ${latest.phase}` },
          { label: '开始于', value: latest.started_at },
        ],
        impact: [{ kind: 'api', label: '后续阶段（详情 / 关系 / 系列计算）未完成' }],
        affected: [{ label: `同步记录 #${latest.id}` }],
        affectedCount: 1,
        actions: [{ kind: 'link', label: '到设置页处理', href: '/settings?tab=bangumi' }],
        waitingFor: '需要用户取消或重新发起同步',
        waiting: {
          kind: 'none',
          label: '需要你处理',
          detail: '到设置页取消该次同步后重新发起；已写入的数据保持有效。',
        },
      });
    }
  } else {
    details.push('还没有同步记录');
  }

  const localEvidence = inspectSyncEvidence();
  issues.push(...syncEvidenceIssues(localEvidence));
  if (localEvidence.errors) status = 'error';
  else if (localEvidence.unknown && status === 'ok') status = 'attention';
  details.push(`本地历史检查 ${localEvidence.runs} 次运行 / ${localEvidence.stages} 条暂存；success 不是远端完整证明。`);
  return {
    module: {
      id: 'sync',
      label: '同步状态',
      description: '最近一次同步结果与卡住的任务',
      status,
      checked: recent,
      details,
    },
    issues,
  };
};

/* ------------------------------------------------- Series / Franchise 派生 */

const seriesDetector: Detector = (): DetectorResult => {
  const seriesCount = toNumber(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM series_entities WHERE state <> 'stale'`)?.n,
  );
  const staleCount = toNumber(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM series_entities WHERE state = 'stale'`)?.n,
  );
  const issues: DiagnosticIssue[] = [];
  let status: DiagnosticModule['status'] = 'ok';

  const driftTotal = countSeriesKeyDrift();
  if (driftTotal > 0) {
    status = 'error';
    const samples = sampleSeriesKeyDrift();
    issues.push({
      id: 'series.key-drift',
      detector: 'series.entities',
      category: 'Series 派生数据',
      severity: 'error',
      title: '归属缓存与 Series 成员表不一致',
      explanation:
        '部分收藏条目的 subjects.series_key 归属缓存与 Series 成员表不一致。收藏库 / 画像的系列统计与系列页面读取的口径不同，必须重建派生数据。',
      evidence: [
        { label: '不一致条目', value: `${driftTotal} 条` },
        ...samples.map((row) => ({
          label: `#${row.id} ${row.title}`,
          value: `缓存 ${row.actual ?? '空'} → 实际 ${row.expected ?? '无归属'}`,
        })),
      ],
      impact: [
        { kind: 'projection', label: 'Series 归属缓存' },
        { kind: 'series', label: 'Series 列表 / 详情', href: '/series' },
        { kind: 'projection', label: '画像的系列统计' },
        { kind: 'search', label: 'Series 搜索', href: '/series' },
      ],
      affected: samples.map((row) => ({
        label: `#${row.id} ${row.title}`,
        detail: `缓存 ${row.actual ?? '空'} → 实际 ${row.expected ?? '无归属'}`,
        href: `/subjects/${row.id}`,
      })),
      affectedCount: driftTotal,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建 Series 派生数据',
          preview: recomputePreview(`${driftTotal} 条归属缓存与成员表不一致`),
        },
      ],
    });
  }

  const duplicateMembership = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT m.subject_id
           FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
          WHERE m.role = 'primary' AND e.state <> 'stale'
          GROUP BY m.subject_id HAVING COUNT(*) > 1)`,
    )?.n,
  );
  if (duplicateMembership > 0) {
    status = 'error';
    issues.push({
      id: 'series.duplicate-membership',
      detector: 'series.entities',
      category: 'Series 派生数据',
      severity: 'error',
      title: '同一作品同时属于多个 Series',
      explanation:
        '一个收藏条目同时被两个 Series 实体标记为正式成员。这会让系列页面重复展示同一部作品，需要重建派生数据消除重复归属。',
      evidence: [{ label: '重复归属的作品数', value: `${duplicateMembership} 条` }],
      impact: [
        { kind: 'series', label: 'Series 列表 / 详情', href: '/series' },
        { kind: 'ui', label: '作品详情中的系列入口' },
      ],
      affected: [],
      affectedCount: duplicateMembership,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建 Series 派生数据',
          preview: recomputePreview(`${duplicateMembership} 个作品存在重复归属`),
        },
      ],
    });
  }

  const counterDrift = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM series_entities e WHERE e.state <> 'stale' AND (
         e.member_count <> (SELECT COUNT(*) FROM series_entity_members m WHERE m.series_id = e.id AND m.role = 'primary')
         OR e.candidate_count <> (SELECT COUNT(*) FROM series_entity_members m WHERE m.series_id = e.id AND m.role = 'candidate')
         OR e.confirmed_count <> (SELECT COUNT(*) FROM series_entity_members m WHERE m.series_id = e.id AND m.role = 'primary' AND m.state = 'confirmed')
         OR e.collected_count <> (SELECT COUNT(*) FROM series_entity_members m JOIN collections c ON c.subject_id = m.subject_id WHERE m.series_id = e.id AND m.role = 'primary')
       )`,
    )?.n,
  );
  if (counterDrift > 0) {
    status = 'error';
    issues.push({
      id: 'series.counter-drift',
      detector: 'series.entities',
      category: 'Series 派生数据',
      severity: 'error',
      title: 'Series 计数与成员明细不一致',
      explanation:
        'Series 实体保存的成员计数与成员明细表对不上，会导致列表上的「N 部」与详情页展示不一致。',
      evidence: [{ label: '计数不一致的 Series', value: `${counterDrift} 个` }],
      impact: [
        { kind: 'series', label: 'Series 列表 / 详情', href: '/series' },
        { kind: 'api', label: 'Series API 的 memberCount / collectedCount' },
      ],
      affected: [],
      affectedCount: counterDrift,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建 Series 派生数据',
          preview: recomputePreview(`${counterDrift} 个 Series 的计数与成员明细不一致`),
        },
      ],
    });
  }

  const anchorMissing = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM series_entities e
        WHERE e.state <> 'stale' AND e.anchor_subject_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM series_entity_members m WHERE m.series_id = e.id AND m.subject_id = e.anchor_subject_id)`,
    )?.n,
  );
  if (anchorMissing > 0) {
    status = 'error';
    issues.push({
      id: 'series.anchor-missing',
      detector: 'series.entities',
      category: 'Series 派生数据',
      severity: 'suspicious',
      title: 'Series 的起点作品不在成员列表中',
      explanation:
        'Series 记录了一个起点作品（anchor），但该作品已不在成员列表里。展示与排序可能因此不稳定，重建派生数据可以恢复一致。',
      evidence: [{ label: '受影响的 Series', value: `${anchorMissing} 个` }],
      impact: [
        { kind: 'series', label: 'Series 详情排序与锚点', href: '/series' },
        { kind: 'projection', label: '成员展示顺序' },
      ],
      affected: [],
      affectedCount: anchorMissing,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建 Series 派生数据',
          preview: recomputePreview(`${anchorMissing} 个 Series 的起点作品缺失`),
        },
      ],
    });
  }

  const emptyTitle = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM series_entities WHERE state <> 'stale' AND trim(title) = ''`,
    )?.n,
  );
  if (emptyTitle > 0) {
    status = 'error';
    issues.push({
      id: 'series.empty-title',
      detector: 'series.entities',
      category: 'Series 派生数据',
      severity: 'error',
      title: 'Series 没有可展示的标题',
      explanation: 'Series 实体的标题为空，列表与搜索结果会出现无名条目。重建派生数据会按当前证据重新推导标题。',
      evidence: [{ label: '空标题 Series', value: `${emptyTitle} 个` }],
      impact: [
        { kind: 'series', label: 'Series 列表 / 详情', href: '/series' },
        { kind: 'search', label: 'Series 搜索', href: '/series' },
      ],
      affected: [],
      affectedCount: emptyTitle,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建 Series 派生数据',
          preview: recomputePreview(`${emptyTitle} 个 Series 标题为空`),
        },
      ],
    });
  }

  // Preserve the existing unsupported-Schema report error from the source-snapshot
  // detector later in this same full run. No partial report is returned/cached.
  const collectionStatus = supportsQualitySchema(schemaVersion()) ? inspectSeriesCollectionStatus() : null;
  if (collectionStatus) issues.push(...seriesCollectionStatusIssues(collectionStatus));
  if (collectionStatus?.driftCount) status = 'error';
  else if ((!collectionStatus || collectionStatus.blockedCount) && status === 'ok') status = 'attention';
  return {
    module: {
      id: 'series',
      label: 'Series 派生数据',
      description: '成员归属、计数、锚点与 titles 投影的一致性',
      status,
      checked: seriesCount,
      details: [
        `${seriesCount} 个 Series（非 stale）`,
        `保留的历史实体行（stale）：${staleCount} 条，不参与展示`,
        `归属缓存不一致：${driftTotal}`,
        `计数不一致：${counterDrift}`,
        ...(collectionStatus ? [`收藏状态分布：对账 ${collectionStatus.seriesScanned} 个，异常 ${collectionStatus.driftCount} 个，无法可靠判断 ${collectionStatus.blockedCount} 个`] : ['收藏状态分布未执行：Schema 未核验']),
      ],
    },
    issues,
  };
};

interface FranchiseSupersedeProposal {
  franchiseKey: string;
  fromKey: string;
  fromTitle: string;
  toKey: string;
  toTitle: string;
}

/**
 * v1.8.4：为 confirmed 家族中的 stale 链接查找**可验证**的身份迁移提议。
 * 没有 lifecycle 谱系的一律不产生提议（不允许靠 overlap / 标题相似度迁移）。
 */
function franchiseSupersedeProposals(): FranchiseSupersedeProposal[] {
  const rows = allSamples(
    `SELECT f.key AS franchise_key, e.key AS series_key
       FROM franchise_series fs
       JOIN franchise_entities f ON f.id = fs.franchise_id
       JOIN series_entities e ON e.id = fs.series_id
      WHERE f.state = 'confirmed' AND e.state = 'stale'
      ORDER BY f.key, e.key`,
  );
  const proposals = new Map<string, FranchiseSupersedeProposal>();
  for (const row of rows) {
    const supersession = findSeriesSupersession(String(row.series_key));
    if (!supersession) continue;
    proposals.set(`${String(row.franchise_key)}:${supersession.from.key}`, {
      franchiseKey: String(row.franchise_key),
      fromKey: supersession.from.key,
      fromTitle: supersession.from.title,
      toKey: supersession.to.key,
      toTitle: supersession.to.title,
    });
  }
  return [...proposals.values()];
}

/** 数据中枢里的「导向治理」动作：跳转到家族详情执行 supersede。 */
function supersedeLinkAction(proposal: FranchiseSupersedeProposal): DiagnosticAction {
  return {
    kind: 'link',
    label: `迁移已被取代的成员（${proposal.fromKey} → ${proposal.toKey}）`,
    href: `/franchises/${encodeURIComponent(proposal.franchiseKey)}`,
    hint:
      `在家族「${proposal.franchiseKey}」详情 → 身份冲突中执行「迁移已被取代的家族成员」` +
      '（仅在有 lifecycle 谱系证据时可用；该动作走 Preview → Execute → Verify）。',
  };
}

const franchiseDetector: Detector = (): DetectorResult => {
  const franchiseCount = toNumber(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM franchise_entities WHERE state <> 'stale'`)?.n,
  );
  const issues: DiagnosticIssue[] = [];
  let status: DiagnosticModule['status'] = 'ok';

  /*
   * v1.8.4：先取「具体是哪些 Franchise 漂移 + 是否由 stale 链接导致」。
   * 已确认且含 stale 链接的家族属于 identity governance，不允许用 generic recompute 假装可修。
   */
  const driftRows = allSamples(
    `SELECT f.key AS franchise_key, f.state AS franchise_state,
            (SELECT COUNT(*) FROM franchise_series fs
               JOIN series_entities e ON e.id = fs.series_id
              WHERE fs.franchise_id = f.id AND e.state = 'stale') AS stale_links
       FROM franchise_entities f WHERE f.state <> 'stale' AND (
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
  );
  const counterDrift = driftRows.length;
  const frozenDrift = driftRows.filter(
    (row) => row.franchise_state === 'confirmed' && Number(row.stale_links) > 0,
  );
  const driftProposals =
    frozenDrift.length > 0
      ? franchiseSupersedeProposals().filter((proposal) =>
          frozenDrift.some((row) => String(row.franchise_key) === proposal.franchiseKey),
        )
      : [];
  if (counterDrift > 0) {
    status = 'error';
    const actions: DiagnosticAction[] = [];
    if (frozenDrift.length === 0) {
      actions.push({
        kind: 'repair',
        repairKind: 'recompute-derived',
        label: '重建 Franchise 派生数据',
        preview: recomputePreview(`${counterDrift} 个 Franchise 的计数不一致`),
      });
    } else {
      for (const proposal of driftProposals) {
        actions.push(supersedeLinkAction(proposal));
      }
    }
    issues.push({
      id: 'franchise.counter-drift',
      detector: 'franchise.entities',
      category: 'Franchise 派生数据',
      severity: 'error',
      title: 'Franchise 派生数据与成员 Series 不一致',
      explanation:
        frozenDrift.length > 0
          ? '已确认家族的成员链接仍指向被身份恢复取代的历史 Series，计数与实际 live 成员对不上。这类问题属于 Franchise identity governance，重建派生数据不会自动改写已确认家族，需要人工执行成员身份迁移。'
          : '家族保存的系列数 / 作品数 / 平均我的评分与实际数据对不上，列表与详情会展示矛盾的数字。',
      evidence: [{ label: '计数不一致的 Franchise', value: `${counterDrift} 个` }],
      impact: [
        { kind: 'franchise', label: 'Franchise 列表 / 详情', href: '/franchises' },
        { kind: 'api', label: 'Franchise API 计数' },
      ],
      affected: driftRows.slice(0, 6).map((row) => ({
        label: String(row.franchise_key),
        detail: Number(row.stale_links) > 0 ? `含 ${row.stale_links} 条 stale 链接` : '派生计数漂移',
      })),
      affectedCount: counterDrift,
      actions,
      ...(frozenDrift.length > 0
        ? {
            waitingFor: '需要人工治理：已确认家族的身份冲突不会被自动改写',
            waiting: {
              kind: 'manual-review' as const,
              label: '需要人工治理',
              detail:
                driftProposals.length > 0
                  ? '请执行「迁移已被取代的家族成员」（家族详情 → 身份冲突）。'
                  : '存在无法验证身份谱系的 stale 成员链接，需要人工核查后再决定。',
            },
          }
        : {}),
    });
  }

  const staleLinkRows = allSamples(
    `SELECT f.key AS franchise_key, f.title AS franchise_title, f.state AS franchise_state,
            e.key AS series_key, e.title AS series_title
       FROM franchise_series fs
       JOIN franchise_entities f ON f.id = fs.franchise_id
       JOIN series_entities e ON e.id = fs.series_id
      WHERE f.state <> 'stale' AND e.state = 'stale'
      ORDER BY f.key, e.key`,
  );
  const staleLinks = staleLinkRows.length;
  const frozenStaleLinks = staleLinkRows.filter((row) => row.franchise_state === 'confirmed');
  const staleProposals =
    frozenStaleLinks.length > 0
      ? franchiseSupersedeProposals().filter((proposal) =>
          frozenStaleLinks.some((row) => String(row.franchise_key) === proposal.franchiseKey),
        )
      : [];
  if (staleLinks > 0) {
    status = 'error';
    const actions: DiagnosticAction[] = [];
    if (frozenStaleLinks.length === 0) {
      actions.push({
        kind: 'repair',
        repairKind: 'recompute-derived',
        label: '重建 Franchise 派生数据',
        preview: recomputePreview(`${staleLinks} 条家族链接指向已废弃 Series`),
      });
    } else {
      for (const proposal of staleProposals) {
        actions.push(supersedeLinkAction(proposal));
      }
    }
    issues.push({
      id: 'franchise.stale-link',
      detector: 'franchise.entities',
      category: 'Franchise 派生数据',
      severity: 'error',
      title: 'Franchise 仍链接着已废弃的 Series',
      explanation:
        frozenStaleLinks.length > 0
          ? '已确认家族中仍保留指向历史身份（已被身份恢复取代）的链接；这类成员身份更正属于人工治理，重建派生数据不会自动修改已确认家族。' +
            (staleProposals.length < frozenStaleLinks.length
              ? '其中部分链接缺少可验证的身份谱系，需要人工核查。'
              : '')
          : '家族里存在指向 stale Series 的链接，会让家族页面出现空条目。重建派生数据会清理这些链接。',
      evidence: [{ label: '指向 stale Series 的链接', value: `${staleLinks} 条` }],
      impact: [{ kind: 'franchise', label: 'Franchise 详情', href: '/franchises' }],
      affected: staleLinkRows.slice(0, 6).map((row) => ({
        label: `${String(row.franchise_key)} × ${String(row.series_key)}`,
        detail: `${String(row.franchise_title)} · ${String(row.series_title)}（link → stale）`,
      })),
      affectedCount: staleLinks,
      actions,
      ...(frozenStaleLinks.length > 0
        ? {
            waitingFor: '需要人工治理：已确认家族的身份冲突不会被自动改写',
            waiting: {
              kind: 'manual-review' as const,
              label: '需要人工治理',
              detail:
                staleProposals.length > 0
                  ? '请执行「迁移已被取代的家族成员」（家族详情 → 身份冲突）。'
                  : '该链接缺少可验证的身份谱系（rebuilt-into / merged / 成员一致性），需要人工核查。',
            },
          }
        : {}),
    });
  }

  /*
   * 待人工确认的家族候选（v1.6.1：candidate / provisional / contested 都属于「等待人工裁决」）：
   * 由现有治理能力（确认 / 否决）处理，不自动改状态。
   */
  const candidates = allSamples(
    `SELECT key, title, state, series_count, known_count, collected_count
       FROM franchise_entities
      WHERE state IN ('candidate', 'provisional', 'contested')
      ORDER BY CASE state WHEN 'candidate' THEN 0 WHEN 'provisional' THEN 1 ELSE 2 END, key`,
  );
  for (const candidate of candidates) {
    const stateLabel =
      candidate.state === 'candidate' ? '候选' : candidate.state === 'provisional' ? '暂定' : '存在争议';
    status = status === 'error' ? status : 'attention';
    issues.push({
      id: `franchise.awaiting-review:${String(candidate.key)}`,
      detector: 'franchise.entities',
      category: 'Franchise 待确认',
      severity: 'needs-review',
      title: `家族候选「${String(candidate.title)}」等待人工确认`,
      explanation:
        `这是 Analyzer 的推断，不是系统事实：多个 Series 之间存在「不同演绎」等结构化证据，因此它们被放在同一个家族候选里（当前状态：${stateLabel}）。确认会把它固定为正式家族；如果你认为推断错误，可以直接否决——否决是真实的治理状态，会保留证据且不会在下次检测里重新冒出来。如果只是个别成员归组错误，也可以在家族页面把它移出，不需要否决整个家族。`,
      evidence: [
        { label: '候选家族', value: String(candidate.key) },
        { label: '当前状态', value: stateLabel },
        { label: '系列数', value: String(candidate.series_count) },
        { label: '涉及作品', value: `已知 ${candidate.known_count} 部 / 已收藏 ${candidate.collected_count} 部` },
      ],
      impact: [
        { kind: 'franchise', label: 'Franchise 列表 / 详情', href: `/franchises/${candidate.key}` },
        { kind: 'projection', label: '家族状态（candidate → confirmed）' },
      ],
      affected: [
        {
          label: `${String(candidate.title)}（${String(candidate.key)}）`,
          detail: `${candidate.series_count} 个系列`,
          href: `/franchises/${candidate.key}`,
        },
      ],
      affectedCount: 1,
      actions: [
        {
          kind: 'repair',
          repairKind: 'confirm-franchise',
          label: '确认该家族',
          target: String(candidate.key),
          preview: preview({
            current: `${String(candidate.title)} 当前状态：${stateLabel}`,
            next: 'confirmed（已确认，自动 resolver 不再改动）',
            reason: '多个 Series 之间存在结构化证据（如「不同演绎」），你确认它们属于同一家族',
            source: '用户在数据中枢确认（等价于家族页面的「确认该家族」按钮）',
            directlyChanges: ['Franchise 治理状态：candidate → confirmed'],
            derivedChanges: [
              'Franchise 列表排序与状态徽标',
              'Franchise 详情页',
              'Series 详情的家族入口',
              'Franchise 搜索投影（按标题可搜）',
            ],
            untouched: ['Series 成员与标题', 'Subject 与 Collection 数据', 'Relation 原始关系'],
            chain: [
              { layer: 'governance', label: '治理状态', detail: '家族状态写为 confirmed' },
              { layer: 'projection', label: '家族链接', detail: '成员 Series 链接确认为 confirmed' },
              { layer: 'search', label: '搜索投影', detail: '家族保持可被标题 / 成员搜索命中' },
              { layer: 'api', label: 'API / UI', detail: 'Franchise 列表与详情显示已确认' },
              { layer: 'cache', label: '缓存失效', detail: '数据版本推进，诊断报告重新检测' },
            ],
          }),
        },
        {
          kind: 'repair',
          repairKind: 'reject-franchise-candidate',
          label: '否决该候选',
          target: String(candidate.key),
          preview: preview({
            current: `${String(candidate.title)} 当前状态：${stateLabel}（等待人工确认）`,
            next: 'rejected（已否决：不再作为待处理候选）',
            reason: '你认为这些 Series 并不属于同一家族，Analyzer 的推断是错的',
            source: '用户在数据中枢否决（写入 candidate_decisions 治理记录）',
            directlyChanges: [`Franchise 治理状态：${stateLabel} → rejected（已否决）`],
            derivedChanges: [
              '数据中枢不再把该家族列为待确认',
              'Franchise 列表显示「已否决」状态（证据与成员仍然保留）',
            ],
            untouched: [
              'Franchise / Series / Subject 数据本身',
              '原始关系证据（不同演绎等 Relation）',
              'Series identity 与成员归属',
            ],
            chain: [
              { layer: 'governance', label: '写入否决决定', detail: 'candidate_decisions 记录否决 + 证据快照，entity_events 记录历史' },
              { layer: 'projection', label: '家族状态', detail: 'franchise_entities.state → rejected；下次重建不会静默改回候选' },
              { layer: 'api', label: 'API / UI', detail: '家族列表 / 详情显示已否决；证据仍可查看' },
              { layer: 'cache', label: '缓存失效', detail: '数据版本推进，诊断报告重新检测' },
              { layer: 'governance', label: '新证据可重开', detail: '若未来出现新成员等新证据，该家族会自动回到候选状态重新评估' },
            ],
          }),
        },
        {
          kind: 'link',
          label: '调整成员 / 名称',
          href: `/franchises/${candidate.key}`,
          hint: '在家族页面查看证据：移出归组错误的成员（≠ 拆分家族），或设置人工名称。',
        },
      ],
    });
  }

  const singleSeries = allSamples(
    `SELECT f.key, f.title, COUNT(*) AS series_count
       FROM franchise_entities f
       JOIN franchise_series fs ON fs.franchise_id = f.id
       JOIN series_entities e ON e.id = fs.series_id AND e.state <> 'stale'
      WHERE f.state <> 'stale'
      GROUP BY f.id HAVING COUNT(*) = 1
      ORDER BY f.key`,
  );
  for (const entry of singleSeries) {
    status = status === 'error' ? status : 'attention';
    issues.push({
      id: `franchise.single-series:${String(entry.key)}`,
      detector: 'franchise.entities',
      category: 'Franchise 派生数据',
      severity: 'suspicious',
      title: `家族「${String(entry.title)}」只包含 1 个系列`,
      explanation:
        '家族通常由至少两个 Series 组成。只有一个成员时，家族页面与 Series 页面内容重复；建议在家族页面复核后决定是否保留。',
      evidence: [
        { label: '家族', value: String(entry.key) },
        { label: '系列数', value: String(entry.series_count) },
      ],
      impact: [{ kind: 'franchise', label: 'Franchise 详情', href: `/franchises/${entry.key}` }],
      affected: [{ label: String(entry.title), href: `/franchises/${entry.key}` }],
      affectedCount: 1,
      actions: [{ kind: 'link', label: '到家族页面查看', href: `/franchises/${entry.key}` }],
      waitingFor: '需要人工判断该家族是否成立（当前没有自动合并 / 拆分能力）',
    });
  }

  const linkCounts = inspectFranchiseLinkCounts();
  issues.push(...franchiseLinkCountIssues(linkCounts));
  if (linkCounts.drift) status = 'error';
  else if (linkCounts.blocked && status === 'ok') status = 'attention';
  return {
    module: {
      id: 'franchise',
      label: 'Franchise 派生数据',
      description: '家族计数、链接与待确认候选',
      status,
      checked: franchiseCount,
      details: [
        `${franchiseCount} 个 Franchise（非 stale）`,
        `待人工确认：${candidates.length}（候选 ${candidates.filter((row) => row.state === 'candidate').length} / 暂定 ${candidates.filter((row) => row.state === 'provisional').length} / 争议 ${candidates.filter((row) => row.state === 'contested').length}）`,
      ],
    },
    issues,
  };
};

/* ---------------------------------------------------------- 标题与候选 */

const titleDetector: Detector = (): DetectorResult => {
  const seriesCount = toNumber(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM series_entities WHERE state <> 'stale'`)?.n,
  );
  const issues: DiagnosticIssue[] = [];
  let status: DiagnosticModule['status'] = 'ok';

  const invalidFranchiseCandidates = all<{ key: string; title: string; title_candidates: string }>(
    "SELECT key, title, title_candidates FROM franchise_entities WHERE state <> 'stale'",
  ).filter((row) => titleCandidatesForMutation(row.title_candidates) === null);
  if (invalidFranchiseCandidates.length > 0) {
    status = 'attention';
    issues.push({
      id: 'titles.franchise-candidates-invalid', detector: 'titles.resolver', category: '标题候选',
      severity: 'needs-review', title: '家族历史候选证据结构异常',
      explanation: '这些家族的历史候选无法完整读取。原始证据仍被保留；冻结家族的重建不会改写它们，名称治理会拒绝覆盖异常证据。不能将重建派生数据当作候选证据修复。',
      evidence: [{ label: '异常家族候选', value: `${invalidFranchiseCandidates.length} 个` }],
      affected: invalidFranchiseCandidates.slice(0, 20).map((row) => ({ label: row.title, href: `/franchises/${row.key}` })),
      affectedCount: invalidFranchiseCandidates.length,
      impact: [{ kind: 'franchise', label: '家族候选与名称治理', href: '/franchises' }],
      actions: [],
      waitingFor: '需要单独核对历史候选证据；自动重建不会修复冻结记录。',
      waiting: { kind: 'manual-review', label: '需要单独核对历史证据', detail: '先保留原始记录，确认候选证据归属与结构后再安排修复。' },
    });
  }

  const resolvedCount = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM series_entities WHERE state <> 'stale' AND title_state = 'resolved'`,
    )?.n,
  );
  const manualCount = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM series_entities WHERE state <> 'stale' AND title_state = 'manual'`,
    )?.n,
  );
  const historicallyResolvedCount = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(DISTINCT e.id) AS n
         FROM series_entities e
         JOIN entity_events ev ON ev.entity_kind = 'series' AND ev.entity_id = e.id
        WHERE e.state <> 'stale'
          AND e.title_state IN ('resolved', 'manual')
          AND ev.kind IN ('title_changed', 'title_manual')
          AND (
            ev.payload LIKE '%"fromState":"provisional"%'
            OR ev.payload LIKE '%"fromState":"unresolved"%'
            OR ev.payload LIKE '%"fromState":"contested"%'
          )`,
    )?.n,
  );

  const contested = allSamples(
    `SELECT key, title, title_state, title_source, member_count
       FROM series_entities
      WHERE state <> 'stale' AND title_state = 'contested'
      ORDER BY member_count DESC, key`,
  );
  if (contested.length > 0) {
    status = 'attention';
    issues.push({
      id: 'titles.contested',
      detector: 'titles.resolver',
      category: '标题争议',
      severity: 'needs-review',
      title: `${contested.length} 个 Series 的标题存在证据冲突`,
      explanation:
        '这些 Series 同时存在强度接近或互相冲突的有效标题候选，自动解析无法安全代替你裁决。建议在 Title Review 中核对来源并确认最终标题。',
      evidence: [
        { label: '有争议的 Series', value: `${contested.length} 个` },
        ...contested.slice(0, 5).map((row) => ({
          label: String(row.title),
          value: `来源 ${String(row.title_source)} · ${String(row.member_count)} 个成员`,
        })),
      ],
      impact: [
        { kind: 'series', label: 'Series 列表 / 详情', href: '/series' },
        { kind: 'search', label: 'Series 搜索（仍可搜到）', href: '/series' },
      ],
      affected: contested.slice(0, 6).map((row) => ({
        label: String(row.title),
        detail: `${String(row.title_source)} · ${String(row.member_count)} 个成员`,
        href: `/series/${row.key}?review=1`,
      })),
      affectedCount: contested.length,
      actions: [
        {
          kind: 'link',
          label: '去 Title Review 处理',
          href: `/series/${contested[0]!.key}?review=1`,
          hint: '人工确认后 resolver 不会再自动覆盖',
        },
      ],
      waitingFor: '存在实质性候选冲突，建议由你在 Title Review 中裁决',
      waiting: {
        kind: 'manual-review',
        label: '等待人工裁决冲突候选',
        detail: '可以在 Title Review 中采纳正确候选、否决错误候选或输入自定义名称。',
      },
    });
  }

  const provisional = allSamples(
    `SELECT key, title, title_state, title_source, member_count
       FROM series_entities
      WHERE state <> 'stale' AND title_state IN ('provisional', 'unresolved')
      ORDER BY member_count DESC, key`,
  );
  if (provisional.length > 0) {
    // provisional / unresolved 不是错误：证据不足时保持暂定是正确行为
    issues.push({
      id: 'titles.provisional',
      detector: 'titles.resolver',
      category: '标题暂定',
      severity: 'uncertain',
      title: `${provisional.length} 个 Series 的标题仍是暂定 / 未确认`,
      explanation:
        '这些名称来自当前证据下的最佳候选（品牌标签 / 成员一致性等）。暂定不是错误：当新的成员或关系进入后，自动解析会继续改善它们；你也可以随时在 Series 详情里人工确认。',
      evidence: [
        { label: '暂定 / 未确认 Series', value: `${provisional.length} 个` },
        ...provisional.slice(0, 5).map((row) => ({
          label: String(row.title),
          value: `来源 ${String(row.title_source)} · ${String(row.member_count)} 个成员`,
        })),
      ],
      impact: [
        { kind: 'series', label: 'Series 列表 / 详情', href: '/series' },
        { kind: 'search', label: 'Series 搜索（仍可搜到）', href: '/series' },
      ],
      affected: provisional.slice(0, 6).map((row) => ({
        label: String(row.title),
        detail: `${String(row.title_source)} · ${String(row.member_count)} 个成员`,
        href: `/series/${row.key}?review=1`,
      })),
      affectedCount: provisional.length,
      actions: [
        {
          kind: 'link',
          label: '去 Title Review 处理',
          href: `/series/${provisional[0]!.key}?review=1`,
          hint: '人工确认后 resolver 不会再自动覆盖',
        },
      ],
      waitingFor: '等待更强的成员 / 关系证据，或由你在 Title Review 中人工确认',
      waiting: {
        kind: 'manual-review',
        label: '可人工确认，也可以继续等待',
        detail: '现在就可以在 Title Review 中确认 / 采纳 / 否决候选；不处理也不会产生错误。',
      },
    });
  }

  /*
   * 显示标题截断（v1.6.1 新增，来源与投影不一致的真实案例）：
   * 成员 / 候选里有完整名称，但 Series 展示标题是截断形态
   * （括号未闭合，或结尾停在半个 token 上，例如「攻壳机动队 S」）。
   */
  const truncated: Array<{
    key: string;
    title: string;
    title_state: string;
    candidate: string;
    reason: string;
  }> = [];
  const seriesRows = allSamples(
    `SELECT id, key, title, title_state, title_candidates FROM series_entities
      WHERE state <> 'stale' AND title_state <> 'manual' ORDER BY id`,
  );
  for (const row of seriesRows) {
    const title = String(row.title ?? '');
    if (!title.trim()) continue;
    const candidates = parseCandidateList(row.title_candidates);
    const invalid = (text: string): string | null => {
      const unbalanced =
        (text.includes('(') && !text.includes(')')) ||
        (text.includes('（') && !text.includes('）')) ||
        (text.includes('「') && !text.includes('」')) ||
        /[（(\[【「『]\s*$/.test(text);
      return unbalanced ? '括号未闭合' : null;
    };
    let reason = invalid(title);
    let suggestion = '';
    if (!reason) {
      for (const candidate of candidates) {
        if (!candidate.valid) continue;
        const normalizedTitle = candidateKeyOf(title);
        const normalizedCandidate = candidateKeyOf(candidate.title);
        if (
          normalizedTitle.length > 0 &&
          normalizedCandidate.startsWith(normalizedTitle) &&
          normalizedCandidate.length >= normalizedTitle.length + 2
        ) {
          // 只在「半个 token 处截断」时报告，避免把 FLCL ↔ FLCL Alternative 这类正常品牌名误报
          const compactTitle = title.toLowerCase().replace(/[\s\u3000]+/g, '');
          const compactCandidate = candidate.title.toLowerCase().replace(/[\s\u3000]+/g, '');
          const index = compactCandidate.indexOf(compactTitle);
          const next = index >= 0 ? compactCandidate[index + compactTitle.length] ?? '' : '';
          if (/[a-z0-9]$/.test(compactTitle) && ['.', '．', '_'].includes(next)) {
            reason = '结尾停在半个 token';
            suggestion = candidate.title;
            break;
          }
        }
      }
    } else {
      const balanced = candidates
        .filter((candidate) => candidate.valid && !invalid(candidate.title))
        .sort((a, b) => b.title.length - a.title.length)[0];
      suggestion = balanced?.title ?? '';
    }
    if (reason) {
      truncated.push({
        key: String(row.key),
        title,
        title_state: String(row.title_state),
        candidate: suggestion,
        reason,
      });
    }
  }
  if (truncated.length > 0) {
    status = 'attention';
    issues.push({
      id: 'titles.display-truncated',
      detector: 'titles.resolver',
      category: '标题与候选',
      severity: 'suspicious',
      title: `${truncated.length} 个 Series 的展示标题疑似截断`,
      explanation:
        '成员 / 候选里有完整名称，但 Series 当前展示标题是截断形态（括号未闭合，或结尾停在半个 token 上）。这属于「来源与展示投影不一致」：搜索与页面会一起显示这个不完整标题，建议采纳完整候选或人工确认。',
      evidence: truncated.slice(0, 6).map((row) => ({
        label: `#${row.key} ${row.title}`,
        value: row.candidate ? `疑似截断（${row.reason}）→ 建议候选「${row.candidate}」` : `疑似截断（${row.reason}）`,
      })),
      impact: [
        { kind: 'series', label: 'Series 列表 / 详情标题', href: '/series' },
        { kind: 'search', label: 'Series 搜索（按截断标题命中）', href: '/series' },
        { kind: 'ui', label: '收藏库 / 系列页面的可读性' },
      ],
      affected: truncated.slice(0, 8).map((row) => ({
        label: row.title,
        detail: row.candidate ? `建议：${row.candidate}` : row.reason,
        href: `/series/${row.key}?review=1`,
      })),
      affectedCount: truncated.length,
      actions: [
        ...truncated
          .filter((row) => row.candidate)
          .slice(0, 3)
          .map((row) => ({
            kind: 'repair' as const,
            repairKind: 'adopt-title-candidate' as const,
            label: `采纳完整候选「${row.candidate}」`,
            target: row.key,
            value: row.candidate,
            preview: preview({
              current: `展示标题「${row.title}」（疑似截断：${row.reason}）`,
              next: `manual confirmed：「${row.candidate}」`,
              reason: '候选列表里存在完整名称，截断标题不是最优展示；人工确认后自动 resolver 不会覆盖',
              source: '用户采纳数据中枢建议的完整候选（等价于 Title Review 的「采用候选」）',
              directlyChanges: ['Series canonical title（manual confirmed）'],
              derivedChanges: [
                'Series 列表 / 详情标题',
                'Series 搜索投影（按新标题命中）',
                'Title Review 的候选 provenance',
              ],
              untouched: [
                'Subject 身份与成员归属',
                'Collection（评分 / 进度 / 状态）',
                'Relation 原始关系数据',
              ],
              chain: [
                { layer: 'governance', label: '人工确认', detail: `title 写为「${row.candidate}」，状态 manual` },
                { layer: 'projection', label: 'Series 投影', detail: '系列标题与候选列表同步更新' },
                { layer: 'search', label: '搜索投影', detail: '搜索按新标题命中该 Series' },
                { layer: 'api', label: 'API / UI', detail: 'Series 列表与详情显示完整标题' },
                { layer: 'cache', label: '缓存失效', detail: '数据版本推进，诊断报告重新检测' },
              ],
            }),
          })),
        {
          kind: 'link' as const,
          label: '去 Title Review 处理',
          href: `/series/${truncated[0]!.key}?review=1`,
          hint: '在候选列表中采纳完整名称，或否决错误候选',
        },
      ],
      waiting: {
        kind: 'manual-review',
        label: '等待人工确认',
        detail: '系统不会自动改名；采纳完整候选或人工输入都会成为 manual confirmed。',
      },
    });
  }

  const unparsable = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM series_entities
        WHERE state <> 'stale' AND title_candidates <> '[]'
          AND json_valid(title_candidates) = 0`,
    )?.n,
  );
  /*
   * 候选否决与投影一致性（v1.6.1）：
   * 治理层已经否决了某候选，但投影里仍然 valid=true → 缓存 / 重建没有跟上，
   * 会让被否决的名字继续作为搜索别名与展示竞争候选。
   */
  const rejectedStale: Array<{ key: string; title: string; candidate: string }> = [];
  for (const row of seriesRows) {
    const candidates = parseCandidateList(row.title_candidates);
    if (candidates.length === 0) continue;
    const decisions = activeRejections(
      'series',
      Number(row.id ?? 0),
      'title',
    );
    if (decisions.length === 0) continue;
    for (const decision of decisions) {
      const stillValid = candidates.some(
        (candidate) => candidate.valid && candidateKeyOf(candidate.title) === decision.candidate_key,
      );
      if (stillValid) {
        rejectedStale.push({
          key: String(row.key),
          title: String(row.title),
          candidate: decision.candidate_title,
        });
      }
    }
  }
  if (rejectedStale.length > 0) {
    status = 'error';
    issues.push({
      id: 'titles.rejected-stale',
      detector: 'titles.resolver',
      category: '标题候选',
      severity: 'error',
      title: `${rejectedStale.length} 个已否决候选仍然出现在有效候选里`,
      explanation:
        '治理层已经记录「用户否决了这个候选」，但派生投影里它仍然是 valid=true，说明重建 / 缓存没有跟上。这会让被否决的名字继续作为搜索别名参与竞争。',
      evidence: rejectedStale.slice(0, 5).map((row) => ({
        label: String(row.title),
        value: `被否决候选「${row.candidate}」仍为 valid=true`,
      })),
      impact: [
        { kind: 'search', label: 'Series 搜索别名', href: '/series' },
        { kind: 'series', label: 'Series 展示标题竞争', href: '/series' },
      ],
      affected: rejectedStale.slice(0, 5).map((row) => ({
        label: String(row.title),
        detail: row.candidate,
        href: `/series/${row.key}?review=1`,
      })),
      affectedCount: rejectedStale.length,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '按治理状态重建候选',
          preview: recomputePreview(`${rejectedStale.length} 个已否决候选仍被当作有效候选`),
        },
      ],
    });
  }

  if (unparsable > 0) {
    status = 'error';
    issues.push({
      id: 'titles.candidates-unparsable',
      detector: 'titles.resolver',
      category: '标题候选',
      severity: 'error',
      title: '标题候选数据无法解析',
      explanation: '部分 Series 的候选列表不是合法 JSON，Title Review 与搜索别名都无法读取它们。重建派生数据会按当前证据重新生成候选。',
      evidence: [{ label: '无法解析的 Series', value: `${unparsable} 个` }],
      impact: [
        { kind: 'series', label: 'Title Review 面板', href: '/series' },
        { kind: 'search', label: '候选别名搜索', href: '/series' },
      ],
      affected: [],
      affectedCount: unparsable,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建标题候选',
          preview: recomputePreview(`${unparsable} 个 Series 的候选数据无法解析`),
        },
      ],
    });
  }

  // 结构异常候选：括号未闭合、以开括号结尾（v1.5.1 曾出现的截断候选）
  const structural: Array<{ key: string; title: string; candidate: string }> = [];
  const rows = allSamples(
    `SELECT key, title, title_candidates FROM series_entities
      WHERE state <> 'stale' AND title_candidates LIKE '%true%' ORDER BY id`,
  );
  for (const row of rows) {
    let candidates: unknown[] = [];
    try {
      const parsed = JSON.parse(String(row.title_candidates ?? '[]'));
      candidates = Array.isArray(parsed) ? parsed : [];
    } catch {
      continue;
    }
    for (const entry of candidates) {
      const candidate = entry as { title?: unknown; valid?: unknown };
      if (candidate?.valid !== true) continue;
      const text = String(candidate.title ?? '');
      if (!text) continue;
      const unbalanced =
        (text.includes('(') && !text.includes(')')) ||
        (text.includes('（') && !text.includes('）')) ||
        (text.includes('「') && !text.includes('」')) ||
        /[（(\[【「『]\s*$/.test(text);
      if (unbalanced) {
        structural.push({ key: String(row.key), title: String(row.title), candidate: text });
      }
    }
  }
  if (structural.length > 0) {
    status = 'attention';
    issues.push({
      id: 'titles.candidate-structural',
      detector: 'titles.resolver',
      category: '标题候选',
      severity: 'suspicious',
      title: `${structural.length} 个候选词结构可疑（括号未闭合）`,
      explanation:
        '候选词里存在未闭合的括号，通常意味着原始名称被截断。它们可能作为搜索别名被使用，建议在 Title Review 中核对并人工确认正确的名称。',
      evidence: structural.slice(0, 5).map((row) => ({
        label: row.title,
        value: `候选「${row.candidate}」`,
      })),
      impact: [
        { kind: 'search', label: 'Series 搜索别名', href: '/series' },
        { kind: 'series', label: 'Series 标题展示', href: '/series' },
      ],
      affected: structural.slice(0, 5).map((row) => ({
        label: row.title,
        detail: row.candidate,
        href: `/series/${row.key}?review=1`,
      })),
      affectedCount: structural.length,
      actions: [
        ...structural.slice(0, 3).map((row) => ({
          kind: 'repair' as const,
          repairKind: 'reject-title-candidate' as const,
          label: `否决候选「${row.candidate}」`,
          target: row.key,
          value: row.candidate,
          preview: preview({
            current: `候选「${row.candidate}」当前 valid=true（参与展示竞争与搜索别名）`,
            next: '已否决：valid=false，退出展示竞争与搜索别名（候选与来源证据继续保留）',
            reason: '候选结构可疑（括号未闭合），继续作为别名会污染搜索与展示',
            source: '用户在数据中枢否决（写入 candidate_decisions 治理记录）',
            directlyChanges: ['标题候选治理状态：rejected'],
            derivedChanges: ['候选列表里的 valid / rejected 标记', 'Series 搜索别名集合'],
            untouched: ['Series 展示标题（除非被否决的正是它）', '成员归属 / 收藏 / 原始关系'],
            chain: [
              { layer: 'governance', label: '写入否决决定', detail: 'candidate_decisions + entity_events 保留证据快照' },
              { layer: 'projection', label: '候选投影', detail: '候选标记 rejected / valid=false' },
              { layer: 'search', label: '搜索别名', detail: '被否决候选不再作为搜索别名' },
              { layer: 'cache', label: '缓存失效', detail: '数据版本推进，诊断报告重新检测' },
            ],
          }),
        })),
        {
          kind: 'link',
          label: '去 Title Review 核对',
          href: `/series/${structural[0]!.key}?review=1`,
          hint: '人工确认会写入 manual confirmed，后续自动解析不会覆盖',
        },
      ],
    });
  }

  /*
   * 被人工否决的标题候选清单（v1.6.2，治理闭环）。
   *
   * 否决不是永久抹掉：候选记录与证据保留在这里，用户可以随时「重新进入评估」。
   * 这是一条信息性清单（不是错误），也不会自动恢复任何状态。
   */
  const rejectedCandidates = allSamples(
    `SELECT d.id, d.entity_id, d.candidate_title, d.reason, d.updated_at, d.evidence,
            e.key, e.title, e.title_state
       FROM candidate_decisions d
       JOIN series_entities e ON e.id = d.entity_id
      WHERE d.entity_kind = 'series' AND d.candidate_kind = 'title'
        AND d.decision = 'rejected' AND e.state <> 'stale'
      ORDER BY d.updated_at DESC, d.id`,
  );
  if (rejectedCandidates.length > 0) {
    issues.push({
      id: 'titles.rejected-candidates',
      detector: 'titles.resolver',
      category: '标题候选',
      severity: 'info',
      title: `${rejectedCandidates.length} 个标题候选已被人工否决`,
      explanation:
        '这些候选已退出展示竞争与搜索别名，但记录与当时的证据快照仍然保留。如果你当时判断有误，或情况已经变化，可以在这里重新进入评估：候选会回到竞争，由 resolver 按当前证据重新选择展示名——不会静默变成人工确认，也不会删除原来的否决记录。',
      evidence: rejectedCandidates.slice(0, 5).map((row) => {
        const previous = decisionEvidence({ evidence: String(row.evidence ?? '') });
        const uncertainty = previous.support === null || previous.coverage === null || previous.sources === null
          ? '；历史证据不完整，未知字段不用于自动重开；保留否决，可人工重新评估' : '';
        return {
        label: `${String(row.title)} · 候选「${String(row.candidate_title)}」`,
        value:
          row.reason && String(row.reason).trim().length > 0
            ? `否决原因：${String(row.reason)}${uncertainty}`
            : `未填写否决原因${uncertainty}`,
        };
      }),
      impact: [
        { kind: 'series', label: 'Series 展示标题竞争', href: '/series' },
        { kind: 'search', label: 'Series 搜索别名', href: '/series' },
      ],
      affected: rejectedCandidates.slice(0, 20).map((row) => ({
        label: `${String(row.title)} · 候选「${String(row.candidate_title)}」`,
        detail: String(row.candidate_title),
        href: `/series/${row.key}?review=1`,
      })),
      affectedCount: rejectedCandidates.length,
      actions: [
        ...rejectedCandidates.slice(0, 3).map((row) => ({
          kind: 'repair' as const,
          repairKind: 'reopen-title-candidate' as const,
          label: `重新进入评估「${String(row.candidate_title)}」`,
          target: String(row.key),
          value: String(row.candidate_title),
          preview: preview({
            current: `候选「${String(row.candidate_title)}」已否决（${row.reason ? String(row.reason) : '未填写原因'}），当前不参与展示与搜索别名`,
            next: `候选重新进入竞争（valid=true）；旧否决保留并标记为 superseded；展示标题由 resolver 按当前证据重新解析（不会变成人工确认）`,
            reason: '你认为当时的否决不正确，或情况已经变化',
            source: '用户在数据中枢「重新进入评估」（写入 candidate_decisions 与 entity_events）',
            directlyChanges: ['标题候选治理状态：rejected → superseded；候选 valid → true'],
            derivedChanges: [
              'Series 展示标题按当前证据重新解析',
              'Series 搜索别名重新包含该候选',
              '数据中枢的已否决候选清单更新',
            ],
            untouched: [
              'Series identity 与成员归属',
              '其他候选的决定',
              'Subject / Collection / Relation 原始数据',
            ],
            chain: [
              { layer: 'governance', label: '写入治理决定', detail: '旧否决标记 superseded，事件记录 trigger=manual' },
              { layer: 'projection', label: '候选与标题', detail: '候选回到竞争，resolver 重新解析展示名' },
              { layer: 'search', label: '搜索别名', detail: '候选重新作为搜索别名生效' },
              { layer: 'api', label: 'API / UI', detail: 'Series 详情与数据中枢显示最新状态' },
              { layer: 'cache', label: '缓存失效', detail: '数据版本推进，诊断报告重新检测' },
            ],
          }),
        })),
        {
          kind: 'link' as const,
          label: '去 Title Review 处理',
          href: `/series/${rejectedCandidates[0]!.key}?review=1`,
          hint: '在候选列表中重新进入评估，或改用自定义名称',
        },
      ],
      waiting: {
        kind: 'manual-review',
        label: '由你决定',
        detail: '保持否决也不会产生错误；只有你主动重新进入评估时才会恢复竞争。',
      },
    });
  }

  return {
    module: {
      id: 'titles',
      label: '标题与候选',
      description: '标题状态、候选结构与人工确认入口',
      status,
      checked: seriesCount,
      details: [
        `自动已确定：${resolvedCount} 个 · 人工已确认：${manualCount} 个${historicallyResolvedCount > 0 ? `（含历史已解决 ${historicallyResolvedCount} 个）` : ''}`,
        `暂定 / 未确认：${provisional.length} 个（不是错误）`,
        ...(contested.length > 0 ? [`有争议：${contested.length} 个（存在候选冲突）`] : []),
        `候选数据无法解析：${unparsable} 个`,
        `结构可疑候选：${structural.length} 个`,
        `被人工否决的候选：${rejectedCandidates.length} 个（保留记录，可重新进入评估）`,
      ],
    },
    issues,
  };
};

/* ------------------------------------------------------------ 关系数据 */

const relationDetector: Detector = (): DetectorResult => {
  const total = toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM subject_relations')?.n);
  const issues: DiagnosticIssue[] = [];
  let status: DiagnosticModule['status'] = 'ok';

  const emptyName = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM subject_relations WHERE trim(relation) = ''`,
    )?.n,
  );
  if (emptyName > 0) {
    status = 'attention';
    const sample = one<{ subject_id: number; related_id: number }>(
      `SELECT subject_id, related_id FROM subject_relations WHERE trim(relation) = '' LIMIT 1`,
    );
    issues.push({
      id: 'relations.empty-name',
      detector: 'relations.integrity',
      category: '关系数据',
      severity: 'error',
      title: `${emptyName} 条关系缺少关系名称`,
      explanation:
        '这些关系行的名称为空，Series 引擎无法判断它们属于连续性、不同演绎还是无关关联，因此不会并入任何系列。',
      evidence: [
        { label: '空名称关系', value: `${emptyName} 条` },
        ...(sample
          ? [{ label: '样本', value: `#${sample.subject_id} → #${sample.related_id}` }]
          : []),
      ],
      impact: [
        { kind: 'series', label: 'Series 分组完整性', href: '/series' },
        { kind: 'projection', label: '关系分类（unknown 不合并）' },
      ],
      affected: sample
        ? [{ label: `#${sample.subject_id} → #${sample.related_id}`, href: `/subjects/${sample.subject_id}` }]
        : [],
      affectedCount: emptyName,
      actions: sample
        ? [{ kind: 'link', label: '查看相关作品', href: `/subjects/${sample.subject_id}` }]
        : [],
      waitingFor: '关系名称来自 Bangumi 原始数据；修复需要上游修正后再同步',
      waiting: {
        kind: 'bangumi-field',
        label: '等待 Bangumi 上游数据',
        detail: '关系名称来自上游；上游修正后重新同步即可，本地无法可靠推断。',
      },
    });
  }

  const uncollected = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(DISTINCT m.subject_id) AS n
         FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
        WHERE m.role = 'primary' AND e.state <> 'stale'
          AND NOT EXISTS (SELECT 1 FROM subjects s WHERE s.id = m.subject_id)`,
    )?.n,
  );
  if (uncollected > 0) {
    issues.push({
      id: 'relations.uncollected-members',
      detector: 'relations.integrity',
      category: '关系数据',
      severity: 'external',
      title: `${uncollected} 个 Series 成员没有本地详情`,
      explanation:
        '这些成员出现在官方关系里但不在收藏中，本地只有关系行名称，没有别名、封面、标签与 NSFW 标记。Analyzer 按「不猜测」原则只把它们当作成员名称使用，不会推断元数据。',
      evidence: [{ label: '未收藏的 Series 成员', value: `${uncollected} 个` }],
      impact: [
        { kind: 'series', label: 'Series 成员（仅名称）', href: '/series' },
        { kind: 'search', label: 'Series 搜索（可用关系行名称命中）', href: '/series' },
        { kind: 'projection', label: 'NSFW 可见性（这些成员没有 nsfw 数据，不参与判定）' },
      ],
      affected: [],
      affectedCount: uncollected,
      actions: [],
      waitingFor: '当这些作品被收藏并完成详情同步后，别名 / 封面 / NSFW 数据会自动补齐',
      waiting: {
        kind: 'collection',
        label: '等待收藏',
        detail: '这些成员不在收藏里，本地没有详情数据；收藏后下一次同步会自动补齐。',
      },
    });
  }

  return {
    module: {
      id: 'relations',
      label: '关系数据',
      description: '官方关系的完整性、空名称与未收藏成员',
      status,
      checked: total,
      details: [
        `${total} 条关系`,
        `空名称：${emptyName} 条`,
        `未收藏 Series 成员：${uncollected} 个（只有关系行名称）`,
      ],
    },
    issues,
  };
};

/* -------------------------------------------- 收藏 / 封面 / 翻译 / 可见性 */

const collectionDetector: Detector = (): DetectorResult => {
  const sourceSnapshots = inspectSourceSnapshots();
  const subjects = toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM subjects')?.n);
  const issues: DiagnosticIssue[] = [];
  let status: DiagnosticModule['status'] = 'ok';

  const detailPending = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM subjects WHERE detail_state <> 'ok'`,
    )?.n,
  );
  const relationsPending = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM subjects WHERE relations_state <> 'ok'`,
    )?.n,
  );
  if (detailPending > 0 || relationsPending > 0) {
    status = 'attention';
    issues.push({
      id: 'collect.detail-pending',
      detector: 'collections.coverage',
      category: '收藏与详情',
      severity: 'external',
      title: `还有 ${detailPending + relationsPending} 项详情 / 关系等待同步`,
      explanation:
        '部分收藏条目还没有完成详情或关系抓取。在此之前，它们的评分分布、制作人员与系列关系不完整，Analyzer 不会用猜测填补这些字段。',
      evidence: [
        { label: '待补齐详情', value: `${detailPending} 条` },
        { label: '待补齐关系', value: `${relationsPending} 条` },
      ],
      impact: [
        { kind: 'ui', label: '作品详情完整性' },
        { kind: 'series', label: 'Series 分组完整性', href: '/series' },
      ],
      affected: [],
      affectedCount: detailPending + relationsPending,
      actions: [{ kind: 'link', label: '到设置页执行同步', href: '/settings?tab=bangumi' }],
      waitingFor: '等待下一次同步抓取剩余详情',
      waiting: {
        kind: 'detail-sync',
        label: '等待详情同步',
        detail: '到设置页执行一次同步即可补齐；不需要手工维护。',
      },
    });
  }

  const missingFiles = allSamples(
    `SELECT id, cover_path FROM subjects WHERE cover_cached_at IS NOT NULL AND cover_path IS NOT NULL`,
  ).filter((row) => !existsSync(join(paths.coverDir, String(row.cover_path))));
  if (missingFiles.length > 0) {
    status = 'error';
    issues.push({
      id: 'cover.cache-drift',
      detector: 'collections.coverage',
      category: '封面缓存',
      severity: 'error',
      title: `${missingFiles.length} 个封面标记为已缓存但文件不存在`,
      explanation:
        '数据库记录这些封面已经缓存，但本地文件缺失（可能被手动清理或磁盘操作影响），页面会尝试重新下载。清除标记后，下次浏览会自动重新缓存。',
      evidence: [
        { label: '缺失的封面文件', value: `${missingFiles.length} 个` },
        ...missingFiles.slice(0, 3).map((row) => ({
          label: `#${row.id}`,
          value: String(row.cover_path),
        })),
      ],
      impact: [
        { kind: 'ui', label: '收藏库 / 详情页封面' },
        { kind: 'storage', label: '封面缓存目录' },
      ],
      affected: missingFiles.slice(0, 5).map((row) => ({
        label: `#${row.id}`,
        detail: String(row.cover_path),
        href: `/subjects/${row.id}`,
      })),
      affectedCount: missingFiles.length,
      actions: [
        {
          kind: 'repair',
          repairKind: 'clear-cover-cache',
          label: '清除失效的缓存标记',
          preview: preview({
            current: `${missingFiles.length} 个条目标记为已缓存，但文件不存在`,
            next: '清除这些条目的 cover_path / cover_cached_at 标记',
            reason: '缓存标记必须与磁盘文件一致，否则页面会读取不存在的文件',
            source: '逐个检查 data/covers 下的实际文件',
            directlyChanges: ['封面缓存标记（cover_path / cover_cached_at）'],
            derivedChanges: ['浏览器下次访问时自动重新缓存封面'],
            untouched: ['data/covers 中已存在的文件', 'Subject / Collection / 其他元数据'],
            chain: [
              { layer: 'source', label: '缓存标记', detail: '只清除文件缺失条目的标记' },
              { layer: 'ui', label: '封面显示', detail: '下次访问时重新下载并缓存' },
              { layer: 'cache', label: '缓存失效', detail: '数据版本推进，诊断报告重新检测' },
            ],
          }),
        },
      ],
    });
  }

  if (sourceSnapshots.invalidCount > 0) {
    status = 'error';
    issues.push({
      id: 'source.snapshot-invalid', detector: 'collections.coverage', category: '来源快照', severity: 'error',
      title: '原始快照存在不可解析的本地表示',
      explanation: '非空 raw 不是有效 JSON 文本或存储类型不正确。这证明本地表示不可用，不证明 Bangumi 远端事实错误，也不能确定损坏原因。合法缺失、旧导入的非对象 JSON 与不同代次不据此判错。',
      evidence: [{label:'判定范围',value:'仅检查 subjects.raw 与 collections.raw 的本地 JSON 表示，不校验远端真实性或跨代次身份'}, {label:'处理边界',value:'原文保持；不能以重算、清空或推断值覆盖来源'}],
      impact: [{kind:'storage',label:'原始来源证据可解释性'}, {kind:'api',label:'依赖原始快照的后续分析'}],
      affected: [], affectedCount: sourceSnapshots.invalidCount, actions: [], sourceSnapshots,
      waiting: {kind:'manual-review',label:'先核查可信备份与来源',detail:'没有确定性本地修复；先保留备份与原文，核对可靠来源。重新获取或恢复须另行授权，处理后强制重新检测；不能覆盖人工决定或历史。'},
    });
  } else if (sourceSnapshots.uncheckedCount > 0 || sourceSnapshots.nonObjectCount > 0) {
    if (status === 'ok') status = 'attention';
  }
  const noSource = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM subjects WHERE cover_url IS NULL OR trim(cover_url) = ''`,
    )?.n,
  );

  return {
    module: {
      id: 'collections',
      sourceSnapshots,
      label: '收藏与封面',
      description: '详情 / 关系抓取覆盖、封面缓存一致性、来源快照本地表示',
      status,
      checked: sourceSnapshots.rowsScanned,
      details: [
        `${subjects} 个 Subject`,
        `详情待补齐：${detailPending}`,
        `封面缓存标记与文件不一致：${missingFiles.length}`,
        `无原始封面链接：${noSource}`,
        '说明：封面缓存写入属于缓存层操作，不推进数据版本；本模块按检测时刻的磁盘状态判断。',
      ],
    },
    issues,
  };
};

const translationDetector: Detector = (): DetectorResult => {
  const total = toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM translation_jobs')?.n);
  const issues: DiagnosticIssue[] = [];
  let status: DiagnosticModule['status'] = 'ok';

  const completedEmpty = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM subjects
        WHERE summary_zh_ai_status = 'completed' AND trim(COALESCE(summary_zh_ai, '')) = ''`,
    )?.n,
  );
  const failed = toNumber(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM translation_jobs WHERE status = 'failed'`)?.n,
  );
  const stuck = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM translation_jobs
        WHERE status IN ('pending', 'processing')
          AND datetime(updated_at) < datetime('now', '-1 day')`,
    )?.n,
  );

  if (completedEmpty > 0) {
    status = 'error';
    issues.push({
      id: 'translation.completed-empty',
      detector: 'translation.queue',
      category: '简介翻译',
      severity: 'error',
      title: `${completedEmpty} 个条目标记为已翻译但内容为空`,
      explanation:
        '翻译状态与内容不一致：状态显示完成，但中文简介为空。到设置页的翻译队列重新入队即可修复（不会覆盖 Bangumi 原文）。',
      evidence: [{ label: '状态与内容不一致', value: `${completedEmpty} 条` }],
      impact: [{ kind: 'ui', label: '作品详情的中文简介' }],
      affected: [],
      affectedCount: completedEmpty,
      actions: [{ kind: 'link', label: '到设置页处理翻译队列', href: '/settings?tab=ai' }],
    });
  }
  if (failed > 0) {
    status = status === 'error' ? status : 'attention';
    issues.push({
      id: 'translation.failed',
      detector: 'translation.queue',
      category: '简介翻译',
      severity: 'needs-review',
      title: `${failed} 个翻译任务失败`,
      explanation: '失败任务会保留在队列里，可在设置页一键重试；失败不影响原文与已有翻译。',
      evidence: [{ label: '失败任务', value: `${failed} 条` }],
      impact: [{ kind: 'ui', label: '中文简介完成度' }],
      affected: [],
      affectedCount: failed,
      actions: [{ kind: 'link', label: '到设置页重试', href: '/settings?tab=ai' }],
      waitingFor: '等待重试（可能依赖 AI 服务可用性）',
      waiting: {
        kind: 'none',
        label: '可在设置页重试',
        detail: '失败任务保留在队列里，重试即可；失败不影响原文与已有翻译。',
      },
    });
  }
  if (stuck > 0) {
    status = status === 'error' ? status : 'attention';
    issues.push({
      id: 'translation.stuck',
      detector: 'translation.queue',
      category: '简介翻译',
      severity: 'suspicious',
      title: `${stuck} 个翻译任务超过 24 小时没有进展`,
      explanation: '任务停留在等待 / 处理状态超过一天，可能是 AI 未配置或请求被中断。到设置页检查 AI 配置后可重新唤醒队列。',
      evidence: [{ label: '停滞任务', value: `${stuck} 条` }],
      impact: [{ kind: 'ui', label: '中文简介完成度' }],
      affected: [],
      affectedCount: stuck,
      actions: [{ kind: 'link', label: '到设置页检查', href: '/settings?tab=ai' }],
      waiting: {
        kind: 'none',
        label: '可在设置页处理',
        detail: '检查 AI 配置后重新唤醒队列即可。',
      },
    });
  }

  return {
    module: {
      id: 'translation',
      label: '简介翻译',
      description: '翻译任务状态与内容一致性',
      status,
      checked: total,
      details: [
        `${total} 条翻译任务`,
        `状态与内容不一致：${completedEmpty}`,
        `失败：${failed}`,
        `停滞：${stuck}`,
        '说明：翻译完成属于缓存层写入，不推进数据版本；报告可能需要「重新检测」才会反映最新内容。',
      ],
    },
    issues,
  };
};

/**
 * NSFW 可见性：直接运行产品真实使用的查询，验证「策略已生效」。
 *
 * 这不是重新实现过滤，而是对最终 API / UI 口径做一次一致性检查：
 * 如果未来某条读取路径漏掉可见性过滤，这里会立刻报错。
 */
const visibilityDetector = (context: DetectorContext): DetectorResult => {
  const totalSubjects = toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM subjects')?.n);
  const seriesCount = toNumber(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM series_entities WHERE state <> 'stale'`)?.n,
  );
  const franchiseCount = toNumber(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM franchise_entities WHERE state <> 'stale'`)?.n,
  );

  if (!context.hideNsfw) {
    return {
      module: {
        id: 'visibility',
        label: 'NSFW 可见性',
        description: '全局隐藏策略的执行一致性',
        status: 'skipped',
        checked: 0,
        details: ['隐藏开关当前关闭：完整数据口径，无可见性过滤需要验证'],
      },
      issues: [],
    };
  }

  const issues: DiagnosticIssue[] = [];
  let status: DiagnosticModule['status'] = 'ok';

  const hiddenSubjects = toNumber(
    one<{ n: number }>('SELECT COUNT(*) AS n FROM subjects WHERE nsfw = 1')?.n,
  );
  const hiddenSeries = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM series_entities e WHERE e.state <> 'stale' AND EXISTS (
         SELECT 1 FROM series_entity_members m JOIN subjects s ON s.id = m.subject_id
          WHERE m.series_id = e.id AND m.role = 'primary' AND s.nsfw = 1)`,
    )?.n,
  );
  const hiddenFranchises = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM franchise_entities f WHERE f.state <> 'stale' AND NOT EXISTS (
         SELECT 1 FROM franchise_series fs
         JOIN series_entities e ON e.id = fs.series_id AND e.state <> 'stale'
          WHERE fs.franchise_id = f.id AND fs.state <> 'conflict'
            AND NOT EXISTS (SELECT 1 FROM series_entity_members m JOIN subjects s ON s.id = m.subject_id
                             WHERE m.series_id = e.id AND m.role = 'primary' AND s.nsfw = 1))`,
    )?.n,
  );

  // 真实产品查询：收藏库 / Series 列表 / Franchise 列表
  // Product reads are paged: asking for 2000 still returns at most 200.
  // Visit every page rather than interpreting a display window as a full check.
  const firstPage = listSubjects({ pageSize: 200, page: 1 });
  const libraryItems = [...firstPage.items];
  for (let page = 2; page <= firstPage.pageCount; page++) {
    libraryItems.push(...listSubjects({ pageSize: 200, page }).items);
  }
  const leakedSubjects = libraryItems.filter((item) => {
    const row = one<{ nsfw: number }>('SELECT nsfw FROM subjects WHERE id = :id', { id: item.id });
    return Boolean(row && Number(row.nsfw) === 1);
  });
  if (leakedSubjects.length > 0) {
    status = 'error';
    issues.push({
      id: 'visibility.subject-leak',
      detector: 'visibility.nsfw',
      category: 'NSFW 可见性',
      severity: 'error',
      title: '隐藏开启时收藏库仍返回 NSFW 条目',
      explanation:
        '可见性策略在收藏库读取路径上失效。这类问题属于代码层面的一致性错误，数据中枢不会自动修改数据，需要开发排查。',
      evidence: [
        { label: '泄漏条目', value: `${leakedSubjects.length} 条` },
        ...leakedSubjects.slice(0, 3).map((item) => ({
          label: `#${item.id}`,
          value: item.nameCn || item.name,
        })),
      ],
      impact: [
        { kind: 'ui', label: '收藏库', href: '/library' },
        { kind: 'search', label: '全局搜索' },
      ],
      affected: leakedSubjects.slice(0, 5).map((item) => ({
        label: item.nameCn || item.name,
        href: `/subjects/${item.id}`,
      })),
      affectedCount: leakedSubjects.length,
      actions: [],
      waitingFor: '需要代码层面排查（超出数据治理范围）',
    });
  }

  const seriesItems = listSeries({ includeSingletons: true, limit: Math.max(1, seriesCount) });
  const leakedSeries = seriesItems.filter((entry) => {
    const row = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM series_entity_members m JOIN subjects s ON s.id = m.subject_id
        WHERE m.series_id = (SELECT id FROM series_entities WHERE key = :key) AND m.role = 'primary' AND s.nsfw = 1`,
      { key: entry.key },
    );
    return toNumber(row?.n) > 0;
  });
  if (leakedSeries.length > 0) {
    status = 'error';
    issues.push({
      id: 'visibility.series-leak',
      detector: 'visibility.nsfw',
      category: 'NSFW 可见性',
      severity: 'error',
      title: '隐藏开启时 Series 列表仍返回含 NSFW 成员的系列',
      explanation: 'Series 级别的可见性过滤失效，需要代码层面排查。',
      evidence: leakedSeries.slice(0, 5).map((entry) => ({
        label: entry.key,
        value: entry.title,
      })),
      impact: [
        { kind: 'series', label: 'Series 列表', href: '/series' },
        { kind: 'search', label: 'Series 搜索', href: '/series' },
      ],
      affected: leakedSeries.slice(0, 5).map((entry) => ({
        label: entry.title,
        href: `/series/${entry.key}`,
      })),
      affectedCount: leakedSeries.length,
      actions: [],
      waitingFor: '需要代码层面排查（超出数据治理范围）',
    });
  }

  const franchises = listFranchises({ limit: Math.max(1, franchiseCount) });
  const leakedFranchises = franchises.filter((entry) => {
    const detail = getFranchiseDetail(entry.key);
    return Boolean(detail && detail.series.length === 0);
  });
  if (leakedFranchises.length > 0) {
    status = 'error';
    issues.push({
      id: 'visibility.franchise-leak',
      detector: 'visibility.nsfw',
      category: 'NSFW 可见性',
      severity: 'error',
      title: '隐藏开启时 Franchise 列表出现空家族',
      explanation: '家族级可见性过滤失效：列表返回了没有可见 Series 的家族。',
      evidence: leakedFranchises.slice(0, 5).map((entry) => ({ label: entry.key, value: entry.title })),
      impact: [{ kind: 'franchise', label: 'Franchise 列表', href: '/franchises' }],
      affected: leakedFranchises.slice(0, 5).map((entry) => ({
        label: entry.title,
        href: `/franchises/${entry.key}`,
      })),
      affectedCount: leakedFranchises.length,
      actions: [],
      waitingFor: '需要代码层面排查（超出数据治理范围）',
    });
  }

  return {
    module: {
      id: 'visibility',
      label: 'NSFW 可见性',
      description: '隐藏策略在收藏库 / Series / Franchise 读取路径上的执行一致性',
      status,
      checked: totalSubjects + seriesCount + franchiseCount,
      details: [
        `隐藏开关：开启`,
        `当前隐藏：${hiddenSubjects} 个条目 · ${hiddenSeries} 个 Series · ${hiddenFranchises} 个 Franchise`,
        `收藏库 / Series / Franchise 读取路径验证通过`,
      ],
    },
    issues,
  };
};

/* --------------------------------------------------------------- 注册表 */

/**
 * 可达性与孤儿检测（v1.6.1 新增）。
 *
 * 回答的问题不是「某字段为空」，而是「数据库里有实体，但正常产品路径进不去 / 搜不到」：
 * - 搜索可达性：实体必须能被自己的展示标题搜到（复用真实搜索逻辑）；
 * - 孤儿实体：没有成员的 Series、没有链接的 Franchise、没有收藏行的 Subject；
 * - 失效别名：旧 key 指向已 stale / 不存在的实体（旧书签会 404）。
 */
const reachabilityDetector: Detector = (): DetectorResult => {
  const seriesCount = toNumber(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM series_entities WHERE state <> 'stale'`)?.n,
  );
  const issues: DiagnosticIssue[] = [];
  let status: DiagnosticModule['status'] = 'ok';
  let checked = seriesCount;

  const unreachableSeries = seriesSearchSelfCheck();
  const unreachableFranchises = franchiseSearchSelfCheck();
  const unreachable = [
    ...unreachableSeries.map((entry) => ({ kind: 'Series' as const, ...entry, href: `/series/${entry.key}` })),
    ...unreachableFranchises.map((entry) => ({
      kind: 'Franchise' as const,
      ...entry,
      href: `/franchises/${entry.key}`,
    })),
  ];
  if (unreachable.length > 0) {
    status = 'error';
    issues.push({
      id: 'search.unreachable',
      detector: 'reachability.entities',
      category: '可达性与孤儿',
      severity: 'error',
      title: `${unreachable.length} 个实体无法通过搜索命中自己`,
      explanation:
        '这些实体存在于数据库与 API 中，但用它们自己的展示标题做搜索时找不到自己。说明展示标题与搜索投影不一致（例如标题为空或候选 / 成员索引缺失），用户会「看得到列表却搜不到」。',
      evidence: unreachable.slice(0, 6).map((entry) => ({
        label: `${entry.kind} ${entry.key}`,
        value: entry.title ? `标题「${entry.title}」无法命中自己` : '标题为空',
      })),
      impact: [
        { kind: 'search', label: 'Series / Franchise 搜索', href: '/series' },
        { kind: 'ui', label: '实体列表与详情' },
      ],
      affected: unreachable.slice(0, 8).map((entry) => ({
        label: `${entry.kind} ${entry.title || entry.key}`,
        href: entry.href,
      })),
      affectedCount: unreachable.length,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建派生数据',
          preview: recomputePreview(`${unreachable.length} 个实体的展示标题无法命中自己`),
        },
      ],
      waiting: {
        kind: 'none',
        label: '可自动修复',
        detail: '重建会按当前证据重新生成标题与候选；如果仍然不可达，说明是搜索投影代码问题，需要开发排查。',
      },
    });
  }

  const emptySeries = allSamples(
    `SELECT e.key, e.title FROM series_entities e
      WHERE e.state <> 'stale'
        AND NOT EXISTS (SELECT 1 FROM series_entity_members m WHERE m.series_id = e.id AND m.role = 'primary')
      ORDER BY 1`,
  );
  if (emptySeries.length > 0) {
    status = 'error';
    issues.push({
      id: 'orphan.series',
      detector: 'reachability.entities',
      category: '可达性与孤儿',
      severity: 'error',
      title: `${emptySeries.length} 个 Series 没有任何正式成员`,
      explanation:
        '这些 Series 在列表 / 搜索里存在，但点进去没有任何成员内容，属于孤儿实体。重建派生数据会按当前成员关系清理或修正它们。',
      evidence: emptySeries.slice(0, 5).map((row) => ({ label: String(row.title), value: String(row.key) })),
      impact: [
        { kind: 'series', label: 'Series 列表 / 详情', href: '/series' },
        { kind: 'search', label: 'Series 搜索', href: '/series' },
      ],
      affected: emptySeries.slice(0, 5).map((row) => ({
        label: String(row.title),
        href: `/series/${row.key}`,
      })),
      affectedCount: emptySeries.length,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建派生数据',
          preview: recomputePreview(`${emptySeries.length} 个 Series 没有任何正式成员`),
        },
      ],
    });
  }

  const emptyFranchises = allSamples(
    `SELECT f.key, f.title FROM franchise_entities f
      WHERE f.state <> 'stale'
        AND NOT EXISTS (SELECT 1 FROM franchise_series fs WHERE fs.franchise_id = f.id)
      ORDER BY 1`,
  );
  if (emptyFranchises.length > 0) {
    status = 'error';
    issues.push({
      id: 'orphan.franchise',
      detector: 'reachability.entities',
      category: '可达性与孤儿',
      severity: 'error',
      title: `${emptyFranchises.length} 个 Franchise 没有任何成员 Series`,
      explanation: '家族详情会显示空内容，属于孤儿实体。重建派生数据会清理这些家族。',
      evidence: emptyFranchises.slice(0, 5).map((row) => ({ label: String(row.title), value: String(row.key) })),
      impact: [{ kind: 'franchise', label: 'Franchise 列表 / 详情', href: '/franchises' }],
      affected: emptyFranchises.slice(0, 5).map((row) => ({
        label: String(row.title),
        href: `/franchises/${row.key}`,
      })),
      affectedCount: emptyFranchises.length,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建派生数据',
          preview: recomputePreview(`${emptyFranchises.length} 个 Franchise 没有任何成员 Series`),
        },
      ],
    });
  }

  const subjectOrphans = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM subjects s
        WHERE NOT EXISTS (SELECT 1 FROM collections c WHERE c.subject_id = s.id)`,
    )?.n,
  );
  if (subjectOrphans > 0) {
    status = 'error';
    issues.push({
      id: 'orphan.subject',
      detector: 'reachability.entities',
      category: '可达性与孤儿',
      severity: 'error',
      title: `${subjectOrphans} 个 Subject 没有对应的收藏记录`,
      explanation:
        '收藏库以 Collection 为入口，没有收藏行的 Subject 在正常产品路径中不可达。数据中枢不会自动删除任何 Subject，需要先确认它是否应该存在。',
      evidence: [{ label: '没有收藏行的 Subject', value: `${subjectOrphans} 条` }],
      impact: [{ kind: 'subject', label: '收藏库 / 搜索可达性', href: '/library' }],
      affected: [],
      affectedCount: subjectOrphans,
      actions: [],
      waitingFor: '需要人工 / 开发确认这些 Subject 的来源（可能是导入或迁移残留）',
      waiting: {
        kind: 'none',
        label: '不能自动修复',
        detail: '删除数据不在数据中枢的能力范围内；请先确认来源。',
      },
    });
  }

  const deadAliases = allSamples(
    `SELECT a.alias_key, a.entity_kind, a.entity_id FROM entity_aliases a
      WHERE (a.entity_kind = 'series' AND NOT EXISTS (
               SELECT 1 FROM series_entities e WHERE e.id = a.entity_id AND e.state <> 'stale'))
         OR (a.entity_kind = 'franchise' AND NOT EXISTS (
               SELECT 1 FROM franchise_entities f WHERE f.id = a.entity_id AND f.state <> 'stale'))
      ORDER BY 1`,
  );
  checked += toNumber(one<{ n: number }>('SELECT COUNT(*) AS n FROM entity_aliases')?.n);
  /* v1.8.3（P1）：stale 身份解析覆盖 —— 旧 key 既没有 live 目标、也没有可解析 alias。 */
  const unresolvableStale = toNumber(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM series_entities e
        WHERE e.state = 'stale'
          AND NOT EXISTS (
            SELECT 1 FROM entity_aliases a
              JOIN series_entities t ON t.id = a.entity_id AND t.state <> 'stale'
             WHERE a.alias_key = e.key AND a.entity_kind = 'series')`,
    )?.n,
  );
  if (deadAliases.length > 0) {
    let lifecyclePlan: EntityLifecyclePlan | null = null;
    try {
      lifecyclePlan = planEntityLifecycle();
    } catch {
      lifecyclePlan = null;
    }
    status = 'error';
    issues.push({
      id: 'orphan.alias',
      detector: 'reachability.entities',
      category: '可达性与孤儿',
      severity: 'error',
      title: `${deadAliases.length} 个旧 key 别名指向已失效实体`,
      explanation:
        '旧的 Series / Franchise key 仍然记录在别名表里，但目标实体已经 stale 或不存在，使用旧书签访问会 404。重建派生数据会重新对账别名注册表。',
      evidence: deadAliases.slice(0, 6).map((row) => ({
        label: String(row.alias_key),
        value: `→ ${String(row.entity_kind)} #${String(row.entity_id)}（已失效）`,
      })),
      impact: [
        { kind: 'ui', label: '旧链接 / 浏览器书签' },
        { kind: 'api', label: '旧 key 的别名解析' },
      ],
      affected: deadAliases.slice(0, 6).map((row) => ({
        label: String(row.alias_key),
        detail: `→ ${String(row.entity_kind)} #${String(row.entity_id)}（已失效）`,
      })),
      affectedCount: deadAliases.length,
      actions: [
        {
          kind: 'repair',
          repairKind: 'recompute-derived',
          label: '重建别名对账',
          preview: aliasLifecyclePreview(deadAliases, lifecyclePlan),
        },
      ],
    });
  }

  return {
    module: {
      id: 'reachability',
      label: '可达性与孤儿',
      description: '搜索可达性、孤儿实体与失效别名',
      status,
      checked,
      details: [
        `Series 自搜索失败：${unreachableSeries.length}`,
        `Franchise 自搜索失败：${unreachableFranchises.length}`,
        `孤儿 Series / Franchise：${emptySeries.length} / ${emptyFranchises.length}`,
        `无收藏行的 Subject：${subjectOrphans}`,
        `失效别名：${deadAliases.length}`,
        `不可解析的 stale 身份：${unresolvableStale}`,
      ],
    },
    issues,
  };
};

export const DETECTORS: Detector[] = [
  storageDetector,
  syncDetector,
  seriesDetector,
  franchiseDetector,
  titleDetector,
  relationDetector,
  collectionDetector,
  translationDetector,
  visibilityDetector,
  reachabilityDetector,
];

/** 小工具：查询一批样本行（检测器只读，不写数据）。 */
function allSamples(sql: string, params: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return all<Record<string, unknown>>(sql, params);
}
