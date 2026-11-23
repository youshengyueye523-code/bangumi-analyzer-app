/**
 * 数据中枢（v1.6.0）内部类型。
 *
 * 检测器只做「读 + 证据收集 + 给出可行的修复动作」，不在这里执行修复；
 * 执行入口统一在 repair.ts，保证「预览 → 执行 → 重新检测 → 验证」闭环。
 */
import type { DiagnosticIssue, DiagnosticModule } from '@bangumi-analyzer/shared';

export interface DetectorContext {
  /** 当前 NSFW 可见性开关（来自 data/config.json）。 */
  hideNsfw: boolean;
}

export interface DetectorResult {
  module: DiagnosticModule;
  issues: DiagnosticIssue[];
}

export type Detector = (context: DetectorContext) => DetectorResult;

/** 构造问题的统一入口，保证每条问题都有证据与影响范围。 */
export function makeIssue(issue: DiagnosticIssue): DiagnosticIssue {
  return issue;
}
