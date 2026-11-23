import { useMemo } from 'react';
import type { TimelinePoint } from '@bangumi-analyzer/shared';
import type { EChartsOption } from 'echarts';
import { Chart, CHART_FONT, axisStyle, baseChartOption, useChartTheme } from './chart.js';
import { overviewBuckets } from '../../lib/timeline.js';

import { formatTimePeriod, useTimeAxis } from './timeAxis.js';

export function TimelineOverview({
  points,
  selectedFrom,
  selectedTo,
  onLocate,
  currentRange = false,
}: {
  points: TimelinePoint[];
  selectedFrom: string;
  selectedTo: string;
  onLocate?: (first: string, last: string) => void;
  currentRange?: boolean;
}) {
  const theme = useChartTheme();
  // The main chart receives only the displayed range, with one unmodified value per period.
  // Historical bucketing remains exclusive to the optional full-history overview.
  const grouped = useMemo(() => currentRange ? {
    step: 1,
    buckets: points.map((p) => ({ first: p.period, last: p.period, added: p.added, recorded: p.added > 0 ? 1 : 0 })),
  } : overviewBuckets(points), [points, currentRange]);
  const categories = useMemo(() => grouped.buckets.map(b => b.first === b.last ? b.first : `${b.first} → ${b.last}`), [grouped]);
  const labels = useMemo(() => grouped.buckets.map(b => b.first === b.last ? formatTimePeriod(b.first) : `${formatTimePeriod(b.first)} → ${formatTimePeriod(b.last)}`), [grouped]);
  const values = useMemo(() => grouped.buckets.map(b => b.added), [grouped]);
  const { container, layout } = useTimeAxis(categories, labels, values, false,
    String(baseChartOption(theme).textStyle?.fontFamily ?? 'sans-serif'));
  const option = useMemo<EChartsOption>(
    () => ({
      ...baseChartOption(theme),
      animation: false,
      grid: { left: layout.left, right: layout.right, top: 12, bottom: CHART_FONT.axis * 2.5, containLabel: false },
      tooltip: {
        ...baseChartOption(theme).tooltip,
        trigger: 'axis',
        confine: true,
        renderMode: 'richText',
        formatter: (raw: unknown) => {
          const item = (raw as Array<{ dataIndex: number }>)[0],
            b = item && grouped.buckets[item.dataIndex];
          return b
            ? `${b.first}${b.first === b.last ? '' : ` → ${b.last}`}\n归集 ${b.added} 部 · 有记录 ${b.recorded} 期`
            : '';
        },
      },
      xAxis: {
        type: 'category',
        ...axisStyle(theme),
        data: categories,
        boundaryGap: true,
        axisTick: { show: false, alignWithLabel: true },
        axisLabel: {
          ...axisStyle(theme).axisLabel,
          interval: (index: number) => layout.ticks.has(index),
          formatter: (_value: string, index: number) => labels[index] ?? '',
          align: 'center',
          showMinLabel: true,
          showMaxLabel: true,
          hideOverlap: false,
          alignMinLabel: 'center',
          alignMaxLabel: 'center',
        },
      },
      yAxis: { type: 'value', min: 0, minInterval: 1, ...axisStyle(theme), splitNumber: 2 },
      series: [
        {
          type: 'bar',
          name: '归集数量',
          data: grouped.buckets.map((b) => ({
            value: b.added,
            itemStyle: {
              color: currentRange || (b.last >= selectedFrom && b.first <= selectedTo) ? theme.accent : theme.subtle,
              opacity: currentRange || (b.last >= selectedFrom && b.first <= selectedTo) ? 1 : 0.4,
            },
          })),
          barMaxWidth: 24,
          large: currentRange && points.length > 1000,
          largeThreshold: 1000,
        },
        // A baseline dot locates sparse records even when their linear bar is dwarfed by a peak.
        {
          type: 'scatter',
          name: '有记录',
          data: grouped.buckets.map((b) => (b.recorded > 0 ? 0 : null)),
          symbolSize: 5,
          itemStyle: { color: theme.accent },
          z: 5,
        },
      ],
    }),
    [theme, grouped, categories, labels, layout, selectedFrom, selectedTo, currentRange, points.length],
  );
  const events = useMemo(
    () => ({
      click: (raw: unknown) => {
        const i = (raw as { dataIndex?: number }).dataIndex,
          b = i === undefined ? undefined : grouped.buckets[i];
        if (b) onLocate?.(b.first, b.last);
      },
    }),
    [grouped, onLocate],
  );
  return (
    <div ref={container}>
      <Chart option={option} height={145} onEvents={onLocate ? events : undefined} />
      <p className="mt-2 text-caption text-muted">
        {grouped.step > 1 ? `概览每柱合并最多 ${grouped.step} 期，数量求和；横轴为该柱的完整周期区间；` : ''}
        {currentRange
          ? '仅显示当前范围 · 归集数量 / 部 · 真实线性尺度；基线圆点标记有记录的时期。'
          : '基线圆点标记有记录的时期。点击定位，精确起止也可用下方范围入口选择。'}
      </p>
    </div>
  );
}

export function TimelineMetricChart({
  points,
  metric,
}: {
  points: TimelinePoint[];
  metric: 'added' | 'episodes' | 'averageRate' | 'total';
}) {
  const theme = useChartTheme();
  const line = metric === 'averageRate' || metric === 'total';
  const name = metric === 'averageRate' ? '分 · 0–10' : metric === 'episodes' ? '集' : '部';
  const periods = useMemo(() => points.map(p => p.period), [points]);
  const labels = useMemo(() => periods.map(formatTimePeriod), [periods]);
  const values = useMemo(() => points.map(p => p[metric]), [points, metric]);
  const { container, layout } = useTimeAxis(periods, labels, values, line,
    String(baseChartOption(theme).textStyle?.fontFamily ?? 'sans-serif'), name);
  const option = useMemo<EChartsOption>(() => {
    const rating = metric === 'averageRate',
      line = rating || metric === 'total';
    const color = rating
      ? theme.palette[2]
      : metric === 'episodes'
        ? theme.palette[6]
        : theme.accent;
    return {
      ...baseChartOption(theme),
      animation: false,
      grid: { left: layout.left, right: layout.right, top: 28, bottom: CHART_FONT.axis * 2.5, containLabel: false },
      tooltip: {
        ...baseChartOption(theme).tooltip,
        trigger: 'axis',
        confine: true,
        renderMode: 'richText',
        formatter: (raw: unknown) => {
          const i = (raw as Array<{ dataIndex: number }>)[0]?.dataIndex,
            p = i === undefined ? undefined : points[i];
          if (!p) return '';
          return `${p.label}\n${rating ? `平均评分：${p.averageRate ?? '无有效评分'}\n评分样本：${p.ratingSample?.ratedCount ?? '未提供'}` : `${metric === 'episodes' ? '归集集数' : metric === 'total' ? '累计归集' : '归集数量'}：${p[metric]}${metric === 'episodes' ? ' 集' : ' 部'}`}`;
        },
      },
      xAxis: {
        type: 'category',
        data: periods,
        ...axisStyle(theme),
        boundaryGap: !line,
        axisTick: { show: false, alignWithLabel: true },
        axisLabel: {
          ...axisStyle(theme).axisLabel,
          interval: (index: number) => layout.ticks.has(index),
          formatter: (_value: string, index: number) => labels[index] ?? '',
          align: 'center',
          showMinLabel: true,
          showMaxLabel: true,
          hideOverlap: false,
          alignMinLabel: 'center',
          alignMaxLabel: 'center',
        },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: rating ? 10 : undefined,
        minInterval: rating ? undefined : 1,
        name: rating ? '分 · 0–10' : metric === 'episodes' ? '集' : '部',
        ...axisStyle(theme),
      },
      series: [
        {
          type: line ? 'line' : 'bar',
          data: points.map((p) => p[metric]),
          itemStyle: { color },
          lineStyle: { color, width: 2 },
          symbol: 'circle',
          symbolSize: 6,
          showSymbol: points.length <= 40,
          connectNulls: false,
          barMaxWidth: 30,
          large: !line && points.length > 1000,
          largeThreshold: 1000,
          progressive: 3000,
        },
      ],
    } as EChartsOption;
  }, [theme, points, metric, periods, labels, layout]);
  return <div ref={container}><Chart option={option} height={230} /></div>;
}
