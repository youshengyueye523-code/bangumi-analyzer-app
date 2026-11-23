/**
 * 「我的画像」的数据契约。
 *
 * 设计原则：所有数字都由本地统计层算好，AI 只负责在**这些证据之上**做归纳；
 * 因此这里同时定义了「结构化数据集」与「AI 输出结构」，两者互相对应。
 */

/** 带置信度与证据的结论。 */
export interface ProfileClaim {
  id: string;
  title: string;
  /** 一句话结论（可读的自然语言） */
  statement: string;
  /** 支撑该结论的具体数字（UI 必须展示） */
  evidence: string[];
  /** data = 由数据直接计算；inference = 基于数据的推测 */
  kind: 'data' | 'inference';
  confidence: 'high' | 'medium' | 'low';
  /** 证据不足时的说明，UI 会显式提示 */
  insufficient?: string;
}

/** 单个维度（标签 / 形态 / 公司 / 导演…）的统计。 */
export interface ProfileDimensionStat {
  name: string;
  count: number;
  share: number;
  averageRate: number | null;
  highShare: number | null;
  /** 高分组占比 ÷ 整体占比，>1 表示在高分作品中更常见 */
  lift: number | null;
}

/** 高分作品中成对出现的标签组合。 */
export interface ProfileTagPair {
  a: string;
  b: string;
  /** 在高分作品中同时出现的作品数 */
  count: number;
  /** 占高分作品的比例 */
  share: number;
  /** 独立假设下的期望共现数 */
  expected: number;
  /** 实际 / 期望 */
  lift: number;
}

/** 可能被主动避开的模式。 */
export interface ProfileAvoidance {
  name: string;
  dimension: string;
  count: number;
  averageRate: number | null;
  overallAverageRate: number | null;
  /** averageRate − overallAverageRate */
  gap: number | null;
  statusCounts: Record<string, number>;
  /** 搁置 + 抛弃 */
  abandoned: number;
  /** 停留在「想看」 */
  wishOnly: number;
  /** 接触过但全部未评分 */
  unratedCount: number;
  pattern: 'low-rated' | 'abandoned' | 'not-started' | 'mostly-unrated';
  note: string;
}

/** 按时间分段的兴趣快照（用 Bangumi 最后更新时间近似）。 */
export interface ProfilePeriod {
  period: string;
  count: number;
  ratedCount: number;
  averageRate: number | null;
  topTags: string[];
  /** 该时期首次出现的标签 */
  newTags: string[];
  /** 标签分布的香农熵（越高越分散） */
  tagEntropy: number | null;
  topFormat: string | null;
}

/** 兴趣广度与集中度。 */
export interface ProfileBreadth {
  distinctTags: number;
  /** 去掉「日本 / TV / 年份」等无区分度标签后的数量 */
  informativeTagCount: number;
  distinctTagsInHighRated: number;
  distinctStudios: number;
  distinctDirectors: number;
  distinctFormats: number;
  /** 前 5 个标签覆盖的作品比例 */
  top5TagShare: number | null;
  /** 赫芬达尔指数（0–1，越高越集中在少数标签） */
  concentration: number | null;
  earlyPeriodEntropy: number | null;
  recentPeriodEntropy: number | null;
  /** 数据集直接给出的判断文案 */
  verdict: string;
}

export interface ProfileLengthBucket {
  bucket: string;
  minEpisodes: number;
  maxEpisodes: number | null;
  count: number;
  averageRate: number | null;
  highShare: number | null;
}

export interface ProfileSeriesStats {
  groupedWorks: number;
  standaloneWorks: number;
  groupCount: number;
  averageRateGrouped: number | null;
  averageRateStandalone: number | null;
  /** 系列内平均部数 */
  averageGroupSize: number | null;
}

/** 画像数据集：本地统计层产出的全部结构化证据。 */
export interface ProfileDataset {
  /** 旧快照可能缺失；不能凭当前配置反推历史口径。 */
  visibility?: 'real' | 'visible';
  /** Absent on historical snapshots made before the wish exclusion rule. */
  personalRatingPolicy?: 'exclude-wish-v1';
  generatedAt: string;
  dataVersion: number;
  sample: {
    total: number;
    rated: number;
    highRated: number;
    lowRated: number;
    yearFrom: number | null;
    yearTo: number | null;
    /** 有「最后更新时间」的作品数（时间分段分析的样本量） */
    datedSample: number;
  };
  basics: {
    statusCounts: Record<string, number>;
    averageRate: number | null;
    medianRate: number | null;
    averageBgmScore: number | null;
    meanDelta: number | null;
    deltaStdDev: number | null;
    completionRate: number;
    watchedEpisodes: number;
    totalEpisodes: number;
  };
  tags: ProfileDimensionStat[];
  tagPairs: ProfileTagPair[];
  formats: ProfileDimensionStat[];
  seasons: ProfileDimensionStat[];
  originals: ProfileDimensionStat[];
  studios: ProfileDimensionStat[];
  directors: ProfileDimensionStat[];
  length: ProfileLengthBucket[];
  series: ProfileSeriesStats;
  avoidance: ProfileAvoidance[];
  periods: ProfilePeriod[];
  breadth: ProfileBreadth;
  /** 确定性结论（不依赖 AI），UI 默认展示 */
  claims: ProfileClaim[];
  /** 供 AI 参考的高分 / 低分作品样本（各 ≤ 40 条，只含必要字段） */
  samples: {
    highRated: ProfileWorkSample[];
    lowRated: ProfileWorkSample[];
    abandoned: ProfileWorkSample[];
  };
}

export interface ProfileWorkSample {
  id: number;
  title: string;
  myRate: number;
  bgmScore: number | null;
  delta: number | null;
  status: string;
  year: number | null;
  format: string;
  episodes: number;
  tags: string[];
  studios: string[];
  directors: string[];
  series: string | null;
}

/* ------------------------------------------------------------- 快照对比 */

export interface ProfileSnapshotSummary {
  visibility?: 'real' | 'visible' | null;
  id: number;
  stageLabel: string;
  note: string;
  source: string;
  rankFrom: number | null;
  rankTo: number | null;
  createdAt: string;
  collectionCount: number;
  ratedCount: number;
  averageRate: number | null;
  candidateCount: number | null;
  hasCandidateList: boolean;
}

export type ProfileChangeVerdict =
  | 'continued'
  | 'strengthened'
  | 'weakened'
  | 'overturned'
  | 'insufficient';

export interface ProfileChange {
  id: string;
  dimension: string;
  verdict: ProfileChangeVerdict;
  statement: string;
  evidence: string[];
}

/** 阶段复盘：两个快照之间的变化。 */
export interface ProfileComparison {
  from: ProfileSnapshotSummary;
  to: ProfileSnapshotSummary;
  stageWorks: {
    /** 本阶段新增（出现在 to 但不在 from） */
    newWorks: number;
    newWorksByStatus: Record<string, number>;
    newWorksAverageRate: number | null;
    /** 上一阶段有、本阶段已不在收藏中的数量 */
    removedWorks: number;
  };
  changes: ProfileChange[];
  /** Rank 复盘：仅有候选清单时才能计算 */
  rankReview: {
    available: boolean;
    reason: string;
    candidateCount: number | null;
    collectedCount: number | null;
    byStatus: Record<string, number> | null;
    hitRate: number | null;
  };
  generatedAt: string;
}

/* ----------------------------------------------------------------- AI */

export type AiProviderKind = 'openai-compatible';

export interface AiConfigPublic {
  enabled: boolean;
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
}

export interface AiConfigUpdate {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  /** 传空字符串表示清除；不传表示保持不变 */
  apiKey?: string;
}

/** AI 输出的一个画像模块。 */
export interface ProfileAiSection {
  id: string;
  title: string;
  /** 结论文字 */
  statement: string;
  /** 必须引用数据集里的具体数字 */
  evidence: string[];
  kind: 'data' | 'inference';
  confidence: 'high' | 'medium' | 'low';
}

export interface ProfileAiOutput {
  sections: ProfileAiSection[];
  /** 整段总结 */
  verdict: string;
  /** 明确无法判断的部分 */
  uncertainties: string[];
  /** 与自我认知可能不同的地方 */
  surprises: string[];
}

export interface ProfileAiReport {
  id: number;
  createdAt: string;
  provider: string;
  model: string;
  datasetHash: string;
  /** 数据、提示词和模型配置均与当前分析一致。历史报告不因此失去可读性。 */
  upToDate: boolean;
  output: ProfileAiOutput;
  usage: { promptTokens: number | null; completionTokens: number | null };
}

export interface ProfileAiStatus {
  configured: boolean;
  enabled: boolean;
  provider: string;
  model: string;
  reason: string;
  generating: boolean;
  reports: Array<Pick<ProfileAiReport, 'id' | 'createdAt' | 'model' | 'upToDate'>>;
  report: ProfileAiReport | null;
}
