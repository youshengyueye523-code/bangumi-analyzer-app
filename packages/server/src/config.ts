import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppConfigPublic, AppConfigUpdate } from '@bangumi-analyzer/shared';
import type { AiConfigPublic } from '@bangumi-analyzer/shared';
import type { MaterialSetting, WallpaperSetting } from '@bangumi-analyzer/shared';
import {
  isWallpaperFileName,
  MATERIAL_DEFAULT,
  MATERIAL_PRESETS,
  SUBJECT_TYPE,
  WALLPAPER_BLUR_MAX,
  WALLPAPER_DEFAULT,
} from '@bangumi-analyzer/shared';

export const APP_VERSION = '2.0.0';

/** Set only by the portable launcher; never persisted in personal configuration. */
export function isDistribution(): boolean { return process.env.BANGUMI_DISTRIBUTION === '1'; }

/** 仓库根目录：无论从 src（tsx）还是 dist（node）启动，层级都是一致的。 */
export const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');

const CONFIG_FILE_NAME = 'config.json';

export interface AppConfig {
  username: string;
  token: string;
  /** 本地个人资料：与 Bangumi 账号无关，仅用于这个工具自己的界面。 */
  nickname: string;
  /** 本地头像（data URL，只保存在本机配置里，不上传任何第三方服务） */
  avatar: string;
  /** 首次使用引导是否已完成 / 已跳过 */
  onboardingSeen: boolean;
  /** 同步后自动把日文简介加入翻译队列（默认开启） */
  summaryAutoTranslate: boolean;
  /** 简介翻译的并发请求数（1–8，默认 2） */
  summaryConcurrency: number;
  subjectTypes: number[];
  requestIntervalMs: number;
  detailRefreshDays: number;
  userAgent: string;
  cacheCovers: boolean;
  httpProxy: string;
  /** 全局背景板：图片以文件形式存放在 data/wallpapers，这里只保存描述信息 */
  wallpaper: WallpaperSetting;
  /** 界面材质倾向：只保存用户可理解的三个值，底层参数由前端映射 */
  material: MaterialSetting;
  /** 隐藏 NSFW 内容（只影响 UI 可见性，不修改数据） */
  hideNsfw: boolean;
  /** 画像的自然语言总结（可选）：不配置时画像的统计部分完全可用 */
  ai: AiConfig;
}

export interface AiConfig {
  enabled: boolean;
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey: string;
}

const DEFAULT_CONFIG: AppConfig = {
  username: '',
  token: '',
  nickname: '',
  avatar: '',
  onboardingSeen: false,
  summaryAutoTranslate: true,
  summaryConcurrency: 2,
  subjectTypes: [SUBJECT_TYPE.Anime],
  // Bangumi 未公开具体限流阈值，实测约 1.3 req/s，这里保守取 1 req/s
  requestIntervalMs: 1000,
  detailRefreshDays: 30,
  userAgent: `bangumi-analyzer/${APP_VERSION} (personal local tool)`,
  cacheCovers: true,
  httpProxy: '',
  wallpaper: { ...WALLPAPER_DEFAULT },
  material: { ...MATERIAL_DEFAULT },
  hideNsfw: false,
  ai: {
    enabled: false,
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
  },
};

export interface RuntimePaths {
  projectRoot: string;
  dataDir: string;
  configFile: string;
  dbFile: string;
  backupDir: string;
  coverDir: string;
  wallpaperDir: string;
  logDir: string;
}

function resolvePaths(): RuntimePaths {
  const dataDir = process.env.BANGUMI_DATA_DIR
    ? resolve(process.env.BANGUMI_DATA_DIR)
    : join(PROJECT_ROOT, 'data');
  return {
    projectRoot: PROJECT_ROOT,
    dataDir,
    configFile: join(dataDir, CONFIG_FILE_NAME),
    dbFile: join(dataDir, 'bangumi.db'),
    backupDir: join(dataDir, 'backups'),
    coverDir: join(dataDir, 'covers'),
    wallpaperDir: join(dataDir, 'wallpapers'),
    logDir: join(dataDir, 'logs'),
  };
}

export const paths: RuntimePaths = resolvePaths();

export function ensureDataDirs(): void {
  for (const dir of [
    paths.dataDir,
    paths.coverDir,
    paths.wallpaperDir,
    paths.logDir,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function coerceStringArray(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  const parsed = value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
  return parsed.length > 0 ? [...new Set(parsed)] : fallback;
}

function coerceNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = coerceNumber(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

/** 背景板设置的容错读取：文件名的格式不对时按「无背景」处理，不影响其余配置。 */
export function coerceWallpaper(value: unknown): WallpaperSetting {
  const raw = (value ?? {}) as Partial<WallpaperSetting>;
  return {
    image: typeof raw.image === 'string' && isWallpaperFileName(raw.image) ? raw.image : '',
    focusX: clampNumber(raw.focusX, WALLPAPER_DEFAULT.focusX, 0, 100),
    focusY: clampNumber(raw.focusY, WALLPAPER_DEFAULT.focusY, 0, 100),
    blur: clampNumber(raw.blur, WALLPAPER_DEFAULT.blur, 0, WALLPAPER_BLUR_MAX),
    strength: clampNumber(raw.strength, WALLPAPER_DEFAULT.strength, 0, 100),
  };
}

/** 材质设置的容错读取：越界值收敛，非法的倾向回落到平衡。 */
export function coerceMaterial(value: unknown): MaterialSetting {
  const raw = (value ?? {}) as Partial<MaterialSetting>;
  const preset =
    raw.preset === 'clear' || raw.preset === 'balanced' || raw.preset === 'frosted'
      ? raw.preset
      : MATERIAL_DEFAULT.preset;
  return {
    preset,
    clarity: clampNumber(raw.clarity, MATERIAL_PRESETS[preset].clarity, 0, 100),
    frosted: clampNumber(raw.frosted, MATERIAL_PRESETS[preset].frosted, 0, 100),
  };
}

/** 读取本地配置；优先级：环境变量 > data/config.json > 内置默认值。 */
export function loadConfig(): AppConfig {
  let fileConfig: Partial<AppConfig> = {};
  if (existsSync(paths.configFile)) {
    try {
      fileConfig = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Partial<AppConfig>;
    } catch (error) {
      throw new Error(
        `无法解析配置文件 ${paths.configFile}：${(error as Error).message}。` +
          '请修复或删除该文件（Token 需要重新填写），已有数据库不受影响。',
      );
    }
  }

  const merged: AppConfig = {
    username: String(fileConfig.username ?? DEFAULT_CONFIG.username),
    token: String(fileConfig.token ?? DEFAULT_CONFIG.token),
    nickname: String(fileConfig.nickname ?? DEFAULT_CONFIG.nickname),
    avatar: String(fileConfig.avatar ?? DEFAULT_CONFIG.avatar),
    onboardingSeen: coerceBoolean(fileConfig.onboardingSeen, DEFAULT_CONFIG.onboardingSeen),
    summaryAutoTranslate: coerceBoolean(
      fileConfig.summaryAutoTranslate,
      DEFAULT_CONFIG.summaryAutoTranslate,
    ),
    summaryConcurrency: Math.min(
      8,
      Math.max(1, Math.round(coerceNumber(fileConfig.summaryConcurrency, DEFAULT_CONFIG.summaryConcurrency))),
    ),
    subjectTypes: coerceStringArray(fileConfig.subjectTypes, DEFAULT_CONFIG.subjectTypes),
    requestIntervalMs: coerceNumber(
      fileConfig.requestIntervalMs,
      DEFAULT_CONFIG.requestIntervalMs,
    ),
    detailRefreshDays: coerceNumber(fileConfig.detailRefreshDays, DEFAULT_CONFIG.detailRefreshDays),
    userAgent: String(fileConfig.userAgent ?? DEFAULT_CONFIG.userAgent),
    cacheCovers: coerceBoolean(fileConfig.cacheCovers, DEFAULT_CONFIG.cacheCovers),
    httpProxy: String(fileConfig.httpProxy ?? DEFAULT_CONFIG.httpProxy),
    wallpaper: coerceWallpaper(fileConfig.wallpaper),
    material: coerceMaterial(fileConfig.material),
    hideNsfw: coerceBoolean(fileConfig.hideNsfw, DEFAULT_CONFIG.hideNsfw),
    ai: {
      enabled: coerceBoolean(fileConfig.ai?.enabled, DEFAULT_CONFIG.ai.enabled),
      provider: 'openai-compatible',
      baseUrl: String(fileConfig.ai?.baseUrl ?? DEFAULT_CONFIG.ai.baseUrl),
      model: String(fileConfig.ai?.model ?? DEFAULT_CONFIG.ai.model),
      apiKey: String(fileConfig.ai?.apiKey ?? DEFAULT_CONFIG.ai.apiKey),
    },
  };

  if (process.env.BANGUMI_USERNAME) merged.username = process.env.BANGUMI_USERNAME;
  if (process.env.BANGUMI_ACCESS_TOKEN) merged.token = process.env.BANGUMI_ACCESS_TOKEN;
  if (process.env.BANGUMI_USER_AGENT) merged.userAgent = process.env.BANGUMI_USER_AGENT;
  if (process.env.BANGUMI_HTTP_PROXY) merged.httpProxy = process.env.BANGUMI_HTTP_PROXY;
  if (process.env.BANGUMI_SUBJECT_TYPES) {
    merged.subjectTypes = coerceStringArray(
      process.env.BANGUMI_SUBJECT_TYPES.split(','),
      DEFAULT_CONFIG.subjectTypes,
    );
  }
  if (process.env.BANGUMI_REQUEST_INTERVAL_MS) {
    merged.requestIntervalMs = Math.max(
      0,
      coerceNumber(process.env.BANGUMI_REQUEST_INTERVAL_MS, merged.requestIntervalMs),
    );
  }
  // 画像 AI 也可用环境变量配置（与网页端配置等价，环境变量优先）
  if (process.env.AI_ENABLED) merged.ai.enabled = coerceBoolean(process.env.AI_ENABLED, false);
  if (process.env.AI_BASE_URL) merged.ai.baseUrl = process.env.AI_BASE_URL;
  if (process.env.AI_MODEL) merged.ai.model = process.env.AI_MODEL;
  if (process.env.AI_API_KEY) merged.ai.apiKey = process.env.AI_API_KEY;

  return merged;
}

/** 仅保存可写入 config.json 的字段（不包含环境变量来源的值）。 */
export function saveConfig(patch: AppConfigUpdate): AppConfig {
  const current = loadConfig();
  const next: AppConfig = { ...current };

  if (patch.username !== undefined) next.username = patch.username;
  if (patch.token !== undefined) next.token = patch.token;
  if (patch.nickname !== undefined) next.nickname = patch.nickname.trim().slice(0, 40);
  if (patch.avatar !== undefined) next.avatar = patch.avatar;
  if (patch.onboardingSeen !== undefined) next.onboardingSeen = patch.onboardingSeen;
  if (patch.summaryAutoTranslate !== undefined) next.summaryAutoTranslate = patch.summaryAutoTranslate;
  if (patch.summaryConcurrency !== undefined) {
    next.summaryConcurrency = Math.min(8, Math.max(1, Math.round(patch.summaryConcurrency)));
  }
  if (patch.subjectTypes !== undefined) {
    next.subjectTypes = coerceStringArray(patch.subjectTypes, current.subjectTypes);
  }
  if (patch.requestIntervalMs !== undefined) {
    next.requestIntervalMs = Math.max(0, Math.round(patch.requestIntervalMs));
  }
  if (patch.detailRefreshDays !== undefined) {
    next.detailRefreshDays = Math.max(1, Math.round(patch.detailRefreshDays));
  }
  if (patch.userAgent !== undefined && patch.userAgent.trim()) {
    next.userAgent = patch.userAgent.trim();
  }
  if (patch.cacheCovers !== undefined) next.cacheCovers = patch.cacheCovers;
  if (patch.httpProxy !== undefined) next.httpProxy = patch.httpProxy;
  if (patch.wallpaper) {
    next.wallpaper = coerceWallpaper({ ...next.wallpaper, ...patch.wallpaper });
  }
  if (patch.material) {
    next.material = coerceMaterial({ ...next.material, ...patch.material });
  }
  if (patch.hideNsfw !== undefined) next.hideNsfw = patch.hideNsfw;
  if (patch.ai) {
    const ai = patch.ai;
    next.ai = {
      ...next.ai,
      ...(ai.enabled !== undefined ? { enabled: ai.enabled } : {}),
      ...(ai.baseUrl !== undefined && ai.baseUrl.trim() ? { baseUrl: ai.baseUrl.trim().replace(/\/+$/, '') } : {}),
      ...(ai.model !== undefined && ai.model.trim() ? { model: ai.model.trim() } : {}),
      ...(ai.apiKey !== undefined ? { apiKey: ai.apiKey } : {}),
    };
  }

  ensureDataDirs();
  const tempFile = `${paths.configFile}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tempFile, paths.configFile);
  return next;
}

export function dbSizeBytes(): number {
  try {
    return statSync(paths.dbFile).size;
  } catch {
    return 0;
  }
}

/** 只暴露给前端的安全视图：绝不包含 Token 明文。 */
export function toPublicConfig(config: AppConfig): AppConfigPublic {
  return {
    ...(isDistribution() ? { canDisconnectBangumi: true } : {}),
    username: config.username,
    hasToken: config.token.length > 0,
    tokenHint: config.token ? maskToken(config.token) : null,
    nickname: config.nickname,
    avatar: config.avatar,
    onboardingSeen: config.onboardingSeen,
    summaryAutoTranslate: config.summaryAutoTranslate,
    summaryConcurrency: config.summaryConcurrency,
    subjectTypes: config.subjectTypes,
    requestIntervalMs: config.requestIntervalMs,
    detailRefreshDays: config.detailRefreshDays,
    userAgent: config.userAgent,
    cacheCovers: config.cacheCovers,
    httpProxy: config.httpProxy,
    wallpaper: config.wallpaper,
    material: config.material,
    hideNsfw: config.hideNsfw,
    ai: toPublicAiConfig(config.ai),
    dataDir: paths.dataDir,
    dbPath: paths.dbFile,
    dbSizeBytes: dbSizeBytes(),
    version: APP_VERSION,
  };
}

/** 生成形如 `bgm_…a1b2` 的提示，用于确认保存的是哪个 Token。 */
export function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/** AI 配置的安全视图：只返回是否已配置与掩码，绝不返回 Key 明文。 */
export function toPublicAiConfig(ai: AiConfig): AiConfigPublic {
  return {
    enabled: ai.enabled,
    provider: ai.provider,
    baseUrl: ai.baseUrl,
    model: ai.model,
    hasApiKey: ai.apiKey.length > 0,
    apiKeyHint: ai.apiKey ? maskToken(ai.apiKey) : null,
  };
}

/** 画像 AI 是否可用：需要开关打开且 Key / 地址 / 模型齐全。 */
export function aiAvailability(ai: AiConfig): { configured: boolean; reason: string } {
  if (!ai.enabled) return { configured: false, reason: '未启用 AI 总结（可在「设置」中开启）' };
  if (!ai.apiKey) return { configured: false, reason: '缺少 AI API Key（可在「设置」中填写）' };
  if (!ai.baseUrl) return { configured: false, reason: '缺少 AI 接口地址' };
  if (!ai.model) return { configured: false, reason: '缺少模型名称' };
  return { configured: true, reason: '' };
}
