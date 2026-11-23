import type { SyncCounters, SyncPhase, SyncProgress, SyncDepth, SyncMode } from '@bangumi-analyzer/shared';
import { clamp, nowIso, round } from '../util.js';

export function emptyCounters(): SyncCounters {
  return {
    requests: 0,
    retries: 0,
    fetched: 0,
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    detailsFetched: 0,
    relationsFetched: 0,
    personsFetched: 0,
    coversCached: 0,
    failures: 0,
  };
}

interface PhaseSegment {
  phase: SyncPhase;
  weight: number;
  start: number;
  end: number;
}

const MAX_ISSUES = 20;

/**
 * 同步进度跟踪器。
 *
 * 阶段权重按「预计耗时」分配（收藏分页很快、条目详情最慢），
 * 这样进度条不会在详情抓取阶段长时间停在 30%。
 */
export class ProgressTracker {
  readonly counters: SyncCounters = emptyCounters();
  readonly issues: string[] = [];
  readonly warnings: string[] = [];
  private segments: PhaseSegment[] = [];
  private currentPhase: SyncPhase = 'preparing';
  private current = 0;
  private total = 0;
  private message = '准备中';
  private phaseStartedAt = Date.now();
  private readonly startedAt = Date.now();
  private lastNotifyAt = 0;

  constructor(
    readonly runId: number,
    readonly mode: SyncMode,
    readonly depth: SyncDepth,
    private readonly notify: (progress: SyncProgress) => void,
  ) {
    this.setPlan([{ phase: 'preparing', weight: 5 }]);
  }

  /**
   * 重新规划后续阶段。收藏列表抓完后我们才知道各阶段的工作量，
   * 因此这里会按实际队列长度重新分配权重。
   */
  setPlan(phases: Array<{ phase: SyncPhase; weight: number }>): void {
    const usable = phases.filter((entry) => entry.weight > 0);
    const totalWeight = usable.reduce((sum, entry) => sum + entry.weight, 0) || 1;
    let cursor = 0;
    this.segments = usable.map((entry) => {
      const start = cursor;
      const end = cursor + (entry.weight / totalWeight) * 100;
      cursor = end;
      return { phase: entry.phase, weight: entry.weight, start, end };
    });
    if (this.segments.length === 0) {
      this.segments = [{ phase: 'preparing', weight: 1, start: 0, end: 100 }];
    }
  }

  setPhase(phase: SyncPhase, message: string, total = 0): void {
    this.currentPhase = phase;
    this.message = message;
    this.current = 0;
    this.total = total;
    this.phaseStartedAt = Date.now();
    this.emit(true);
  }

  setPhaseTotal(total: number): void {
    this.total = total;
  }

  advance(count: number, message?: string): void {
    this.current += count;
    if (message) this.message = message;
    this.emit(false);
  }

  setMessage(message: string): void {
    this.message = message;
    this.emit(false);
  }

  addIssue(message: string): void {
    this.counters.failures += 1;
    if (this.issues.length < MAX_ISSUES) this.issues.push(message);
  }

  addWarning(message: string): void {
    if (this.warnings.length < MAX_ISSUES) this.warnings.push(message);
  }

  private percent(): number {
    const segment =
      this.segments.find((entry) => entry.phase === this.currentPhase) ?? this.segments.at(-1);
    if (!segment) return 0;
    const ratio = this.total > 0 ? clamp(this.current / this.total, 0, 1) : 0;
    return round(segment.start + (segment.end - segment.start) * ratio, 1) ?? 0;
  }

  private etaSeconds(): number | null {
    if (this.total <= 0 || this.current <= 0) return null;
    const elapsedSeconds = (Date.now() - this.phaseStartedAt) / 1000;
    if (elapsedSeconds < 1.5) return null;
    const perItem = elapsedSeconds / this.current;
    const remaining = Math.max(0, this.total - this.current);
    return Math.round(remaining * perItem);
  }

  snapshot(): SyncProgress {
    return {
      runId: this.runId,
      mode: this.mode,
      depth: this.depth,
      phase: this.currentPhase,
      message: this.message,
      current: this.current,
      total: this.total,
      percent: this.percent(),
      etaSeconds: this.etaSeconds(),
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: nowIso(),
      counters: { ...this.counters },
      issues: [...this.issues],
      warnings: [...this.warnings],
    };
  }

  /** 进度通知做了节流：高频写入不会拖慢同步本身。 */
  emit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastNotifyAt < 350) return;
    this.lastNotifyAt = now;
    this.notify(this.snapshot());
  }
}
