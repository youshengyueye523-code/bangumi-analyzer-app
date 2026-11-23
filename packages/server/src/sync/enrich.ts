import { BangumiApiError, type BangumiDataSource } from '../bangumi/client.js';
import {
  relationsToRows,
  staffFromInfobox,
  staffFromPersons,
  subjectFromDetail,
} from '../bangumi/normalize.js';
import {
  getSubjectRow,
  markDetailFailure,
  markPersonsFailure,
  markPersonsSynced,
  markRelationsFailure,
  markRelationsSynced,
  recomputeSubjectFacets,
  replaceRelations,
  replaceStaff,
  upsertSubjectDetail,
} from '../db/subjects.js';
import type { InfoboxItem } from '@bangumi-analyzer/shared';
import { upsertSubjectSummary } from '../db/summaries.js';
import { setMeta, transaction } from '../db/index.js';
import { nowIso, parseJsonColumn } from '../util.js';
import type { ProgressTracker } from './progress.js';

export interface EnrichContext {
  client: BangumiDataSource;
  signal: AbortSignal;
  progress: ProgressTracker;
}

export interface EnrichOutcome {
  synced: number;
  failed: number;
  /** 认证失败等不可继续的错误 */
  fatal: BangumiApiError | null;
  cancelled: boolean;
}

function isFatal(error: unknown): BangumiApiError | null {
  if (error instanceof BangumiApiError) {
    if (error.kind === 'auth' || error.kind === 'forbidden' || error.kind === 'aborted') return error;
  }
  return null;
}

function describe(error: unknown): string {
  if (error instanceof BangumiApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 连续网络失败达到该次数时中止同步：网络大概率已经断开，继续请求没有意义。 */
const NETWORK_FAILURE_LIMIT = 5;

/** 逐条抓取条目详情（放送形态、制作公司、评分分布、infobox…）。 */
export async function enrichDetails(ids: number[], context: EnrichContext): Promise<EnrichOutcome> {
  const { client, signal, progress } = context;
  let synced = 0;
  let failed = 0;
  let consecutiveNetworkFailures = 0;

  for (const id of ids) {
    if (signal.aborted) return { synced, failed, fatal: null, cancelled: true };
    try {
      const detail = await client.getSubject(id, { signal });
      if (signal.aborted) return { synced, failed, fatal: null, cancelled: true };
      if (detail.id !== id) throw new BangumiApiError('parse', `条目 ${id} 的响应身份不一致，已保留原详情`);
      const existing = getSubjectRow(id) ?? null;
      const row = subjectFromDetail(detail, existing);
      const timestamp = nowIso();
      transaction(() => {
        upsertSubjectDetail(row, timestamp);
        // 详情里的简介是权威版本：原文 + 语言识别 + （必要时）翻译入队
        upsertSubjectSummary({
          subjectId: id,
          subjectName: row.name || row.name_cn,
          timestamp,
        });

        const infobox = parseJsonColumn<InfoboxItem[]>(row.infobox, []);
        replaceStaff(id, staffFromInfobox(id, infobox));
        recomputeSubjectFacets(id);
        setMeta('sync_projection_pending', '1');
      });

      synced += 1;
      consecutiveNetworkFailures = 0;
      progress.counters.detailsFetched += 1;
      progress.advance(1, `正在补充条目详情（${synced}/${ids.length}）`);
    } catch (error) {
      if (signal.aborted) return { synced, failed, fatal: null, cancelled: true };
      const fatal = isFatal(error);
      if (fatal) {
        return { synced, failed, fatal, cancelled: fatal.kind === 'aborted' };
      }
      failed += 1;
      markDetailFailure(id, describe(error), nowIso());
      progress.addIssue(`条目 ${id} 详情同步失败：${describe(error)}`);
      progress.advance(1, `正在补充条目详情（${synced}/${ids.length}）`);
      if (error instanceof BangumiApiError && error.kind === 'network') {
        consecutiveNetworkFailures += 1;
        if (consecutiveNetworkFailures >= NETWORK_FAILURE_LIMIT) {
          return {
            synced,
            failed,
            fatal: new BangumiApiError(
              'network',
              `连续 ${NETWORK_FAILURE_LIMIT} 次网络请求失败，已中止本次同步`,
              { hint: '本地已有数据保持可用；网络恢复后再次同步即可从中断处继续。' },
            ),
            cancelled: false,
          };
        }
      } else {
        consecutiveNetworkFailures = 0;
      }
    }
  }

  return { synced, failed, fatal: null, cancelled: false };
}

/** 抓取官方「系列关系」，用于把多季作品归入同一系列。 */
export async function enrichRelations(
  ids: number[],
  context: EnrichContext,
): Promise<EnrichOutcome> {
  const { client, signal, progress } = context;
  let synced = 0;
  let failed = 0;

  for (const id of ids) {
    if (signal.aborted) return { synced, failed, fatal: null, cancelled: true };
    try {
      const relations = await client.getSubjectRelations(id, { signal });
      if (signal.aborted) return { synced, failed, fatal: null, cancelled: true };
      transaction(() => {
        replaceRelations(id, relationsToRows(id, relations), nowIso());
        markRelationsSynced(id, nowIso());
        setMeta('sync_projection_pending', '1');
      });
      synced += 1;
      progress.counters.relationsFetched += 1;
      progress.advance(1, `正在抓取系列关系（${synced}/${ids.length}）`);
    } catch (error) {
      if (signal.aborted) return { synced, failed, fatal: null, cancelled: true };
      const fatal = isFatal(error);
      if (fatal) return { synced, failed, fatal, cancelled: fatal.kind === 'aborted' };
      failed += 1;
      markRelationsFailure(id, nowIso());
      progress.addIssue(`条目 ${id} 系列关系同步失败：${describe(error)}`);
      progress.advance(1, `正在抓取系列关系（${synced}/${ids.length}）`);
    }
  }

  return { synced, failed, fatal: null, cancelled: false };
}

/** 抓取官方制作人员数据（比 infobox 更完整，可覆盖动画制作/导演等关系）。 */
export async function enrichPersons(
  ids: number[],
  context: EnrichContext,
): Promise<EnrichOutcome> {
  const { client, signal, progress } = context;
  let synced = 0;
  let failed = 0;

  for (const id of ids) {
    if (signal.aborted) return { synced, failed, fatal: null, cancelled: true };
    try {
      const persons = await client.getSubjectPersons(id, { signal });
      if (signal.aborted) return { synced, failed, fatal: null, cancelled: true };
      const rows = staffFromPersons(id, persons);
      transaction(() => {
        // 接口返回空列表通常意味着「该条目暂无人员数据」，
        // 此时保留 infobox 解析结果，避免把已有的制作公司/导演数据清空。
        if (rows.length > 0) {
          const relations = [...new Set(rows.map((row) => row.relation))];
          replaceStaff(id, rows, { replaceRelations: relations });
        }
        recomputeSubjectFacets(id);
        markPersonsSynced(id, nowIso());
        setMeta('sync_projection_pending', '1');
      });
      synced += 1;
      progress.counters.personsFetched += 1;
      progress.advance(1, `正在抓取制作人员（${synced}/${ids.length}）`);
    } catch (error) {
      if (signal.aborted) return { synced, failed, fatal: null, cancelled: true };
      const fatal = isFatal(error);
      if (fatal) return { synced, failed, fatal, cancelled: fatal.kind === 'aborted' };
      failed += 1;
      markPersonsFailure(id, nowIso());
      progress.addIssue(`条目 ${id} 制作人员同步失败：${describe(error)}`);
      progress.advance(1, `正在抓取制作人员（${synced}/${ids.length}）`);
    }
  }

  return { synced, failed, fatal: null, cancelled: false };
}
