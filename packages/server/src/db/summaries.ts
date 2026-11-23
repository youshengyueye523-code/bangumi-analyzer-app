/**
 * 简介双语数据层。
 *
 * 字段职责（互相独立，谁都不会覆盖谁）：
 *   - `subjects.summary`             ：Bangumi 返回的原始 summary（一手数据，永远原样保留）
 *   - `subjects.summary_original`    ：解析出的原文段（可识别的非中文语言）
 *   - `subjects.summary_zh_official` ：Bangumi 官方中文（纯中文 summary 或双语结构中的中文段）
 *   - `subjects.summary_zh_ai`       ：AI 生成的中文翻译（只会写这一列）
 *
 * 中文显示优先级（在 `chinese` 字段里统一算好，前端不再判断）：
 *   1. 官方中文 → 标注「Bangumi 官方中文简介」，**不调用 AI**；
 *   2. 否则 AI 翻译 → 标注「AI 翻译」；
 *   3. 否则为空，由界面显示状态（待翻译 / 翻译中 / 翻译失败 / 待配置 AI / 语言无法识别）。
 *
 * 这一层不发起任何网络请求，因此同步流程调用它是安全的。
 */

import {
  detectSummaryLanguage,
  normalizeSummaryForHash,
  parseSummarySegments,
  TRANSLATION_STATUS,
  translationStrategy,
  type SummaryLanguage,
  type TranslationStatus,
} from '@bangumi-analyzer/shared';
import { all, one, run, transaction } from './index.js';
import { currentJobForSubject, enqueueTranslationJob, markJobObsolete, obsoleteStaleJobs, requeueJob } from './translationJobs.js';

/** 中文简介的来源 */
export type SummaryChineseSource = 'bangumi' | 'ai' | 'none';

export interface SummaryRecord {
  subjectId: number;
  /** 原文段（可识别的非中文语言；纯中文简介时为空） */
  original: string;
  /** 原文语言：zh / ja / en / ko / other / unknown / empty */
  language: SummaryLanguage;
  /** 原文是否可自动翻译成中文 */
  translatable: boolean;
  /** 不可翻译时的原因（用于界面提示） */
  unsupportedReason: string;
  sourceHash: string;
  /** 官方中文简介（可能为空） */
  officialChinese: string;
  /** 是否为双语结构（含分隔标记） */
  bilingual: boolean;
  /** 命中的分隔标记（仅用于调试与测试，界面不显示） */
  marker: string;
  /** AI 中文翻译（可能为空） */
  translation: string;
  status: TranslationStatus;
  translationHash: string;
  translationModel: string;
  translationProvider: string;
  translationUpdatedAt: string | null;
  translationError: string | null;
  /** 最终要显示的中文内容（官方中文或 AI 翻译） */
  chinese: string;
  chineseSource: SummaryChineseSource;
  /** 有 AI 翻译、但翻译依据的原文已过期（旧翻译仍然保留可读） */
  stale: boolean;
}

interface SummaryRow {
  id: number;
  summary: string;
  summary_original: string;
  summary_original_hash: string;
  summary_original_lang: string;
  summary_zh_official: string;
  summary_zh_ai: string;
  summary_zh_ai_status: string;
  summary_zh_ai_hash: string;
  summary_zh_ai_model: string;
  summary_zh_ai_provider: string;
  summary_zh_ai_updated_at: string | null;
  summary_zh_ai_error: string | null;
  summary_zh_source: string;
}

const SUMMARY_COLUMNS = `
  id, summary, summary_original, summary_original_hash, summary_original_lang,
  summary_zh_official, summary_zh_ai, summary_zh_ai_status, summary_zh_ai_hash,
  summary_zh_ai_model, summary_zh_ai_provider, summary_zh_ai_updated_at,
  summary_zh_ai_error, summary_zh_source
`;

function mapRow(row: SummaryRow): SummaryRecord {
  const parsed = parseSummarySegments(row.summary || row.summary_original || '');
  const original = row.summary_original || parsed?.original || '';
  const stats = detectSummaryLanguage(original || parsed?.chinese || '');
  const language = (row.summary_original_lang || stats.language) as SummaryLanguage;
  const strategy = translationStrategy(original ? language : 'zh');
  const sourceHash = row.summary_original_hash || '';
  const status = (row.summary_zh_ai_status || TRANSLATION_STATUS.Idle) as TranslationStatus;
  const translationHash = row.summary_zh_ai_hash || '';
  const translation = row.summary_zh_ai || '';
  const officialChinese = row.summary_zh_official || parsed?.chinese || '';

  const chinese = officialChinese || translation;
  const chineseSource: SummaryChineseSource = officialChinese
    ? 'bangumi'
    : translation
      ? 'ai'
      : 'none';
  // 「是否需要 AI 翻译」：语言可翻译且没有官方中文
  const needsTranslation = strategy.translate && !officialChinese;

  return {
    subjectId: Number(row.id),
    original: parsed?.original || original,
    language,
    translatable: needsTranslation,
    unsupportedReason: strategy.translate
      ? officialChinese
        ? '已有 Bangumi 官方中文，无需 AI 翻译'
        : ''
      : strategy.reason,
    sourceHash,
    officialChinese,
    bilingual: Boolean(parsed?.marker),
    marker: parsed?.marker ?? '',
    translation,
    status,
    translationHash,
    translationModel: row.summary_zh_ai_model || '',
    translationProvider: row.summary_zh_ai_provider || '',
    translationUpdatedAt: row.summary_zh_ai_updated_at,
    translationError: row.summary_zh_ai_error,
    chinese,
    chineseSource,
    // 翻译依据的原文已变化 → 标记过期（旧翻译继续显示，不会被清空）
    stale: Boolean(translation) && Boolean(sourceHash) && translationHash !== sourceHash,
  };
}

export function getSummaryRecord(subjectId: number): SummaryRecord | null {
  const row = one<SummaryRow>(`SELECT ${SUMMARY_COLUMNS} FROM subjects WHERE id = :id`, {
    id: subjectId,
  });
  return row ? mapRow(row) : null;
}

export interface UpsertSummaryInput {
  subjectId: number;
  /** 当前条目名，仅用于提示模型统一专有名词 */
  subjectName: string;
  timestamp: string;
  /** 可选：显式指定 summary 文本（历史回填时使用）；不传则读取数据库中的一手 summary */
  text?: string;
  /** 是否允许入队（默认允许） */
  enqueue?: boolean;
}

export interface UpsertSummaryResult {
  language: SummaryLanguage;
  hash: string;
  changed: boolean;
  enqueued: boolean;
  /** 原文变化但旧翻译被保留下来 */
  previousTranslationKept: boolean;
  /** 识别为双语结构（含分隔标记） */
  bilingual: boolean;
  /** 本次识别出的官方中文长度（0 表示没有） */
  officialChineseLength: number;
  marker: string;
}

const EMPTY_RESULT: UpsertSummaryResult = {
  language: 'empty',
  hash: '',
  changed: false,
  enqueued: false,
  previousTranslationKept: false,
  bilingual: false,
  officialChineseLength: 0,
  marker: '',
};

/**
 * 保存原文结构并按需入队翻译。
 *
 * 状态推导完全由「解析结果 + 翻译策略」决定：
 *   - 有官方中文           → idle（不调用 AI）
 *   - 原文可翻译且没有有效翻译 → pending（入队）
 *   - 原文可翻译且已有有效翻译 → completed
 *   - 原文语言无法识别       → idle（保留原文，不调用 AI）
 *   - 没有简介             → idle
 */
export function upsertSubjectSummary(input: UpsertSummaryInput): UpsertSummaryResult {
  const row = one<{
    summary: string;
    summary_original_hash: string;
    summary_zh_ai: string;
    summary_zh_ai_hash: string;
  }>(
    `SELECT summary, summary_original_hash, summary_zh_ai, summary_zh_ai_hash
       FROM subjects WHERE id = :id`,
    { id: input.subjectId },
  );
  if (!row) return EMPTY_RESULT;

  const rawSummary = (input.text ?? row.summary ?? '').trim();
  const parsed = parseSummarySegments(rawSummary);
  if (!parsed) {
    run(
      `UPDATE subjects SET
         summary_original = '', summary_original_hash = '', summary_original_lang = 'empty',
         summary_zh_official = '',
         summary_zh_ai_status = CASE WHEN summary_zh_ai = '' THEN 'idle' ELSE summary_zh_ai_status END
       WHERE id = :id`,
      { id: input.subjectId },
    );
    return EMPTY_RESULT;
  }

  const original = parsed.original.trim();
  const stats = detectSummaryLanguage(original || parsed.chinese);
  const hash = original ? normalizeSummaryForHash(original) : '';
  const strategy = translationStrategy(original ? stats.language : 'zh');
  const allowEnqueue = input.enqueue !== false;
  const hasOfficial = parsed.chinese.length > 0;

  const previousHash = row.summary_original_hash ?? '';
  const hasTranslation = Boolean(row.summary_zh_ai);
  const changed = previousHash !== hash;
  const previousTranslationKept = changed && hasTranslation;
  const translationUpToDate = Boolean(hash) && row.summary_zh_ai_hash === hash && hasTranslation;

  // 状态：官方中文优先；其次按策略决定是否需要翻译
  let nextStatus: TranslationStatus = TRANSLATION_STATUS.Idle;
  if (!hasOfficial && strategy.translate) {
    nextStatus = translationUpToDate ? TRANSLATION_STATUS.Completed : TRANSLATION_STATUS.Pending;
  }

  transaction(() => {
    run(
      `UPDATE subjects SET
         summary_original = :original,
         summary_original_hash = :hash,
         summary_original_lang = :lang,
         summary_zh_official = :official,
         summary_zh_source = CASE
           WHEN :official <> '' THEN 'bangumi'
           WHEN summary_zh_ai <> '' THEN 'ai'
           ELSE 'none'
         END,
         summary_zh_ai_status = :status
       WHERE id = :id`,
      {
        id: input.subjectId,
        original: parsed.original,
        hash,
        lang: original ? stats.language : 'zh',
        official: parsed.chinese,
        status: nextStatus,
      },
    );
  });

  let enqueued = false;
  if (allowEnqueue && strategy.translate && !hasOfficial) {
    const collected = one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM subjects WHERE id = :id AND EXISTS (SELECT 1 FROM collections c WHERE c.subject_id = :id)',
      { id: input.subjectId },
    );
    if (Number(collected?.count ?? 0) > 0) {
      const result = enqueueTranslationJob({
        subjectId: input.subjectId,
        sourceHash: hash,
        timestamp: input.timestamp,
      });
      enqueued = result.created;
    }
  } else if (allowEnqueue) {
    /*
     * 不需要翻译（官方中文 / 无法识别语言 / 无简介）：
     * 把该作品未完成的任务标记为 obsolete，避免它们继续占用队列与「失败」统计。
     * 已经生成的 AI 翻译不会删除，只是不再作为当前中文来源。
     */
    const job = currentJobForSubject(input.subjectId);
    if (job && (job.status === 'pending' || job.status === 'processing' || job.status === 'waiting_ai')) {
      markJobObsolete(
        Number(job.id),
        hasOfficial ? '已有 Bangumi 官方中文，无需 AI 翻译' : '原文语言无法识别，未调用 AI',
        input.timestamp,
      );
      run(`UPDATE subjects SET summary_zh_ai_status = 'idle' WHERE id = :id`, {
        id: input.subjectId,
      });
    }
  }

  return {
    language: original ? stats.language : 'zh',
    hash,
    changed,
    enqueued,
    previousTranslationKept,
    bilingual: Boolean(parsed.marker),
    officialChineseLength: parsed.chinese.length,
    marker: parsed.marker,
  };
}

export interface SummaryScanResult {
  scanned: number;
  /** 纯中文（无原文段） */
  chinese: number;
  /** 双语结构（官方中文 + 原文） */
  bilingual: number;
  /** 可翻译的外文原文（日文 / 英文 / 韩文 / 其他） */
  translatable: number;
  /** 语言无法识别，保留原文且不翻译 */
  unknown: number;
  empty: number;
  /** 本次新入队的任务数 */
  enqueued: number;
  /** 本次被标记为历史失效的任务数 */
  obsoleted: number;
}

/**
 * 历史数据回填 / 配置补齐后的补队：
 * 全量扫描「我的收藏」中的简介，重新解析结构、识别语言、按策略入队。
 * 幂等：同一「作品 + 原文 hash」不会重复入队（唯一索引兜底）。
 */
export function refreshSummaryQueue(timestamp: string): SummaryScanResult {
  const rows = all<{ id: number; name: string; summary: string }>(
    `SELECT s.id, s.name, s.summary
       FROM subjects s JOIN collections c ON c.subject_id = s.id
      WHERE s.summary <> ''`,
  );
  const result: SummaryScanResult = {
    scanned: rows.length,
    chinese: 0,
    bilingual: 0,
    translatable: 0,
    unknown: 0,
    empty: 0,
    enqueued: 0,
    obsoleted: 0,
  };

  for (const row of rows) {
    const parsed = parseSummarySegments(row.summary);
    const stats = detectSummaryLanguage(parsed?.original ?? parsed?.chinese ?? '');
    /*
     * 分类互斥（便于人工核对）：
     *   双语结构（官方中文 + 原文）> 纯外文可翻译 > 语言无法识别 > 纯官方中文 > 无简介
     */
    if (!parsed) result.empty += 1;
    else if (parsed.marker) result.bilingual += 1;
    else if (parsed.original && translationStrategy(stats.language).translate) result.translatable += 1;
    else if (stats.language === 'unknown') result.unknown += 1;
    else result.chinese += 1;

    const upsert = upsertSubjectSummary({
      subjectId: Number(row.id),
      subjectName: row.name,
      timestamp,
      text: row.summary,
    });
    if (upsert.enqueued) result.enqueued += 1;
  }

  result.obsoleted = obsoleteStaleJobs(timestamp);
  return result;
}

/** 手动「立即翻译 / 重新翻译」：原文与官方中文都不动，只重新生成 AI 中文。 */
export function requeueSubjectTranslation(subjectId: number, timestamp: string): boolean {
  const record = getSummaryRecord(subjectId);
  if (!record || !record.translatable || !record.sourceHash) return false;
  // 已经有官方中文时不需要 AI 翻译
  if (record.officialChinese) return false;

  const existing = one<{ id: number }>(
    'SELECT id FROM translation_jobs WHERE subject_id = :id AND source_hash = :hash',
    { id: subjectId, hash: record.sourceHash },
  );

  if (existing) {
    run(
      `UPDATE translation_jobs
         SET status = 'pending', next_attempt_at = NULL, last_error = NULL, attempts = 0,
             updated_at = :ts
       WHERE id = :id`,
      { id: Number(existing.id), ts: timestamp },
    );
  } else {
    enqueueTranslationJob({ subjectId, sourceHash: record.sourceHash, timestamp });
  }
  run(
    `UPDATE subjects SET summary_zh_ai_status = 'pending', summary_zh_ai_error = NULL WHERE id = :id`,
    { id: subjectId },
  );
  return true;
}

/** AI 配置补齐后，把 waiting_ai 的任务放回队列（仅限当前有效任务）。 */
export function requeueWhenAiConfigured(timestamp: string): number {
  const rows = all<{ id: number }>(
    `SELECT j.id FROM translation_jobs j JOIN subjects s ON s.id = j.subject_id
      WHERE j.status = 'waiting_ai'
        AND j.source_hash = s.summary_original_hash
        AND s.summary_zh_official = ''`,
  );
  let count = 0;
  for (const row of rows) if (requeueJob(Number(row.id), timestamp)) count += 1;
  return count;
}

/** 总览统计（用于设置页与作品详情页）。 */
export interface SummaryTotals {
  collected: number;
  withSummary: number;
  noSummary: number;
  /** 官方中文（含双语结构中的中文段） */
  officialChinese: number;
  /** 双语结构（官方中文 + 原文） */
  bilingual: number;
  /** 有可翻译原文、但还没有有效 AI 翻译 */
  untranslated: number;
  /** 当前 hash 对应的有效 AI 翻译 */
  translated: number;
  /** 有 AI 翻译但基于旧版原文（仅作历史 fallback） */
  stale: number;
  /** 已被 Bangumi 官方中文取代的历史 AI 翻译（不再展示） */
  supersededAi: number;
  /** 原文语言无法识别，保留原文且不翻译 */
  unknownLanguage: number;
  /** 按原文语言分类（互斥） */
  bySourceLanguage: Record<string, number>;
}

export function summaryTotals(): SummaryTotals {
  const rows = all<{
    summary: string;
    summary_original: string;
    summary_original_lang: string;
    summary_original_hash: string;
    summary_zh_official: string;
    summary_zh_ai: string;
    summary_zh_ai_hash: string;
  }>(
    `SELECT s.summary, s.summary_original, s.summary_original_lang, s.summary_original_hash,
            s.summary_zh_official, s.summary_zh_ai, s.summary_zh_ai_hash
       FROM subjects s JOIN collections c ON c.subject_id = s.id`,
  );

  const totals: SummaryTotals = {
    collected: rows.length,
    withSummary: 0,
    noSummary: 0,
    officialChinese: 0,
    bilingual: 0,
    untranslated: 0,
    translated: 0,
    stale: 0,
    supersededAi: 0,
    unknownLanguage: 0,
    bySourceLanguage: {},
  };

  for (const row of rows) {
    const parsed = parseSummarySegments(row.summary);
    if (!row.summary.trim()) totals.noSummary += 1;
    else totals.withSummary += 1;
    if (parsed?.marker) totals.bilingual += 1;
    if (parsed?.chinese) totals.officialChinese += 1;

    const original = row.summary_original || parsed?.original || '';
    const lang = row.summary_original_lang || detectSummaryLanguage(original).language;
    const strategy = translationStrategy(original ? (lang as SummaryLanguage) : 'zh');
    const key = original ? lang : row.summary.trim() ? 'zh' : 'empty';
    totals.bySourceLanguage[key] = (totals.bySourceLanguage[key] ?? 0) + 1;

    const hasValidAi =
      Boolean(row.summary_zh_ai) &&
      Boolean(row.summary_original_hash) &&
      row.summary_original_hash === row.summary_zh_ai_hash;
    const hasStaleAi =
      Boolean(row.summary_zh_ai) &&
      Boolean(row.summary_original_hash) &&
      row.summary_original_hash !== row.summary_zh_ai_hash;

    if (hasValidAi && !parsed?.chinese) totals.translated += 1;
    if (parsed?.chinese && (hasValidAi || hasStaleAi)) totals.supersededAi += 1;
    if (hasStaleAi && !parsed?.chinese) totals.stale += 1;
    if (!parsed?.chinese && strategy.translate && !hasValidAi) totals.untranslated += 1;
    if (!parsed?.chinese && original && lang === 'unknown') totals.unknownLanguage += 1;
  }

  return totals;
}
