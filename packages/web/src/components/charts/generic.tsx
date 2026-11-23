import type { EChartsOption } from 'echarts';
import { format as chartFormat } from 'echarts/core';
import { useMemo } from 'react';
import { cn } from '../../lib/cn.js';
import { formatNumber } from '../../lib/format.js';
import { CHART_FONT, Chart, axisStyle, baseChartOption, resolveChartColor, useChartTheme } from './chart.js';

export interface NamedValue {
  name: string;
  value: number;
  color?: string;
}

export function tooltipFormatter(params: unknown): string {
  const list = Array.isArray(params) ? params : [params];
  return list
    .map((entry) => {
      const item = entry as { marker?: string; name?: string; value?: unknown; seriesName?: string };
      const raw = Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value;
      const value = typeof raw === 'number' ? formatNumber(raw) : String(raw ?? '');
      return `${item.marker ?? ''}${item.seriesName ? `${item.seriesName} · ` : ''}${item.name ?? ''}：${value}`;
    })
    .join('<br/>');
}

/** 环形图：展示构成比例（收藏状态、放送形态等）。 */
export function DistributionDonut({
  items,
  height = 240,
  centerLabel,
  centerValue,
  valueSuffix = '部',
}: {
  items: NamedValue[];
  height?: number;
  centerLabel?: string;
  centerValue?: string;
  valueSuffix?: string;
}) {
  const theme = useChartTheme();
  const option = useMemo<EChartsOption>(() => {
    const total = items.reduce((sum, item) => sum + item.value, 0);
    const base = baseChartOption(theme);
    const legend = {
      orient: 'vertical' as const,
      right: 4,
      top: 'center' as const,
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 8,
      icon: 'circle' as const,
      textStyle: { color: theme.muted, fontSize: CHART_FONT.legend },
      formatter: (name: string) => {
        const item = items.find((entry) => entry.name === name);
        if (!item) return name;
        const share = total > 0 ? Math.round((item.value / total) * 100) : 0;
        return `${name}  ${item.value} · ${share}%`;
      },
    };
    const centerGraphic = (left: string, valueTop: string, labelTop: string) =>
      centerLabel
        ? [
            {
              type: 'text',
              left,
              top: valueTop,
              style: {
                text: centerValue ?? '',
                fill: theme.text,
                fontSize: CHART_FONT.centerValue,
                fontWeight: 600,
                align: 'center',
              },
            },
            {
              type: 'text',
              left,
              top: labelTop,
              style: { text: centerLabel, fill: theme.subtle, fontSize: CHART_FONT.centerLabel, align: 'center' },
            },
          ]
        : undefined;
    const pieSeries = (center: [string, string], radius: [string, string]) => [
      {
        type: 'pie' as const,
        radius,
        center,
        avoidLabelOverlap: true,
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 4 },
        label: { show: false },
        labelLine: { show: false },
        data: items.map((item) => ({
          name: item.name,
          value: item.value,
          ...(item.color
            ? { itemStyle: { color: resolveChartColor(item.color, theme.palette[0]) } }
            : {}),
        })),
      },
    ];
    /*
     * 窄容器（例如 1024px 下三列布局里的卡片）里右侧图例会压到圆环上，
     * 因此用 ECharts 的 media 查询在窄宽度下把图例移到下方、圆环居中——
     * 这是同一套组件的响应式规则，不是页面级的临时补丁。
     */
    return {
      baseOption: {
      ...base,
      tooltip: {
        ...base.tooltip,
        trigger: 'item',
        formatter: (params: unknown) => {
          const item = params as { name: string; value: number; percent: number; marker: string };
          return `${item.marker}${item.name}：${formatNumber(item.value)}${valueSuffix}（${item.percent}%）`;
        },
      },
        legend,
        graphic: centerGraphic('30%', '43%', '57%'),
        series: pieSeries(['32%', '50%'], ['58%', '84%']),
      },
      media: [
        {
          query: { maxWidth: 360 },
          option: {
            legend: {
              ...legend,
              orient: 'horizontal',
              left: 'center',
              right: 'auto',
              top: 'auto',
              bottom: 0,
              itemGap: 10,
            },
            graphic: centerGraphic('50%', '33%', '46%'),
            series: pieSeries(['50%', '36%'], ['52%', '76%']),
          },
        },
      ],
    } as EChartsOption;
  }, [items, theme, centerLabel, centerValue, valueSuffix]);

  return <Chart option={option} height={height} />;
}

/** 纵向柱状图：类别数量对比，可选叠加平均分折线。 */
export function CategoryBar({
  categories,
  values,
  height = 240,
  color,
  unit = '部',
  rotation = 0,
  averageValues,
  averageName = '平均我的评分',
  averageAxisMax = 10,
  timeWindow,
  onTimeWindowChange,
}: {
  categories: string[];
  values: number[];
  height?: number;
  color?: string;
  unit?: string;
  rotation?: number;
  averageValues?: Array<number | null>;
  averageName?: string;
  averageAxisMax?: number;
  timeWindow?: { start: number; end: number };
  onTimeWindowChange?: (range: { start: number; end: number }) => void;
}) {
  const theme = useChartTheme();
  const option = useMemo<EChartsOption>(() => {
    const base = baseChartOption(theme);
    const hasAverage = Boolean(averageValues?.some((value) => value !== null));
    // Rotated labels must stay below the axis. Reserve their measured horizontal
    // projection rather than reversing text alignment into the plotted bars.
    const angle = Math.abs(rotation) * Math.PI / 180;
    const font = `${CHART_FONT.axis}px ${(base.textStyle as { fontFamily: string }).fontFamily}`;
    const rotatedInset = rotation ? Math.ceil(Math.max(0, ...categories.map((category) => {
      const rect = chartFormat.getTextRect(category, font);
      return rect.width * Math.cos(angle) + rect.height * Math.sin(angle);
    }))) + 8 : 8;
    return {
      ...base,
      tooltip: {
        ...base.tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: tooltipFormatter,
      },
      /*
       * Y 轴单位（「部」「集」「人」）是贴网格上边缘绘制的，
       * 只要存在单位名称就必须在基准留白之上再让出一行图例的高度，
       * 否则文字上半部分会被画到画布之外（曾经的实际 Bug）。
       */
      grid: {
        ...base.grid,
        top: hasAverage ? 46 : unit ? 44 : 12,
        left: rotation > 0 ? rotatedInset : 8,
        right: Math.max(hasAverage ? 40 : 12, rotation < 0 ? rotatedInset : 0),
        bottom: timeWindow ? 36 : 4,
      },
      dataZoom: timeWindow
        ? [{
            // Filter only ECharts' working data. Props/raw history remain complete;
            // a single-period ordinal extent must not place outside points at its centre.
            type: 'slider', xAxisIndex: 0, filterMode: 'filter',
            start: timeWindow.start, end: timeWindow.end,
            bottom: 0, height: 18, showDetail: false, brushSelect: false,
            borderColor: theme.border, fillerColor: theme.surface2,
            handleStyle: { color: theme.accent, borderColor: theme.accent },
            moveHandleStyle: { color: theme.accent },
            dataBackground: { lineStyle: { color: theme.subtle }, areaStyle: { color: theme.surface2 } },
          }]
        : undefined,
      legend: hasAverage
        ? {
            top: 0,
            /*
             * 顶部这一行同时要放 Y 轴单位（左侧）与图例（右侧）。
             * 用 left + width 限定图例只占右侧 62%，窄窗口下文字会自动换行，
             * 不会和单位文字叠在一起。
             */
            left: '38%',
            width: '62%',
            right: 0,
            itemWidth: 10,
            itemHeight: 6,
            textStyle: { color: theme.subtle, fontSize: CHART_FONT.legend },
          }
        : undefined,
      xAxis: {
        type: 'category',
        data: categories,
        ...axisStyle(theme),
        splitLine: { show: false },
        axisLabel: {
          color: theme.subtle,
          fontSize: CHART_FONT.axis,
          rotate: rotation,
          alignMinLabel: categories.length === 1 ? 'center' : rotation > 0 ? 'right' : 'left',
          alignMaxLabel: rotation < 0 ? 'left' : 'right',
          showMinLabel: true,
          showMaxLabel: true,
          hideOverlap: true,
        },
      },
      yAxis: [
        {
          type: 'value',
          ...axisStyle(theme),
          axisLabel: { color: theme.subtle, fontSize: CHART_FONT.axis },
          name: unit,
          nameTextStyle: { color: theme.subtle, fontSize: CHART_FONT.axisName },
        },
        ...(hasAverage
          ? [{ type: 'value' as const, min: 0, max: averageAxisMax, show: false }]
          : []),
      ],
      series: [
        {
          name: '数量',
          type: 'bar',
          data: values,
          barMaxWidth: 26,
          itemStyle: {
            color: resolveChartColor(color, theme.palette[0]),
            borderRadius: [4, 4, 0, 0],
          },
        },
        ...(hasAverage
          ? [
              {
                name: averageName,
                type: 'line' as const,
                yAxisIndex: 1,
                data: averageValues ?? [],
                symbolSize: 5,
                lineStyle: { width: 2, color: theme.palette[2] },
                itemStyle: { color: theme.palette[2] },
                connectNulls: false,
              },
            ]
          : []),
      ],
    } as EChartsOption;
  }, [categories, values, theme, color, unit, rotation, averageValues, averageName, averageAxisMax, timeWindow]);

  const onEvents = useMemo(() => onTimeWindowChange ? {
    datazoom: (params: unknown) => {
      const event = params as { start?: number; end?: number; batch?: Array<{ start?: number; end?: number }> };
      const range = event.batch?.[0] ?? event;
      if (typeof range.start === 'number' && typeof range.end === 'number' && Number.isFinite(range.start) && Number.isFinite(range.end)) {
        onTimeWindowChange({ start: range.start, end: range.end });
      }
    },
  } : undefined, [onTimeWindowChange]);
  return <Chart option={option} height={height} onEvents={onEvents} />;
}

/** 横向排行图：标签 / 制作公司 / 导演排行。 */
export function RankedBar({
  items,
  height = 260,
  unit = '部',
  valueFormatter,
  maxItems = 12,
}: {
  items: NamedValue[];
  height?: number;
  unit?: string;
  valueFormatter?: (item: NamedValue) => string;
  maxItems?: number;
}) {
  const theme = useChartTheme();
  const option = useMemo<EChartsOption>(() => {
    const visible = items.slice(0, maxItems).reverse();
    const base = baseChartOption(theme);
    return {
      ...base,
      tooltip: {
        ...base.tooltip,
        trigger: 'item',
        formatter: (params: unknown) => {
          const item = params as { name: string; value: number; dataIndex: number };
          const source = visible[item.dataIndex];
          const text =
            valueFormatter && source ? valueFormatter(source) : `${formatNumber(item.value)}${unit}`;
          return `${item.name}：${text}`;
        },
      },
      grid: { left: 8, right: 28, top: 8, bottom: 4, containLabel: true },
      xAxis: {
        type: 'value',
        ...axisStyle(theme),
        axisLabel: { color: theme.subtle, fontSize: CHART_FONT.axis },
      },
      yAxis: {
        type: 'category',
        data: visible.map((item) => item.name),
        ...axisStyle(theme),
        splitLine: { show: false },
        axisLabel: { color: theme.muted, fontSize: CHART_FONT.legend, width: 118, overflow: 'truncate' },
      },
      series: [
        {
          type: 'bar',
          data: visible.map((item, index) => ({
            value: item.value,
            itemStyle: {
              // 单一色相 + 由深到浅的透明度梯度，比彩虹配色更克制
              color: resolveChartColor(item.color, theme.palette[0]),
              opacity:
                visible.length > 1 ? Number((0.5 + (0.5 * index) / (visible.length - 1)).toFixed(2)) : 1,
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barMaxWidth: 16,
          label: {
            show: true,
            position: 'right',
            color: theme.subtle,
            fontSize: CHART_FONT.label,
            formatter: (params: { value: number }) => formatNumber(params.value),
          },
        },
      ],
    } as EChartsOption;
  }, [items, theme, unit, valueFormatter, maxItems]);

  return <Chart option={option} height={height} />;
}

export function ChartSkeleton({ height = 240, className }: { height?: number; className?: string }) {
  return (
    <div
      className={cn('skeleton w-full rounded-[10px]', className)}
      style={{ height }}
      aria-label="图表加载中"
    />
  );
}
