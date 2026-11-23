import type { BgmSubject } from '@bangumi-analyzer/shared';

// 响应证据与容错后的业务模型分开，避免默认值/字段剥离成为 raw 事实。
const sources = new WeakMap<BgmSubject, unknown>();

export function rememberSubjectSource(subject: BgmSubject, raw: unknown): BgmSubject {
  sources.set(subject, raw);
  return subject;
}

export function subjectSource(subject: BgmSubject): unknown {
  return sources.get(subject) ?? subject;
}
