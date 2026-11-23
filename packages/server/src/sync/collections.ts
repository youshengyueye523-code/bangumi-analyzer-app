import {
  parseCollectionItem,
  type BgmCollectionItem,
} from '@bangumi-analyzer/shared';
import type { BangumiDataSource } from '../bangumi/client.js';
import { BangumiApiError } from '../bangumi/client.js';
import { collectionFromItem, subjectFromSlim } from '../bangumi/normalize.js';
import { all, one, run, transaction } from '../db/index.js';
import { firstSeenAt, upsertCollection, upsertSubjectSlim } from '../db/subjects.js';
import { recordRatingBeforeWish } from '../db/ratingHistory.js';
import { upsertSubjectSummary } from '../db/summaries.js';
import { nowIso, toJson } from '../util.js';
import type { ProgressTracker } from './progress.js';

/** Bangumi 文档标注的最大分页大小，保守使用以避免触发校验错误。 */
export const PAGE_SIZE = 50;

export interface CollectOptions {
  username: string;
  subjectTypes: number[];
  signal: AbortSignal;
  progress: ProgressTracker;
}

export interface CollectResult {
  /** 是否完整抓取了所有分页（只有完整抓取时才允许执行删除） */
  complete: boolean;
  totalReported: number;
  staged: number;
  pages: number;
  /** 因结构异常被跳过的条目 */
  skipped: number;
}

function clearStaging(runId: number): void {
  run('DELETE FROM sync_stage WHERE run_id = :runId', { runId });
}

function stageItem(runId: number, subjectId: number, payload: unknown, pageIndex: number): void {
  run(
    `INSERT INTO sync_stage (run_id, subject_id, payload, page_index, created_at)
     VALUES (:runId, :subjectId, :payload, :pageIndex, :createdAt)
     ON CONFLICT(run_id, subject_id) DO UPDATE SET payload = excluded.payload`,
    {
      runId,
      subjectId,
      payload: toJson(payload),
      pageIndex,
      createdAt: nowIso(),
    },
  );
}

/**
 * 分页抓取收藏列表。
 *
 * 所有分页都写入 `sync_stage` 暂存区，**不会**在抓取过程中修改正式数据；
 * 任何一页失败都会让本次同步标记为「未完成」，从而跳过删除操作。
 */
export async function collectCollections(
  client: BangumiDataSource,
  runId: number,
  options: CollectOptions,
): Promise<CollectResult> {
  const { username, subjectTypes, signal, progress } = options;
  clearStaging(runId);

  let staged = 0;
  let pages = 0;
  let skipped = 0;
  let totalReported = 0;
  let complete = true;

  const subjectTypeList = effectiveSubjectTypes(subjectTypes);
  for (const subjectType of subjectTypeList) {
    let offset = 0;
    let expectedTotal: number | null = null;
    const validIds = new Set<number>();

    // 防御性上限：即使接口异常返回超大 total 也不会无限循环
    for (let pageIndex = 0; pageIndex < 2000; pageIndex += 1) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');

      const page = await client.getCollectionsPage(
        username,
        { subjectType, limit: PAGE_SIZE, offset },
        { signal },
      );
      // 上游可能忽略 abort，最后一页返回后也不能进入暂存或正式应用。
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      pages += 1;
      if (expectedTotal === null) {
        expectedTotal = page.total;
        totalReported += page.total;
        progress.setPhaseTotal(page.total * subjectTypeList.length);
      } else if (page.total !== expectedTotal) {
        // 抓取期间集合发生变化，不能把 offset 分页中的遗漏当作取消收藏。
        complete = false;
        expectedTotal = Math.max(expectedTotal, page.total);
      }

      const received = Array.isArray(page.data) ? page.data : [];
      if (received.length === 0) break;

      for (const raw of received) {
        const parsed = parseCollectionItem(raw);
        if (!parsed.value) {
          complete = false;
          skipped += 1;
          progress.addIssue(
            `条目 ${parsed.issues[0]?.subjectId ?? '未知'} 的数据结构异常，已跳过（${parsed.issues[0]?.message ?? ''}）`,
          );
          continue;
        }
        const item = parsed.value as BgmCollectionItem;
        if (item.subject_type !== subjectType) {
          complete = false;
          skipped += 1;
          progress.addIssue(`条目 ${item.subject_id} 的类型不属于本次分页范围，已跳过并保留原数据。`);
          continue;
        }
        validIds.add(item.subject_id);
        stageItem(runId, item.subject_id, raw, pageIndex);
        staged += 1;
      }

      progress.advance(received.length, `已获取收藏 ${staged} 条（第 ${pages} 页）`);

      offset += received.length;
      // total 可能略有偏差，因此以「返回空页」作为兜底终止条件
      if (expectedTotal !== null && offset >= expectedTotal) break;
    }
    if (validIds.size !== expectedTotal) complete = false;
  }

  const uniqueStaged = one<{ n: number }>('SELECT COUNT(*) AS n FROM sync_stage WHERE run_id = :runId', {
    runId,
  });
  const uniqueCount = Number(uniqueStaged?.n ?? 0);
  if (uniqueCount < staged) {
    complete = false;
    progress.addWarning(
      `接口返回了 ${staged - uniqueCount} 条重复条目，已按条目 ID 去重。`,
    );
  }
  if (skipped > 0) {
    progress.addWarning(`${skipped} 条收藏的数据结构不符合预期，已跳过并保留原数据。`);
  }
  if (!complete) {
    progress.addWarning('收藏分页或条目结构不完整，无法确认远端删除；本次跳过删除并保留未返回的本地收藏。');
  }

  return { complete, totalReported, staged: uniqueCount, pages, skipped };
}

interface ExistingCollection {
  subject_id: number;
  subject_type: number;
  type: number;
  rate: number;
  ep_status: number;
  vol_status: number;
  comment: string;
  tags: string;
  private: number;
  updated_at: string | null;
}

export interface ApplyResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  skippedDeletions: boolean;
  /** v1.8.3（B1）：因「本次未抓取该 subject type」而被保护、未参与删除的本地收藏数。 */
  protectedOutOfScope: number;
  /** 被保护的 subject type 列表（供审计与 UI 说明）。 */
  protectedTypes: number[];
}

/** 单次同步允许删除的最大条数：超过则视为可疑并跳过删除。 */
export function deletionThreshold(existingCount: number): number {
  return Math.max(50, Math.ceil(existingCount * 0.2));
}

/**
 * 本次同步实际抓取的 subject type。
 *
 * v1.8.3（B1）：抓取与删除必须共用同一条范围定义 —— 删除只能作用于
 * 本次真正抓取的类型；范围之外的类型无论差集结果如何都不构成删除依据。
 */
export function effectiveSubjectTypes(subjectTypes: number[]): number[] {
  return subjectTypes.length > 0 ? subjectTypes : [2];
}

/**
 * 把暂存区的数据应用到正式表。
 *
 * 整个过程在一个事务里完成：要么全部生效，要么完全回滚，
 * 不会出现「同步到一半、数据半新半旧」的状态。
 */
export function applyCollections(
  runId: number,
  options: { allowDeletions: boolean; authenticated: boolean; progress: ProgressTracker; subjectTypes: number[] },
): ApplyResult {
  const rows = all<{ payload: string }>(
    'SELECT payload FROM sync_stage WHERE run_id = :runId',
    { runId },
  );
  const items: BgmCollectionItem[] = [];
  const sourceItems = new Map<number, unknown>();
  for (const row of rows) {
    const source = JSON.parse(row.payload);
    const parsed = parseCollectionItem(source);
    if (parsed.value) {
      items.push(parsed.value);
      sourceItems.set(parsed.value.subject_id, source);
    }
  }

  const existingRows = all<ExistingCollection>(
    `SELECT subject_id, subject_type, type, rate, ep_status, vol_status, comment, tags, private, updated_at
     FROM collections`,
  );
  const existing = new Map(existingRows.map((row) => [Number(row.subject_id), row]));

  const seen = new Set<number>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const item of items) {
    const previous = existing.get(item.subject_id);
    if (!previous) {
      added += 1;
    } else {
      const changed =
        previous.type !== item.type ||
        previous.rate !== (item.rate ?? 0) ||
        previous.ep_status !== (item.ep_status ?? 0) ||
        previous.vol_status !== (item.vol_status ?? 0) ||
        previous.comment !== (item.comment ?? '') ||
        previous.private !== (item.private ? 1 : 0) ||
        previous.updated_at !== (item.updated_at || null) ||
        previous.tags !== toJson(Array.isArray(item.tags) ? item.tags : []);
      if (changed) updated += 1;
      else unchanged += 1;
    }
    seen.add(item.subject_id);
  }

  const removedRows = existingRows.filter((row) => !seen.has(Number(row.subject_id)));

  /*
   * v1.8.3（B1）：删除只能作用于本次实际抓取的 subject type。
   * 未抓取类型在本地仍然存在的收藏不构成「已被删除」的证据 —— 它们必须
   * 原样保留，并把保护数量写进 warning，作为数据中枢的 audit evidence。
   */
  const scopedTypes = new Set(effectiveSubjectTypes(options.subjectTypes));
  const outOfScope = removedRows.filter((row) => !scopedTypes.has(Number(row.subject_type)));
  const removedIds = removedRows
    .filter((row) => scopedTypes.has(Number(row.subject_type)))
    .filter((row) => options.authenticated || Number(row.private) !== 1)
    .map((row) => Number(row.subject_id));
  const protectedPrivate = options.authenticated
    ? 0
    : removedRows.filter((row) => scopedTypes.has(Number(row.subject_type)) && Number(row.private) === 1).length;
  if (protectedPrivate > 0) {
    options.progress.addWarning(`本次未认证，只能读取公开收藏；${protectedPrivate} 条未返回的本地私有收藏已原样保留，不能据此认定取消收藏。`);
  }
  const protectedTypes = [...new Set(outOfScope.map((row) => Number(row.subject_type)))].sort(
    (a, b) => a - b,
  );
  if (outOfScope.length > 0) {
    options.progress.addWarning(
      `本次未抓取的 subject type（${protectedTypes.join(' / ')}）有 ${outOfScope.length} 条本地收藏，` +
        '不在删除范围内，已原样保留（同步范围变化不会删除数据；如确需停止同步某类型，请单独确认）。',
    );
  }

  let skippedDeletions = false;
  let removable = removedIds;
  if (!options.allowDeletions) {
    removable = [];
    skippedDeletions = removedIds.length > 0;
  } else if (removedIds.length > deletionThreshold(existing.size)) {
    removable = [];
    skippedDeletions = true;
    options.progress.addWarning(
      `本次接口返回的数据显示有 ${removedIds.length} 条收藏消失，` +
        `超过安全阈值（${deletionThreshold(existing.size)} 条），已跳过删除以免误删本地数据。` +
        '如果确实在 Bangumi 上批量取消收藏，可再次手动同步确认。',
    );
  }

  const timestamp = nowIso();
  transaction(() => {
    for (const item of items) {
      const previous = existing.get(item.subject_id);
      if (item.type === 1 && previous && previous.type !== 1 && previous.rate > 0) {
        recordRatingBeforeWish(item.subject_id, runId);
      }
      const subjectRow = subjectFromSlim(item);
      upsertSubjectSlim(subjectRow, timestamp);
      const collectionRow = collectionFromItem(item, {
        firstSeenAt: timestamp,
        syncedAt: timestamp,
        raw: sourceItems.get(item.subject_id),
      });
      upsertCollection(collectionRow, firstSeenAt(item.subject_id) ?? timestamp, timestamp);
    }
    for (const id of removable) {
      run('DELETE FROM collections WHERE subject_id = :id', { id });
    }
  });

  clearStaging(runId);

  /*
   * 简介入队：放在事务之外，保证「Bangumi 同步」与「AI 翻译」彻底解耦——
   * 翻译任务只是写本地队列，任何异常都不会回滚刚刚写入的收藏数据。
   */
  for (const item of items) {
    try {
      upsertSubjectSummary({
        subjectId: item.subject_id,
        subjectName: subjectFromSlim(item).name,
        timestamp,
      });
    } catch (error) {
      // 简介入队失败绝不影响同步结果，只记录到同步告警里
      options.progress.addWarning(
        `条目 ${item.subject_id} 的简介未能进入翻译队列：${describeCollectError(error)}`,
      );
    }
  }

  return {
    added,
    updated,
    removed: removable.length,
    unchanged,
    skippedDeletions,
    protectedOutOfScope: outOfScope.length,
    protectedTypes,
  };
}

/** 把异常统一转换成可读的说明（不包含任何敏感信息）。 */
export function describeCollectError(error: unknown): string {
  if (error instanceof BangumiApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
