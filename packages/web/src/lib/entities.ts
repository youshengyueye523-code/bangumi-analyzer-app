import type {
  EntityTitleState,
  EvidenceCoverage,
  FranchiseState,
  MembershipState,
  SeriesEntityState,
} from '@bangumi-analyzer/shared';

export const TITLE_STATE_LABEL: Record<EntityTitleState, string> = {
  resolved: '自动确定',
  provisional: '待确认',
  unresolved: '未确认',
  contested: '有争议',
  manual: '人工确认',
};

export const TITLE_STATE_TONE: Record<
  EntityTitleState,
  'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
> = {
  resolved: 'success',
  provisional: 'warning',
  unresolved: 'neutral',
  contested: 'danger',
  manual: 'accent',
};

export const SERIES_STATE_LABEL: Record<SeriesEntityState, string> = {
  stable: '关系证据',
  provisional: '标题推测',
};

export const FRANCHISE_STATE_LABEL: Record<FranchiseState, string> = {
  candidate: '候选家族',
  provisional: '暂定家族',
  confirmed: '已确认家族',
  contested: '存在争议',
  rejected: '已否决',
};

export const FRANCHISE_STATE_TONE: Record<
  FranchiseState,
  'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
> = {
  candidate: 'neutral',
  provisional: 'warning',
  confirmed: 'success',
  contested: 'danger',
  rejected: 'neutral',
};

export const MEMBERSHIP_STATE_LABEL: Record<MembershipState, string> = {
  confirmed: '确定',
  probable: '推测',
  candidate: '候选',
};

export const COVERAGE_LABEL: Record<EvidenceCoverage, string> = {
  full: '证据完整',
  partial: '证据部分缺失',
  'relations-only': '仅有关系数据',
};
