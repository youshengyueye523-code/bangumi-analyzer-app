/**
 * Series / Franchise 引擎真实数据审计。
 *
 * 先构建 server（tsc），再指向数据库副本运行：
 *   BANGUMI_DATA_DIR=<副本目录> node packages/server/scripts/series-audit.mjs
 *
 * 脚本会重建实体（写入传入的数据目录），因此只应对副本使用。
 */

import { openDatabase } from '../dist/db/index.js';
import { recomputeSeries } from '../dist/db/series.js';
import {
  getFranchiseDetail,
  getRelationAudit,
  getSeriesDetail,
  listFranchises,
  listSeries,
} from '../dist/db/query.js';

openDatabase({});
const result = recomputeSeries();
const series = listSeries({ sort: 'size', includeSingletons: true, limit: 500 });
const multi = series.filter((entry) => entry.memberCount >= 2);
const singletons = series.filter((entry) => entry.memberCount < 2);
const franchises = listFranchises({ limit: 200 });
const audit = getRelationAudit();

console.log(
  JSON.stringify(
    {
      rebuild: result,
      counts: {
        seriesTotal: series.length,
        multi: multi.length,
        singletons: singletons.length,
        franchises: franchises.length,
      },
      unknownRelations: audit.entries.filter((entry) => entry.klass === 'unknown'),
      migration: audit.migration,
      coverage: {
        full: series.filter((entry) => entry.evidenceCoverage === 'full').length,
        partial: series.filter((entry) => entry.evidenceCoverage === 'partial').length,
        relationsOnly: series.filter((entry) => entry.evidenceCoverage === 'relations-only').length,
      },
      topSeries: multi.slice(0, 15).map((entry) => ({
        key: entry.key,
        title: entry.title,
        titleState: entry.titleState,
        titleSource: entry.titleSource,
        state: entry.state,
        members: entry.memberCount,
        collected: entry.collectedCount,
        coverage: entry.evidenceCoverage,
      })),
      franchises: franchises.map((entry) => ({
        key: entry.key,
        title: entry.title,
        state: entry.state,
        titleState: entry.titleState,
        series: entry.seriesCount,
        candidates: entry.candidateSeriesCount,
        collected: entry.collectedCount,
      })),
    },
    null,
    1,
  ),
);

function showSeriesByTitle(needle) {
  const entries = series.filter((entry) => entry.title.includes(needle));
  for (const entry of entries) {
    const detail = getSeriesDetail(entry.key);
    if (!detail) continue;
    console.log(
      JSON.stringify(
        {
          needle,
          key: detail.key,
          title: detail.title,
          titleState: detail.titleState,
          members: detail.members.map((member) => ({
            id: member.subjectId,
            title: member.title,
            reason: member.reason,
            state: member.state,
            collected: member.collected,
          })),
          mergeCandidates: detail.mergeCandidates,
          related: detail.related.slice(0, 6),
        },
        null,
        1,
      ),
    );
  }
}

for (const needle of ['辉夜', '我推的孩子', '空之境界', '物语', '永生之酒', '无头骑士']) {
  showSeriesByTitle(needle);
}

for (const franchise of franchises) {
  const detail = getFranchiseDetail(franchise.key);
  if (!detail) continue;
  console.log(
    JSON.stringify(
      {
        franchise: detail.title,
        state: detail.state,
        series: detail.series.map((entry) => ({
          title: entry.title,
          linkState: entry.linkState,
          evidence: entry.evidence,
          works: entry.entries.map((item) => item.nameCn || item.name),
        })),
      },
      null,
      1,
    ),
  );
}
