import { ApiRequestError } from './api.js';

// These are markers from the server projection, not displayable evidence. The
// views still use the default protected API response and never request originals.
export const WITHHELD_EVIDENCE = '受保护证据：原文完整保留，需通过独立「完整审计证据」确认入口查看。';
export const isVisibleText = (value: string) => value !== WITHHELD_EVIDENCE;

export function visibleEvidenceText(value: string | null | undefined): string | undefined {
  return value && isVisibleText(value) ? value : undefined;
}

export function verificationSummary(text: string): string {
  return text.replace('；请审阅验证层级，必要时独立确认完整证据。', '；请审阅验证层级。');
}

export function evidenceDisplayError(error: unknown): unknown {
  if (error instanceof ApiRequestError && error.hint === '请检查请求或通过完整审计证据入口复查。') {
    return new ApiRequestError(error.message, {
      code: error.code, status: error.status, dataIntact: error.dataIntact, resultUnknown: error.resultUnknown,
    });
  }
  return error;
}
