/**
 * 画像的 AI 总结（可选功能）。
 *
 * 架构上严格遵守「数据先行、AI 总结」：
 *   - AI 只能看到 `buildAiView()` 生成的结构化统计视图，看不到数据库；
 *   - 系统提示明确禁止推断性格 / 年龄 / 心理 / 现实生活；
 *   - 输出必须是 JSON，并被 schema 校验后才保存；
 *   - 未配置 AI 时，画像的统计部分完全不受影响。
 */

import { z } from 'zod';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import type { AiConfig } from '../config.js';
import type { ProfileAiOutput, ProfileDataset } from '@bangumi-analyzer/shared';
import type { profileFranchiseStats } from '../stats/profile.js';

export type AiErrorKind =
  | 'disabled'
  | 'configuration'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'server'
  | 'invalid_response';

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly hint: string;

  constructor(kind: AiErrorKind, message: string, hint = '') {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.hint = hint;
  }
}

const SECTION_IDS = [
  ['what-you-like', '你到底喜欢什么'],
  ['core-template', '你的核心审美模板'],
  ['avoidance', '你会主动避开什么'],
  ['high-score-works', '你真正容易打高分的作品'],
  ['boundaries', '你的兴趣边界'],
  ['expanding', '你的兴趣正在扩大吗'],
  ['changes', '你的审美变化'],
  ['stable', '哪些判断最稳定'],
  ['overturned', '哪些判断正在被新数据推翻'],
  ['counterintuitive', '与你自己认知可能不同的地方'],
] as const;

const claimSchema = z.object({
  id: z.string(),
  title: z.string(),
  statement: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  kind: z.enum(['data', 'inference']),
  confidence: z.enum(['high', 'medium', 'low']),
});

const outputSchema = z.object({
  sections: z.array(claimSchema).min(3),
  verdict: z.string().min(1),
  uncertainties: z.array(z.string()).default([]),
  surprises: z.array(z.string()).default([]),
});

/**
 * 生成给 AI 的结构化视图：只保留统计结论与少量样本，
 * 并显式标注「哪些是直接数据」「哪些是本地推测」。
 */
type FranchiseStats = ReturnType<typeof profileFranchiseStats>;

export function buildAiView(dataset: ProfileDataset, franchises?: FranchiseStats): unknown {
  const take = <T>(list: T[] | undefined, count: number): T[] =>
    Array.isArray(list) ? list.slice(0, count) : [];
  return {
    note: '以下全部数字由本地统计层计算，AI 只能引用这里出现的数字与作品名。',
    sample: dataset.sample,
    basics: dataset.basics,
    topTags: take(dataset.tags, 40).map((tag) => ({
      name: tag.name,
      count: tag.count,
      share: tag.share,
      averageRate: tag.averageRate,
      highShare: tag.highShare,
      lift: tag.lift,
    })),
    tagPairsInHighRated: take(dataset.tagPairs, 12),
    formats: take(dataset.formats, 10),
    seasons: take(dataset.seasons, 6),
    originals: take(dataset.originals, 10),
    studios: take(dataset.studios, 20),
    directors: take(dataset.directors, 20),
    lengthBuckets: dataset.length,
    series: dataset.series,
    franchises,
    avoidanceCandidates: take(dataset.avoidance, 10),
    periods: take(dataset.periods, 12),
    breadth: dataset.breadth,
    deterministicClaims: dataset.claims.map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      statement: claim.statement,
      evidence: claim.evidence,
      confidence: claim.confidence,
      insufficient: claim.insufficient ?? null,
    })),
    highRatedSamples: take(dataset.samples.highRated, 15),
    lowRatedSamples: take(dataset.samples.lowRated, 10),
    abandonedSamples: take(dataset.samples.abandoned, 10),
  };
}

export function buildPrompt(dataset: ProfileDataset, franchises?: FranchiseStats): { system: string; user: string } {
  const system = [
    '你是一位长期观察同一位观众观看记录的动画审美分析师，负责对他的收藏数据做系统性复盘。',
    '',
    '硬性规则（必须遵守）：',
    '1. 只讨论「动画观看行为与作品偏好」，绝对不要推断性格、年龄、性别、人格类型、心理状态、现实生活、职业或任何个人属性。',
    '2. 每一条结论都必须引用给定数据中的具体数字或作品名，禁止编造数据、作品名或标签。',
    '3. 数据不足时必须直接写「当前数据不足」，不要用推测填空。',
    '4. 明确区分：kind="data" 表示由数据直接计算出的结论；kind="inference" 表示基于数据的推测。',
    '5. 证据薄弱时把 confidence 设为 "low"，不要为了让文字更精彩而拔高结论。',
    '6. 输出必须是合法 JSON（不要 Markdown 代码块、不要多余解释），结构如下：',
    JSON.stringify(
      {
        sections: [
          {
            id: SECTION_IDS.map(([id]) => id).join(' | '),
            title: SECTION_IDS.map(([, title]) => title).join(' | '),
            statement: '这一模块的结论（2-4 句，引用具体数字）',
            evidence: ['使用到的统计数字，尽量写成「X 部 / Y% / 平均 Z 分」的形式'],
            kind: 'data | inference',
            confidence: 'high | medium | low',
          },
        ],
        verdict: '把整个画像浓缩成一段完整、有逻辑的自然语言总结（不要写成数据报告口吻）',
        uncertainties: ['当前数据无法判断的部分'],
        surprises: ['与用户自我认知可能不同的地方（必须有数据支撑，没有就留空数组）'],
      },
      null,
      0,
    ),
    '',
    `sections 必须覆盖以下 ${SECTION_IDS.length} 个模块，id 与 title 必须严格使用给定的值：`,
    SECTION_IDS.map(([id, title]) => `- ${id}：${title}`).join('\n'),
    '',
    '写作口吻：像一位长期观察你观看记录的人在复盘你的审美，而不是一份数据分析报告；但每句话背后都要有数字。',
  ].join('\n');

  const user = [
    '以下是程序基于我的完整收藏计算的统计结果和代表样本：',
    JSON.stringify(buildAiView(dataset, franchises), null, 1),
    '',
    '请基于以上数据输出 JSON 画像。',
  ].join('\n');

  return { system, user };
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

const TRANSLATION_MARKER = '以下是需要翻译的动画简介原文（保持原文语言，不要改写）';

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AiError('invalid_response', 'AI 返回的内容不是 JSON');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new AiError('invalid_response', 'AI 返回的内容无法解析为 JSON');
  }
}

interface TransportOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Only AI fetches use this dispatcher; standard process proxy/NO_PROXY rules apply. */
let aiProxy: EnvHttpProxyAgent | undefined;
function proxyDispatcher(): EnvHttpProxyAgent | undefined {
  const env = process.env;
  if (!env.http_proxy && !env.HTTP_PROXY && !env.https_proxy && !env.HTTPS_PROXY) return undefined;
  return aiProxy ??= new EnvHttpProxyAgent();
}

export function aiCompletionUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions';
    return url.href;
  } catch {
    throw new AiError('configuration', 'AI 接口地址不是有效的 HTTP(S) 兼容地址');
  }
}

function transportCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: unknown; errors?: unknown[] } | null;
  const code = e?.code;
  if (typeof code === 'string' && /^(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)$/.test(code)) return code;
  const cause = e?.cause as { code?: string; errors?: unknown[] } | undefined;
  for (const child of [cause, ...(cause?.errors ?? []), ...(e?.errors ?? [])]) {
    const childCode = (child as { code?: string } | undefined)?.code;
    if (childCode) {
      const safe = transportCode({ code: childCode });
      if (safe) return safe;
    }
  }
  return undefined;
}

async function chatCompletion(
  config: AiConfig,
  body: object,
  options: TransportOptions,
  deadline: number,
): Promise<{ payload: ChatCompletionResponse; content: string }> {
  const url = aiCompletionUrl(config.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? deadline);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let receiving = false;
  try {
    signal.throwIfAborted();
    const dispatcher = options.fetchImpl ? undefined : proxyDispatcher();
    const init = {
      method: 'POST', redirect: 'error' as const, signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    };
    const response = dispatcher
      ? await undiciFetch(url, { ...init, dispatcher })
      : await (options.fetchImpl ?? fetch)(url, init);
    receiving = true;
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        throw new AiError('auth', `AI 认证失败（HTTP ${response.status}）`, '请检查 API Key 和该模型的权限。');
      }
      if (response.status === 429) {
        const delay = (response.headers.get('retry-after') ?? '').trim();
        const seconds = /^\d{1,5}$/.test(delay) ? Number(delay) : null;
        throw new AiError('rate_limit', 'AI 接口限流（HTTP 429）', seconds === null ? '请稍后再试。' : `上游建议等待 ${seconds} 秒。`);
      }
      throw new AiError('server', `AI 接口返回 HTTP ${response.status}`);
    }
    if (response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      void response.body?.cancel().catch(() => undefined);
      throw new AiError('invalid_response', 'AI 接口未遵循非流式请求，返回了事件流', '此处需要兼容 OpenAI 的非流式 JSON 响应。');
    }
    const text = await response.text();
    signal.throwIfAborted();
    let payload: ChatCompletionResponse;
    try { payload = JSON.parse(text) as ChatCompletionResponse; }
    catch { throw new AiError('invalid_response', 'AI 返回的不是合法 JSON'); }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AiError('invalid_response', 'AI 没有返回文本内容');
    return { payload, content };
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (options.signal?.aborted) throw new AiError('cancelled', '已停止等待 AI 响应');
    const code = transportCode(error);
    const stage = receiving ? '读取响应' : '连接或等待响应头';
    if (controller.signal.aborted || code?.endsWith('_TIMEOUT') || code === 'ETIMEDOUT') {
      throw new AiError('timeout', `AI 请求超时（${stage}${code ? ` · ${code}` : ''}）`);
    }
    throw new AiError('network', `AI 传输失败（${stage}${code ? ` · ${code}` : ''}）`,
      '请检查接口、网络和进程代理设置。');
  } finally {
    clearTimeout(timer);
  }
}

export function buildProfileSummaryRequest(model: string, dataset: ProfileDataset, franchises: FranchiseStats) {
  const prompt = buildPrompt(dataset, franchises);
  return {
    model, stream: false,
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.4,
    response_format: { type: 'json_object' },
  };
}

export interface GenerateOptions extends TransportOptions {
  config: AiConfig;
  body: ReturnType<typeof buildProfileSummaryRequest>;
}

export interface GenerateResult {
  output: ProfileAiOutput;
  provider: string;
  model: string;
  usage: { promptTokens: number | null; completionTokens: number | null };
}

/** 调用 OpenAI 兼容的 /chat/completions 接口并校验输出。 */
export async function generateProfileSummary(options: GenerateOptions): Promise<GenerateResult> {
  const { config } = options;
  if (!config.enabled || !config.apiKey) {
    throw new AiError('disabled', 'AI 总结未启用', '请在「设置 → AI」中启用并填写 API Key。');
  }

  const { payload, content } = await chatCompletion(config, options.body, options, 120_000);
  const parsed = outputSchema.safeParse(extractJson(content));
  if (!parsed.success) {
    throw new AiError('invalid_response', 'AI 返回的画像结构不符合要求');
  }
  return {
    output: parsed.data,
    provider: config.provider,
    model: config.model,
    usage: { promptTokens: payload.usage?.prompt_tokens ?? null, completionTokens: payload.usage?.completion_tokens ?? null },
  };
}

/* ------------------------------------------------------- 简介日译中 */

export interface TranslateOptions extends TransportOptions {
  config: AiConfig;
  /** 要翻译的原文（一手资料，只读） */
  source: string;
  /** 原文语言代码（ja / en / ko / other），用于选择提示词中的语言说明 */
  sourceLanguage?: string;
  /** 作品名，仅用于让模型统一专有名词，不参与翻译输出结构 */
  subjectName?: string;
}

export interface TranslateResult {
  text: string;
  provider: string;
  model: string;
  usage: { promptTokens: number | null; completionTokens: number | null };
}

/** 源语言的提示词描述：所有可翻译语言共用同一套约束，只有语言名不同。 */
const SOURCE_LANGUAGE_LABEL: Record<string, string> = {
  ja: '日文',
  en: '英文',
  ko: '韩文',
  other: '外文',
};

/** 简介翻译的系统提示：约束只能翻译，禁止扩写与解释。 */
export function buildTranslationPrompt(
  subjectName?: string,
  sourceLanguage = 'ja',
): { system: string; user: (source: string) => string } {
  const languageLabel = SOURCE_LANGUAGE_LABEL[sourceLanguage] ?? '外文';
  const system = [
    `你是一位专业的动画作品简介译者，负责把${languageLabel}简介翻译成简体中文。`,
    '',
    '硬性规则（必须遵守）：',
    '1. 只做翻译。不得添加原文没有的信息，不得删除原文的重要信息，不得扩写剧情，不得解释或评论。',
    '2. 专有名词保持一致：人名、作品名、机构名按动画圈通行译名翻译，首次出现时可在括号内保留原语言原名。',
    '3. 保留原文的分段结构，不要合并成一段。',
    '4. 不要输出「以下是翻译」「译文」「翻译如下」之类的说明，也不要输出 Markdown 代码块。',
    '5. 直接输出简体中文译文正文本身。',
    '6. 若原文中包含制作人员、放送信息等事实，按原文照译，不要补充你已知的其他信息。',
    subjectName ? `7. 本条目名称为「${subjectName}」，翻译时请使用该名称的通行中文译名。` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const user = (source: string): string =>
    [
      TRANSLATION_MARKER,
      '----- 原文开始 -----',
      source,
      '----- 原文结束 -----',
      '',
      '请直接输出简体中文译文，不要任何额外说明。',
    ].join('\n');

  return { system, user };
}

/**
 * 日文简介 → 简体中文。
 * 与画像 AI 共用同一套 provider 配置（Base URL / API Key / Model / Provider），
 * 但使用独立的提示词与输出校验，输出为纯文本而非 JSON。
 */
export async function translateSummary(options: TranslateOptions): Promise<TranslateResult> {
  const { config, source } = options;
  if (!config.enabled || !config.apiKey) {
    throw new AiError('disabled', 'AI 未启用', '请在「设置 → AI」中启用并填写 API Key，之后队列会自动继续。');
  }
  if (!source.trim()) {
    throw new AiError('invalid_response', '原文为空，无法翻译');
  }

  const prompt = buildTranslationPrompt(options.subjectName, options.sourceLanguage ?? 'ja');
  const { payload, content } = await chatCompletion(config, {
    model: config.model, stream: false,
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user(source) }],
    temperature: 0.2,
  }, options, 60_000);
  return {
    text: content, provider: config.provider, model: config.model,
    usage: { promptTokens: payload.usage?.prompt_tokens ?? null, completionTokens: payload.usage?.completion_tokens ?? null },
  };
}
