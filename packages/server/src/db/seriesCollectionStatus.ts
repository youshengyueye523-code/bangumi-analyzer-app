import { supportsQualitySchema } from './schema.js';
/** Current local membership → collection state distribution. Not an upstream/raw oracle. */
import { createHash } from 'node:crypto';
import { ApiError, type DiagnosticIssue, type DiagnosticsRepairCheck } from '@bangumi-analyzer/shared';
import { dataVersion, getDatabase, run, schemaVersion, transaction } from './index.js';
import { recordMutation } from './mutation.js';
import { getSeriesDetail, isSeriesHidden, listSeries } from './query.js';

export const STATUS_DRIFT = 'series.collection-status-drift';
export const STATUS_UNASSESSABLE = 'series.collection-status-unassessable';
const LIMIT = 20;
const MEMBER_EVIDENCE_LIMIT = 10;
const MAX_STATUS_BYTES = 4096;
type Counts = Record<string, number>;
interface StatusPlan {
  key: string;
  id: string;
  before: string;
  expected: Counts;
  token: string;
  blocked: boolean;
  evidence: string[];
  memberCount: number;
  blockingMemberCount: number;
  blockingEvidence: string[];
}
export interface StatusScan {
  seriesScanned: number;
  membersScanned: number;
  driftCount: number;
  blockedCount: number;
  plans: StatusPlan[];
  blockedSamples: StatusPlan[];
  dataVersion: number;
}

/** Sparse/zero-filled objects and key order are equivalent; malformed values are not. */
export function statusCountsEqual(value: unknown, expected: Counts): boolean {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_STATUS_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const counts = parsed as Counts;
    return Object.entries(counts).every(([k, n]) => /^[1-5]$/.test(k) && Number.isSafeInteger(n) && n >= 0) &&
      ['1', '2', '3', '4', '5'].every(k => (counts[k] ?? 0) === (expected[k] ?? 0));
  } catch { return false; }
}

/** Full streaming scan, bounded evidence. target is for Execute/Verify, never a scan limit. */
export function inspectSeriesCollectionStatus(target?: string): StatusScan {
  const db = getDatabase();
  let active = false;
  try {
    db.exec('SAVEPOINT diagnostic_series_collection_status'); active = true;
    if (!supportsQualitySchema(schemaVersion())) throw Error('Unassessed status schema');
    const result: StatusScan = {seriesScanned: 0, membersScanned: 0, driftCount: 0, blockedCount: 0,
      plans: [], blockedSamples: [], dataVersion: dataVersion()};
    // No JSON SQL parsing, no per-entity nested scans, no sample-limited verdict.
    const stmt = db.prepare(`WITH duplicate_primary AS (
      SELECT m.subject_id FROM series_entity_members m JOIN series_entities e ON e.id=m.series_id
      WHERE m.role='primary' AND e.state<>'stale' GROUP BY m.subject_id HAVING COUNT(*)>1
    ) SELECT e.id,e.key,e.state,e.revision,e.updated_at,
      typeof(e.status_counts) AS status_storage,length(CAST(e.status_counts AS BLOB)) AS status_bytes,
      CASE WHEN length(CAST(e.status_counts AS BLOB))<=${MAX_STATUS_BYTES} THEN e.status_counts ELSE NULL END AS status_counts,
      m.subject_id,m.state AS member_state,m.reason_code,m.via_subject_id,m.via_relation,m.position,
      s.id AS local_subject,s.nsfw,c.subject_id AS collected,c.type,
      typeof(c.type) AS type_storage,c.updated_at AS collection_updated,c.synced_at,
      d.subject_id AS duplicate_primary
      FROM series_entities e LEFT JOIN series_entity_members m ON m.series_id=e.id AND m.role='primary'
      LEFT JOIN subjects s ON s.id=m.subject_id LEFT JOIN collections c ON c.subject_id=m.subject_id
      LEFT JOIN duplicate_primary d ON d.subject_id=m.subject_id
      WHERE e.state<>'stale' ORDER BY e.id,m.subject_id`);
    stmt.setReadBigInts(true);
    let current: StatusPlan | undefined;
    let digest = createHash('sha256');
    const finish = () => {
      if (!current) return;
      current.token = digest.digest('hex');
      if (current.blocked) {
        result.blockedCount++;
        if ((target === undefined || target === current.key) && result.blockedSamples.length < LIMIT) result.blockedSamples.push(current);
      } else if (!statusCountsEqual(current.before, current.expected)) {
        result.driftCount++;
        if ((target === undefined || target === current.key) && result.plans.length < LIMIT) result.plans.push(current);
      }
    };
    for (const row of stmt.iterate()) {
      if (typeof row.id !== 'bigint' || typeof row.key !== 'string') throw Error('Invalid series identity');
      if (typeof row.status_bytes === 'bigint' && row.status_bytes > BigInt(MAX_STATUS_BYTES)) throw Error('Status projection exceeds read budget');
      if (!current || current.id !== row.id.toString()) {
        finish(); result.seriesScanned++;
        current = {id: row.id.toString(), key: row.key, before: typeof row.status_counts === 'string' && row.status_storage === 'text'
          ? row.status_counts : `[${row.status_storage}: ${row.status_counts instanceof Uint8Array ? Buffer.from(row.status_counts).toString('hex') : String(row.status_counts)}]`,
          expected: {}, blocked: false, evidence: [], memberCount: 0, blockingMemberCount: 0, blockingEvidence: [], token: ''};
        digest = createHash('sha256').update(JSON.stringify([result.dataVersion, current.id, row.key, row.state,
          String(row.revision), row.updated_at, row.status_storage, String(row.status_bytes), current.before]));
      }
      if (row.subject_id === null) continue;
      result.membersScanned++;
      current.memberCount++;
      const type = typeof row.type === 'bigint' ? Number(row.type) : row.type;
      const validType = row.type_storage === 'integer' && typeof type === 'number' && Number.isInteger(type) && type >= 1 && type <= 5;
      const valid = row.collected === null || (row.local_subject !== null && validType);
      const reasons: string[] = [];
      if (row.collected !== null && row.local_subject === null) reasons.push('缺失本地Subject');
      if (row.collected !== null && !validType) reasons.push('非法收藏状态');
      if (row.duplicate_primary !== null) reasons.push('重复live primary归属');
      current.blocked ||= reasons.length > 0;
      if (row.collected !== null && valid) {
        const key = String(type); current.expected[key] = (current.expected[key] ?? 0) + 1;
      }
      // Source identities and generations, not inferred truth from a potentially older raw snapshot.
      const fields = [row.subject_id,row.local_subject,row.nsfw,row.collected,row.type,row.type_storage,
        row.collection_updated,row.synced_at,row.duplicate_primary].map(x => typeof x === 'bigint' ? x.toString() : x);
      digest.update(JSON.stringify(fields));
      digest.update(JSON.stringify([row.member_state,row.reason_code,String(row.via_subject_id),row.via_relation,String(row.position)]));
      if (current.evidence.length < MEMBER_EVIDENCE_LIMIT) current.evidence.push(JSON.stringify(fields));
      // Blocking causes have their own budget; normal context cannot evict them.
      if (reasons.length) {
        current.blockingMemberCount++;
        if (current.blockingEvidence.length < MEMBER_EVIDENCE_LIMIT) current.blockingEvidence.push(JSON.stringify({
          subjectId: fields[0], reasons, localSubjectId: fields[1], nsfw: fields[2],
          collectionSubjectId: fields[3], collectionType: fields[4], storage: fields[5],
          updatedAt: fields[6], syncedAt: fields[7], duplicatePrimarySubjectId: fields[8],
        }));
      }
    }
    finish();
    db.exec('RELEASE SAVEPOINT diagnostic_series_collection_status'); active = false;
    return result;
  } catch {
    if (active) { try { db.exec('ROLLBACK TO SAVEPOINT diagnostic_series_collection_status'); }
      finally { db.exec('RELEASE SAVEPOINT diagnostic_series_collection_status'); } }
    throw new ApiError('Series 收藏状态对账未完成，不能认定一致', {
      code: 'series_status_check_incomplete', status: 500, dataIntact: true,
      hint: '保留来源与人工治理；Schema 未核验或读取中断时不能使用健康结论。',
    });
  }
}

export function seriesCollectionStatusIssues(scan: StatusScan): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const shared = {
    detector: 'series.entities', category: 'Series 派生数据',
    impact: [{kind: 'series' as const, label: 'Series 列表 / 详情', href: '/series'}],
  };
  if (scan.driftCount) issues.push({...shared, id: STATUS_DRIFT, severity: 'error',
    title: 'Series 收藏状态分布与当前收藏事实不一致',
    explanation: '当前正式成员的收藏状态分组与物化分布不一致，即使收藏总数相同也可能错误。影响系列列表与详情状态标签；不等同于上游错误、数据库损坏或 Real / Visible 差异。不比较不同代次 raw，也不把未收藏或 relation-only 成员推断为想看。',
    evidence: [{label: '检查范围', value: `${scan.seriesScanned} 个当前 Series，${scan.membersScanned} 条正式成员；dataVersion=${scan.dataVersion}；异常 ${scan.driftCount}；每次展示最多 ${LIMIT} 个修复目标`},
      ...scan.plans.map(p => ({label: p.key, value: `当前 ${p.before} → 来源重算 ${JSON.stringify(p.expected)}；成员上下文${p.memberCount > p.evidence.length ? '已截断' : '完整'}：展示 ${p.evidence.length}/${p.memberCount}，未展示 ${p.memberCount - p.evidence.length}；源字段顺序 subject/本地subject/nsfw/collection/type/storage/updated/synced/重复归属：${p.evidence.join(';')}`}))],
    affected: scan.plans.map(p => ({label: p.key, href: `/series/${encodeURIComponent(p.key)}`})), affectedCount: scan.driftCount,
    actions: scan.plans.filter(p => p.key.length <= 120).map(p => ({kind: 'repair', repairKind: 'recompute-derived', target: p.key, value: p.token,
      label: '从当前成员与收藏重新生成状态分布',
      preview: {current: `${p.key}: ${p.before}`, next: JSON.stringify(p.expected),
        reason: '仅重算有确定本地来源的收藏状态分布；不重建身份或改变成员。', source: 'series_entity_members.primary + collections.type（当前本地事实）',
        directlyChanges: [], derivedChanges: [`${p.key}.status_counts: ${p.before} → ${JSON.stringify(p.expected)}`],
        untouched: ['原始来源、收藏、成员、人工名称、候选裁决、排除与历史均不修改'],
        chain: [{layer: 'source', label: '当前成员与收藏事实', detail: `dataVersion=${scan.dataVersion}；计划=${p.token}`},
          {layer: 'projection', label: '重新生成目标状态分布', detail: '只重算该 Series 的 status_counts；不执行全图重建'},
          {layer: 'api', label: 'Series 列表 / 详情', detail: '复检物化分布、详情观看统计与列表状态分布'},
          {layer: 'cache', label: '缓存失效', detail: '通过统一 mutation 推进数据版本并失效统计与报告缓存'}]},
    })),
    waitingFor: '按预览逐个重算；其余目标在刷新后继续提供。不支持批量猜测或重写来源。',
  });
  if (scan.blockedCount) issues.push({...shared, id: STATUS_UNASSESSABLE, severity: 'needs-review',
    title: '部分 Series 收藏状态无法可靠对账',
    explanation: '当前正式成员存在非法收藏状态、缺失本地来源或重复正式归属，不能生成唯一可信的状态分布。这不是未知上游字段或正常未收藏状态；保留来源与人工治理，不自动改收藏或成员。阻断成员证据采用有界样本；具体原因、展示数量与未展示数量见完整审计证据，安全摘要不代表完整证据。',
    evidence: [{label: '检查范围', value: `无法可靠对账 ${scan.blockedCount} 个 Series；展示 ${scan.blockedSamples.length} 个，未展示 ${scan.blockedCount - scan.blockedSamples.length} 个；每个 Series 最多 ${MEMBER_EVIDENCE_LIMIT} 条阻断成员证据，不是全量成员清单`},
      ...scan.blockedSamples.map(p => ({label: p.key, value: `阻断成员证据${p.blockingMemberCount > p.blockingEvidence.length ? '已截断' : '完整'}：展示 ${p.blockingEvidence.length}/${p.blockingMemberCount}，未展示 ${p.blockingMemberCount - p.blockingEvidence.length}；正式成员 ${p.memberCount}；${p.blockingEvidence.join(';')}`}))],
    affected: [], affectedCount: scan.blockedCount, actions: [],
    waiting: {kind: 'manual-review', label: '先核查收藏来源与成员归属', detail: '保留备份与原始证据，经授权补正可信来源或治理后重新检测；不能使用全图重建强行消除。'},
    waitingFor: '先核查收藏来源与成员归属',
  });
  return issues;
}

/** Re-derive from authoritative local facts, never accept client-provided projection values. */
export function recomputeSeriesCollectionStatus(target: string, token: string): DiagnosticsRepairCheck[] {
  return transaction(() => {
    const before = inspectSeriesCollectionStatus(target);
    const plan = before.plans.find(p => p.key === target && p.token === token);
    if (!plan) throw new ApiError('状态分布预览已失效或来源不可信，请重新检测', {code: 'series_status_plan_stale', status: 409, dataIntact: true});
    run('UPDATE series_entities SET status_counts=:counts WHERE key=:key AND state<>\'stale\'', {key: target, counts: JSON.stringify(plan.expected)});
    const mutation = recordMutation('repair', 'recompute-series-collection-status');
    const after = inspectSeriesCollectionStatus(target);
    const detail = getSeriesDetail(target);
    const hidden = isSeriesHidden(target);
    const list = listSeries({includeSingletons: true, limit: Number.MAX_SAFE_INTEGER}).find(s => s.key === target);
    const checks: DiagnosticsRepairCheck[] = [
      {layer: 'projection', label: '目标收藏状态分布重新对账', ok: !after.plans.length && !after.blockedSamples.length, detail: `目标 ${target}；从当前来源再次全量对账`},
      {layer: 'cache', label: '数据版本 / 缓存失效', ok: mutation.dataVersion > before.dataVersion, detail: '通过统一 mutation 推进数据版本并失效统计与报告缓存'},
      {layer: 'api', label: 'Series 列表 / 详情状态分布', ok: hidden ? detail === null && list === undefined : Boolean(detail && list &&
        statusCountsEqual(JSON.stringify(detail.statusCounts), plan.expected) && statusCountsEqual(JSON.stringify(list.statusCounts), plan.expected) &&
        [detail.watch.wish,detail.watch.watched,detail.watch.watching,detail.watch.onHold,detail.watch.dropped].every((n,i) => n === (plan.expected[String(i+1)] ?? 0))),
        detail: hidden ? '当前隐私口径下目标列表与详情均不可见；Real 不变量独立检查' : '可见列表、详情分布与详情观看统计按同一当前来源验证'},
    ];
    return checks;
  });
}
