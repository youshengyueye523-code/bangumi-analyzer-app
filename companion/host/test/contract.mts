import type { CompanionStatus, CompanionBridge, OpenResult } from '../bridge.js';
import type { AnalyzerStatus, CompanionDriver } from '../../ui/src/driver/types.js';
export function compatible(b: CompanionBridge, status: CompanionStatus, open: OpenResult): [AnalyzerStatus, CompanionDriver, OpenResult] {
  return [status, { kind:'codex', getStatus:b.getStatus,startAnalyzer:b.startAnalyzer,stopAnalyzer:b.stopAnalyzer,openAnalyzer:b.openAnalyzer,subscribe:b.onStatus }, open];
}
