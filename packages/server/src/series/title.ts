/**
 * Canonical / display title 解析。
 *
 * 三层语义：
 * - identity：由 db/series 的实体对账维护，与本文件无关；
 * - canonical title：只有 resolved / manual 属于事实，重算只允许提出 proposal；
 * - display title：provisional / unresolved / contested 状态下的「当前最佳展示名」，
 *   允许随更强的新证据重新选择 —— 暂定不等于永久锁死一个候选。
 *
 * 候选处理流水线：生成 → 结构质量校验 → 跨来源共识归并 → 选出当前最佳展示名。
 * 低质量候选不会主导展示，但会保留在候选列表里用于解释。
 */

export type TitleState = 'resolved' | 'provisional' | 'unresolved' | 'contested' | 'manual';

export interface TitleCandidate {
  title: string;
  source: string;
  state: TitleState;
  evidence: string;
  /** 结构质量校验结果；false 表示不参与展示竞争 */
  valid: boolean;
  /** 被否决的原因（valid=false 时给出，用于 explainability） */
  rejectReason?: string;
  /** 支持该候选的成员数 */
  support: number;
  /** support / 成员总数 */
  coverage: number;
}

export interface ExistingTitle {
  title: string;
  state: TitleState;
  source: string;
}

export interface TitleMember {
  title: string;
  /** 核心成员（起点 / 连续性 / 同一作品体派生）才有资格定义系列品牌 */
  core: boolean;
  tags: string[];
}

export interface ResolveTitleInput {
  members: TitleMember[];
  tagFrequency: Map<string, number>;
  rareTagLimit: number;
  isExcludedTag: (tag: string) => boolean;
  anchorTitle: string | null;
  singleton: boolean;
  fallbackLabel: string;
  existing?: ExistingTitle | null;
}

export interface TitleResolution {
  title: string;
  state: TitleState;
  source: string;
  candidates: TitleCandidate[];
  /** 与已确立（resolved/manual）名称冲突、值得人工复核的候选 */
  proposed: TitleCandidate | null;
  /** 本次解析是否改变了非锁定状态的展示名 */
  changed: boolean;
}

/* ------------------------------------------------------------ 文本规范化 */

const FORMAT_PREFIXES = [
  '剧场总集篇',
  '剧场版',
  '劇場版',
  '电影',
  '映画',
  '剧场',
  '劇場',
  '总集篇',
  '総集編',
  '特别篇',
  '特別篇',
  'OVA',
  'OAD',
  'WEB',
  'Web',
  'TV',
];

const TRAILING_FORMAT = /(?:剧场版|劇場版|电影|映画|总集篇|総集編|特别篇|特別篇|OVA|OAD|WEB)$/i;
const SEASON_MARKER =
  /(?:第\s*[0-9一二三四五六七八九十]{1,3}\s*[季期部篇]|第\s*[0-9]{1,3}\s*シリーズ|season\s*\d{1,2}|part\s*\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+season)/i;
const TAIL_PUNCTUATION = /[\s:：·・\-–—~～!！?？.,，。、'"“”‘’/／\\×✕]+$/;
const TAIL_ORDINAL = /[\s:：·・\-–—]*(?:第\s*[0-9一二三四五六七八九十]{0,3}|\d{1,3})\s*$/;
const TAIL_PARTICLE = /[\s:：·・\-–—]*[的之与和]\s*$/;
/** 尾部的 1–2 个拉丁/数字短记号（如「… Re」「… II」）不是系列名的一部分 */
const TAIL_SHORT_TOKEN = /^(.*?)[\s:：·・\-–—]+[A-Za-z0-9]{1,2}$/;
const SUBTITLE_SEPARATOR = /[：:～~—–·・]/;
const DASH_TAIL = /[\-–—·・]\s*.{0,1}$/;
const TAIL_CONNECTOR = /[\s:：·・\-–—~～,，、]$/;

const BRACKET_PAIRS: Array<[string, string]> = [
  ['（', '）'],
  ['(', ')'],
  ['【', '】'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['〈', '〉'],
  ['[', ']'],
  ['“', '”'],
  ['‘', '’'],
];
const CLOSING_TO_OPENING = new Map(BRACKET_PAIRS.map(([open, close]) => [close, open]));
const OPENING_BRACKETS = new Set(BRACKET_PAIRS.map(([open]) => open));

function stripUnmatchedTrailingBrackets(value: string): string {
  let text = value;
  while (text.length > 0) {
    const last = text[text.length - 1]!;
    if (OPENING_BRACKETS.has(last)) {
      text = text.slice(0, -1).trimEnd();
      continue;
    }
    const matchingOpen = CLOSING_TO_OPENING.get(last);
    if (matchingOpen) {
      // 仅当尾部闭合括号在串内没有配对开括号时才剥离，避免把「(※似乎可行？)」的「)」误删导致括号失衡
      let depth = 0;
      for (const ch of text) {
        if (ch === matchingOpen) depth += 1;
        else if (ch === last) depth -= 1;
      }
      if (depth < 0) {
        text = text.slice(0, -1).trimEnd();
        continue;
      }
    }
    break;
  }
  return text;
}

function normalizeTitle(value: string): string {
  let text = (value ?? '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of FORMAT_PREFIXES) {
      if (text.startsWith(prefix)) {
        text = text.slice(prefix.length).trim();
        changed = true;
      }
    }
  }
  return text;
}

/** 去掉季度 / 集数 / 格式尾巴，得到可比较的品牌形态。 */
function cleanBrand(value: string): string {
  let text = value.trim();
  for (let i = 0; i < 4; i += 1) {
    const before = text;
    text = stripUnmatchedTrailingBrackets(
      text
        .replace(TAIL_PUNCTUATION, '')
        .replace(TAIL_ORDINAL, '')
        .replace(TAIL_PARTICLE, '')
        .replace(SEASON_MARKER_TRAIL, '')
        .replace(TRAILING_FORMAT, '')
        .trim(),
    );
    if (text === before) break;
  }
  const shortToken = TAIL_SHORT_TOKEN.exec(text);
  if (shortToken) {
    const head = (shortToken[1] ?? '').trim();
    const cjk = (head.match(/[\u3400-\u9fff\u3040-\u30ff]/g) ?? []).length;
    const compact = head.replace(/[\s\p{P}]/gu, '');
    // 仅当剩余部分本身已经是像样的品牌时才剥离（避免把 K-ON 误伤成 K）
    if (cjk >= 3 || compact.length >= 5) text = head;
  }
  const separator = SUBTITLE_SEPARATOR.exec(text);
  if (separator && separator.index > 0) {
    const head = text.slice(0, separator.index).trim();
    const cjk = (head.match(/[\u3400-\u9fff\u3040-\u30ff]/g) ?? []).length;
    const latin = (head.match(/[A-Za-z]/g) ?? []).length;
    if (cjk >= 3 || latin >= 5) {
      text = stripUnmatchedTrailingBrackets(head.replace(TAIL_PUNCTUATION, '').trim());
    }
  }
  return text;
}

/** 尾部季度标记（允许后面跟着副标题，如「第四季 丧失篇」）。 */
const SEASON_MARKER_TRAIL = new RegExp(
  `[\\s:：·・\\-–—]*(?:第\\s*[0-9一二三四五六七八九十]{1,3}\\s*[季期部篇]|第\\s*[0-9]{1,3}\\s*シリーズ|season\\s*\\d{1,2}|part\\s*\\d{1,2})(?:\\s.*)?$`,
  'i',
);

function brandLengthValid(value: string): boolean {
  const cjk = (value.match(/[\u3400-\u9fff\u3040-\u30ff]/g) ?? []).length;
  if (cjk >= 2) return true;
  const compact = value.replace(/[\s\p{P}]/gu, '');
  if (/^(tv|web|ova|oad|sp|cm|pv|op|ed|part|cour)$/i.test(compact)) return false;
  // 纯拉丁短名（AIR / K / Z 等）同样可以是正式系列名：放宽到 2 个字符
  return compact.length >= 2;
}

function commonPrefix(a: string, b: string): string {
  const length = Math.min(a.length, b.length);
  let index = 0;
  while (index < length && a[index] === b[index]) index += 1;
  return a.slice(0, index);
}

function normalizeForCompare(value: string): string {
  return (value ?? '').toLowerCase().replace(/[\s\p{P}]/gu, '');
}

/* --------------------------------------------------------- 候选结构校验 */

export interface CandidateValidity {
  valid: boolean;
  reason?: string;
}

/** 通用结构校验：截断、未闭合括号、季度/格式残片、泛化短前缀。 */
export function validateCandidateStructure(title: string): CandidateValidity {
  const text = (title ?? '').trim();
  if (!text) return { valid: false, reason: '空候选' };
  if (!brandLengthValid(text)) return { valid: false, reason: '过短，缺乏系列名语义' };

  const stack: string[] = [];
  for (const char of text) {
    if (OPENING_BRACKETS.has(char)) {
      stack.push(char);
      continue;
    }
    const opening = CLOSING_TO_OPENING.get(char);
    if (!opening) continue;
    if (stack.pop() !== opening) return { valid: false, reason: '括号 / 引号不成对' };
  }
  if (stack.length > 0) return { valid: false, reason: '括号 / 引号未闭合' };

  if (DASH_TAIL.test(text)) return { valid: false, reason: '疑似截断（分隔符后内容不完整）' };
  if (TAIL_CONNECTOR.test(text)) return { valid: false, reason: '疑似截断（以连接词结尾）' };
  if (SEASON_MARKER.test(text)) return { valid: false, reason: '包含季度 / 集数标记，未形成系列名' };
  if (TRAILING_FORMAT.test(text)) return { valid: false, reason: '以放送形态结尾，不是系列名' };
  return { valid: true };
}

/* ------------------------------------------------------------- 候选生成 */

export interface BrandFromTitles {
  title: string;
  hits: number;
  total: number;
}

function compactSpace(value: string): string {
  return (value ?? '').replace(/[\s\u3000]+/g, '');
}

function trimIncompleteLatinTail(prefix: string, a: string, b: string): string {
  // 若公共前缀在拉丁字母/数字词中或缩写点处截断（如「攻壳机动队 STAND...」与「攻壳机动队 S.A.C.」公共前缀「攻壳机动队S」），
  // 回退该未闭合拉丁片段，避免产出「攻壳机动队S」这类半个 token 的品牌名。
  let text = prefix;
  const nextA = a[text.length] ?? '';
  const nextB = b[text.length] ?? '';
  const continuesLatin = /[A-Za-z0-9.．_]/.test(nextA) || /[A-Za-z0-9.．_]/.test(nextB);
  if (continuesLatin && /[A-Za-z0-9]$/.test(text)) {
    text = text.replace(/[A-Za-z0-9]+$/, '');
  }
  return text;
}

/** 从成员标题中提取「多数成员共享的品牌前缀」；提取失败返回 null。 */
export function computeBrandFromTitles(titles: string[]): BrandFromTitles | null {
  const cleaned = titles
    .map((title) => normalizeTitle(title))
    .map((title) => title.trim())
    .filter((title) => title.length > 0);
  if (cleaned.length < 2) return null;

  const compactCleaned = cleaned.map((title) => compactSpace(title));
  const counts = new Map<string, number>();
  const addCandidate = (rawPrefix: string) => {
    const brand = cleanBrand(rawPrefix);
    if (!brand || !brandLengthValid(brand)) return;
    if (!validateCandidateStructure(brand).valid) return;
    counts.set(brand, (counts.get(brand) ?? 0) + 1);
  };
  for (let i = 0; i < cleaned.length; i += 1) {
    for (let j = i + 1; j < cleaned.length; j += 1) {
      const rawPref = trimIncompleteLatinTail(
        commonPrefix(cleaned[i]!, cleaned[j]!),
        cleaned[i]!,
        cleaned[j]!,
      );
      addCandidate(rawPref);
      // 容忍仅空格差异（如「天元突破 红莲螺岩」与「天元突破红莲螺岩」）
      const compactPref = trimIncompleteLatinTail(
        commonPrefix(compactCleaned[i]!, compactCleaned[j]!),
        compactCleaned[i]!,
        compactCleaned[j]!,
      );
      if (compactPref.length >= 2) {
        addCandidate(compactPref);
      }
    }
  }
  if (counts.size === 0) return null;

  const required = Math.max(2, Math.ceil(cleaned.length * 0.5));
  // 按去空格形态去重，保留更贴近原始标题写法（带空格/完整标点）的代表形态
  const byCompact = new Map<string, { brand: string; hits: number; exactHits: number }>();
  for (const brand of counts.keys()) {
    const cb = compactSpace(brand);
    const hits = compactCleaned.filter((title) => title.startsWith(cb)).length;
    if (hits < required) continue;
    const exactHits = cleaned.filter((title) => title.startsWith(brand)).length;
    const existing = byCompact.get(cb);
    if (
      !existing ||
      exactHits > existing.exactHits ||
      (exactHits === existing.exactHits && brand.length > existing.brand.length)
    ) {
      byCompact.set(cb, { brand, hits, exactHits });
    }
  }
  const pool = [...byCompact.values()];
  if (pool.length === 0) return null;

  // 若较长候选只是某子篇章前缀（如「少女与战车 最终章」5/10），而其基础品牌（「少女与战车」10/10）
  // 覆盖了显著更多核心成员，则基础品牌优先；若覆盖率接近（如「机动战士高达」7/8 vs「机动战士」8/8），
  // 仍保留更具辨识度的较长完整品牌。
  const significantGap = Math.max(2, Math.ceil(cleaned.length * 0.2));
  const ranked = pool.sort((a, b) => {
    const ca = compactSpace(a.brand);
    const cb = compactSpace(b.brand);
    if (ca !== cb && (cb.startsWith(ca) || ca.startsWith(cb))) {
      const shorter = ca.length < cb.length ? a : b;
      const longer = ca.length < cb.length ? b : a;
      const hitDiff = shorter.hits - longer.hits;
      const longerCov = longer.hits / cleaned.length;
      const shorterCov = shorter.hits / cleaned.length;
      if (hitDiff >= significantGap || (longerCov < 0.7 && shorterCov >= 0.85)) {
        return shorter === a ? -1 : 1;
      }
    }
    return (
      b.brand.length - a.brand.length ||
      b.hits - a.hits ||
      a.brand.localeCompare(b.brand, 'zh-Hans-CN')
    );
  });
  const best = ranked[0];
  if (!best) return null;
  return { title: best.brand, hits: best.hits, total: cleaned.length };
}

function normalizeTag(value: string): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s\p{P}]/gu, '');
}

/** 品牌型标签：带「系列」标记、或出现在成员标题中。 */
export function isBrandLikeTag(tag: string, memberTitles: string[]): boolean {
  const raw = (tag ?? '').trim();
  if (raw.length < 2) return false;
  if (/系列|シリーズ|project|企画|计划|プロジェクト/i.test(raw)) return true;
  const normalized = normalizeTag(raw);
  if (normalized.length < 2) return false;
  const titleHits = memberTitles.filter((title) =>
    normalizeTag(normalizeTitle(title)).includes(normalized),
  ).length;
  return titleHits >= 2;
}

export interface TagBrand {
  title: string;
  hits: number;
  frequency: number;
}

export function computeBrandFromTags(options: {
  memberTags: string[][];
  memberTitles: string[];
  tagFrequency: Map<string, number>;
  rareTagLimit: number;
  isExcludedTag: (tag: string) => boolean;
}): TagBrand | null {
  const { memberTags, memberTitles, tagFrequency, rareTagLimit, isExcludedTag } = options;
  const counts = new Map<string, number>();
  for (const tags of memberTags) {
    for (const tag of new Set(tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, hits]) => hits >= 2)
    .filter(([tag]) => !isExcludedTag(tag))
    .filter(([tag, hits]) => (tagFrequency.get(tag) ?? hits) <= rareTagLimit)
    .filter(([tag]) => isBrandLikeTag(tag, memberTitles))
    .map(([tag, hits]) => ({ tag, hits, frequency: tagFrequency.get(tag) ?? hits }))
    .sort(
      (a, b) =>
        b.hits - a.hits || b.tag.length - a.tag.length || a.tag.localeCompare(b.tag, 'zh-Hans-CN'),
    );
  const top = ranked[0];
  if (!top) return null;
  return { title: top.tag, hits: top.hits, frequency: top.frequency };
}

/* --------------------------------------------------------------- 主流程 */

interface RawCandidate {
  title: string;
  source: string;
  evidence: string;
  support: number;
}

interface CandidateGroup {
  normalized: string;
  candidates: TitleCandidate[];
  sources: Set<string>;
  maxSupport: number;
  maxTier: number;
  maxLength: number;
}

const SOURCE_TIER: Record<string, number> = {
  'brand:members': 3,
  'brand:tag': 2,
  anchor: 1,
};

const SOURCE_LABEL: Record<string, string> = {
  'brand:members': '成员标题品牌',
  'brand:tag': '稀有品牌标签',
  anchor: '起点作品标题',
};

function tierOf(source: string): number {
  return SOURCE_TIER[source] ?? 0;
}

function buildCandidates(input: ResolveTitleInput): TitleCandidate[] {
  const memberCount = Math.max(1, input.members.length);
  const titled = input.members.filter((member) => member.title.trim().length > 0);
  const core = titled.filter((member) => member.core);
  const raw: RawCandidate[] = [];

  // 1) 核心成员标题品牌：只要有带标题的核心成员，衍生成员（广播 / LIVE / 番外等）
  //    就不允许参与定义系列品牌；仅当核心成员完全没有标题时才回退到全部成员。
  const coreTitleBasis = core.length >= 2 ? core : core.length === 0 ? titled : [];
  const brandBase = coreTitleBasis;
  const brandScope = core.length >= 2 ? '核心成员' : '成员';
  const brand = computeBrandFromTitles(brandBase.map((member) => member.title));
  if (brand) {
    raw.push({
      title: brand.title,
      source: 'brand:members',
      evidence: `${brand.hits}/${brandBase.length} 个${brandScope}标题共享同一品牌前缀`,
      support: brand.hits,
    });
  }

  // 2) 稀有品牌标签：核心成员优先，缺失时回退到全部成员
  const tagBasis = core.length >= 2 ? core : core.length === 0 ? titled : core;
  const titlesForTag = tagBasis.map((member) => member.title);
  const coreTagBrand = computeBrandFromTags({
    memberTags: tagBasis.map((member) => member.tags),
    memberTitles: titlesForTag,
    tagFrequency: input.tagFrequency,
    rareTagLimit: input.rareTagLimit,
    isExcludedTag: input.isExcludedTag,
  });
  // 核心成员本身带标签却没有品牌标签时，不允许衍生成员的标签越权定义系列
  const coreHasTags = tagBasis.some((member) => member.tags.length > 0);
  const tagBrand =
    coreTagBrand ??
    (coreHasTags
      ? null
      : computeBrandFromTags({
          memberTags: titled.map((member) => member.tags),
          memberTitles: titled.map((member) => member.title),
          tagFrequency: input.tagFrequency,
          rareTagLimit: input.rareTagLimit,
          isExcludedTag: input.isExcludedTag,
        }));
  if (tagBrand) {
    raw.push({
      title: tagBrand.title,
      source: 'brand:tag',
      evidence: `成员共享稀有标签「${tagBrand.title}」（${tagBrand.hits} 个成员）`,
      support: tagBrand.hits,
    });
  }

  // 3) 锚点标题：拓扑参考，不作为事实名称
  if (input.anchorTitle && input.anchorTitle.trim()) {
    raw.push({
      title: input.anchorTitle.trim(),
      source: 'anchor',
      evidence: input.singleton ? '单成员系列直接使用作品标题' : '核心起点作品标题',
      support: 1,
    });
  }

  const seen = new Set<string>();
  const candidates: TitleCandidate[] = [];
  for (const candidate of raw) {
    const key = `${candidate.source}:${candidate.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 单成员系列的名称就是这部作品自己的标题，不存在"猜品牌"的问题
    const validity =
      input.singleton && candidate.source === 'anchor'
        ? { valid: true }
        : validateCandidateStructure(candidate.title);
    candidates.push({
      title: candidate.title,
      source: candidate.source,
      state: 'provisional',
      evidence: candidate.evidence,
      valid: validity.valid,
      ...(validity.reason ? { rejectReason: validity.reason } : {}),
      support: candidate.support,
      coverage: candidate.support / memberCount,
    });
  }

  // 泛化短前缀：如「孤独」相较于「孤独摇滚」没有系列身份语义。
  // 仅针对真正的短前缀（≤ 2 个汉字，或纯拉丁且不足 4 字符），且不误杀「本身就是某核心成员完整标题」的正牌短名（如「风筝」「鬼父」）。
  const exactCoreTitles = new Set(
    (core.length > 0 ? core : titled).map((member) => normalizeForCompare(normalizeTitle(member.title))),
  );
  for (const candidate of candidates) {
    if (!candidate.valid) continue;
    const normalized = normalizeForCompare(candidate.title);
    const cjk = (candidate.title.match(/[\u3400-\u9fff\u3040-\u30ff]/g) ?? []).length;
    const compactLen = normalized.length;
    if (cjk > 2 || (cjk === 0 && compactLen >= 4)) continue;
    if (exactCoreTitles.has(normalized)) continue;
    const longer = candidates.find((other) => {
      if (other === candidate || !other.valid) return false;
      const otherNormalized = normalizeForCompare(other.title);
      return otherNormalized.startsWith(normalized) && otherNormalized.length >= normalized.length + 2;
    });
    if (longer) {
      candidate.valid = false;
      candidate.rejectReason = `过短泛化前缀，被更完整的候选「${longer.title}」覆盖`;
    }
  }
  return candidates;
}

function groupCandidates(candidates: TitleCandidate[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  for (const candidate of candidates) {
    if (!candidate.valid) continue;
    const normalized = normalizeForCompare(candidate.title);
    const group = groups.get(normalized) ?? {
      normalized,
      candidates: [],
      sources: new Set<string>(),
      maxSupport: 0,
      maxTier: 0,
      maxLength: 0,
    };
    group.candidates.push(candidate);
    group.sources.add(candidate.source);
    group.maxSupport = Math.max(group.maxSupport, candidate.support);
    group.maxTier = Math.max(group.maxTier, tierOf(candidate.source));
    group.maxLength = Math.max(group.maxLength, candidate.title.length);
    groups.set(normalized, group);
  }
  return [...groups.values()];
}

/** 共识组内的展示形态：优先锚点写法，其次支持度最高，再取更长者。 */
function preferredVariant(group: CandidateGroup): TitleCandidate {
  const anchor = group.candidates.find((candidate) => candidate.source === 'anchor');
  if (anchor) return anchor;
  return [...group.candidates].sort(
    (a, b) =>
      b.support - a.support ||
      b.title.length - a.title.length ||
      a.title.localeCompare(b.title, 'zh-Hans-CN'),
  )[0]!;
}

function groupRank(group: CandidateGroup, memberCount: number): number[] {
  return [
    group.sources.size >= 2 ? 1 : 0,
    group.maxSupport / Math.max(1, memberCount),
    group.maxTier,
    group.maxLength,
  ];
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function consensusEvidence(group: CandidateGroup): string {
  const labels = [...group.sources]
    .sort((a, b) => tierOf(b) - tierOf(a))
    .map((source) => SOURCE_LABEL[source] ?? source);
  return `${labels.length} 类独立证据一致（${labels.join(' / ')}）`;
}

export function resolveTitle(input: ResolveTitleInput): TitleResolution {
  const memberCount = Math.max(1, input.members.length);
  const titled = input.members.filter((member) => member.title.trim().length > 0);
  const core = titled.filter((member) => member.core);
  const brandBasisCount = Math.max(
    1,
    core.length >= 2 ? core.length : core.length === 0 ? titled.length : core.length,
  );
  const taggedMemberCount = Math.max(
    1,
    input.members.filter((member) => member.tags.length > 0).length,
  );

  const candidates = buildCandidates(input);
  const valid = candidates.filter((candidate) => candidate.valid);
  const groups = groupCandidates(candidates);
  const consensus = groups.filter((group) => group.sources.size >= 2);

  let chosenGroup: CandidateGroup | null = null;
  let chosenCandidate: TitleCandidate | null = null;
  let state: TitleState = 'unresolved';
  let source = 'fallback';
  let title = input.fallbackLabel;

  if (consensus.length > 0) {
    const rankedConsensus = [...consensus].sort((a, b) =>
      compareRank(groupRank(b, memberCount), groupRank(a, memberCount)),
    );
    chosenGroup = rankedConsensus[0]!;
    const secondConsensus = rankedConsensus[1];
    const variant = preferredVariant(chosenGroup);
    // 展示形态优先采用锚点写法（官方标点更完整），来源标注最强证据层级
    const strongest = [...chosenGroup.candidates].sort(
      (a, b) => tierOf(b.source) - tierOf(a.source) || b.support - a.support,
    )[0]!;
    title = variant.title;
    source = strongest.source;
    chosenCandidate =
      chosenGroup.candidates.find(
        (candidate) => normalizeForCompare(candidate.title) === normalizeForCompare(variant.title),
      ) ?? variant;

    const bm = chosenGroup.candidates.find((c) => c.source === 'brand:members');
    const bt = chosenGroup.candidates.find((c) => c.source === 'brand:tag');
    const coverage = chosenGroup.maxSupport / memberCount;
    const coreCoverage = bm ? bm.support / brandBasisCount : 0;
    const tagCoverageOfTagged = bt ? bt.support / taggedMemberCount : 0;

    const consensusContested =
      Boolean(secondConsensus) &&
      secondConsensus!.sources.size >= chosenGroup.sources.size &&
      Math.abs(secondConsensus!.maxSupport / memberCount - coverage) < 0.1 &&
      secondConsensus!.normalized !== chosenGroup.normalized;

    const strongMembersConsensus = Boolean(bm && bm.support >= 2 && coreCoverage >= 0.6);
    const strongTagConsensus = Boolean(
      bt && (coverage >= 0.6 || (bt.support >= 3 && tagCoverageOfTagged >= 0.6 && coverage >= 0.3)),
    );

    state = consensusContested
      ? 'contested'
      : strongMembersConsensus || strongTagConsensus
        ? 'resolved'
        : 'provisional';
    variant.evidence = `${variant.evidence}；${consensusEvidence(chosenGroup)}`;
    for (const candidate of chosenGroup.candidates) {
      candidate.state = state;
    }
  } else if (valid.length > 0) {
    const sorted = [...valid].sort(
      (a, b) =>
        tierOf(b.source) - tierOf(a.source) ||
        b.coverage - a.coverage ||
        b.title.length - a.title.length ||
        a.title.localeCompare(b.title, 'zh-Hans-CN'),
    );
    const best = sorted[0]!;
    const second = sorted[1];
    title = best.title;
    source = best.source;
    chosenCandidate = best;

    const sameTierContested =
      Boolean(second) &&
      tierOf(second!.source) === tierOf(best.source) &&
      Math.abs(second!.coverage - best.coverage) < 0.1 &&
      normalizeForCompare(second!.title) !== normalizeForCompare(best.title);

    // 跨来源实质冲突：成员标题品牌覆盖偏弱（< 0.6 整体）同时存在高支持度且完全不同的稀有品牌标签
    const conflictingTag =
      best.source === 'brand:members'
        ? valid.find((c) => {
            if (c.source !== 'brand:tag') return false;
            const normBest = normalizeForCompare(best.title);
            const normTag = normalizeForCompare(c.title);
            if (normBest === normTag || normBest.includes(normTag) || normTag.includes(normBest)) {
              return false;
            }
            return c.support >= 3 && c.coverage >= 0.5 && best.coverage < 0.6;
          })
        : undefined;

    const contested = sameTierContested || Boolean(conflictingTag);

    if (contested) {
      state = 'contested';
    } else if (input.singleton && best.source === 'anchor' && best.title.trim().length > 0) {
      // 单成员系列的名称就是这部作品自己的官方标题，自动确定
      state = 'resolved';
    } else if (best.source === 'brand:members') {
      const coreCoverage = best.support / brandBasisCount;
      // 成员标题品牌覆盖绝大多数核心成员（≥ 60%），且整体覆盖 ≥ 50% 或至少 3 个核心成员支持
      state =
        coreCoverage >= 0.6 && best.support >= 2 && (best.coverage >= 0.5 || best.support >= 3)
          ? 'resolved'
          : 'provisional';
    } else if (best.source === 'brand:tag') {
      // 无成员标题前缀时（如「物语系列」「灰色系列」），高覆盖稀有品牌标签（≥ 3 成员且 ≥ 60% 全成员）
      // 且不存在相冲突的成员标题品牌时，自动确定
      const hasOtherBrandMembers = valid.some((c) => c.source === 'brand:members');
      state =
        !hasOtherBrandMembers && best.support >= 3 && best.coverage >= 0.6
          ? 'resolved'
          : 'provisional';
    } else {
      state = 'provisional';
    }

    // 候选对象同步展示状态
    for (const candidate of candidates) {
      if (candidate === best) candidate.state = state;
    }
  }

  // 候选列表：选中的在前，其余按来源层级 / 支持度排序，被否决的保留在末尾
  const ordered = [...candidates].sort((a, b) => {
    const aChosen = a.valid && normalizeForCompare(a.title) === normalizeForCompare(title) &&
      (chosenGroup ? true : a.source === source);
    const bChosen = b.valid && normalizeForCompare(b.title) === normalizeForCompare(title) &&
      (chosenGroup ? true : b.source === source);
    if (aChosen !== bChosen) return aChosen ? -1 : 1;
    if (a.valid !== b.valid) return a.valid ? -1 : 1;
    return (
      tierOf(b.source) - tierOf(a.source) ||
      b.coverage - a.coverage ||
      a.title.localeCompare(b.title, 'zh-Hans-CN')
    );
  });

  const existing = input.existing ?? null;
  const locked = existing?.state === 'resolved' || existing?.state === 'manual';
  const newCandidate: TitleCandidate = {
    title,
    source,
    state,
    evidence:
      candidates.find(
        (candidate) => candidate.valid && normalizeForCompare(candidate.title) === normalizeForCompare(title),
      )?.evidence ?? '',
    valid: state !== 'unresolved',
    support: chosenGroup?.maxSupport ?? chosenCandidate?.support ?? 0,
    coverage: chosenGroup
      ? chosenGroup.maxSupport / memberCount
      : chosenCandidate?.coverage ?? 0,
  };

  if (existing && locked) {
    const proposed =
      state !== 'unresolved' && normalizeForCompare(title) !== normalizeForCompare(existing.title)
        ? newCandidate
        : null;
    return {
      title: existing.title,
      state: existing.state,
      source: existing.source,
      candidates: ordered,
      proposed,
      changed: false,
    };
  }

  if (existing && state !== 'unresolved') {
    const groupByNormalized = new Map(groups.map((group) => [group.normalized, group]));
    const existingGroup = groupByNormalized.get(normalizeForCompare(existing.title)) ?? null;
    const newRank = chosenGroup
      ? groupRank(chosenGroup, memberCount)
      : chosenCandidate
        ? [0, chosenCandidate.coverage, tierOf(chosenCandidate.source), chosenCandidate.title.length]
        : [0, 0, 0, 0];
    const existingRank = existingGroup ? groupRank(existingGroup, memberCount) : null;
    // 仅当旧展示名不再是有效候选，或新证据严格更强时才改变 —— 避免无证据的来回抖动
    if (existingRank && compareRank(existingRank, newRank) >= 0) {
      const sameChosen = normalizeForCompare(existing.title) === normalizeForCompare(title);
      return {
        title: existing.title,
        // 名称形态保持稳定，但状态可以随更强的证据提升（provisional → resolved）
        state: sameChosen ? state : existing.state,
        source: sameChosen ? source : existing.source,
        candidates: ordered,
        proposed: null,
        changed: false,
      };
    }
  }

  return {
    title,
    state,
    source,
    candidates: ordered,
    proposed: null,
    changed: Boolean(existing && normalizeForCompare(existing.title) !== normalizeForCompare(title)),
  };
}
