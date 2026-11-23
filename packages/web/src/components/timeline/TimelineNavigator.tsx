import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { periodKey, periodLabel, type PeriodRange, type TimelineGrain } from '../../lib/timeline.js';

type Part = 'first' | 'last' | 'pan';
type Gesture = { part: Part; base: PeriodRange; next: PeriodRange; x: number; width: number; identity: string };
const navigationKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** Drafts reach only the lightweight main chart; release creates one range/history entry. */
export function TimelineNavigator({ range, domain, grain, snapshot, onCommit, onPreview }: {
  range: PeriodRange; domain: PeriodRange; grain: TimelineGrain; snapshot: string;
  onCommit: (range: PeriodRange) => void;
  onPreview?: (range: PeriodRange | null) => void;
}) {
  const [preview, setPreview] = useState<PeriodRange | null>(null);
  const gesture = useRef<Gesture | null>(null), cancelled = useRef(false);
  const identity = `${snapshot}:${grain}:${domain.first}:${domain.last}:${range.first}:${range.last}`;
  const shown = preview ?? range;
  const label = (index: number) => periodLabel(periodKey(index, grain), grain);
  const cancel = () => { if (gesture.current) cancelled.current = true; gesture.current = null; setPreview(null); onPreview?.(null); };
  useEffect(() => { cancel(); }, [identity]);
  const begin = (part: Part, x = 0, width = 1) => {
    cancelled.current = false;
    gesture.current = { part, base: range, next: range, x, width: Math.max(1, width), identity };
  };
  const update = (next: PeriodRange) => {
    const active = gesture.current;
    if (!active || cancelled.current || active.identity !== identity) return;
    active.next = next; setPreview(next); onPreview?.(next);
  };
  const edgeValue = (part: 'first' | 'last', value: number) => {
    const base = gesture.current?.base ?? range;
    return part === 'first'
      ? { first: Math.max(domain.first, Math.min(base.last, value)), last: base.last }
      : { first: base.first, last: Math.min(domain.last, Math.max(base.first, value)) };
  };
  const panValue = (first: number) => {
    const base = gesture.current?.base ?? range, span = base.last - base.first;
    const start = Math.max(domain.first, Math.min(domain.last - span, first));
    return { first: start, last: start + span };
  };
  const finish = () => {
    const active = gesture.current; gesture.current = null; setPreview(null); onPreview?.(null);
    if (!cancelled.current && active?.identity === identity &&
      (active.next.first !== active.base.first || active.next.last !== active.base.last)) onCommit(active.next);
    cancelled.current = false;
  };
  const pointerStart = (event: PointerEvent<HTMLElement>, part: Part) => {
    if (event.button !== 0 || gesture.current) return;
    event.currentTarget.focus();
    begin(part, event.clientX, event.currentTarget.getBoundingClientRect().width);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (part === 'pan') event.preventDefault();
  };
  const escape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return false;
    event.preventDefault(); event.stopPropagation(); cancel(); return true;
  };
  return (
    <fieldset className="mt-3 space-y-1 border-t border-border pt-3" aria-label="拖动时间范围">
      <legend className="sr-only">拖动端点或整段范围，松手应用，Esc取消</legend>
      {(['first', 'last'] as const).map((part, i) => (
        <label key={part} className="block text-caption text-muted">
          {i === 0 ? '范围起点' : '范围终点'} · {label(shown[part])}
          <input className="timeline-slider" type="range" aria-label={i === 0 ? '范围起点' : '范围终点'}
            aria-valuetext={label(shown[part])} min={domain.first} max={domain.last} step={1} value={shown[part]}
            onPointerDown={(e) => pointerStart(e, part)}
            onChange={(e) => {
              if (cancelled.current) return;
              const next = edgeValue(part, Number(e.target.value));
              if (gesture.current) update(next); else onCommit(next); // Assistive native increment actions.
            }}
            onPointerUp={() => finish()} onPointerCancel={cancel} onLostPointerCapture={() => { if (gesture.current) cancel(); }}
            onKeyDown={(e) => { if (!escape(e) && navigationKeys.has(e.key) && !gesture.current) begin(part); }}
            onKeyUp={(e) => { if (navigationKeys.has(e.key)) finish(); }} onBlur={cancel}
          />
        </label>
      ))}
      <div role="slider" tabIndex={0} aria-label="整体平移范围" aria-valuemin={domain.first}
        aria-valuemax={domain.last - (range.last - range.first)} aria-valuenow={shown.first}
        aria-valuetext={`${label(shown.first)} — ${label(shown.last)}`} aria-orientation="horizontal"
        aria-disabled={range.last - range.first === domain.last - domain.first}
        className="flex min-h-11 cursor-ew-resize items-center justify-center rounded-control border border-border bg-surface-2 px-3 text-note text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ touchAction: 'none' }}
        onPointerDown={(e) => pointerStart(e, 'pan')}
        onPointerMove={(e) => { const active = gesture.current; if (active?.part === 'pan') update(panValue(active.base.first + Math.round((e.clientX - active.x) / active.width * (domain.last - domain.first)))); }}
        onPointerUp={() => finish()} onPointerCancel={cancel} onLostPointerCapture={() => { if (gesture.current) cancel(); }}
        onKeyDown={(e) => {
          if (escape(e) || !navigationKeys.has(e.key)) return;
          e.preventDefault(); if (!gesture.current) begin('pan');
          const base = gesture.current!.next;
          const step = e.shiftKey || e.key.startsWith('Page') ? 12 : 1;
          update(panValue(e.key === 'Home' ? domain.first : e.key === 'End' ? domain.last : base.first + (['ArrowLeft', 'ArrowDown', 'PageDown'].includes(e.key) ? -step : step)));
        }}
        onKeyUp={(e) => { if (navigationKeys.has(e.key)) finish(); }} onBlur={cancel}
      >拖动整段范围 · 方向键也可平移</div>
      <p role="status" className="pt-1 text-caption text-muted">
        {preview ? `预览：${label(shown.first)} — ${label(shown.last)} · 松手应用，Esc取消` : '端点分行独立调整；整段拖动保持跨度。日期输入仍需应用。'}
      </p>
    </fieldset>
  );
}
