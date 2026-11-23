/**
 * v1.8 Entity Analysis：B–E 层指标的 canonical 计算（只读）。
 *
 * 语义来源：docs/v1.8-entity-metric-registry.md（冻结契约）。
 * - 成员范围：role = 'primary'；candidate 永不参与；
 * - relation-only：进入 Coverage 分母，不进入其它指标；
 * - 比率型指标分子分母同口径；无样本 → null（不是 0）；
 * - 整体隐藏由 detail 层返回 HiddenState，本模块不处理「整体隐藏」；
 * - 不用 mean-of-means：Franchise 先展开到成员再平均。
 *
 * 每个 Entity 详情固定两条聚合 SQL：成员行 + 隐藏上下文（无 N+1）。
 */
import type {
  AnimeFormat,
  EntityAnalysis,
  EntityAnalysisHiddenContext,
} from '@bangumi-analyzer/shared';
import { all, one } from './index.js';
import { watchedEpisodes as computeWatchedEpisodes } from '@bangumi-analyzer/shared';
import { memberVisibilityClause, seriesVisibilityClause, personallyVisibleId, type Visibility } from './visibility.js';
import { EPISODE_EXPRESSION, EP_STATUS_EXPRESSION, MINUTES_PER_EPISODE } from '../stats/expressions.js';

interface AnalysisMemberRow {
  subject_id: number;
  local: number;
  collected: number;
  collection_type: number | null;
  rate: number | null;
  bgm_score: number | null;
  year: number | null;
  format: string | null;
  episodes: number;
  ep_status: number | null;
}

interface AnalysisMember {
  subjectId: number;
  local: boolean;
  collected: boolean;
  collectionType: number;
  rate: number;
  bgmScore: number | null;
  year: number | null;
  format: string | null;
  episodes: number;
  epStatus: number;
}

const MEMBER_COLUMNS = /* sql */ `
  m.subject_id AS subject_id,
  CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS local,
  CASE WHEN c.subject_id IS NULL THEN 0 ELSE 1 END AS collected,
  c.type AS collection_type,
  COALESCE(effective_personal_rate(c.type,c.rate), 0) AS rate,
  canonical_score(s.score) AS bgm_score,
  canonical_positive_integer(s.year) AS year,
  s.format AS format,
  ${EPISODE_EXPRESSION} AS episodes,
  ${EP_STATUS_EXPRESSION} AS ep_status
`;

function toMembers(rows: AnalysisMemberRow[]): AnalysisMember[] {
  // 同一 subject 在多个成员 Series 下只计一次（当前真实数据 0 重复，规则先冻结）
  const byId = new Map<number, AnalysisMember>();
  for (const row of rows) {
    const subjectId = Number(row.subject_id);
    if (byId.has(subjectId)) continue;
    byId.set(subjectId, {
      subjectId,
      local: Number(row.local) === 1,
      collected: Number(row.collected) === 1,
      collectionType: Number(row.collection_type ?? 0),
      rate: Number(row.rate ?? 0),
      bgmScore: row.bgm_score === null ? null : Number(row.bgm_score),
      year: row.year === null ? null : Number(row.year),
      format: row.format,
      episodes: Number(row.episodes ?? 0),
      epStatus: Number(row.ep_status ?? 0),
    });
  }
  return [...byId.values()];
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function mean(sum: number, count: number, digits: number): number | null {
  if (count <= 0) return null;
  return Number((sum / count).toFixed(digits));
}

function buildAnalysis(
  rows: AnalysisMemberRow[],
  hidden: EntityAnalysisHiddenContext,
  visibility: Visibility,
): EntityAnalysis {
  const members = toMembers(rows);

  let collectedCount = 0;
  let relationOnly = 0;
  let watchedMembers = 0;
  let ratedCount = 0;
  let rateSum = 0;
  let pairedCount = 0;
  let deltaSum = 0;
  let watchedEpisodes = 0;
  let contributingMembers = 0;
  let excludedNoEpisodeData = 0;
  let minutes = 0;
  let firstYear: number | null = null;
  let lastYear: number | null = null;
  let datedMembers = 0;
  const statusCounts: Record<'1' | '2' | '3' | '4' | '5', number> = {
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    '5': 0,
  };
  const yearCounts = new Map<number, number>();

  for (const member of members) {
    // relation-only：只有关系数据 → 只进入 Coverage 分母
    if (!member.local) {
      relationOnly += 1;
      continue;
    }
    // Air facts 与收藏状态无关：本地已知年份即可参与（作品事实）
    if (member.year !== null) {
      datedMembers += 1;
      firstYear = firstYear === null ? member.year : Math.min(firstYear, member.year);
      lastYear = lastYear === null ? member.year : Math.max(lastYear, member.year);
      yearCounts.set(member.year, (yearCounts.get(member.year) ?? 0) + 1);
    }
    if (!member.collected) continue;

    collectedCount += 1;
    if (member.collectionType >= 1 && member.collectionType <= 5) {
      const key = String(member.collectionType) as keyof typeof statusCounts;
      statusCounts[key] += 1;
    }
    if (member.rate > 0) {
      ratedCount += 1;
      rateSum += member.rate;
    }
    if (member.rate > 0 && member.bgmScore !== null && member.bgmScore > 0) {
      pairedCount += 1;
      deltaSum += member.rate - member.bgmScore;
    }
    if (member.collectionType === 2) watchedMembers += 1;

    if ([2, 3, 4, 5].includes(member.collectionType)) {
      if (member.episodes > 0) {
        const watched = computeWatchedEpisodes({ collectionType: member.collectionType,
          epStatus: member.epStatus, totalEpisodes: member.episodes });
        watchedEpisodes += watched;
        contributingMembers += 1;
        minutes += watched * (MINUTES_PER_EPISODE[member.format as AnimeFormat] ?? 24);
      } else {
        excludedNoEpisodeData += 1;
      }
    }
  }

  const knownMembers = members.length;
  const distribution = [...yearCounts.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year);

  return {
    visibility,
    hidden,
    coverage: {
      value: ratio(collectedCount, knownMembers),
      knownMembers,
      localCollected: collectedCount,
      relationOnly,
    },
    completion: {
      value: ratio(watchedMembers, collectedCount),
      watched: watchedMembers,
      collectedCount,
    },
    statusStructure: {
      counts: statusCounts,
      collectedCount,
      available: collectedCount > 0,
    },
    rating: {
      average: { value: mean(rateSum, ratedCount, 2), ratedCount },
      coverage: {
        value: ratio(ratedCount, collectedCount),
        ratedCount,
        collectedCount,
      },
      delta: { value: mean(deltaSum, pairedCount, 2), pairedCount },
    },
    air: {
      span: { firstYear, lastYear, datedMembers, totalMembers: knownMembers },
      distribution: { years: distribution, datedMembers, totalMembers: knownMembers },
    },
    consumption: {
      watchedMembers,
      watchedEpisodes,
      estimatedWatchTime: {
        minutes: contributingMembers > 0 ? minutes : null,
        isEstimate: true,
        contributingMembers,
        excludedNoEpisodeData,
      },
    },
  };
}

export function seriesAnalysis(seriesId: number, visibility: Visibility): EntityAnalysis {
  const rows = all<AnalysisMemberRow>(
    `SELECT ${MEMBER_COLUMNS}
     FROM series_entity_members m
     LEFT JOIN subjects s ON s.id = m.subject_id
     LEFT JOIN collections c ON c.subject_id = m.subject_id
     WHERE m.series_id = :id AND m.role = 'primary'
       AND ${memberVisibilityClause('s', visibility)}
     ORDER BY m.position ASC, m.subject_id ASC`,
    { id: seriesId },
  );
  const hiddenMembers = Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM series_entity_members m
       JOIN subjects s ON s.id = m.subject_id
       WHERE m.series_id = :id AND m.role = 'primary' AND (s.nsfw=1 OR NOT (${personallyVisibleId('s.id')}))`,
      { id: seriesId },
    )?.n ?? 0,
  );
  return buildAnalysis(rows, { series: 0, members: hiddenMembers }, visibility);
}

export function franchiseAnalysis(franchiseId: number, visibility: Visibility): EntityAnalysis {
  const rows = all<AnalysisMemberRow>(
    `SELECT ${MEMBER_COLUMNS}
     FROM franchise_series fs
     JOIN series_entities e ON e.id = fs.series_id AND e.state <> 'stale'
     JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
     LEFT JOIN subjects s ON s.id = m.subject_id
     LEFT JOIN collections c ON c.subject_id = m.subject_id
     WHERE fs.franchise_id = :id
       AND ${seriesVisibilityClause('e', visibility)}
       AND ${memberVisibilityClause('s', visibility)}
     ORDER BY fs.series_id ASC, m.position ASC, m.subject_id ASC`,
    { id: franchiseId },
  );
  // 隐藏上下文始终描述 hideNsfw 的隐藏范围（与当前请求口径无关）
  const hiddenRow = one<{ series: number; members: number }>(
    `SELECT COUNT(DISTINCT e.id) AS series, COUNT(DISTINCT m.subject_id) AS members
     FROM franchise_series fs
     JOIN series_entities e ON e.id = fs.series_id AND e.state <> 'stale'
     LEFT JOIN series_entity_members m ON m.series_id = fs.series_id AND m.role = 'primary'
     WHERE fs.franchise_id = :id AND NOT (${seriesVisibilityClause('e', 'visible')})`,
    { id: franchiseId },
  );
  return buildAnalysis(
    rows,
    {
      series: Number(hiddenRow?.series ?? 0),
      members: Number(hiddenRow?.members ?? 0),
    },
    visibility,
  );
}
