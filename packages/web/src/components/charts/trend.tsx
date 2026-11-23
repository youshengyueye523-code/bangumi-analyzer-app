import type { EChartsOption } from 'echarts';
import { useMemo } from 'react';
import {
  CHART_FONT,
  Chart,
  axisStyle,
  baseChartOption,
  resolveChartColor,
  useChartTheme,
} from './chart.js';
import { tooltipFormatter } from './generic.js';

/** 折线 / 面积趋势图：支持双 Y 轴（数量 + 评分）。 */
export function TrendArea({
  categories,
  series,
  height = 280,
  dualAxis = false,
  yAxisFormatter,
}: {
  categories: string[];
  series: Array<{
    name: string;
    data: Array<number | null>;
    color?: string;
    area?: boolean;
    axis?: 0 | 1;
  }>;
  height?: number;
  dualAxis?: boolean;
  yAxisFormatter?: (value: number) => string;
}) {
  const theme = useChartTheme();
  const option = useMemo<EChartsOption>(() => {
    const base = baseChartOption(theme);
    return {
      ...base,
      tooltip: { ...base.tooltip, trigger: 'axis', confine: true, formatter: tooltipFormatter },
      legend: {
        top: 0,
        // 与 CategoryBar 同一规则：右侧 62% 归图例，左侧留给 Y 轴单位
        left: '38%',
        width: '62%',
        right: 0,
        itemWidth: 12,
        itemHeight: 6,
        textStyle: { color: theme.subtle, fontSize: CHART_FONT.legend },
      },
      // 与 CategoryBar 同一规则：顶部图例 + Y 轴单位各占一行
      grid: { ...base.grid, top: 46 },
      xAxis: {
        type: 'category',
        data: categories,
        boundaryGap: false,
        ...axisStyle(theme),
        splitLine: { show: false },
        axisLabel: {
          color: theme.subtle,
          fontSize: CHART_FONT.axis,
          // 首尾点位于网格边缘：文字向绘图区内对齐，避免依赖固定留白。
          // 单点仍居中；自动间隔只抽稀刻度，不改变任何 series 数据或 Tooltip。
          alignMinLabel: categories.length === 1 ? 'center' : 'left',
          alignMaxLabel: 'right',
          interval: 'auto',
          showMinLabel: true,
          showMaxLabel: true,
          hideOverlap: true,
        },
      },
      yAxis: dualAxis
        ? [
            {
              type: 'value',
              ...axisStyle(theme),
              axisLabel: {
                color: theme.subtle,
                fontSize: CHART_FONT.axis,
                formatter: yAxisFormatter ? (value: number) => yAxisFormatter(value) : undefined,
              },
            },
            {
              type: 'value',
              min: 0,
              max: 10,
              position: 'right',
              splitLine: { show: false },
              axisLine: { show: false },
              axisTick: { show: false },
              axisLabel: { color: theme.subtle, fontSize: CHART_FONT.axis },
            },
          ]
        : {
            type: 'value',
            ...axisStyle(theme),
            axisLabel: {
              color: theme.subtle,
              fontSize: CHART_FONT.label,
              formatter: yAxisFormatter ? (value: number) => yAxisFormatter(value) : undefined,
            },
          },
      series: series.map((entry, index) => ({
        name: entry.name,
        type: 'line',
        yAxisIndex: dualAxis ? (entry.axis ?? 0) : 0,
        data: entry.data,
        smooth: false,
        symbol: 'circle',
        symbolSize: 5,
        showSymbol: categories.length <= 40,
        connectNulls: false,
        lineStyle: {
          width: 2,
          color: resolveChartColor(entry.color, theme.palette[index % theme.palette.length]),
        },
        itemStyle: {
          color: resolveChartColor(entry.color, theme.palette[index % theme.palette.length]),
        },
        areaStyle:
          entry.area === false
            ? undefined
            : {
                opacity: 0.12,
                color: resolveChartColor(entry.color, theme.palette[index % theme.palette.length]),
              },
      })),
    } as EChartsOption;
  }, [categories, series, theme, dualAxis, yAxisFormatter]);

  // 窗口缩窄后，ECharts 的隐藏 HTML Tooltip 可能仍保留旧坐标。
  // 浮层查询限定在图内，容器也约束隐藏浮层，避免撑出页面横向滚动。
  return <Chart option={option} height={height} className="overflow-hidden" />;
}

/** 我的评分 vs 大众评分：散点图 + 一致线参考。 */
export function ComparisonScatter({
  points,
  height = 320,
}: {
  points: Array<{ id: number; name: string; myRate: number; bgmScore: number; delta: number }>;
  height?: number;
}) {
  const theme = useChartTheme();
  const option = useMemo<EChartsOption>(() => {
    const base = baseChartOption(theme);
    return {
      ...base,
      tooltip: {
        ...base.tooltip,
        trigger: 'item',
        formatter: (params: unknown) => {
          const item = params as { data: [number, number, string, number] };
          const [bgmScore, myRate, name, delta] = item.data;
          return `${name}<br/>我的评分 ${myRate} · 大众 ${bgmScore}<br/>差值 ${delta > 0 ? '+' : ''}${delta}`;
        },
      },
      // 散点图的两个轴都带名称（「我的评分」「Bangumi 平均分」），
      // 顶部在基准留白之上再让出轴名称的高度，避免单位文字被裁掉。
      // 两个轴都有名称：顶部让出「我的评分」，底部让出「Bangumi 平均分」
      grid: { ...base.grid, top: 58, bottom: 34 },
      xAxis: {
        type: 'value',
        name: 'Bangumi 平均分',
        nameLocation: 'middle',
        nameGap: 26,
        min: 3,
        max: 10,
        ...axisStyle(theme),
        nameTextStyle: { color: theme.subtle, fontSize: CHART_FONT.axisName },
        axisLabel: { color: theme.subtle, fontSize: CHART_FONT.axis },
      },
      yAxis: {
        type: 'value',
        name: '我的评分',
        min: 0,
        max: 10,
        ...axisStyle(theme),
        nameTextStyle: { color: theme.subtle, fontSize: CHART_FONT.axisName },
        axisLabel: { color: theme.subtle, fontSize: CHART_FONT.axis },
      },
      series: [
        {
          type: 'scatter',
          symbolSize: 9,
          data: points.map((point) => [
            point.bgmScore,
            point.myRate,
            point.name || `#${point.id}`,
            point.delta,
          ]),
          itemStyle: {
            color: theme.palette[0],
            opacity: 0.72,
            borderColor: theme.surface,
            borderWidth: 1,
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: theme.border, type: 'dashed' },
            label: {
              color: theme.subtle,
              fontSize: CHART_FONT.label,
              formatter: '评分一致线',
              position: 'insideEndTop',
            },
            data: [[{ coord: [3, 3] }, { coord: [10, 10] }]],
          },
        },
      ],
    } as EChartsOption;
  }, [points, theme]);

  return <Chart option={option} height={height} />;
}

/** 年份 × 季度热力图：观看节奏。 */
export function QuarterHeatmap({
  data,
  years,
  height = 260,
}: {
  data: Array<{ year: number; quarter: number; count: number }>;
  years: number[];
  height?: number;
}) {
  const theme = useChartTheme();
  const option = useMemo<EChartsOption>(() => {
    const max = Math.max(1, ...data.map((entry) => entry.count));
    const base = baseChartOption(theme);
    return {
      ...base,
      tooltip: {
        ...base.tooltip,
        formatter: (params: unknown) => {
          const item = params as { data: [number, number, number] };
          return `${item.data[0]} 年 Q${item.data[1] + 1}：${item.data[2]} 部`;
        },
      },
      grid: { left: 8, right: 12, top: 8, bottom: 40, containLabel: true },
      xAxis: {
        type: 'category',
        data: ['Q1', 'Q2', 'Q3', 'Q4'],
        ...axisStyle(theme),
        splitLine: { show: false },
        axisLine: { show: false },
      },
      yAxis: {
        type: 'category',
        data: years.map(String),
        ...axisStyle(theme),
        splitLine: { show: false },
        axisLine: { show: false },
        axisLabel: { color: theme.subtle, fontSize: CHART_FONT.axis },
      },
      visualMap: {
        min: 0,
        max,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 10,
        itemHeight: 70,
        textStyle: { color: theme.subtle, fontSize: CHART_FONT.label },
        inRange: { color: [theme.surface2, theme.palette[0]] },
      },
      series: [
        {
          type: 'heatmap',
          data: data.map((entry) => [entry.quarter - 1, years.indexOf(entry.year), entry.count]),
          label: {
            show: true,
            color: theme.text,
            fontSize: CHART_FONT.label,
            formatter: (params: unknown) => {
              const item = params as { data: [number, number, number] };
              return item.data[2] > 0 ? String(item.data[2]) : '';
            },
          },
          itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 4 },
        },
      ],
    } as EChartsOption;
  }, [data, years, theme]);

  return <Chart option={option} height={height} />;
}
