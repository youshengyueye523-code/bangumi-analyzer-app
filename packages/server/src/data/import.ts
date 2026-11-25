import {
  ApiError,
  parseCollectionItem,
  type ImportPreview,
  type ImportResult,
} from '@bangumi-analyzer/shared';
import { z } from 'zod';
import { collectionFromItem, subjectFromSlim, type SubjectRow } from '../bangumi/normalize.js';
import { one, run, transaction } from '../db/index.js';
import { recordMutation } from '../db/mutation.js';
import { recomputeSeries } from '../db/series.js';
import { collectionFromExportRow, subjectFromExportRow, staffFromExportRow, relationFromExportRow } from './mappers.js';
import { nowIso, pick, toJson } from '../util.js';

const exportSchema = z.object({
  format: z.literal('bangumi-analyzer-export'),
  version: z.number().int().min(1),
  exportedAt: z.string().optional(),
  counts: z.unknown().optional(),
  collections: z.array(z.record(z.string(), z.unknown())).default([]),
  subjects: z.array(z.record(z.string(), z.unknown())).default([]),
});

const MAX_IMPORT_ITEMS = 200_000;

function assertImportLimit(rows: unknown[]): void {
  if (rows.length > MAX_IMPORT_ITEMS) {
    throw new ApiError(`导入记录超过 ${MAX_IMPORT_ITEMS} 条上限`, {
      code: 'import_too_large', status: 400,
      hint: '请拆分文件后重试；本次输入未被截断或写入。',
    });
  }
}

interface NormalizedImport {
  detectedFormat: ImportPreview['detectedFormat'];
  subjects: SubjectRow[];
  collections: Array<{
    subjectId: number;
    subjectType: number;
    type: number;
    rate: number;
    epStatus: number;
    volStatus: number;
    comment: string;
    tags: string;
    private: number;
    updatedAt: string | null;
    raw: string;
  }>;
  staff: Array<{ subjectId: number; personId: number | null; name: string; relation: string; career: string; source: string }>;
  relations: Array<{ subjectId: number; relatedId: number; relation: string; type: number; name: string; nameCn: string }>;
  skipped: number;
  warnings: string[];
}

/** 预览与执行共用同一最终集合，重复 ID 最后一条生效，孤立引用不计为写入。 */
function finalizeImport(result: NormalizedImport): NormalizedImport {
  const subjects = new Map(result.subjects.map((row) => [row.id, row]));
  const collections = new Map(result.collections.map((row) => [row.subjectId, row]));
  const duplicates = result.subjects.length - subjects.size + result.collections.length - collections.size;
  result.subjects = [...subjects.values()];
  result.collections = [...collections.values()];
  result.skipped += duplicates;
  if (duplicates) result.warnings.push(`重复 ID 已合并：${duplicates} 条，以最后一条为准。`);
  const types = new Map<number, number | undefined>();
  const subjectType = (id: number): number | undefined => {
    // 既有 subject.type 不由导入 UPDATE 改写，不能用输入中的另一个类型冒充实际目标。
    if (!types.has(id)) types.set(id,
      one<{ type: number }>('SELECT type FROM subjects WHERE id = :id', { id })?.type ?? subjects.get(id)?.type);
    return types.get(id);
  };
  const hasSubject = (id: number): boolean => subjectType(id) !== undefined;
  const originalCount = result.collections.length + result.staff.length + result.relations.length;
  result.collections = result.collections.filter((row) => hasSubject(row.subjectId));
  result.staff = result.staff.filter((row) => hasSubject(row.subjectId));
  result.relations = result.relations.filter((row) => hasSubject(row.subjectId));
  const orphans = originalCount - result.collections.length - result.staff.length - result.relations.length;
  result.skipped += orphans;
  if (orphans) result.warnings.push(`缺少对应作品，已跳过 ${orphans} 条孤立收藏、人员或关系记录。`);
  const collectionCount = result.collections.length;
  result.collections = result.collections.filter((row) => row.subjectType === subjectType(row.subjectId));
  const mismatches = collectionCount - result.collections.length;
  result.skipped += mismatches;
  if (mismatches) result.warnings.push(`收藏与作品类型不一致，已跳过 ${mismatches} 条收藏记录。`);
  return result;
}

/**
 * 自动识别导入格式：
 * 1. 本工具导出的 JSON（含 format 字段）；
 * 2. Bangumi 官方「用户收藏」接口返回的原始 JSON 数组（或 `{ data: [...] }`）。
 */
export function normalizeImport(payload: unknown): NormalizedImport {
  const result: NormalizedImport = {
    detectedFormat: 'unknown',
    subjects: [],
    collections: [],
    staff: [],
    relations: [],
    skipped: 0,
    warnings: [],
  };

  const parsedExport = exportSchema.safeParse(payload);
  if (parsedExport.success) {
    assertImportLimit(parsedExport.data.subjects);
    assertImportLimit(parsedExport.data.collections);
    result.detectedFormat = 'bangumi-analyzer-export';
    for (const row of parsedExport.data.subjects.slice(0, MAX_IMPORT_ITEMS)) {
      const kind = String(row.kind ?? 'subject');
      if (kind === 'staff') {
        const normalized = staffFromExportRow(row);
        if (!normalized) result.skipped += 1;
        else result.staff.push(normalized);
        continue;
      }
      if (kind === 'relation') {
        const normalized = relationFromExportRow(row);
        if (!normalized) result.skipped += 1;
        else result.relations.push(normalized);
        continue;
      }
      const subject = subjectFromExportRow(row);
      if (!subject) {
        result.skipped += 1;
        continue;
      }
      result.subjects.push(subject);
    }

    for (const row of parsedExport.data.collections.slice(0, MAX_IMPORT_ITEMS)) {
      const collection = collectionFromExportRow(row);
      if (!collection) {
        result.skipped += 1;
        continue;
      }
      result.collections.push(collection);
    }
    return finalizeImport(result);
  }

  // 兼容 Bangumi 原始收藏数组
  const rawItems = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown[] }).data)
      ? ((payload as { data: unknown[] }).data)
      : null;

  if (rawItems) {
    assertImportLimit(rawItems);
    result.detectedFormat = 'bangumi-collection-array';
    for (const item of rawItems.slice(0, MAX_IMPORT_ITEMS)) {
      const parsed = parseCollectionItem(item);
      if (!parsed.value) {
        result.skipped += 1;
        continue;
      }
      result.subjects.push(subjectFromSlim(parsed.value));
      const collection = collectionFromItem(parsed.value, {
        firstSeenAt: nowIso(),
        syncedAt: nowIso(),
        raw: item,
      });
      result.collections.push({
        subjectId: collection.subject_id,
        subjectType: collection.subject_type,
        type: collection.type,
        rate: collection.rate,
        epStatus: collection.ep_status,
        volStatus: collection.vol_status,
        comment: collection.comment,
        tags: collection.tags,
        private: collection.private,
        updatedAt: collection.updated_at,
        raw: collection.raw,
      });
    }
    return finalizeImport(result);
  }

  throw new ApiError('无法识别导入文件格式', {
    code: 'unknown_import_format',
    status: 400,
    hint:
      '支持两种格式：① 本工具「导出 JSON」生成的文件；② Bangumi 官方收藏接口返回的 JSON 数组。',
  });
}

/** 生成导入预览（不写数据库）。 */
export function previewImport(payload: unknown): ImportPreview {
  const normalized = normalizeImport(payload);
  let newSubjects = 0;
  let updatedSubjects = 0;
  let newCollections = 0;
  let updatedCollections = 0;
  let protectedSubjects = 0;

  for (const subject of normalized.subjects) {
    const existing = one<{ id: number; detail_state: string }>('SELECT id, detail_state FROM subjects WHERE id = :id', {
      id: subject.id,
    });
    if (existing?.detail_state === 'ok') protectedSubjects += 1;
    else if (existing) updatedSubjects += 1;
    else newSubjects += 1;
  }
  for (const collection of normalized.collections) {
    const existing = one<{ subject_id: number }>(
      'SELECT subject_id FROM collections WHERE subject_id = :id',
      { id: collection.subjectId },
    );
    if (existing) updatedCollections += 1;
    else newCollections += 1;
  }

  return {
    detectedFormat: normalized.detectedFormat,
    total: normalized.subjects.length + normalized.collections.length,
    newSubjects,
    updatedSubjects,
    newCollections,
    updatedCollections,
    skipped: normalized.skipped + protectedSubjects,
    warnings: protectedSubjects
      ? [...normalized.warnings, `${protectedSubjects} 个作品已有完整详情，保留本地详情，不计为更新。`]
      : normalized.warnings,
    sampleTitles: normalized.subjects
      .slice(0, 5)
      .map((subject) => subject.name_cn || subject.name)
      .filter(Boolean),
  };
}

/**
 * 应用导入。
 *
 * 安全策略：
 * - 只增不删：导入不会删除本地已有条目；
 * - 已完整同步（detail_state = 'ok'）的条目详情不会被导入数据覆盖；
 * - 整个过程在单个事务内完成，出错自动回滚。
 */
export function applyImport(payload: unknown, options: { dryRun?: boolean } = {}): ImportResult {
  const startedAt = Date.now();
  const normalized = normalizeImport(payload);
  const preview = previewImport(payload);
  if (options.dryRun) {
    return { ...preview, applied: false, durationMs: Date.now() - startedAt };
  }

  const timestamp = nowIso();
  transaction(() => {
    for (const subject of normalized.subjects) {
      const existing = one<{ detail_state: string }>(
        'SELECT detail_state FROM subjects WHERE id = :id',
        { id: subject.id },
      );
      if (!existing) {
        const { eps_provided: _provided, ...persisted } = subject;
        run(
          `INSERT INTO subjects (id, type, name, name_cn, aliases, platform, format, date, year, month,
             season, year_month, year_quarter, eps, total_episodes, volumes, score, rank, rating_total,
             rating_dist, collection_stats, collection_total, collection_total_known, meta_tags, tags, tag_names, infobox,
             studios, directors, originals, summary, images, cover_url, nsfw, locked, is_series, raw,
             created_at, updated_at)
           VALUES (:id, :type, :name, :name_cn, :aliases, :platform, :format, :date, :year, :month,
             :season, :year_month, :year_quarter, :eps, :total_episodes, :volumes, :score, :rank,
             :rating_total, :rating_dist, :collection_stats, :collection_total, :collection_total_known, :meta_tags, :tags,
             :tag_names, :infobox, :studios, :directors, :originals, :summary, :images, :cover_url,
             :nsfw, :locked, :is_series, :raw, :created_at, :updated_at)`,
          { ...persisted, created_at: timestamp, updated_at: timestamp },
        );
      } else if (existing.detail_state !== 'ok') {
        const updatable = [
          'id',
          'platform',
          'format',
          'date',
          'year',
          'month',
          'season',
          'year_month',
          'year_quarter',
          'eps',
          'total_episodes',
          'raw',
          'rating_dist',
          'collection_stats',
          'collection_total',
          'collection_total_known',
          'meta_tags',
          'infobox',
          'studios',
          'directors',
          'originals',
        ] as const;
        run(
          `UPDATE subjects SET platform = :platform, format = :format, date = :date, year = :year,
             month = :month, season = :season, year_month = :year_month, year_quarter = :year_quarter,
             eps = CASE WHEN :eps_provided THEN :eps ELSE eps END,
             total_episodes = :total_episodes, rating_dist = :rating_dist,
             raw = COALESCE(:raw, raw),
             collection_stats = :collection_stats, meta_tags = :meta_tags, infobox = :infobox,
             collection_total = CASE WHEN :collection_total_known = 1 THEN :collection_total ELSE collection_total END,
             collection_total_known = CASE WHEN :collection_total_known = 1 THEN 1 ELSE collection_total_known END,
             studios = :studios, directors = :directors, originals = :originals,
             updated_at = :updated_at
           WHERE id = :id`,
          { ...pick(subject, updatable), eps_provided: subject.eps_provided ? 1 : 0, updated_at: timestamp },
        );
      }
    }

    for (const collection of normalized.collections) {
      const exists = one<{ subject_id: number }>('SELECT id FROM subjects WHERE id = :id', {
        id: collection.subjectId,
      });
      if (!exists) {
        normalized.skipped += 1;
        continue;
      }
      run(
        `INSERT INTO collections (subject_id, subject_type, type, rate, ep_status, vol_status,
           comment, tags, private, updated_at, first_seen_at, synced_at, raw)
         VALUES (:subjectId, :subjectType, :type, :rate, :epStatus, :volStatus, :comment, :tags,
           :private, :updatedAt, :firstSeenAt, :syncedAt, :raw)
         ON CONFLICT(subject_id) DO UPDATE SET
           subject_type = excluded.subject_type, type = excluded.type, rate = excluded.rate,
           ep_status = excluded.ep_status, vol_status = excluded.vol_status,
           comment = excluded.comment, tags = excluded.tags, private = excluded.private,
           updated_at = excluded.updated_at, synced_at = excluded.synced_at, raw = excluded.raw`,
        {
          ...collection,
          firstSeenAt: timestamp,
          syncedAt: timestamp,
        },
      );
    }

    for (const staff of normalized.staff) {
      run(
        `INSERT INTO subject_staff (subject_id, person_id, name, relation, career, source)
         VALUES (:subjectId, :personId, :name, :relation, :career, :source)
         ON CONFLICT(subject_id, name, relation, source) DO UPDATE SET
           person_id = excluded.person_id, career = excluded.career`,
        staff,
      );
    }

    for (const relation of normalized.relations) {
      run(
        `INSERT INTO subject_relations (subject_id, related_id, relation, type, name, name_cn, created_at)
         VALUES (:subjectId, :relatedId, :relation, :type, :name, :nameCn, :createdAt)
         ON CONFLICT(subject_id, related_id) DO UPDATE SET
           relation = excluded.relation, type = excluded.type,
           name = excluded.name, name_cn = excluded.name_cn`,
        { ...relation, createdAt: timestamp },
      );
    }
    recomputeSeries();
    recordMutation(
      'import',
      `import: +${preview.newSubjects} subjects / +${preview.newCollections} collections`,
    );
  });

  return { ...preview, applied: true, durationMs: Date.now() - startedAt };
}
