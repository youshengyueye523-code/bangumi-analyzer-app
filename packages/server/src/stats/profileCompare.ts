/**
 * 阶段复盘：比较两个画像快照，回答「这一阶段推翻了上一阶段的哪些判断」。
 *
 * 全部结论都由两个快照的数据直接计算，不依赖 AI；
 * AI 只会在拿到这些结构化差异之后，负责写成一段自然语言复盘。
 */

import {
  COLLECTION_TYPE_LABEL,
  type ProfileChange,
  type ProfileComparison,
  type ProfileDimensionStat,
  type ProfileSnapshotSummary,
} from '@bangumi-analyzer/shared';
import {
  getSnapshot,
  type SnapshotMember,
  type SnapshotRecord,
} from '../db/profileSnapshots.js';
import { nowIso, round } from '../util.js';
import { z } from 'zod';

const RELATIVE_THRESHOLD = 0.15;
const MIN_SAMPLE = 5;

// 仅核验对比实际消费的证据；不能用容错默认值把损坏快照伪装成完整 Real。
const countSchema = z.number().int().nonnegative();
const shareSchema = z.number().finite().min(0).max(1);
const dimensionSchema = z.object({
  name: z.string(), count: countSchema, share: shareSchema,
  averageRate: z.number().finite().min(0).max(10).nullable(),
});
const comparisonDatasetSchema = z.object({
  visibility: z.literal('real'),
  personalRatingPolicy: z.literal('exclude-wish-v1').optional(),
  sample: z.object({ total: countSchema, rated: countSchema, highRated: countSchema }),
  basics: z.object({ averageRate: z.number().finite().min(1).max(10).nullable() }),
  tags: z.array(dimensionSchema), formats: z.array(dimensionSchema),
  studios: z.array(dimensionSchema), directors: z.array(dimensionSchema),
  tagPairs: z.array(z.object({ a: z.string(), b: z.string(), count: countSchema, share: shareSchema })),
  breadth: z.object({
    distinctTags: countSchema, recentPeriodEntropy: z.number().finite().nonnegative().nullable(),
    top5TagShare: shareSchema.nullable(),
  }),
});
const comparisonMembersSchema = z.record(
  z.string().regex(/^[1-9]\d*$/).refine((key) => Number.isSafeInteger(Number(key))),
  z.tuple([z.number().int().min(1).max(5), z.number().int().min(0).max(10)]),
);

function hasComparableEvidence(record: SnapshotRecord): boolean {
  if (!comparisonDatasetSchema.safeParse(record.dataset).success ||
      !comparisonMembersSchema.safeParse(record.members).success) return false;
  const members = Object.values(record.members);
  if (record.dataset.personalRatingPolicy === 'exclude-wish-v1' &&
      members.some(([status, rate]) => status === 1 && rate !== 0)) return false;
  const rates = members.map((member) => member[1]).filter((rate) => rate > 0);
  const rated = rates.length;
  const highRated = rates.filter((rate) => rate >= 8).length;
  const average = rated ? round(rates.reduce((sum, rate) => sum + rate, 0) / rated) : null;
  if (record.dataset.sample.total !== members.length || record.collectionCount !== members.length ||
      record.dataset.sample.rated !== rated || record.ratedCount !== rated ||
      record.dataset.sample.highRated !== highRated || record.averageRate !== average ||
      record.dataset.basics.averageRate !== average) return false;
  // 维度占比使用全部收藏；标签共现使用高分收藏。不能把类型合法的矛盾值当作证据。
  const validShare = (count: number, share: number, denominator: number) =>
    count <= denominator && share === (denominator ? Number((count / denominator).toFixed(4)) : 0);
  for (const key of ['tags', 'formats', 'studios', 'directors'] as const) {
    const rows = record.dataset[key];
    if (new Set(rows.map((row) => row.name)).size !== rows.length ||
        rows.some((row) => !validShare(row.count, row.share, members.length))) return false;
  }
  return record.dataset.tagPairs.every((pair) => validShare(pair.count, pair.share, highRated));
}

type DimensionKey = 'formats' | 'tags' | 'studios' | 'directors';

const DIMENSION_LABEL: Record<DimensionKey, string> = {
  formats: '放送形态',
  tags: '标签偏好',
  studios: '制作公司',
  directors: '导演',
};

function topOf(dataset: SnapshotRecord['dataset'], key: DimensionKey): ProfileDimensionStat | null {
  const list = dataset[key];
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0] ?? null;
}

function compareDimension(
  key: DimensionKey,
  from: SnapshotRecord['dataset'],
  to: SnapshotRecord['dataset'],
): ProfileChange {
  const label = DIMENSION_LABEL[key];
  const before = topOf(from, key);
  const after = topOf(to, key);
  const id = `dimension-${key}`;

  if (!before || !after || before.count < MIN_SAMPLE || after.count < MIN_SAMPLE) {
    return {
      id,
      dimension: label,
      verdict: 'insufficient',
      statement: `${label}的样本量不足，暂不判断变化。`,
      evidence: [
        `上一阶段最多：${before ? `${before.name}（${before.count} 部）` : '无'}`,
        `本阶段最多：${after ? `${after.name}（${after.count} 部）` : '无'}`,
        `判断门槛：两阶段各自至少 ${MIN_SAMPLE} 部作品`,
      ],
    };
  }

  if (before.name !== after.name) {
    return {
      id,
      dimension: label,
      verdict: 'overturned',
      statement: `${label}的第一位发生了变化：从「${before.name}」变为「${after.name}」。`,
      evidence: [
        `上一阶段：${before.name} ${before.count} 部（占比 ${(before.share * 100).toFixed(1)}%）`,
        `本阶段：${after.name} ${after.count} 部（占比 ${(after.share * 100).toFixed(1)}%）`,
      ],
    };
  }

  const relative = before.share > 0 ? (after.share - before.share) / before.share : 0;
  // 百分比以十进制保存，精确的 ±15% 可能比门槛少一个浮点 ULP。
  const boundaryTolerance = Number.EPSILON * 8;
  const verdict =
    relative >= RELATIVE_THRESHOLD - boundaryTolerance
      ? 'strengthened'
      : relative <= -RELATIVE_THRESHOLD + boundaryTolerance
        ? 'weakened'
        : 'continued';
  const direction =
    verdict === 'strengthened' ? '进一步强化' : verdict === 'weakened' ? '有所减弱' : '保持稳定';

  return {
    id,
    dimension: label,
    verdict,
    statement: `${label}的核心仍然是「${after.name}」，占比 ${direction}。`,
    evidence: [
      `占比变化：${(before.share * 100).toFixed(1)}% → ${(after.share * 100).toFixed(1)}%`,
      `作品数：${before.count} 部 → ${after.count} 部`,
      `平均我的评分：${before.averageRate ?? '—'} → ${after.averageRate ?? '—'}`,
    ],
  };
}

function compareCoreTemplate(
  from: SnapshotRecord['dataset'],
  to: SnapshotRecord['dataset'],
): ProfileChange {
  const before = from.tagPairs?.[0];
  const after = to.tagPairs?.[0];
  const describe = (pair: typeof after) => (pair ? `${pair.a} + ${pair.b}（${pair.count} 部）` : '无');

  if (!before || !after) {
    return {
      id: 'core-template',
      dimension: '核心审美模板',
      verdict: 'insufficient',
      statement: '至少有一个阶段的标签共现样本不足，无法判断核心模板是否变化。',
      evidence: [`上一阶段：${describe(before)}`, `本阶段：${describe(after)}`],
    };
  }

  const same = before.a === after.a && before.b === after.b;
  return {
    id: 'core-template',
    dimension: '核心审美模板',
    verdict: same ? 'continued' : 'overturned',
    statement: same
      ? `核心审美模板保持为「${after.a} + ${after.b}」。`
      : `核心审美模板发生变化：从「${before.a} + ${before.b}」变为「${after.a} + ${after.b}」。`,
    evidence: [
      `上一阶段：${describe(before)}，占高分作品 ${(before.share * 100).toFixed(1)}%`,
      `本阶段：${describe(after)}，占高分作品 ${(after.share * 100).toFixed(1)}%`,
    ],
  };
}

function compareBreadth(
  from: SnapshotRecord['dataset'],
  to: SnapshotRecord['dataset'],
): ProfileChange {
  const before = from.breadth;
  const after = to.breadth;
  const entropyDelta =
    before?.recentPeriodEntropy !== null &&
    before?.recentPeriodEntropy !== undefined &&
    after?.recentPeriodEntropy !== null &&
    after?.recentPeriodEntropy !== undefined
      ? Number((after.recentPeriodEntropy - before.recentPeriodEntropy).toFixed(2))
      : null;
  const tagDelta = (after?.distinctTags ?? 0) - (before?.distinctTags ?? 0);

  let verdict: ProfileChange['verdict'] = 'continued';
  if (entropyDelta === null) verdict = 'insufficient';
  else if (entropyDelta >= 0.3) verdict = 'strengthened';
  else if (entropyDelta <= -0.3) verdict = 'weakened';

  return {
    id: 'breadth',
    dimension: '兴趣边界',
    verdict,
    statement:
      verdict === 'insufficient'
        ? '缺少可比的时间分段数据，无法判断兴趣范围的变化。'
        : verdict === 'strengthened'
          ? '兴趣范围在本阶段扩大。'
          : verdict === 'weakened'
            ? '兴趣范围在本阶段收窄。'
            : '兴趣范围基本稳定。',
    evidence: [
      `不同标签数：${before?.distinctTags ?? '—'} → ${after?.distinctTags ?? '—'}（${tagDelta >= 0 ? '+' : ''}${tagDelta}）`,
      `最近阶段标签分散度：${before?.recentPeriodEntropy ?? '—'} → ${after?.recentPeriodEntropy ?? '—'}`,
      `前 5 标签覆盖率：${before?.top5TagShare !== null && before?.top5TagShare !== undefined ? `${(before.top5TagShare * 100).toFixed(1)}%` : '—'} → ${after?.top5TagShare !== null && after?.top5TagShare !== undefined ? `${(after.top5TagShare * 100).toFixed(1)}%` : '—'}`,
    ],
  };
}

function summarize(summary: ProfileSnapshotSummary): ProfileSnapshotSummary {
  return summary;
}

export function compareSnapshots(fromId: number, toId: number): ProfileComparison | null {
  const fromRecord = getSnapshot(fromId);
  const toRecord = getSnapshot(toId);
  if (!fromRecord || !toRecord) return null;
  if (fromRecord.visibility !== 'real' || toRecord.visibility !== 'real') return null;
  if (fromRecord.dataset?.personalRatingPolicy !== toRecord.dataset?.personalRatingPolicy) return null;
  if (!hasComparableEvidence(fromRecord) || !hasComparableEvidence(toRecord)) return null;

  const fromIds = new Set(Object.keys(fromRecord.members));
  const toIds = new Set(Object.keys(toRecord.members));
  const newIds = [...toIds].filter((id) => !fromIds.has(id));
  const removedIds = [...fromIds].filter((id) => !toIds.has(id));

  const byStatus: Record<string, number> = {};
  let rateSum = 0;
  let rateCount = 0;
  for (const id of newIds) {
    const member = toRecord.members[id] as SnapshotMember | undefined;
    if (!member) continue;
    const [type, rate] = member;
    const label = COLLECTION_TYPE_LABEL[type as 1] ?? String(type);
    byStatus[label] = (byStatus[label] ?? 0) + 1;
    if (rate > 0) {
      rateSum += rate;
      rateCount += 1;
    }
  }

  const changes: ProfileChange[] = [
    compareCoreTemplate(fromRecord.dataset, toRecord.dataset),
    ...(['tags', 'formats', 'studios', 'directors'] as DimensionKey[]).map((key) =>
      compareDimension(key, fromRecord.dataset, toRecord.dataset),
    ),
    compareBreadth(fromRecord.dataset, toRecord.dataset),
  ];

  const candidates = toRecord.candidateIds ?? null;
  let rankReview: ProfileComparison['rankReview'];
  if (!candidates || candidates.length === 0) {
    rankReview = {
      available: false,
      reason:
        '本阶段快照没有记录候选清单（例如某一 Rank 范围内新增的作品），因此无法计算「候选中有多少最终进入收藏」。',
      candidateCount: null,
      collectedCount: null,
      byStatus: null,
      hitRate: null,
    };
  } else {
    const collected = candidates.filter((id) => toIds.has(String(id)));
    const statusCounts: Record<string, number> = {};
    for (const id of collected) {
      const member = toRecord.members[String(id)] as SnapshotMember | undefined;
      if (!member) continue;
      const label = COLLECTION_TYPE_LABEL[member[0] as 1] ?? String(member[0]);
      statusCounts[label] = (statusCounts[label] ?? 0) + 1;
    }
    rankReview = {
      available: true,
      reason: '',
      candidateCount: candidates.length,
      collectedCount: collected.length,
      byStatus: statusCounts,
      hitRate: candidates.length > 0 ? Number((collected.length / candidates.length).toFixed(4)) : null,
    };
  }

  return {
    from: summarize(fromRecord),
    to: summarize(toRecord),
    stageWorks: {
      newWorks: newIds.length,
      newWorksByStatus: byStatus,
      newWorksAverageRate: rateCount > 0 ? round(rateSum / rateCount) : null,
      removedWorks: removedIds.length,
    },
    changes,
    rankReview,
    generatedAt: nowIso(),
  };
}
