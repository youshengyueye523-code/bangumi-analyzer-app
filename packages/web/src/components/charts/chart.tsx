import { BarChart, HeatmapChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useMemo, useRef } from 'react';
import type { EChartsOption } from 'echarts';
import { cn } from '../../lib/cn.js';
import { useResolvedTheme } from '../../lib/theme.js';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  VisualMapComponent,
  MarkLineComponent,
  GraphicComponent,
  CanvasRenderer,
]);

export interface ChartTheme {
  text: string;
  muted: string;
  subtle: string;
  border: string;
  surface: string;
  surface2: string;
  accent: string;
  palette: string[];
}

/**
 * 图表文字规格（统一 token，禁止各图表自己写 fontSize）。
 *
 * 分析型界面里图表文字必须在正常桌面距离下可读：
 * 坐标轴 11px、图例 / 提示 12px、图内标签 11px。
 */
export const CHART_FONT = {
  /** 坐标轴刻度 */
  axis: 11,
  /** 坐标轴名称（单位） */
  axisName: 11,
  /** 图例 */
  legend: 12,
  /** 提示框正文 */
  tooltip: 12,
  /** 图内标签（柱状数值、热力图等） */
  label: 11,
  /** 环形图中心数字 / 说明 */
  centerValue: 22,
  centerLabel: 12,
} as const;

export function readChartTheme(): ChartTheme {
  if (typeof window === 'undefined') {
    return {
      text: '#e7eaf1',
      muted: '#9ba4b4',
      subtle: '#6b7486',
      border: '#232936',
      surface: '#12151d',
      surface2: '#171b24',
      accent: '#6d8bff',
      palette: ['#6d8bff', '#3ddc97', '#f5b544', '#ff7a9c', '#6fd3f7', '#b18cff', '#4fd1c5', '#ff9f68'],
    };
  }
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    text: value('--text', '#e7eaf1'),
    muted: value('--text-muted', '#9ba4b4'),
    subtle: value('--text-subtle', '#6b7486'),
    border: value('--border', '#232936'),
    surface: value('--surface', '#12151d'),
    surface2: value('--surface-2', '#171b24'),
    accent: value('--accent', '#6d8bff'),
    palette: Array.from({ length: 8 }, (_, index) => value(`--chart-${index + 1}`, '#6d8bff')),
  };
}

/**
 * 把 `var(--chart-1)` 这类 CSS 变量解析成具体颜色值。
 * Canvas 无法解析 CSS 变量，因此图表里所有颜色都必须先经过这一步。
 */
export function resolveChartColor(color: string | null | undefined, fallback?: string): string {
  const fallbackValue = fallback ?? '#6d8bff';
  if (!color) return fallbackValue;
  const value = color.trim();
  if (!value) return fallbackValue;
  const match = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(value);
  if (!match) return value;
  if (typeof window === 'undefined') return fallbackValue;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]!).trim();
  return resolved || fallbackValue;
}

/** 统一的坐标轴 / 提示框样式，保证所有图表视觉语言一致。 */
export function baseChartOption(theme: ChartTheme): EChartsOption {
  return {
    color: theme.palette,
    animationDuration: 420,
    animationEasing: 'cubicOut',
    textStyle: {
      fontFamily:
        "Inter, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', sans-serif",
      color: theme.text,
      fontSize: CHART_FONT.tooltip,
    },
    /*
     * 顶部留白必须容纳 Y 轴单位文字（例如「部」「集」「人」）。
     *
     * ECharts 的 yAxis.name 默认贴在网格上边缘（nameLocation: 'end'），
     * 文字是以「中心点对齐网格顶部」绘制的：如果 grid.top 太小，
     * 文字上半部分会被画到画布之外，看起来就是「顶部单位被裁掉一半」。
     * 这里统一按 字号(10) + 上下间距 预留，所有图表共用同一个基准值，
     * 需要更宽松的图表只允许在此基础上加大（例如带图例的图表）。
     */
    grid: { left: 8, right: 12, top: 44, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: theme.text, fontSize: CHART_FONT.tooltip },
      extraCssText: 'border-radius:10px;box-shadow:0 16px 32px -20px rgba(0,0,0,0.6);',
    },
  };
}

export function axisStyle(theme: ChartTheme) {
  return {
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { show: false },
    axisLabel: { color: theme.subtle, fontSize: CHART_FONT.axis },
    splitLine: { lineStyle: { color: theme.border, type: 'dashed' as const, opacity: 0.6 } },
  };
}

export function Chart({
  option,
  height = 260,
  className,
  onEvents,
}: {
  option: EChartsOption;
  height?: number;
  className?: string;
  onEvents?: Record<string, (params: unknown) => void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    if (!containerRef.current) return;
    const instance = echarts.init(containerRef.current, undefined, { renderer: 'canvas' });
    instanceRef.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option, theme]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance || !onEvents) return;
    const handlers = Object.entries(onEvents);
    for (const [event, handler] of handlers) instance.on(event, handler);
    return () => {
      for (const [event, handler] of handlers) instance.off(event, handler);
    };
  }, [onEvents]);

  return (
    <div ref={containerRef} className={cn('w-full', className)} style={{ height }} aria-hidden />
  );
}

/** 图表容器：负责标题、说明与空状态，图表本体只关心 option。 */
export function ChartFrame({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('card-surface flex flex-col px-4 pb-3 pt-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="clamp-2 text-card" title={title}>
            {title}
          </h3>
          {description ? <p className="mt-0.5 text-data text-subtle">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="mt-2 flex-1">{children}</div>
    </div>
  );
}

export function useChartTheme(): ChartTheme {
  const theme = useResolvedTheme();
  return useMemo(() => readChartTheme(), [theme]);
}

export type { EChartsOption };
