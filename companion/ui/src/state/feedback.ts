import { useSyncExternalStore } from 'react';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';
export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

let items: Toast[] = [];
let seq = 1;
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());

export function toast(tone: ToastTone, title: string, body?: string, ms = 3600) {
  const id = seq++;
  items = [...items, { id, tone, title, body }].slice(-4);
  emit();
  setTimeout(() => dismiss(id), ms);
}
export function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}
export const useToasts = () =>
  useSyncExternalStore(
    (l) => {
      ls.add(l);
      return () => ls.delete(l);
    },
    () => items,
  );

/** 运行日志（首页「活动」与初始化日志共用，内存中） */
export interface LogLine {
  t: number;
  level: 'info' | 'ok' | 'warn' | 'error';
  text: string;
  seq?: number;
}
let logs: LogLine[] = [];
const seenSeqs = new Set<number>();
const lls = new Set<() => void>();
export function log(level: LogLine['level'], text: string) {
  logs = [...logs, { t: Date.now(), level, text }].slice(-300);
  lls.forEach((l) => l());
}
export function ingestRuntimeLogs(entries?: Array<{ seq: number; at: string; level: 'info' | 'error'; event: string }>) {
  if (!entries?.length) return;
  let added = false;
  for (const e of entries) {
    if (seenSeqs.has(e.seq)) continue;
    seenSeqs.add(e.seq);
    const parsed = Date.parse(e.at);
    const lv: LogLine['level'] = e.level === 'error' ? 'error' : /ready|ok|valid|stopped/.test(e.event) ? 'ok' : /lock|warn|timeout/.test(e.event) ? 'warn' : 'info';
    logs = [...logs, { t: Number.isFinite(parsed) ? parsed : Date.now(), level: lv, text: `[runtime #${e.seq}] ${e.event}`, seq: e.seq }];
    added = true;
  }
  if (added) {
    logs = logs.slice(-300);
    lls.forEach((l) => l());
  }
}
export function clearLogs() {
  logs = [];
  seenSeqs.clear();
  lls.forEach((l) => l());
}
export const useLogs = () =>
  useSyncExternalStore(
    (l) => {
      lls.add(l);
      return () => lls.delete(l);
    },
    () => logs,
  );
