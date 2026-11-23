/**
 * 简介语言识别、结构解析与翻译策略（前后端共用）。
 *
 * 真实数据形态（v1.4.0 全量统计确认）：
 *   1. 官方中文；
 *   2. 日文原文 + `[中文简介]` 分隔标记 + 官方中文（混合双语）；
 *   3. 纯日文；
 *   4. 其他语言（英文、韩文，以及少量无法确定语言的短文本）；
 *   5. 无简介。
 *
 * 处理规则抽象成「检测 → 分类 → 策略」三段，不再把语言硬编码进业务逻辑：
 *   - zh      → 官方中文，直接用，不调用 AI；
 *   - ja/en/ko/other（可识别的非中文语言）→ 进入统一翻译队列，AI 译成中文；
 *   - unknown → 无法可靠识别，保留原文，默认不调用 AI；
 *   - empty   → 没有简介。
 * 新增语言只需扩展 `detectSummaryLanguage` 与 `LANGUAGE_LABEL`，队列与展示无需改动。
 *
 * 识别只依赖字符类别与少量高频虚词（无词典、无网络），
 * 保证同一段文本在任何时候都得到同一结论（结果入库并参与 hash 去重）。
 */

export type SummaryLanguage = 'zh' | 'ja' | 'en' | 'ko' | 'other' | 'unknown' | 'empty';

export const LANGUAGE_LABEL: Record<SummaryLanguage, string> = {
  zh: '中文',
  ja: '日文',
  en: '英文',
  ko: '韩文',
  other: '其他语言',
  unknown: '无法识别',
  empty: '无',
};

export interface SummaryLanguageStats {
  language: SummaryLanguage;
  kanaCount: number;
  cjkCount: number;
  /** 假名占「假名 + 汉字」的比例 */
  kanaRatio: number;
  /** 命中的日语功能词数量 */
  particleCount: number;
  /** 命中的中文专属用字数量（日文不使用的简化字等） */
  chineseOnlyCount: number;
  latinCount: number;
  hangulCount: number;
}

/** 判定日文所需的最少假名数量 */
export const KANA_MIN_COUNT = 8;
/** 假名占「汉字 + 假名」的比例下限 */
export const KANA_MIN_RATIO = 0.12;
/** 日文片段所需的最少日语功能词 */
export const JAPANESE_PARTICLE_MIN = 3;
/** 日文片段中假名的比例下限 */
export const JAPANESE_SEGMENT_RATIO = 0.2;
/** 假名密度达到该值可直接判为日文 */
export const JAPANESE_STRONG_RATIO = 0.4;
/** 日语功能词密度（功能词 / 「假名 + 汉字」）：日文正文实测 ≥ 0.13，中文简介 ≤ 0.10 */
export const JAPANESE_PARTICLE_DENSITY = 0.1;
/** 中文虚词密度下限 */
export const CHINESE_MARKER_RATIO = 0.03;
/** 出现中文专属用字、或中文虚词密度达到该值时，视为「有中文证据」 */
export const CHINESE_EVIDENCE_RATIO = 0.05;

const KANA_PATTERN = /[\u3040-\u309F\u30A0-\u30FF]/g;
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const LATIN_PATTERN = /[A-Za-z]/g;
const HANGUL_PATTERN = /[\uAC00-\uD7AF\u1100-\u11FF]/g;
/** 其他文字系统：西里尔 / 阿拉伯 / 泰文 / 天城文 / 希腊文 / 希伯来文 */
const OTHER_SCRIPT_PATTERN =
  /[\u0400-\u04FF\u0600-\u06FF\u0E00-\u0E7F\u0900-\u097F\u0370-\u03FF\u0590-\u05FF]/g;

/*
 * 日语功能词：助词与助动词。
 * 中文简介里的假名几乎全部来自人名 / 作品名（「泉こなた」「柊つかさ」），
 * 不会出现这些功能词，因此它们是把「中文夹日文名」与「日文正文」区分开的关键。
 * 必须包含 は（最常用的助词）与句末助词（ね / よ / か / ぞ / ぜ）。
 */
const JAPANESE_PARTICLE_PATTERN =
  /[をがにでとへやものはねよかぞぜ]|です|ます|した|する|して|いる|ある|ている|でした|ません|から|まで|より|など|という|によって/g;

/*
 * 中文专属用字：这些简化字在现代日文里不使用，
 * 一旦出现基本可以判定是中文（用于「汉字为主 + 少量假名」的场景）。
 * 选择时排除了中日共用字（例如 与 / 无 / 当 / 后 / 里 / 点 / 现）。
 */
const CHINESE_ONLY_PATTERN =
  /[们这说过从没让时话认请谁么样边车见头长门马鸟风飞义乐书买卖电兴习乡亲亿众优传伤价单对将儿]/g;

/** 中文虚词用字：密度用于判断「汉字为主 + 少量假名」的段落 */
const CHINESE_MARKER_PATTERN = /[的了是在那们就都也很和说过从并没你他她它]/g;

function rawStats(value: string): { kanaCount: number; cjkCount: number; kanaRatio: number } {
  const kanaCount = (value.match(KANA_PATTERN) ?? []).length;
  const cjkCount = (value.match(CJK_PATTERN) ?? []).length;
  const total = kanaCount + cjkCount;
  return { kanaCount, cjkCount, kanaRatio: total === 0 ? 0 : kanaCount / total };
}

function chineseMarkerRatio(value: string): number {
  const markers = (value.match(CHINESE_MARKER_PATTERN) ?? []).length;
  const { kanaCount, cjkCount } = rawStats(value);
  const total = kanaCount + cjkCount;
  return total === 0 ? 0 : markers / total;
}

/** 是否属于「以中文为主」的正文。 */
export function isChineseText(text: string): boolean {
  return detectSummaryLanguage(text).language === 'zh';
}

/**
 * 判断「AI 译文是否算中文」。
 *
 * 比 `isChineseText` 宽松：译文里保留原语言的专有名词（人名 / 作品名）是正常现象，
 * 例如「内容是冷饭《よりぬき銀魂さん》（银魂精选集）精选集重播加新作动画」——
 * 这是合格的中文译文，只是夹了一个日文标题。因此这里只看
 * 「汉字足够多 + 假名密度不高」，而不是要求整段被判定为纯中文。
 */
export function isChineseTranslationText(text: string): boolean {
  const { kanaCount, cjkCount, kanaRatio } = rawStats(text);
  if (cjkCount < 6) return false;
  if (kanaRatio >= 0.3) return false;
  // 假名数量本身也不应过多（避免「一句话中文 + 一整段日文」）
  return kanaCount <= Math.max(12, cjkCount * 0.4);
}

/**
 * 翻译策略：所有能可靠识别的非中文语言都进入统一翻译链路；
 * 无法识别语言时保留原文且不调用 AI（不为了「支持更多语言」而强行判定）。
 */
export function translationStrategy(language: SummaryLanguage): {
  translate: boolean;
  reason: string;
} {
  switch (language) {
    case 'zh':
      return { translate: false, reason: '官方中文简介，无需翻译' };
    case 'ja':
    case 'en':
    case 'ko':
    case 'other':
      return { translate: true, reason: '' };
    case 'empty':
      return { translate: false, reason: '没有简介' };
    default:
      return { translate: false, reason: '暂无法识别语言，已保留原文（未调用 AI）' };
  }
}

/**
 * 判断一个「片段」是否是日文正文。
 * 只有假名比例足够高、且出现足够多日语功能词的片段才算日文。
 */
function isJapaneseSegment(segment: string): boolean {
  const { kanaCount, kanaRatio } = rawStats(segment);
  if (kanaCount < KANA_MIN_COUNT) return false;
  if (kanaRatio < JAPANESE_SEGMENT_RATIO) return false;
  const particles = (segment.match(JAPANESE_PARTICLE_PATTERN) ?? []).length;
  return particles >= JAPANESE_PARTICLE_MIN;
}

/**
 * 片段级语言倾向：按长度加权投票，解决「中文简介里塞满日文专有名词」
 * 与「日文正文里夹中文引用」在整段比例上难以区分的问题。
 *
 * - 片段里出现中文专属用字 / 中文虚词密集 → 判为中文片段；
 * - 片段里有假名且出现日语功能词、假名比例够高 → 判为日文片段；
 * - 其余（例如只剩汉字的人名、数字、拉丁字母）→ 中性，不投票。
 */
function segmentKind(segment: string): 'ja' | 'zh' | 'neutral' {
  const { kanaCount, kanaRatio } = rawStats(segment);
  const chineseOnly = (segment.match(CHINESE_ONLY_PATTERN) ?? []).length;
  const markerRatio = chineseMarkerRatio(segment);
  if (chineseOnly >= 1 || markerRatio >= 0.08) return 'zh';

  const particles = (segment.match(JAPANESE_PARTICLE_PATTERN) ?? []).length;
  if (kanaCount >= 3 && particles >= 1 && kanaRatio >= 0.2) return 'ja';
  if (kanaCount >= 6 && kanaRatio >= 0.15) return 'ja';
  return 'neutral';
}

/**
 * 识别简介语言。
 *
 * 判定顺序（先强信号，后兜底）：
 *   1. 空文本；
 *   2. 韩文（谚文）；
 *   3. 日文：日语功能词 + 假名比例，或假名密度直接达标，或日文片段占多数；
 *   4. 中文：中文专属用字 / 无假名且汉字足够 / 中文虚词密度 / 汉字为主且假名很少；
 *   5. 英文与其他文字系统；
 *   6. 其余为「无法识别」。
 */
export function detectSummaryLanguage(text: string | null | undefined): SummaryLanguageStats {
  const value = (text ?? '').trim();
  const { kanaCount, cjkCount, kanaRatio } = rawStats(value);
  const particleCount = (value.match(JAPANESE_PARTICLE_PATTERN) ?? []).length;
  const chineseOnlyCount = (value.match(CHINESE_ONLY_PATTERN) ?? []).length;
  const latinCount = (value.match(LATIN_PATTERN) ?? []).length;
  const hangulCount = (value.match(HANGUL_PATTERN) ?? []).length;
  const base: SummaryLanguageStats = {
    language: "empty",
    kanaCount,
    cjkCount,
    kanaRatio,
    particleCount,
    chineseOnlyCount,
    latinCount,
    hangulCount,
  };
  if (!value) return base;

  // 2. 韩文
  if (hangulCount >= 5) return { ...base, language: "ko" };

  const markerRatio = chineseMarkerRatio(value);
  const visible = value.replace(/\s/g, "").length;
  const particleDensity = cjkCount + kanaCount === 0 ? 0 : particleCount / (cjkCount + kanaCount);
  /*
   * 有明确的中文证据（中文专属用字或中文虚词密度达标）时不允许判成日文，
   * 这样「中文简介里夹日文专有名词」不会被误判成日文。
   * 反过来，日文正文里夹中文引用（假名密度很高）仍会先被日文规则命中。
   */
  const hasChineseEvidence = chineseOnlyCount >= 1 || markerRatio >= CHINESE_EVIDENCE_RATIO;

  // 3. 日文：先判日文，避免「日文正文里夹中文引用」被当成中文
  const segments = value
    .split(/[。！？!?\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  /*
   * 片段级投票（按长度加权）：
   * 中文简介里常出现大量日文专有名词，日文正文里也可能夹中文引用，
   * 只看整段字符比例无法区分；逐句判断更接近人类阅读时的判断方式。
   */
  let japaneseWeight = 0;
  let chineseWeight = 0;
  for (const segment of segments) {
    const kind = segmentKind(segment);
    if (kind === 'ja') japaneseWeight += segment.length;
    else if (kind === 'zh') chineseWeight += segment.length;
  }
  const japaneseDominant = japaneseWeight >= 20 && japaneseWeight >= chineseWeight;
  const chineseDominant = chineseWeight >= 20 && chineseWeight > japaneseWeight;

  const japaneseSegments = segments.filter((segment) => isJapaneseSegment(segment)).length;
  const segmentRatio = segments.length === 0 ? 0 : japaneseSegments / segments.length;
  const looksJapanese =
    // 片段级投票：日文句子占多数（按长度）→ 日文
    japaneseDominant ||
    // 强信号：假名密度很高，一定是日文正文
    (kanaCount >= 20 && kanaRatio >= JAPANESE_STRONG_RATIO && !chineseDominant) ||
    // 正常日文：假名 + 功能词都足够，且没有中文证据
    (kanaCount >= KANA_MIN_COUNT &&
      particleCount >= JAPANESE_PARTICLE_MIN &&
      particleDensity >= JAPANESE_PARTICLE_DENSITY &&
      !hasChineseEvidence) ||
    // 短日文（例如只有几行特典信息）
    (kanaCount >= 10 &&
      particleCount >= 5 &&
      particleDensity >= JAPANESE_PARTICLE_DENSITY * 0.6 &&
      !hasChineseEvidence) ||
    // 极短混排：假名很少但出现了日语功能词，且没有任何中文证据
    (kanaCount >= 1 &&
      particleCount >= 1 &&
      kanaRatio >= 0.06 &&
      cjkCount < 40 &&
      chineseOnlyCount === 0 &&
      markerRatio < CHINESE_MARKER_RATIO) ||
    // 片段级：日文片段占多数
    (japaneseSegments > 0 && segmentRatio >= 0.5);
  if (looksJapanese) return { ...base, language: "ja" };

  // 4. 中文
  const looksChinese =
    // 片段级投票：中文句子占多数（按长度）→ 中文
    chineseDominant ||
    (kanaCount === 0 && cjkCount >= 6) ||
    (chineseOnlyCount >= 1 && kanaRatio < 0.35) ||
    (markerRatio >= CHINESE_MARKER_RATIO && kanaRatio < 0.35) ||
    (cjkCount >= 10 && kanaRatio < 0.2) ||
    (cjkCount >= 6 && kanaRatio < 0.15);
  if (looksChinese) return { ...base, language: "zh" };

  // 5. 英文与其他文字系统
  if (latinCount >= 20 && visible > 0 && latinCount / visible >= 0.5) {
    return { ...base, language: "en" };
  }
  if ((value.match(OTHER_SCRIPT_PATTERN) ?? []).length >= 10) {
    return { ...base, language: "other" };
  }

  // 6. 无法可靠识别：保留原文，不调用 AI
  return { ...base, language: "unknown" };
}

export interface SummarySegments {
  /** 完整的原始 summary（一手数据，永远不修改） */
  raw: string;
  /** 中文部分：官方中文简介（纯中文 summary 或混合格式中的中文段落） */
  chinese: string;
  /** 原文快照：非中文部分；纯中文简介时为空 */
  original: string;
  /** 中文是否来自 Bangumi 官方（而不是 AI 翻译） */
  officialChinese: boolean;
  /** 命中的分隔标记（调试 / 说明用，界面不显示） */
  marker: string;
}

/**
 * 分隔标记（整行独占）。真实数据存在**两种顺序相反**的双语格式：
 *
 *   A. 原文在前：`日文原文` + `[中文简介]` + `中文`   （实测 4 条）
 *   B. 原文在后：`中文` + `[简介原文]` + `日文原文`   （实测 43 条）
 *
 * 两种标记分别用下面两个正则识别，并且都要求整行只有标记本身，
 * 避免误切正文里出现的「中文简介」「原文」等字样。
 */
const CHINESE_AFTER_MARKER =
  /^[ \t]*(?:[\[【（(〔［]\s*(?:简体)?中文(?:简介|介绍|概要|说明|翻译|版)?\s*[\]】）)〕］]|(?:简体)?中文(?:简介|介绍|概要|说明|翻译|版)\s*[:：])[ \t]*$/gmu;
/** 原文在后：`[简介原文]` / `[原文]` / `[日文原文]` / `原文：` 等 */
const ORIGINAL_AFTER_MARKER =
  /^[ \t]*(?:[\[【（(〔［]\s*(?:简介)?(?:原文|原版简介|日文原文|日文简介|原文简介)\s*[\]】）)〕］]|(?:简介)?(?:原文|日文原文|日文简介)\s*[:：])[ \t]*$/gmu;

/** 中文正文判定：用于确认分隔标记后半段确实是中文。 */
function looksChinese(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  const stats = detectSummaryLanguage(value);
  return stats.language === "zh";
}

/**
 * 原文段判定：必须是「可识别的非中文语言」。
 * 只要求「不是中文、且能识别出语言」，因此英文 / 韩文等双语结构同样可拆；
 * 无法识别的文本不会命中，保证「宁可不拆，也不误拆」。
 */
function looksForeignText(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  const stats = detectSummaryLanguage(value);
  return stats.language !== "zh" && stats.language !== "unknown" && stats.language !== "empty";
}

/**
 * 解析 Bangumi 的 summary 结构。
 *
 * 解析是**保守**的：只有「标记整行独占」+「标记前是可识别的非中文原文」+
 * 「标记后是中文」三个条件同时满足才拆分；任何一条不满足就整体当作原文，
 * 绝不因为解析判断而修改一手数据。
 */
export function parseSummarySegments(summary: string | null | undefined): SummarySegments | null {
  const raw = (summary ?? "").trim();
  if (!raw) return null;

  let sawSectionMarker = false;

  // 变体 A：原文在前 + `[中文简介]` + 中文
  for (const match of raw.matchAll(CHINESE_AFTER_MARKER)) {
    const index = match.index ?? 0;
    const head = raw.slice(0, index).trim();
    const tail = raw.slice(index + match[0].length).trim();
    if (head.length > 0) sawSectionMarker = true;
    if (!looksForeignText(head) || !looksChinese(tail)) continue;
    return { raw, chinese: tail, original: head, officialChinese: true, marker: match[0].trim() };
  }

  // 变体 B：中文在前 + `[简介原文]` + 原文
  for (const match of raw.matchAll(ORIGINAL_AFTER_MARKER)) {
    const index = match.index ?? 0;
    const head = raw.slice(0, index).trim();
    const tail = raw.slice(index + match[0].length).trim();
    if (head.length > 0) sawSectionMarker = true;
    if (!looksChinese(head) || !looksForeignText(tail)) continue;
    return { raw, chinese: head, original: tail, officialChinese: true, marker: match[0].trim() };
  }

  /*
   * 出现分隔标记但结构无法高置信度确认（例如前后都是中文、或前半段语言无法识别）：
   * 整段按原文处理，不把它当作官方中文，避免把两种内容混在一起展示。
   */
  if (sawSectionMarker) {
    return { raw, chinese: "", original: raw, officialChinese: false, marker: "" };
  }

  // 没有分隔标记：整段要么是中文（官方中文简介），要么是外文原文
  if (looksChinese(raw)) {
    return { raw, chinese: raw, original: "", officialChinese: true, marker: "" };
  }
  return { raw, chinese: "", original: raw, officialChinese: false, marker: "" };
}

/**
 * 原文指纹：用于「原文没变就不重复翻译」。
 * 归一化（去首尾空白、统一换行）后计算，避免 Bangumi 只改排版就触发重译。
 */
export function normalizeSummaryForHash(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export const TRANSLATION_STATUS = {
  /** 不需要翻译（官方中文 / 无简介 / 语言无法识别） */
  Idle: 'idle',
  /** 已入队，等待处理 */
  Pending: 'pending',
  /** 正在翻译 */
  Processing: 'processing',
  /** 翻译完成 */
  Completed: 'completed',
  /** 重试耗尽，需要人工介入 */
  Failed: 'failed',
  /** AI 未配置 / 认证失败，等待配置后继续 */
  WaitingAi: 'waiting_ai',
} as const;

export type TranslationStatus = (typeof TRANSLATION_STATUS)[keyof typeof TRANSLATION_STATUS];

export const TRANSLATION_STATUS_LABEL: Record<TranslationStatus, string> = {
  idle: '无需翻译',
  pending: '待翻译',
  processing: '翻译中',
  completed: '已翻译',
  failed: '翻译失败',
  waiting_ai: '待配置 AI',
};

/** 翻译任务的最终状态（含历史失效任务）。 */
export type TranslationJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'waiting_ai'
  /** 原文已更新 / 已有官方中文，历史任务失效，不再参与队列 */
  | 'obsolete';

export const TRANSLATION_JOB_STATUS_LABEL: Record<TranslationJobStatus, string> = {
  pending: '待翻译',
  processing: '翻译中',
  completed: '已翻译',
  failed: '翻译失败',
  waiting_ai: '待配置 AI',
  obsolete: '历史失效任务',
};

/** 中文简介的来源：Bangumi 官方中文，或本地 AI 翻译。 */
export type SummaryChineseSource = 'bangumi' | 'ai' | 'none';

export const SUMMARY_CHINESE_SOURCE_LABEL: Record<SummaryChineseSource, string> = {
  bangumi: 'Bangumi 官方中文简介',
  ai: 'AI 翻译',
  none: '',
};

/**
 * 翻译结果清洗：模型只允许输出纯中文正文。
 * 去掉常见前后缀（「以下是翻译：」「译文：」）、Markdown 代码块与首尾引号，
 * 但**不做任何改写**——正文内容原样保留，避免把模型输出变成二次创作。
 */
export function cleanTranslationOutput(raw: string): string {
  let text = (raw ?? '').trim();
  const fenced = /^```(?:[a-zA-Z]*)\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  const prefixPatterns = [
    /^(以下是|下面是)?(中文)?(简体中文)?(翻译|译文|中文翻译)(如下|结果)?\s*[:：]?\s*/,
    /^(翻译结果|中文译文)\s*[:：]\s*/,
  ];
  for (const pattern of prefixPatterns) text = text.replace(pattern, '');

  text = text.replace(/^["“「『]+/, '').replace(/["”」』]+$/, '');
  // 压缩三个以上连续空行，保留原文的分段
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * 判断翻译结果是否可信。
 *
 * 只做「异常检测」，不做「正确性判定」：
 *   - 必须是中文正文（不能是复述原文、英文或其他语言）；
 *   - 不能过短 / 过长（长度比例只作参考，短原文不做比例限制）；
 *   - 不能是解释型回答。
 * 源语言已经从「仅日文」扩展为任意可翻译语言，因此这里不再限制源语言类型，
 * 只要求它属于「可翻译」策略。
 */
export function validateTranslationOutput(
  translated: string,
  source: string,
): { ok: true } | { ok: false; reason: string } {
  const text = translated.trim();
  if (!text) return { ok: false, reason: '翻译结果为空' };

  const sourceStats = detectSummaryLanguage(source);
  const strategy = translationStrategy(sourceStats.language);
  if (!strategy.translate) {
    return { ok: false, reason: `原文语言（${sourceStats.language}）不在自动翻译范围内` };
  }

  if (!isChineseTranslationText(text)) {
    return { ok: false, reason: '翻译结果不是中文正文（可能只是复述原文或输出了其他语言）' };
  }
  if (text.length < 6) return { ok: false, reason: `翻译结果过短（${text.length} 字）` };

  // 长度只作异常参考：短原文不设比例下限，避免把简洁译文误判为异常
  if (source.length >= 60) {
    const minLength = Math.max(6, Math.floor(source.length * 0.15));
    if (text.length < minLength) {
      return { ok: false, reason: `翻译结果明显偏短（${text.length} 字，原文 ${source.length} 字）` };
    }
  }
  const maxLength = Math.ceil(source.length * 4) + 400;
  if (text.length > maxLength) {
    return { ok: false, reason: `翻译结果明显偏长（${text.length} 字，原文 ${source.length} 字）` };
  }

  // 明显的“解释型”开头（不属于简介正文）
  if (/^(这段|该|以下).{0,6}(介绍|作品|动画|剧情|简介)/.test(text)) {
    return { ok: false, reason: '翻译结果看起来是解释而不是译文' };
  }
  return { ok: true };
}
