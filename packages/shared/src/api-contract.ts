/**
 * 本地服务端 API 的契约定义。
 * 前端只通过这里描述的结构访问本地服务端，不直接接触 Bangumi Token。
 */

import { z } from 'zod';
import type { SummaryChineseSource, SummaryLanguage, TranslationStatus } from './translation.js';
import {
  ANIME_FORMATS,
  SEASONS,
  isCollectionType,
  type AnimeFormat,
  type CollectionType,
  type Season,
} from './subject.js';
import type { AiConfigPublic, AiConfigUpdate } from './profile.js';

/* ------------------------------------------------------------------ 同步 */

export type SyncMode = 'full' | 'incremental' | 'enrich';
export type SyncDepth = 1 | 2;

/** 深度 1：条目详情（放送形态、制作公司、评分分布等）；深度 2：额外抓取系列关系与制作人员。 */
export interface SyncRequest {
  mode: SyncMode;
  depth?: SyncDepth;
  /** 忽略 detailRefreshDays，强制重新抓取所有条目详情 */
  forceDetail?: boolean;
  /** 是否在同步后缓存封面到本地（离线可用） */
  cacheCovers?: boolean;
}

export const syncRequestSchema = z.object({
  mode: z.enum(['full', 'incremental', 'enrich']),
  depth: z.union([z.literal(1), z.literal(2)]).optional(),
  forceDetail: z.boolean().optional(),
  cacheCovers: z.boolean().optional(),
});

export type SyncPhase =
  | 'idle'
  | 'preparing'
  | 'collections'
  | 'applying'
  | 'enriching'
  | 'relations'
  | 'persons'
  | 'series'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'interrupted';

export interface SyncCounters {
  requests: number;
  retries: number;
  fetched: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  detailsFetched: number;
  relationsFetched: number;
  personsFetched: number;
  coversCached: number;
  failures: number;
}

export interface SyncProgress {
  runId: number;
  mode: SyncMode;
  depth: SyncDepth;
  phase: SyncPhase;
  message: string;
  current: number;
  total: number;
  percent: number;
  /** 预计剩余秒数，数据不足时为 null */
  etaSeconds: number | null;
  startedAt: string;
  updatedAt: string;
  counters: SyncCounters;
  /** 最近的告警/失败信息（最多保留 20 条） */
  issues: string[];
  /** 尝试应用删除但被安全阀拦下时的说明 */
  warnings: string[];
}

export interface SyncRunSummary {
  id: number;
  mode: SyncMode;
  depth: number;
  status: 'running' | 'success' | 'error' | 'cancelled' | 'interrupted';
  phase: SyncPhase;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  counters: SyncCounters;
  error: string | null;
  warnings: string[];
}

export interface SyncStatus {
  running: boolean;
  progress: SyncProgress | null;
  lastRun: SyncRunSummary | null;
  lastSuccessfulSyncAt: string | null;
}

/* ------------------------------------------------------------- 配置/凭据 */

export interface AppConfigPublic {
  /** Runtime capability, not a writable user preference. Absent in ordinary Local. */
  canDisconnectBangumi?: boolean;
  username: string;
  hasToken: boolean;
  /** 仅用于确认保存的是哪一个 Token，例如 `bgm_…f3a2` */
  tokenHint: string | null;
  /** 本地昵称（这个工具自己的资料，与 Bangumi 账号无关） */
  nickname: string;
  /** 本地头像：data URL；为空表示未设置 */
  avatar: string;
  /** 首次使用引导是否已完成 / 已跳过 */
  onboardingSeen: boolean;
  /** 同步后自动把日文简介加入翻译队列 */
  summaryAutoTranslate: boolean;
  /** 简介翻译并发数 */
  summaryConcurrency: number;
  subjectTypes: number[];
  /** 两次 Bangumi 请求之间的最小间隔（毫秒） */
  requestIntervalMs: number;
  /** 条目详情缓存有效期（天），超过后重新抓取 */
  detailRefreshDays: number;
  userAgent: string;
  cacheCovers: boolean;
  /** 可选 HTTP 代理，留空则使用系统环境变量 */
  httpProxy: string;
  dataDir: string;
  dbPath: string;
  dbSizeBytes: number;
  version: string;
  ai: AiConfigPublic;
  /** 全局背景板设置（所有页面共用；image 为空表示无背景） */
  wallpaper: WallpaperSetting;
  /** 界面材质倾向（通透度 / 磨砂度） */
  material: MaterialSetting;
  /**
   * 隐藏 NSFW 内容（全局可见性策略）。
   *
   * 判定只依据 Bangumi `subject.nsfw`；打开后 NSFW 内容仅在当前 UI 中隐藏，
   * 不会删除或修改任何本地数据。
   */
  hideNsfw: boolean;
}

export interface AppConfigUpdate {
  username?: string;
  /** 传空字符串可清除；不传表示保持不变 */
  token?: string;
  nickname?: string;
  /** 传空字符串可清除本地头像 */
  avatar?: string;
  onboardingSeen?: boolean;
  summaryAutoTranslate?: boolean;
  summaryConcurrency?: number;
  subjectTypes?: number[];
  requestIntervalMs?: number;
  detailRefreshDays?: number;
  userAgent?: string;
  cacheCovers?: boolean;
  httpProxy?: string;
  ai?: AiConfigUpdate;
  wallpaper?: WallpaperSettingUpdate;
  material?: MaterialSettingUpdate;
  hideNsfw?: boolean;
}

/**
 * 背景板设置。
 *
 * 底部刻意分成两组语义（不影响 UI 只暴露「背景强度 / 模糊度」两个参数）：
 *   Wallpaper：image + 构图焦点
 *   Effect   ：blur（雾化）+ strength（背景存在感）
 */
export interface WallpaperSetting {
  /**
   * 背景图文件名（位于 data/wallpapers/），空字符串表示无背景。
   * 只保存文件名，不保存图片内容 —— 图片本体以文件形式落盘，
   * 避免把多 MB 的 base64 塞进每次都会请求的 /api/config。
   */
  image: string;
  /** 构图焦点：0–100，对应 background-position 的百分比 */
  focusX: number;
  focusY: number;
  /** 模糊半径（px） */
  blur: number;
  /** 背景强度：0–100，越大背景存在感越强（面板越透） */
  strength: number;
}

export type WallpaperSettingUpdate = Partial<WallpaperSetting>;

/** 背景图允许的类型与体积上限（头像限制之外的独立策略，只用于背景板）。 */
export const WALLPAPER_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const WALLPAPER_MAX_BYTES = 12 * 1024 * 1024;
export const WALLPAPER_BLUR_MAX = 40;

export const WALLPAPER_DEFAULT: WallpaperSetting = {
  image: '',
  focusX: 50,
  focusY: 50,
  blur: 10,
  strength: 60,
};

/** 背景图文件名格式：wp-<16 位十六进制>.<扩展名>（内容寻址，可长期缓存）。 */
export const WALLPAPER_FILE_PATTERN = /^wp-[0-9a-f]{16}\.(png|jpg|webp)$/;

export function isWallpaperFileName(value: string): boolean {
  return WALLPAPER_FILE_PATTERN.test(value);
}

/** 校验背景图 data URL：白名单类型 + 体积上限。返回错误说明，合法时返回 null。 */
export function validateWallpaperDataUrl(value: string): string | null {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value.trim());
  if (!match) return '背景图必须是 PNG / JPEG / WebP 图片（data URL 格式）';
  const mime = match[1]!.toLowerCase();
  if (!(WALLPAPER_MIME_TYPES as readonly string[]).includes(mime)) {
    return '仅支持 PNG / JPEG / WebP 格式的背景图';
  }
  const padding = match[2]!.endsWith('==') ? 2 : match[2]!.endsWith('=') ? 1 : 0;
  const bytes = (match[2]!.length * 3) / 4 - padding;
  if (bytes > WALLPAPER_MAX_BYTES) {
    return `背景图过大（约 ${(bytes / 1024 / 1024).toFixed(1)} MB），请压缩到 ${WALLPAPER_MAX_BYTES / 1024 / 1024} MB 以内`;
  }
  return null;
}

/** 把背景图 data URL 解码成字节；格式不合法时返回错误说明（含文件头校验）。 */
export function decodeWallpaperDataUrl(
  value: string,
): { ok: true; mime: string; bytes: Uint8Array } | { ok: false; reason: string } {
  const invalid = validateWallpaperDataUrl(value);
  if (invalid) return { ok: false, reason: invalid };
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value.trim())!;
  const mime = match[1]!.toLowerCase();
  const bytes = Uint8Array.from(atob(match[2]!), (char) => char.charCodeAt(0));
  if (!verifyImageMagicBytes(mime, bytes)) {
    return { ok: false, reason: '背景图内容与声明的图片格式不一致，已拒绝保存。' };
  }
  return { ok: true, mime, bytes };
}

/**
 * 界面材质（v1.5.0）。
 *
 * 面向用户只暴露「材质倾向 + 通透度 + 磨砂度」三个概念；
 * 底层的 blur / alpha / tint 由前端按层级自行映射，不在这里暴露。
 */
export type MaterialPreset = 'clear' | 'balanced' | 'frosted';

export interface MaterialSetting {
  /** 材质倾向：清透 / 平衡 / 磨砂 */
  preset: MaterialPreset;
  /** 通透度 0–100（越大越透） */
  clarity: number;
  /** 磨砂度 0–100（越大越模糊） */
  frosted: number;
}

export type MaterialSettingUpdate = Partial<MaterialSetting>;

export const MATERIAL_PRESET_LABEL: Record<MaterialPreset, string> = {
  clear: '清透',
  balanced: '平衡',
  frosted: '磨砂',
};

/** 预设只是「同时设置通透度与磨砂度」的快捷方式，用户仍可单独微调两个滑块。 */
export const MATERIAL_PRESETS: Record<MaterialPreset, { clarity: number; frosted: number }> = {
  clear: { clarity: 78, frosted: 22 },
  balanced: { clarity: 50, frosted: 50 },
  frosted: { clarity: 24, frosted: 82 },
};

export const MATERIAL_DEFAULT: MaterialSetting = {
  preset: 'balanced',
  ...MATERIAL_PRESETS.balanced,
};

/** 允许的本地头像类型（只做本地保存，不会上传到任何第三方服务）。 */
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
/** 头像体积上限：2MB 原始文件（base64 后约 2.7MB）。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 校验本地头像：必须是白名单图片类型的 data URL，且解码后的体积在限制内。
 * 返回错误说明，合法时返回 null。
 */
export function validateAvatarDataUrl(value: string): string | null {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value.trim());
  if (!match) return '头像必须是 PNG / JPEG / WebP / GIF 图片（data URL 格式）';
  const mime = match[1]!.toLowerCase();
  if (!(AVATAR_MIME_TYPES as readonly string[]).includes(mime)) {
    return `不支持的头像格式：${mime}（仅支持 PNG / JPEG / WebP / GIF）`;
  }
  const base64 = match[2]!;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  if (bytes > AVATAR_MAX_BYTES) {
    return `头像文件过大（${(bytes / 1024 / 1024).toFixed(2)} MB），请压缩到 2 MB 以内`;
  }
  return null;
}

/**
 * 校验图片字节与声明的 MIME 类型是否一致（文件头魔数检查）。
 * 只做本地保存前的安全校验，不依赖任何第三方库。
 */
export function verifyImageMagicBytes(mime: string, bytes: Uint8Array): boolean {
  const startsWith = (signature: number[]): boolean =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  switch (mime.toLowerCase()) {
    case 'image/png':
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith([0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith([0x47, 0x49, 0x46, 0x38]);
    case 'image/webp':
      // RIFF....WEBP
      return (
        bytes.length >= 12 &&
        startsWith([0x52, 0x49, 0x46, 0x46]) &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return false;
  }
}

/** 把头像 data URL 解码成字节；格式不合法时返回错误说明。 */
export function decodeAvatarDataUrl(
  value: string,
): { ok: true; mime: string; bytes: Uint8Array } | { ok: false; reason: string } {
  const invalid = validateAvatarDataUrl(value);
  if (invalid) return { ok: false, reason: invalid };
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value.trim())!;
  const mime = match[1]!.toLowerCase();
  const bytes = Uint8Array.from(atob(match[2]!), (char) => char.charCodeAt(0));
  if (!verifyImageMagicBytes(mime, bytes)) {
    return { ok: false, reason: '头像文件内容与声明的图片格式不一致，已拒绝保存。' };
  }
  return { ok: true, mime, bytes };
}

export const appConfigUpdateSchema = z.object({
  username: z.string().trim().max(64).optional(),
  token: z.string().max(512).optional(),
  nickname: z.string().trim().max(40).optional(),
  avatar: z
    .string()
    .max(4_000_000)
    .refine((value) => value === '' || validateAvatarDataUrl(value) === null, {
      message: '头像格式不合法（仅支持 2MB 以内的 PNG / JPEG / WebP / GIF）',
    })
    .optional(),
  onboardingSeen: z.boolean().optional(),
  summaryAutoTranslate: z.boolean().optional(),
  summaryConcurrency: z.number().int().min(1).max(8).optional(),
  subjectTypes: z.array(z.number().int()).max(5).optional(),
  requestIntervalMs: z.number().int().min(0).max(10_000).optional(),
  detailRefreshDays: z.number().int().min(1).max(3650).optional(),
  userAgent: z.string().trim().max(200).optional(),
  cacheCovers: z.boolean().optional(),
  httpProxy: z.string().trim().max(300).optional(),
  wallpaper: z
    .object({
      // 只接受服务端自己生成的文件名（或空字符串清除），绝不接受 data URL
      image: z
        .string()
        .max(120)
        .refine((value) => value === '' || isWallpaperFileName(value), {
          message: '背景图文件名不合法（需要先通过 /api/wallpaper 上传）',
        })
        .optional(),
      focusX: z.number().min(0).max(100).optional(),
      focusY: z.number().min(0).max(100).optional(),
      blur: z.number().min(0).max(WALLPAPER_BLUR_MAX).optional(),
      strength: z.number().min(0).max(100).optional(),
    })
    .optional(),
  material: z
    .object({
      preset: z.enum(['clear', 'balanced', 'frosted']).optional(),
      clarity: z.number().min(0).max(100).optional(),
      frosted: z.number().min(0).max(100).optional(),
    })
    .optional(),
  hideNsfw: z.boolean().optional(),
  ai: z
    .object({
      enabled: z.boolean().optional(),
      baseUrl: z.string().trim().max(300).optional(),
      model: z.string().trim().max(120).optional(),
      apiKey: z.string().max(512).optional(),
    })
    .optional(),
});

export interface CredentialCheckResult {
  ok: boolean;
  message: string;
  user?: { id: number; username: string; nickname: string; avatar: string | null };
}

/** 首次使用引导状态（纯本地判断）。 */
export interface OnboardingState {
  /** 已经完成或跳过引导 */
  completed: boolean;
  seen: boolean;
  steps: Array<{
    id: 'profile' | 'bangumi' | 'sync';
    title: string;
    description: string;
    done: boolean;
  }>;
  collections: number;
  profile: {
    nickname: string;
    avatar: string;
    username: string;
    hasToken: boolean;
  };
}

/* ------------------------------------------------------------- 简介翻译 */

export interface SummaryTranslationFields {
  /** 最终要显示的中文简介（官方中文或 AI 翻译，可能为空） */
  chinese: string;
  /** 中文来源：bangumi（官方中文）/ ai（本地翻译）/ none */
  chineseSource: SummaryChineseSource;
  /**
   * 是否属于「日文原文 + [中文简介] + 官方中文」的混合双语简介。
   * 界面据此说明「两部分都来自 Bangumi」，不必显示分隔标记本身。
   */
  bilingual: boolean;
  /** Bangumi 一手原文（可能为空） */
  original: string;
  /** 原文语言 */
  originalLanguage: SummaryLanguage;
  /** 原文是否支持自动翻译成中文（目前仅日文） */
  translatable: boolean;
  /** 不支持自动翻译时的原因 */
  unsupportedReason: string;
  /** 翻译状态 */
  status: TranslationStatus;
  /** 有翻译但基于旧版原文 */
  stale: boolean;
  translationModel: string;
  translationProvider: string;
  translationUpdatedAt: string | null;
  translationError: string | null;
}

/** 单条作品的简介翻译状态（作品详情页用）。 */
export interface SubjectSummaryState extends SummaryTranslationFields {
  subjectId: number;
  /** 是否已入队并且队列正在处理 */
  queued: boolean;
  jobId: number | null;
  attempts: number;
}

/** 队列总览（设置页 / 手动操作）。 */
export interface TranslationQueueStatus {
  /**
   * 队列计数：只统计「与作品当前原文 hash 一致」的任务，
   * `obsolete` 是原文已变化、仅作历史记录保留的失效任务（不参与其它计数）。
   */
  counts: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    waiting_ai: number;
    obsolete: number;
  };
  /** worker 是否正在运行 */
  running: boolean;
  /** 当前设置：自动翻译开关与并发数 */
  autoTranslate: boolean;
  concurrency: number;
  /** AI 是否可用（不可用时任务会停在「待配置 AI」） */
  aiConfigured: boolean;
  aiReason: string;
  /**
   * 简介结构统计。
   * 「按中文来源」与「按原文语言」是两个互不重叠的口径，不能相加：
   *   - 中文来源：officialChinese（官方中文，含双语结构）/ translated（AI）/ untranslated（待翻译）
   *     / noSummary（没有简介）
   *   - 原文语言：bySourceLanguage（ja / en / ko / other / unknown / zh / empty，互斥求和 = collected）
   */
  totals: {
    collected: number;
    withSummary: number;
    noSummary: number;
    /** 官方中文（含双语结构的中文段） */
    officialChinese: number;
    /** 双语结构（官方中文 + 原文，含分隔标记） */
    bilingual: number;
    /** 当前原文 hash 对应的有效 AI 翻译 */
    translated: number;
    /** 需要翻译但还没有有效翻译 */
    untranslated: number;
    /** 有 AI 翻译但基于旧版原文（历史 fallback） */
    stale: number;
    /** 已被 Bangumi 官方中文取代的历史 AI 翻译（不再展示） */
    supersededAi: number;
    /** 原文语言无法识别，保留原文且不调用 AI */
    unknownLanguage: number;
    /** 按原文语言分类，互斥且求和等于 collected */
    bySourceLanguage: Record<string, number>;
  };
  lastError: string | null;
}

export const summaryQueueActionSchema = z.object({
  action: z.enum(['retry-all', 'cancel-all', 'backfill', 'wake']),
});

/* --------------------------------------------------------------- 条目模型 */

export interface SubjectListItem {
  id: number;
  name: string;
  nameCn: string;
  cover: string | null;
  coverCached: boolean;
  platform: string;
  format: AnimeFormat;
  date: string | null;
  year: number | null;
  month: number | null;
  season: Season | null;
  yearQuarter: string | null;
  totalEpisodes: number;
  collectionType: CollectionType;
  rate: number;
  epStatus: number;
  watchedEpisodes: number;
  progress: number;
  comment: string;
  userTags: string[];
  bgmScore: number | null;
  bgmRank: number | null;
  ratingTotal: number | null;
  collectionTotal: number | null;
  delta: number | null;
  tags: string[];
  studios: string[];
  directors: string[];
  collectionUpdatedAt: string | null;
  firstSeenAt: string | null;
  detailSyncedAt: string | null;
  seriesKey: string | null;
  /**
   * 命中原因（仅在主搜索栏使用了关键词时返回）：
   * title / alias / id / tag / userTag / staff / studio / director
   */
  matchReasons?: string[];
}

/** 主搜索栏的命中类型标签（前端用于展示「为什么命中」） */
export const MATCH_REASON_LABEL: Record<string, string> = {
  title: '标题命中',
  alias: '别名命中',
  id: 'ID 命中',
  tag: '标签命中',
  userTag: '个人标签命中',
  staff: '制作人员命中',
  studio: '制作公司命中',
  director: '导演命中',
};

export interface SubjectStaff {
  id: number | null;
  name: string;
  relation: string;
  career: string[];
  source: 'person-api' | 'infobox';
}

export interface SubjectRelation {
  id: number;
  name: string;
  nameCn: string;
  relation: string;
  type: number;
  /** 该关联条目是否也在本地收藏中 */
  inCollection: boolean;
  collectionType: CollectionType | null;
}

export interface PersonalRatingHistory {
  rate: number;
  previousCollectionType: Exclude<CollectionType, 1>;
  /** Local observation time, not a claim about when the user rated on Bangumi. */
  observedAt: string;
}

export interface SubjectDetail extends SubjectListItem {
  /** For wish only: a retained prior observation, never the current effective score. */
  personalRatingHistory?: PersonalRatingHistory | null;
  /** For wish only: the score carried by the latest collection source, not necessarily historical. */
  sourcePersonalRate?: number | null;
  /** Bangumi 一手原文（中文 / 日文 / 其他语言，原样保存） */
  summary: string;
  /** 简介双语状态：中文内容、来源、原文语言、翻译状态（见 SubjectSummaryState） */
  summaryState: SubjectSummaryState;
  metaTags: string[];
  nsfw: boolean;
  locked: boolean;
  isSeries: boolean;
  ratingDistribution: Record<string, number>;
  collectionBreakdown: Record<string, number>;
  infobox: Array<{ key: string; values: Array<{ key: string | null; value: string }> }>;
  staff: SubjectStaff[];
  relations: SubjectRelation[];
  relationsSyncedAt: string | null;
  personsSyncedAt: string | null;
  rawSubject: unknown;
  rawCollection: unknown;
  /** Subject → Series 归属（数据层始终存在，单成员系列也有） */
  series: EntityLink | null;
  /** Subject → Series → Franchise 推导归属 */
  franchise: EntityLink | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /**
   * 来源上下文：从作品详情跳转过来时（`fromSubject=<id>`），
   * 告诉前端「触发这次检索的那部作品是否包含在当前结果里」。
   * 它只用于界面提示，不参与筛选，也不会扩大查询范围。
   */
  context?: {
    subjectId: number;
    title: string;
    relation: string;
    present: boolean;
  } | null;
}

/* ------------------------------------------------------------- 查询与筛选 */

export const SORT_FIELDS = [
  'updated',
  'added',
  'rate',
  'bgmScore',
  'delta',
  'year',
  'progress',
  'title',
  'ratingTotal',
  'collectionTotal',
] as const;

export type SortField = (typeof SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';

export const SORT_FIELD_LABEL: Record<SortField, string> = {
  updated: '最近更新',
  added: '首次同步',
  rate: '我的评分',
  bgmScore: 'Bangumi 评分',
  delta: '评分差',
  year: '放送年份',
  progress: '观看进度',
  title: '名称',
  ratingTotal: '评分人数',
  collectionTotal: '收藏人数',
};

export const PROGRESS_FILTERS = [
  'all',
  'not-started',
  'in-progress',
  'completed',
  'unfinished',
] as const;
export type ProgressFilter = (typeof PROGRESS_FILTERS)[number];

export const PROGRESS_FILTER_LABEL: Record<ProgressFilter, string> = {
  all: '全部进度',
  'not-started': '未开始',
  'in-progress': '进行中',
  completed: '已完成',
  unfinished: '未完成（在看/搁置/抛弃）',
};

export interface SubjectQuery {
  q?: string;
  status?: CollectionType[];
  format?: AnimeFormat[];
  season?: Season[];
  yearFrom?: number;
  yearTo?: number;
  rateMin?: number;
  rateMax?: number;
  bgmScoreMin?: number;
  bgmScoreMax?: number;
  ratingMin?: number;
  ratingMax?: number;
  deltaMin?: number;
  deltaMax?: number;
  progress?: ProgressFilter;
  /** 标签匹配方式：any = 命中其一，all = 同时具备 */
  tagMode?: 'any' | 'all';
  tags?: string[];
  studios?: string[];
  directors?: string[];
  /** 按制作人员姓名筛选（任意关系：导演 / 脚本 / 动画制作 / 音乐…） */
  staff?: string[];
  rated?: 'all' | 'rated' | 'unrated';
  /** 只看评分高于/低于 Bangumi 平均分的作品 */
  bias?: 'all' | 'over' | 'under';
  /** 触发本次检索的来源作品（仅作为界面上下文，不参与筛选） */
  fromSubject?: number;
  /** 来源作品里的关系名，例如「音响监督」，仅用于提示 */
  sourceRelation?: string;
  seriesKey?: string;
  sort?: SortField;
  order?: SortOrder;
  page?: number;
  pageSize?: number;
}

function csvToArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => csvToArray(entry));
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const optionalNumber = z
  .union([z.string(), z.number()])
  .optional()
  .transform((value) => {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  });

const stringArray = z.unknown().optional().transform((value) => csvToArray(value));

const statusArray = z.unknown().optional().transform((value) =>
  csvToArray(value)
    .map((part) => Number(part))
    .filter((part): part is CollectionType => isCollectionType(part)),
);

const formatArray = z.unknown().optional().transform((value) =>
  csvToArray(value).filter((part): part is AnimeFormat =>
    (ANIME_FORMATS as readonly string[]).includes(part),
  ),
);

const seasonArray = z.unknown().optional().transform((value) =>
  csvToArray(value).filter((part): part is Season =>
    (SEASONS as readonly string[]).includes(part),
  ),
);

export const subjectQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: statusArray,
  format: formatArray,
  season: seasonArray,
  yearFrom: optionalNumber,
  yearTo: optionalNumber,
  rateMin: optionalNumber,
  rateMax: optionalNumber,
  bgmScoreMin: optionalNumber,
  bgmScoreMax: optionalNumber,
  ratingMin: optionalNumber,
  ratingMax: optionalNumber,
  deltaMin: optionalNumber,
  deltaMax: optionalNumber,
  progress: z.enum(PROGRESS_FILTERS).optional(),
  tagMode: z.enum(['any', 'all']).optional(),
  tags: stringArray,
  studios: stringArray,
  directors: stringArray,
  staff: stringArray,
  rated: z.enum(['all', 'rated', 'unrated']).optional(),
  bias: z.enum(['all', 'over', 'under']).optional(),
  seriesKey: z.string().trim().max(120).optional(),
  fromSubject: optionalNumber,
  sourceRelation: z.string().trim().max(60).optional(),
  sort: z.enum(SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: optionalNumber,
  pageSize: optionalNumber,
});

export interface FilterFacets {
  years: Array<{ value: number; count: number }>;
  formats: Array<{ value: AnimeFormat; label: string; count: number }>;
  seasons: Array<{ value: Season; count: number }>;
  tags: Array<{ value: string; count: number }>;
  /** 去重后的标签总数（不截断，用于界面上显示“共 N 个标签”） */
  tagTotal: number;
  /** 只出现一次的标签数量，用于说明长尾规模 */
  tagSingletonCount: number;
  studios: Array<{ value: string; count: number }>;
  directors: Array<{ value: string; count: number }>;
  /** 收藏库中出现过的制作人员 / 公司总数（去重，不截断） */
  staffTotal: number;
  statuses: Array<{ value: CollectionType; count: number }>;
  /** 当前可见收藏数（隐藏 NSFW 时小于 realTotal） */
  total: number;
  /** 真实收藏总数（不受可见性设置影响，用于「真实统计 / 当前可见」对照） */
  realTotal: number;
  /** 当前被可见性设置隐藏的收藏条目数（关闭隐藏时为 0） */
  hiddenCount: number;
  ratedCount: number;
  yearMin: number | null;
  yearMax: number | null;
}

/* ------------------------------------------------------ 标签反向追溯 */

/** 在某一组筛选结果内聚合出的标签分布（例如：制作人员 → 作品 → 标签）。 */
export interface TagCountList {
  /** 去重后的标签数量 */
  total: number;
  /** 参与聚合的作品数量（即当前筛选结果数） */
  matchedSubjects: number;
  tags: Array<{ value: string; count: number }>;
}

/* ------------------------------------------------ 制作人员检索（全量可搜索） */

export interface StaffSearchItem {
  name: string;
  /** 该人员在收藏库中参与的作品数 */
  works: number;
  /** 出现过的关系名（最多若干个，用于区分导演 / 音响监督 / 制作公司） */
  relations: string[];
}

export interface StaffSearchResult {
  /** 收藏库中出现过的制作人员 / 公司总数（去重，不截断） */
  total: number;
  /** 命中关键词的数量 */
  matched: number;
  items: StaffSearchItem[];
  query: string;
}

/* ---------------------------------------------------------- 全局实体检索 */

export interface EntityWorkHit {
  id: number;
  title: string;
  originalTitle: string;
  year: number | null;
  cover: string | null;
  reasons: string[];
}

export interface EntitySearchResult {
  query: string;
  /** 关键词在整个收藏库中命中的作品总数（与主搜索栏回车后的结果一致） */
  workTotal: number;
  works: EntityWorkHit[];
  tags: Array<{ value: string; count: number }>;
  staff: StaffSearchItem[];
  studios: Array<{ value: string; count: number }>;
  directors: Array<{ value: string; count: number }>;
}

/* ----------------------------------------------------------------- 统计 */

export interface OverviewStats {
  total: number;
  statusCounts: Record<string, number>;
  ratedCount: number;
  unratedCount: number;
  averageRate: number | null;
  medianRate: number | null;
  averageBgmScore: number | null;
  completionRate: number;
  highRatedCount: number;
  lowRatedCount: number;
  /**
   * 非「看过」的收藏数量（想看 + 在看 + 搁置 + 抛弃）= 收藏总量 − 看过。
   * 与 `completionRate` 同源，不能再用「搁置」等单一状态代指。
   */
  unfinishedCount: number;
  /** 已记录观看集数（口径见下面的集数进度字段） */
  watchedEpisodes: number;
  /** 可计算的总集数（只统计集数信息已知的条目，不含「想看」） */
  totalEpisodes: number;
  /** 集数层面的进度 = watchedEpisodes / totalEpisodes，**不代表收藏完成度** */
  progressRatio: number;
  /** 参与集数统计的条目数（看过 / 在看 / 搁置 / 抛弃中集数已知的条目） */
  progressCountedSubjects: number;
  estimatedMinutes: number;
  meanDelta: number | null;
  yearRange: { min: number | null; max: number | null };
  detailCoverage: { synced: number; total: number; ratio: number };
  relationsCoverage: { synced: number; total: number; ratio: number };
  lastSyncAt: string | null;
  lastSyncSummary: { added: number; updated: number; removed: number } | null;
  dataVersion: number;
}

export interface CountItem {
  key: string;
  label: string;
  count: number;
  share: number;
  averageRate: number | null;
  averageBgmScore: number | null;
  /** 在「我给出 ≥8 分」的作品中，该项所占比例（用于偏好分析） */
  highRatedShare: number | null;
}

export interface DistributionStats {
  status: CountItem[];
  rate: CountItem[];
  bgmScore: CountItem[];
  year: CountItem[];
  format: CountItem[];
  season: CountItem[];
  tag: CountItem[];
  original: CountItem[];
}

export interface TimelinePoint {
  period: string;
  label: string;
  added: number;
  updated: number;
  total: number;
  episodes: number;
  averageRate: number | null;
  /** Canonical 有效评分的原始总和与样本数；缺失表示旧服务未提供。 */
  ratingSample?: { ratedCount: number; ratingSum: number };
}

export interface TimelineStats {
  granularity: 'year' | 'quarter' | 'month';
  basis: 'collection-updated-at';
  note: string;
  points: TimelinePoint[];
  /** 可选扩展，缺失时不能据 points 猜测全历史完整性或覆盖率。 */
  context?: {
    contextVersion: 1;
    visibility: 'real' | 'visible';
    dataVersion: number;
    /** 每次读取更新；不随 dataVersion 聚合缓存冻结。 */
    viewReferenceAt: string;
    referenceMonth: string;
    calendarZone: 'Asia/Shanghai';
    sourceRefreshedAt: string | null;
    sequence: { kind: 'full'; complete: boolean; from: string | null; to: string | null };
    /** 日期非空且成功归桶的当前收藏数；不是历史事件覆盖率。 */
    timeCoverage: { datedCollections: number; undatedCollections: number };
  };
}

export interface BiasItem {
  id: number;
  name: string;
  nameCn: string;
  cover: string | null;
  myRate: number;
  bgmScore: number;
  delta: number;
  ratingTotal: number | null;
  year: number | null;
  format: AnimeFormat;
}

export interface RatingBiasStats {
  count: number;
  meanDelta: number | null;
  stdDev: number | null;
  overratedCount: number;
  underratedCount: number;
  matchedCount: number;
  over: BiasItem[];
  under: BiasItem[];
  scatter: Array<{ id: number; name: string; myRate: number; bgmScore: number; delta: number }>;
}

export interface StudioStats {
  items: Array<{
    name: string;
    total: number;
    rated: number;
    averageRate: number | null;
    averageBgmScore: number | null;
    highRatedCount: number;
    highRatedShare: number | null;
    averageDelta: number | null;
  }>;
}

export interface HabitsStats {
  averagePerYear: number | null;
  busiestYear: { year: number; count: number } | null;
  busiestQuarter: { year: number; quarter: number; count: number } | null;
  activeYears: number;
  spanYears: number;
  averageProgress: number | null;
  heatmap: Array<{ year: number; quarter: number; count: number }>;
  weekdayDistribution: Array<{ key: string; label: string; count: number; share: number }>;
  averageEpisodesPerYear: number | null;
}

/** 首页一次性获取的数据，避免多个请求互相等待。 */
export interface DashboardPayload {
  generatedAt: string;
  /** NSFW setting applied to this response. Absent in older/demo payloads. */
  hideNsfw?: boolean;
  overview: OverviewStats;
  distributions: DistributionStats;
  timeline: TimelineStats;
  bias: RatingBiasStats;
  recentlyUpdated: SubjectListItem[];
  recentlyAdded: SubjectListItem[];
  inProgress: SubjectListItem[];
}

/* ------------------------------------------------------------- 系列 / 家族 */

/**
 * Series / Franchise 的语义分层：
 *   Subject →（membership）→ Series →（membership）→ Franchise
 *
 * - 每个层级都有独立的稳定 identity（不透明 key）与名称状态；
 * - 不确定状态是一等公民：候选 ≠ 事实，未确认 ≠ 已确认；
 * - 用户收藏只影响统计口径，不影响实体身份。
 */

export type EntityTitleState =
  | 'resolved'
  | 'provisional'
  | 'unresolved'
  | 'contested'
  | 'manual';

export type MembershipState = 'confirmed' | 'probable' | 'candidate';
export type EvidenceCoverage = 'full' | 'partial' | 'relations-only';
export type SeriesEntityState = 'stable' | 'provisional';
export type FranchiseState = 'candidate' | 'provisional' | 'confirmed' | 'contested' | 'rejected';
export type FranchiseLinkState = 'candidate' | 'provisional' | 'confirmed' | 'conflict';

export interface EntityTitleCandidate {
  title: string;
  source: string;
  state: EntityTitleState;
  evidence: string;
  /** 结构质量校验：false 表示该候选不参与展示竞争（保留用于解释） */
  valid?: boolean;
  rejectReason?: string;
  /** 人工否决：候选保留在列表里用于解释，但不再参与展示与搜索别名 */
  rejected?: boolean;
  rejectedAt?: string | null;
  support?: number;
  coverage?: number;
}

export interface SeriesGroupSummary {
  key: string;
  title: string;
  titleState: EntityTitleState;
  titleSource: string;
  state: SeriesEntityState;
  /** 已知成员数（收藏 + relation 引用） */
  memberCount: number;
  /** 我的收藏成员数（统计口径） */
  collectedCount: number;
  /** 由连续性关系确认的成员数 */
  confirmedCount: number;
  /** 归属存在歧义的候选成员数（不计入统计） */
  candidateCount: number;
  totalEpisodes: number;
  averageRate: number | null;
  firstYear: number | null;
  lastYear: number | null;
  statusCounts: Record<string, number>;
  evidenceCoverage: EvidenceCoverage;
  /** 列表视觉识别：来自已收藏成员（按展示序），不参与 identity / title。 */
  coverSubjects: Array<{ id: number; title: string }>;
  /** v1.8 Ranking：按指标排序时返回（display ≠ rankable） */
  ranking?: EntityRankingMeta;
}

/** 成员 + 「为什么属于这个系列」的结构化理由。 */
export interface SeriesMemberEntry {
  subjectId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  collected: boolean;
  /** 本地没有 subjects 行、只有关系数据（不猜测、不参与重复统计） */
  relationOnly: boolean;
  role: 'primary' | 'candidate';
  state: MembershipState;
  reasonCode: string;
  reason: string;
  viaSubjectId: number | null;
  viaRelation: string | null;
  /** 收藏成员附带的完整条目信息（用于复用现有列表组件） */
  item: SubjectListItem | null;
}

/** 相关但未纳入成员的作品（弱关联 / 跨媒体 / 未知关系）。 */
export interface SeriesRelatedEntry {
  subjectId: number;
  title: string;
  relation: string;
  relationClass: string;
  reason: string;
  coveredBy: number | null;
}

/**
 * 系列的观看情况：全部字段都由「我的收藏条目」直接聚合得到，
 * 不包含任何推测，也不把未收藏条目算作「未看」。
 */
export interface SeriesWatchSummary {
  /** 已知成员数（收藏 + relation 引用），不是统计口径 */
  knownMembers: number;
  /** 我的收藏条目数（系列统计的唯一依据） */
  collectedCount: number;
  /** 归属存在歧义的候选成员数（不计入统计） */
  candidateCount: number;
  watched: number;
  wish: number;
  watching: number;
  onHold: number;
  dropped: number;
  allWatched: boolean;
  anyStarted: boolean;
  insufficient: string | null;
}

export interface SeriesMergeCandidate {
  seriesKey: string;
  title: string;
  state: SeriesEntityState;
  relations: string[];
}

export interface SeriesDetail extends SeriesGroupSummary {
  presentation?: EvidencePresentation;
  protectedTitleCandidateCount?: number;
  /** 规范化 key（旧 key 通过 alias 解析后返回真实 key） */
  canonicalKey: string;
  /** 命中旧 key 时返回被请求的旧 key */
  aliasedFrom: string | null;
  members: SeriesMemberEntry[];
  related: SeriesRelatedEntry[];
  mergeCandidates: SeriesMergeCandidate[];
  titleCandidates: EntityTitleCandidate[];
  /** 人工确认时间（title_state = manual 时存在） */
  titleConfirmedAt: string | null;
  /** 该 Series 归属的 Franchise（若存在候选/暂定/已确认家族） */
  franchise: EntityLink | null;
  watch: SeriesWatchSummary;
  /** v1.8 Entity Analysis：B–E 层指标 + 样本 + 口径（F 层复用 members） */
  analysis: EntityAnalysis;
}

/** Title Review：确认当前名称 / 采用候选 / 自定义标题。 */
export const seriesTitleOverrideSchema = z
  .object({
    mode: z.enum(['confirm-current', 'candidate', 'custom']),
    title: z.string().trim().max(120).optional(),
  })
  .refine((value) => value.mode === 'confirm-current' || Boolean(value.title && value.title.length > 0), {
    message: 'candidate / custom 模式必须提供 title',
    path: ['title'],
  });

export type SeriesTitleOverrideInput = z.infer<typeof seriesTitleOverrideSchema>;

/**
 * 候选治理（v1.6.1）：对具体候选执行否决 / 采纳。
 *
 * - 否决：写入真实的治理状态（candidate_decisions），候选保留用于解释但退出竞争；
 * - 采纳：等价于 Title Review 的「采用候选」，成为 manual confirmed。
 */
export const seriesTitleCandidateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(240).optional(),
});
export type SeriesTitleCandidateInput = z.infer<typeof seriesTitleCandidateSchema>;

/** 家族候选治理：确认 / 否决（reason 记录在治理历史里）。 */
export const franchiseDecisionSchema = z.object({
  reason: z.string().trim().max(240).optional(),
});
export type FranchiseDecisionInput = z.infer<typeof franchiseDecisionSchema>;

export interface FranchiseSummary {
  key: string;
  title: string;
  titleState: EntityTitleState;
  titleSource: string;
  state: FranchiseState;
  seriesCount: number;
  confirmedSeriesCount: number;
  candidateSeriesCount: number;
  conflictSeriesCount: number;
  collectedCount: number;
  knownCount: number;
  averageRate: number | null;
  firstYear: number | null;
  lastYear: number | null;
  /** 家族封面：来自成员系列内已收藏作品的封面，仅用于视觉识别。 */
  coverSubjects: Array<{ id: number; title: string }>;
  /** v1.8 Ranking：按指标排序时返回（display ≠ rankable） */
  ranking?: EntityRankingMeta;
}

/** v1.8 Ranking：允许进入排名的指标与门槛（Registry 冻结）。 */
export type EntityRankingMetric = 'coverage' | 'completion' | 'rate';

export const ENTITY_RANKING_MIN_SAMPLE = 3;

export interface EntityRankingMeta {
  metric: EntityRankingMetric;
  /** 指标值：coverage / completion 为 0..1 比率；rate 为平均分；无样本 → null */
  value: number | null;
  /** 样本量：Coverage = knownMembers；Completion = collectedCount；Rating = ratedCount */
  sample: number;
  /** sample ≥ 3 才进入该指标的排名域；不达标者仍展示，但不参与排名 */
  rankable: boolean;
}

export interface FranchiseSeriesEntry {
  key: string;
  title: string;
  state: SeriesEntityState;
  linkState: FranchiseLinkState;
  evidence: string[];
  memberCount: number;
  collectedCount: number;
  entries: SubjectListItem[];
}

export interface FranchiseDetail extends FranchiseSummary {
  presentation?: EvidencePresentation;
  protectedTitleCandidateCount?: number;
  canonicalKey: string;
  aliasedFrom: string | null;
  titleCandidates: EntityTitleCandidate[];
  series: FranchiseSeriesEntry[];
  /** 成员排除治理记录（含已撤销的 provenance），v1.7.0 */
  exclusions: FranchiseMemberExclusion[];
  /**
   * v1.8.4 身份冲突：家族链接指向已被身份恢复取代的 stale Series。
   * superseded：存在可验证的 `rebuilt-into` / merged 谱系，可执行 supersede 治理动作；
   * unresolved：缺少谱系证据，需要人工核查，不允许自动迁移。
   */
  identityConflicts: FranchiseIdentityConflict[];
  /** v1.8 Entity Analysis：跨 Series 聚合的 B–E 层指标 + 样本 + 口径 */
  analysis: EntityAnalysis;
}

export interface FranchiseIdentityConflict {
  /** A safe HTTP summary, not missing lifecycle evidence. Confirm full evidence to inspect it. */
  evidenceProtected?: boolean;
  fromSeriesKey: string;
  fromSeriesTitle: string;
  /** 恢复后的同一真实 Series 身份（仅在存在可验证谱系时给出）。 */
  toSeriesKey: string | null;
  toSeriesTitle: string | null;
  reason: 'superseded' | 'unresolved';
  /** 生命周期证据快照：alias reason / merged 事件 / 成员一致性。 */
  evidence: {
    aliasReason: string;
    mergedEventId: number;
    mergedAt: string;
    restoredEventId: number | null;
    members: number[];
    exact: boolean;
    high: boolean;
  } | null;
}

/* ------------------------------------------------------- Entity Analysis（v1.8） */

/** 计算口径：Real = 完整数据；Visible = 当前可见投影。 */
export type EntityAnalysisVisibility = 'visible' | 'real';

/** 当前实体作用范围内的隐藏上下文（口径条数据，始终描述 hideNsfw 的隐藏范围）。 */
export interface EntityAnalysisHiddenContext {
  /** 被隐藏的成员 Series 数（Series detail 恒为 0） */
  series: number;
  /** 这些隐藏内容覆盖的 primary 成员数 */
  members: number;
}

export interface EntityAnalysisCoverage {
  value: number | null;
  knownMembers: number;
  localCollected: number;
  relationOnly: number;
}

export interface EntityAnalysisCompletion {
  value: number | null;
  /** 分子：看过（type = 2）的收藏成员 */
  watched: number;
  /** 分母：收藏成员总数 */
  collectedCount: number;
}

export interface EntityAnalysisStatusStructure {
  /** 五种收藏状态的成员计数（'1'..'5'） */
  counts: Record<'1' | '2' | '3' | '4' | '5', number>;
  collectedCount: number;
  /** 无收藏成员时结构不可用（不是「全 0」） */
  available: boolean;
}

export interface EntityAnalysisRatingAverage {
  value: number | null;
  /** 样本量：已评分的收藏成员数 */
  ratedCount: number;
}

export interface EntityAnalysisRatingCoverage {
  value: number | null;
  ratedCount: number;
  collectedCount: number;
}

export interface EntityAnalysisRatingDelta {
  /** mean-of-deltas（Registry 锁定的唯一口径） */
  value: number | null;
  pairedCount: number;
}

export interface EntityAnalysisAirSpan {
  firstYear: number | null;
  lastYear: number | null;
  datedMembers: number;
  totalMembers: number;
}

export interface EntityAnalysisAirDistribution {
  years: Array<{ year: number; count: number }>;
  datedMembers: number;
  totalMembers: number;
}

export interface EntityAnalysisEstimatedWatchTime {
  minutes: number | null;
  /** 永久标记：估算值，不是实际观看时长 */
  isEstimate: true;
  contributingMembers: number;
  excludedNoEpisodeData: number;
}

export interface EntityAnalysisConsumption {
  /** 看过的收藏成员数（原始计数证据） */
  watchedMembers: number;
  /** 已看集数（严格继承 WATCHED_EXPRESSION） */
  watchedEpisodes: number;
  estimatedWatchTime: EntityAnalysisEstimatedWatchTime;
}

export interface EntityAnalysis {
  visibility: EntityAnalysisVisibility;
  hidden: EntityAnalysisHiddenContext;
  coverage: EntityAnalysisCoverage;
  completion: EntityAnalysisCompletion;
  statusStructure: EntityAnalysisStatusStructure;
  rating: {
    average: EntityAnalysisRatingAverage;
    coverage: EntityAnalysisRatingCoverage;
    delta: EntityAnalysisRatingDelta;
  };
  air: {
    span: EntityAnalysisAirSpan;
    distribution: EntityAnalysisAirDistribution;
  };
  consumption: EntityAnalysisConsumption;
}

export interface RelationAuditEntry {
  relation: string;
  klass: string;
  polarity: string;
  note: string;
  count: number;
}

export interface RelationAudit {
  total: number;
  unknownCount: number;
  entries: RelationAuditEntry[];
  /** v1.5.0 → v1.5.1 迁移对账：旧组如何映射到新实体 */
  migration: {
    legacyGroups: number;
    aliasedGroups: number;
    unmappedGroups: number;
    mergedTargets: number;
    splitGroups: number;
  };
}

/** Subject 详情页上的 Series / Franchise 归属链接。 */
export interface EntityLink {
  key: string;
  title: string;
  titleState: EntityTitleState;
  state: string;
}

/* ------------------------------------------------- Series / IP 域内搜索 */

/**
 * 命中来源：与 Library Global Search 保持同一套「为什么命中」语义，
 * 但结果实体固定为 Series / Franchise。
 */
export type IpSearchMatchType = 'title' | 'alias' | 'series' | 'member' | 'member-alias' | 'key';

export interface IpSearchMatch {
  type: IpSearchMatchType;
  /** 命中的具体文本（用于展示「命中成员：XXX」） */
  text: string;
  /** 命中来自哪个上层实体（例如 Franchise 模式下命中的成员属于哪个 Series） */
  via?: string;
}

export interface SeriesSearchHit {
  key: string;
  title: string;
  titleState: EntityTitleState;
  state: EntityLink['state'];
  memberCount: number;
  collectedCount: number;
  coverSubjects: Array<{ id: number; title: string }>;
  matchReasons: IpSearchMatch[];
}

export interface FranchiseSearchHit {
  key: string;
  title: string;
  titleState: EntityTitleState;
  state: EntityLink['state'];
  seriesCount: number;
  collectedCount: number;
  coverSubjects: Array<{ id: number; title: string }>;
  matchReasons: IpSearchMatch[];
}

export interface IpSearchResponse<T> {
  query: string;
  /** 匹配到的实体总数（不受 limit 影响） */
  total: number;
  items: T[];
}

/* --------------------------------------------------------- 数据导入导出 */

export interface ExportCounts {
  collections: number;
  subjects: number;
  staff: number;
  relations: number;
}

export interface ExportPayload {
  format: 'bangumi-analyzer-export';
  version: 1;
  exportedAt: string;
  app: { version: string };
  counts: ExportCounts;
  collections: unknown[];
  subjects: unknown[];
}

export interface ImportPreview {
  detectedFormat: 'bangumi-analyzer-export' | 'bangumi-collection-array' | 'unknown';
  total: number;
  newSubjects: number;
  updatedSubjects: number;
  newCollections: number;
  updatedCollections: number;
  skipped: number;
  warnings: string[];
  sampleTitles: string[];
}

export interface ImportResult extends ImportPreview {
  applied: boolean;
  durationMs: number;
}

export interface BackupInfo {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

/* --------------------------------------------------------------- 通用响应 */

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    /** 面向用户的处理建议 */
    hint?: string;
    /** 是否影响已有数据 */
    dataIntact?: boolean;
    /** The remote request may have run even though no result reached this client. */
    resultUnknown?: boolean;
    detail?: string;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly status: number;
  readonly dataIntact: boolean;
  readonly resultUnknown: boolean;

  constructor(
    message: string,
    options: { code?: string; hint?: string; status?: number; dataIntact?: boolean; resultUnknown?: boolean } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code ?? 'internal_error';
    this.hint = options.hint;
    this.status = options.status ?? 500;
    this.dataIntact = options.dataIntact ?? true;
    this.resultUnknown = options.resultUnknown ?? false;
  }
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  dataDir: string;
  dbPath: string;
  subjects: number;
  collections: number;
  syncRunning: boolean;
}

/* ------------------------------------------------ 数据中枢（v1.6.0） */

/**
 * 问题严重度（数据中枢的统一语义）。
 *
 * 关键原则：provisional / unresolved / empty 都不是 error。
 * 只有「有真实数据依据的确定错误」才使用 error。
 */
export const DIAGNOSTIC_SEVERITIES = [
  'error',
  'suspicious',
  'needs-review',
  'uncertain',
  'external',
  'info',
] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export const DIAGNOSTIC_SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  error: '确定错误',
  suspicious: '高度可疑',
  'needs-review': '待人工确认',
  uncertain: '当前不确定',
  external: '外部数据依赖',
  info: '信息',
};

export const DIAGNOSTIC_MODULE_STATUSES = ['ok', 'attention', 'error', 'skipped'] as const;
export type DiagnosticModuleStatus = (typeof DIAGNOSTIC_MODULE_STATUSES)[number];

/** 证据行：诊断结论必须能落到具体数据上。 */
export interface DiagnosticEvidence {
  label: string;
  value: string;
}

/** 上下游影响项：说明问题会影响哪些真实功能。 */
export interface DiagnosticImpact {
  kind: 'subject' | 'series' | 'franchise' | 'search' | 'projection' | 'api' | 'ui' | 'storage';
  label: string;
  /** 可跳转的实体（如 Series 详情、Subject 详情）。 */
  href?: string;
}

/** 受影响实体样本（聚合问题时只展示前几条，并给出总数）。 */
export interface DiagnosticAffectedEntity {
  label: string;
  detail?: string;
  href?: string;
}

/** 影响链的一层：让用户看懂「改这个，到底会动什么」。 */
export interface DiagnosticImpactStep {
  layer: 'governance' | 'source' | 'projection' | 'search' | 'api' | 'ui' | 'cache';
  label: string;
  detail: string;
}

/** Repair Preview：执行前必须说明「改什么、为什么、影响什么、不碰什么」。 */
export interface DiagnosticRepairPreview {
  /** HTTP Visible projection cannot expose the exact historical plan. UI must request explicit evidence consent before executing. */
  requiresRealEvidence?: boolean;
  /** 当前状态（真实值）。 */
  current: string;
  /** 修复后将变成什么。 */
  next: string;
  /** 为什么这样修。 */
  reason: string;
  /** 修复依据的来源。 */
  source: string;
  /** 直接修改（source-of-truth / 治理状态）。 */
  directlyChanges: string[];
  /** 由直接修改自动派生（系统负责重算，不需要人工维护）。 */
  derivedChanges: string[];
  /** 明确不会被修改的数据。 */
  untouched: string[];
  /** 影响链：从治理状态到最终 UI 的因果顺序。 */
  chain: DiagnosticImpactStep[];
}

/** Evidence disclosure is independent of metric visibility. Optional for old servers. */
export interface EvidencePresentation {
  version: 1;
  mode: 'visible' | 'real';
  privacyApplied: boolean;
  note: string;
}

export const DIAGNOSTIC_REPAIR_KINDS = [
  'recompute-derived',
  'confirm-franchise',
  'clear-cover-cache',
  'reject-franchise-candidate',
  'adopt-title-candidate',
  'reject-title-candidate',
  'reopen-title-candidate',
] as const;
export type DiagnosticRepairKind = (typeof DIAGNOSTIC_REPAIR_KINDS)[number];

export type DiagnosticAction =
  | {
      kind: 'repair';
      repairKind: DiagnosticRepairKind;
      label: string;
      /** confirm-franchise 等需要具体目标。 */
      target?: string;
      /** 候选治理需要具体的候选值（例如候选标题）。 */
      value?: string;
      preview: DiagnosticRepairPreview;
    }
  | {
      kind: 'link';
      label: string;
      href: string;
      hint?: string;
    };

export interface DiagnosticIssue {
  sourceSnapshots?: DiagnosticSourceSnapshots;
  /** Local declared-FK check only; counts are failed references, not distinct works. */
  foreignKeys?: DiagnosticForeignKeyCheck;
  id: string;
  detector: string;
  /** 面向用户的问题分类（如「Series 派生数据」）。 */
  category: string;
  severity: DiagnosticSeverity;
  title: string;
  explanation: string;
  evidence: DiagnosticEvidence[];
  impact: DiagnosticImpact[];
  affected: DiagnosticAffectedEntity[];
  affectedCount: number;
  actions: DiagnosticAction[];
  /** 外部依赖说明（等待什么条件才能解决）。 */
  waitingFor?: string;
  /** 外部依赖分类：回答「我现在到底能不能做什么」。 */
  waiting?: {
    kind:
      | 'collection'
      | 'detail-sync'
      | 'bangumi-field'
      | 'relation-update'
      | 'manual-review'
      | 'network'
      | 'none';
    label: string;
    detail: string;
  };
}

export interface DiagnosticModule {
  sourceSnapshots?: DiagnosticSourceSnapshots;
  foreignKeys?: DiagnosticForeignKeyCheck;
  id: string;
  label: string;
  description: string;
  status: DiagnosticModuleStatus;
  /** 本模块实际检查了多少条记录 / 项检查。 */
  checked: number;
  details: string[];
}

/** Complete row enumeration is not complete source authenticity or semantic validation. */
export interface DiagnosticSourceSnapshots {
  scope: 'stored-source-json';
  scanStatus: 'complete';
  assessment: 'format-only';
  schemaVersion: number;
  maxBytesPerSnapshot: number;
  sampleLimit: number;
  rowsScanned: number;
  absentCount: number;
  objectCount: number;
  nonObjectCount: number;
  invalidCount: number;
  uncheckedCount: number;
  samplesTruncated: boolean;
  samples: Array<{ table: 'subjects' | 'collections'; recordId: string | null; reason: 'invalid-json' | 'non-text'; identityProtected: boolean }>;
}

export interface DiagnosticForeignKeyRelation {
  table: string | null;
  parent: string | null;
  foreignKeyId: number;
  columns: string[];
  parentColumns: Array<string | null>;
  schemaProtected: boolean;
}

export interface DiagnosticForeignKeyCheck {
  scope: 'declared-sqlite-foreign-keys';
  status: 'complete';
  tablesInspected: number;
  constraintCount: number;
  foreignKeysEnabled: boolean;
  violationCount: number;
  sampleLimit: number;
  samplesTruncated: boolean;
  groupCount: number;
  groupsTruncated: boolean;
  groups: Array<DiagnosticForeignKeyRelation & { violationCount: number }>;
  samples: Array<DiagnosticForeignKeyRelation & { rowid: string | null; identityProtected: boolean }>;
}

export interface DiagnosticsSummary {
  error: number;
  suspicious: number;
  'needs-review': number;
  uncertain: number;
  external: number;
  info: number;
  total: number;
}

export interface DiagnosticsScope {
  subjects: number;
  collections: number;
  relations: number;
  series: number;
  franchises: number;
  staleSeries: number;
}

/** Snapshot validity is independent of scan completeness and data errors. */
export interface DiagnosticsFreshness {
  status: 'snapshot' | 'expired';
  observedAt: string;
  validUntil: string;
  reason: 'age' | 'local-change' | 'clock' | null;
  boundary: string;
}

export interface DiagnosticsReport {
  /** Missing on legacy servers does not establish present observation validity. */
  freshness?: DiagnosticsFreshness;
  presentation?: EvidencePresentation;
  /** Absent on legacy servers: consumers must not infer complete coverage from absence. */
  coverage?: { status: 'complete'; note: string };
  /** Issue display pagination; detection and summary cover the whole registered detector domain. */
  issuePage?: { offset: number; limit: number; total: number; hasMore: boolean };
  generatedAt: string;
  durationMs: number;
  dataVersion: number;
  hideNsfw: boolean;
  /** 最近一次真实数据变更（sync / import / governance / repair / maintenance）。 */
  lastMutation: { scope: string | null; at: string | null; detail: string | null };
  scope: DiagnosticsScope;
  summary: DiagnosticsSummary;
  modules: DiagnosticModule[];
  issues: DiagnosticIssue[];
}

export const diagnosticsRepairRequestSchema = z.object({
  issueId: z.string().trim().min(1).max(160),
  kind: z.enum(DIAGNOSTIC_REPAIR_KINDS),
  target: z.string().trim().max(120).optional(),
  value: z.string().trim().max(160).optional(),
});
export type DiagnosticsRepairRequest = z.infer<typeof diagnosticsRepairRequestSchema>;

export interface DiagnosticsRepairCheck {
  label: string;
  ok: boolean;
  detail: string;
  /** 该检查覆盖的层级：验证必须覆盖真实受影响层，而不是只重跑 detector。 */
  layer: 'source' | 'governance' | 'projection' | 'search' | 'api' | 'ui' | 'detector' | 'cache';
}

export interface DiagnosticsVerification {
  /** 目标问题在重新检测后确实消失。 */
  verified: boolean;
  /** 有部分目标未通过验证：必须如实报告，不能显示绿灯。 */
  partial: boolean;
  summary: string;
  resolvedIssueIds: string[];
  remainingIssueIds: string[];
  checks: DiagnosticsRepairCheck[];
}

export interface DiagnosticsRepairResult {
  ok: boolean;
  repair: {
    kind: DiagnosticRepairKind;
    label: string;
    target?: string;
  };
  verification: DiagnosticsVerification;
  report: DiagnosticsReport;
}

/* -------------------------------------------- 治理历史（v1.6.2，只读） */

/**
 * 治理 / 修复历史条目：完全来自 entity_events 与 candidate_decisions，
 * 是既有事实的只读投影，不引入新的写模型。
 */
export interface DiagnosticHistoryEntry {
  id: string;
  /** 记录时间（决定行用最近一次状态变化时间）。 */
  at: string;
  source: 'entity_event' | 'candidate_decision';
  /** 机器可读的动作类型（title_manual / candidate_rejected / confirmed / rejected ...）。 */
  kind: string;
  /** 人类可读动作说明。 */
  summary: string;
  /** 谁做的：本地用户 / 系统自动 / 维护操作。 */
  actor: 'user' | 'system' | 'maintenance';
  entityKind: 'series' | 'franchise' | 'legacy';
  entityId: number;
  /** 当前实体 key（若仍存在）。 */
  entityKey: string | null;
  /** 当前实体标题（若仍存在）。 */
  entityTitle: string | null;
  /** 当前治理状态（title_state / franchise state）。 */
  currentState: string | null;
  /** 对应候选（若有）。 */
  candidate: { kind: string; title: string } | null;
  /** 状态变化描述（如 confirmed → rejected）。 */
  stateChange: string | null;
  /** 当时保存的原因。 */
  reason: string | null;
  /** 当时保存的证据快照（JSON 字符串，只读展示）。 */
  evidence: string | null;
}

export interface DiagnosticsHistoryResponse {
  presentation?: EvidencePresentation;
  entries: DiagnosticHistoryEntry[];
  /** 与筛选条件匹配的总条数（用于「显示更多」）。 */
  total: number;
  filters: {
    entityKind: 'all' | 'series' | 'franchise';
    actor: 'all' | 'user' | 'system' | 'maintenance';
    limit: number;
  };
}

/* ------------------------------ Franchise 成员 / 名称治理（v1.7.0） */

/**
 * Franchise 局部治理动作。
 *
 * 语义边界（三者必须保持独立）：
 *   成员移出 ≠ Franchise Split
 *   撤销成员排除 ≠ 强制重新加入
 *   修正成员构成 ≠ 自动确认 Franchise
 */
export const FRANCHISE_GOVERNANCE_KINDS = [
  'exclude-franchise-member',
  'reopen-franchise-member',
  'supersede-franchise-member',
  'adopt-franchise-title',
  'reset-franchise-title',
] as const;
export type FranchiseGovernanceKind = (typeof FRANCHISE_GOVERNANCE_KINDS)[number];

export const FRANCHISE_GOVERNANCE_LABEL: Record<FranchiseGovernanceKind, string> = {
  'exclude-franchise-member': '移出家族成员',
  'reopen-franchise-member': '撤销成员排除（重新评估）',
  'supersede-franchise-member': '迁移已被取代的家族成员',
  'adopt-franchise-title': '设置家族名称',
  'reset-franchise-title': '恢复自动解析',
};

/** 成员排除记录：active 表示当前生效，revoked 表示用户已撤销（provenance 保留）。 */
export interface FranchiseMemberExclusion {
  /** HTTP-only safe evidence summary; no navigable identity is disclosed. */
  identityProtected?: boolean;
  seriesKey: string;
  seriesTitle: string;
  state: 'active' | 'revoked';
  reason: string;
  /** 作出决定时的证据快照（JSON 字符串，只读展示）。 */
  evidence: string;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export const franchiseGovernanceRequestSchema = z.object({
  kind: z.enum(FRANCHISE_GOVERNANCE_KINDS),
  /** exclude / reopen 的目标成员（Series key）。 */
  series: z.string().trim().max(160).optional(),
  /** adopt-franchise-title 的人工名称。 */
  title: z.string().trim().max(120).optional(),
  reason: z.string().trim().max(240).optional(),
});
export type FranchiseGovernanceRequest = z.infer<typeof franchiseGovernanceRequestSchema>;

/** 执行前的影响预览：当前 → 未来 → 原因 / 来源 / 直接修改 / 自动派生 / 不会修改 / 影响链。 */
export interface FranchiseGovernancePreviewResponse {
  presentation?: EvidencePresentation;
  requiresRealEvidence?: boolean;
  kind: FranchiseGovernanceKind;
  label: string;
  allowed: boolean;
  /** 不可执行时的原因说明（allowed=false 时必填）。 */
  message: string;
  preview: DiagnosticRepairPreview | null;
}

/** 执行结果：复用数据中枢的验证契约（逐层 checks + 重新检测）。 */
export interface FranchiseGovernanceResult {
  ok: boolean;
  repair: {
    kind: FranchiseGovernanceKind;
    label: string;
    target?: string;
    value?: string;
  };
  verification: DiagnosticsVerification;
  report: DiagnosticsReport;
}
