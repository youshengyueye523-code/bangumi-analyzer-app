/**
 * v1.6.1 一次性 Franchise 治理初始化。
 *
 * 做三件事（只改治理状态与派生投影，不删除任何数据）：
 *   1. 解除全部 confirmed 家族的确认锁定 → 回到 candidate，重新进入可评估状态；
 *   2. 重新运行 Series / Franchise 引擎，重建投影（成员、链接、计数、标题）；
 *   3. 重新扫描家族级证据，报告：
 *      - 解锁前后状态分布；
 *      - 新出现的家族候选；
 *      - 仍然存在「不同演绎 / 衍生」关系但没有共享家族的 Series 对（遗漏候选）；
 *      - 每个家族的组成，便于人工复核明显错误的历史家族。
 *
 * 用法：pnpm -C packages/server run franchise:rescan
 */
import { closeDatabase, all, dataVersion, integrityCheck, openDatabase } from '../src/db/index.js';
import { recordMutation } from '../src/db/mutation.js';
import { listFranchises } from '../src/db/query.js';
import { recomputeSeries, resetFranchiseGovernance } from '../src/db/series.js';
import { classifyRelation } from '../src/series/taxonomy.js';

interface FranchiseRow {
  id: number;
  key: string;
  title: string;
  state: string;
  series_count: number;
}

function stateCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of all<{ state: string; n: number }>(
    `SELECT state, COUNT(*) AS n FROM franchise_entities WHERE state <> 'stale' GROUP BY state`,
  )) {
    counts[row.state] = Number(row.n);
  }
  return counts;
}

function franchiseComposition(): Array<{
  key: string;
  title: string;
  state: string;
  series: string[];
}> {
  const rows = all<FranchiseRow>(
    `SELECT id, key, title, state, series_count FROM franchise_entities WHERE state <> 'stale' ORDER BY key`,
  );
  return rows.map((row) => ({
    key: row.key,
    title: row.title,
    state: row.state,
    series: all<{ title: string }>(
      `SELECT e.title FROM franchise_series fs JOIN series_entities e ON e.id = fs.series_id
        WHERE fs.franchise_id = :id ORDER BY e.title`,
      { id: row.id },
    ).map((entry) => entry.title),
  }));
}

/** 家族级证据存在、但没有共享家族的 Series 对（潜在遗漏候选）。 */
function missingFranchisePairs(): Array<{ relation: string; a: string; b: string }> {
  const seriesOf = (subjectId: number) =>
    all<{ id: number; title: string }>(
      `SELECT e.id, e.title FROM series_entity_members m JOIN series_entities e ON e.id = m.series_id
        WHERE m.subject_id = :id AND m.role = 'primary' AND e.state <> 'stale' LIMIT 1`,
      { id: subjectId },
    )[0];
  const franchisesOf = (seriesId: number) =>
    all<{ id: number }>(
      `SELECT fs.franchise_id AS id FROM franchise_series fs
        JOIN franchise_entities f ON f.id = fs.franchise_id
       WHERE fs.series_id = :id AND f.state <> 'stale'`,
      { id: seriesId },
    ).map((row) => Number(row.id));

  const seen = new Set<string>();
  const missing: Array<{ relation: string; a: string; b: string }> = [];
  const relations = all<{ subject_id: number; related_id: number; relation: string }>(
    `SELECT DISTINCT subject_id, related_id, relation FROM subject_relations`,
  );
  for (const relation of relations) {
    const kind = classifyRelation(relation.relation ?? '');
    if (kind.klass !== 'alternate' && kind.klass !== 'derivative') continue;
    const a = seriesOf(Number(relation.subject_id));
    const b = seriesOf(Number(relation.related_id));
    if (!a || !b || a.id === b.id) continue;
    const pairKey = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const franchisesA = franchisesOf(a.id);
    const franchisesB = franchisesOf(b.id);
    if (franchisesA.some((id) => franchisesB.includes(id))) continue;
    missing.push({ relation: relation.relation, a: a.title, b: b.title });
  }
  return missing;
}

openDatabase();
const beforeStates = stateCounts();
const beforeKeys = new Set(
  all<{ key: string }>(`SELECT key FROM franchise_entities WHERE state <> 'stale'`).map((row) => row.key),
);
const beforeComposition = franchiseComposition();

const reset = resetFranchiseGovernance();
const rebuild = recomputeSeries();
recordMutation('maintenance', 'v1.6.1 franchise governance reset + rescan');

const afterStates = stateCounts();
const afterComposition = franchiseComposition();
const newKeys = afterComposition
  .map((entry) => entry.key)
  .filter((key) => !beforeKeys.has(key));
const pending = afterComposition.filter((entry) =>
  ['candidate', 'provisional', 'contested'].includes(entry.state),
);
const missing = missingFranchisePairs();

console.log(
  JSON.stringify(
    {
      version: 'v1.6.1 franchise governance initialization',
      integrity: integrityCheck(),
      dataVersion: dataVersion(),
      before: {
        states: beforeStates,
        franchiseCount: beforeComposition.length,
      },
      reset: {
        unlocked: reset.unlocked,
        unlockedKeys: reset.unlockedKeys,
      },
      rebuild,
      after: {
        states: afterStates,
        franchiseCount: afterComposition.length,
        newCandidateKeys: newKeys,
        pendingReview: pending.length,
      },
      missingFranchisePairs: missing,
      composition: afterComposition,
      beforeComposition,
    },
    null,
    2,
  ),
);
closeDatabase();
