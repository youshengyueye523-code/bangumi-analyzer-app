/** Closed local outcome copy, persisted in existing run warnings on handled failure/cancel.
 * Legacy/interrupted records without exactly one outcome remain unknown. No remote proof.
 */
export const SYNC_FAILURE_EXPLANATIONS = {
  beforeApply: '本次同步未提交收藏应用，也未成功提交详情、关系或人员补充；暂存与失败尝试记录可能保留。这不代表此前本地数据状态已获验证。',
  afterApplyRestored: '本次同步已有来源应用提交，异常路径的派生重建已完成；已提交数据不会因失败自动撤销。这不代表远端采集完整或所有详情均已补齐。',
  afterApplyPending: '本次同步已有来源应用提交，但异常路径的派生重建未完成，仍需恢复；已提交来源不会因失败自动撤销。请核查待恢复状态后重新检测。',
  unknown: '本次同步未完整完成；历史记录不足以判断来源是否已提交及派生恢复是否完成。不能仅凭失败状态断言来源未变、远端完整或本地数据损坏。',
} as const;

export function syncFailureExplanation(warnings: string | null): string {
  try {
    const values: unknown = JSON.parse(warnings ?? 'null');
    if (!Array.isArray(values)) return SYNC_FAILURE_EXPLANATIONS.unknown;
    const known = new Set<string>([
      SYNC_FAILURE_EXPLANATIONS.beforeApply,
      SYNC_FAILURE_EXPLANATIONS.afterApplyRestored,
      SYNC_FAILURE_EXPLANATIONS.afterApplyPending,
    ]);
    const outcomes = new Set<string>(values.filter((v): v is string => typeof v === 'string' && known.has(v)));
    return outcomes.size === 1 ? [...outcomes][0]! : SYNC_FAILURE_EXPLANATIONS.unknown;
  } catch {
    return SYNC_FAILURE_EXPLANATIONS.unknown;
  }
}
