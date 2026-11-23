import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'echarts/core';
import { CHART_FONT } from './chart.js';

/** Axis text only; category identity and all series indices keep the original period keys. */
export function formatTimePeriod(period: string): string {
  return period.replace(/^(\d{4})Q([1-4])$/, '$1 Q$2');
}

function ordinal(period: string, fallback: number): number {
  if (/^\d{4}-\d{2}$/.test(period)) return Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1;
  if (/^\d{4}Q[1-4]$/.test(period)) return Number(period.slice(0, 4)) * 4 + Number(period.slice(5)) - 1;
  return /^\d{4}$/.test(period) ? Number(period) : fallback;
}

function readableStep(required: number, period: string): number {
  const calendar = /^\d{4}-\d{2}$/.test(period) ? [1, 2, 3, 6, 12, 24, 36, 60]
    : /^\d{4}Q[1-4]$/.test(period) ? [1, 2, 4, 8, 12, 20] : [1, 2, 5];
  const candidates = new Set(calendar);
  const year = /^\d{4}-\d{2}$/.test(period) ? 12 : /^\d{4}Q[1-4]$/.test(period) ? 4 : 1;
  for (let scale = 1; scale <= Math.max(10, required * 10); scale *= 10)
    for (const step of [1, 2, 5]) candidates.add(year * step * scale);
  return [...candidates].sort((a, b) => a - b).find(step => step >= required) ?? required;
}

/** A measured, centered category layout. Only label indices are sampled, never data. */
export function timeAxisLayout({ periods, labels, width, boundaryGap, measure, maximum = 0, name = '', fontSize = 11 }: {
  periods: string[]; labels: string[]; width: number; boundaryGap: boolean;
  measure: (text: string) => number; maximum?: number; name?: string; fontSize?: number;
}) {
  const gap = fontSize * 0.7;
  const widths = labels.map(measure);
  // Reserve genuine glyph space around centered endpoints and outside the Y axis.
  const upper = Math.pow(10, Math.ceil(Math.log10(Math.max(1, maximum))));
  const left = Math.ceil(Math.max(measure(format.addCommas(upper)) + fontSize,
    (widths[0] ?? 0) / 2 + gap, measure(name) / 2 + gap));
  const right = Math.ceil((widths.at(-1) ?? 0) / 2 + gap);
  const plotWidth = Math.max(1, width - left - right), n = labels.length;
  const position = (i: number) => n === 1 ? left + plotWidth / 2
    : left + plotWidth * (boundaryGap ? (i + 0.5) / n : i / Math.max(1, n - 1));
  const ticks = new Set<number>();
  if (n) ticks.add(0);
  if (n > 1) ticks.add(n - 1);
  const spacing = plotWidth / Math.max(1, boundaryGap ? n : n - 1);
  const widest = widths.reduce((max, value) => Math.max(max, value), 0);
  const step = readableStep(Math.max(1, Math.ceil((widest + gap) / spacing)), periods[0] ?? '');
  let previous = 0;
  for (let i = 1; i < n - 1; i++) {
    if (ordinal(periods[i]!, i) % step !== 0) continue;
    if (position(i) - widths[i]! / 2 < position(previous) + widths[previous]! / 2 + gap) continue;
    if (position(i) + widths[i]! / 2 + gap > position(n - 1) - widths[n - 1]! / 2) continue;
    ticks.add(i); previous = i;
  }
  return { left, right, ticks, step, position };
}

export function useTimeAxis(periods: string[], labels: string[], values: Array<number | null>, line: boolean, fontFamily: string, name = '') {
  const container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(320);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () => { if (element.clientWidth > 0) setWidth(element.clientWidth); };
    resize(); const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => timeAxisLayout({ periods, labels, width, boundaryGap: !line,
    maximum: values.reduce<number>((max, value) => Math.max(max, value ?? 0), 0), name, fontSize: CHART_FONT.axis,
    measure: text => format.getTextRect(text, `${CHART_FONT.axis}px ${fontFamily}`).width,
  }), [periods, labels, width, values, line, fontFamily, name]);
  return { container, layout };
}
