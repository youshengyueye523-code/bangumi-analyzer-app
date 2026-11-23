import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EChartsOption } from "echarts";

/**
 * 图表轴单位文字的回归测试。
 *
 * 背景：ECharts 的 yAxis.name（例如「部」「集」「人」）以「中心点对齐网格上边缘」
 * 绘制，grid.top 太小会把文字上半部分画到画布之外，视觉上就是「顶部单位被裁掉」。
 * 这里直接检查各图表生成的 option，保证单位文字始终有足够留白。
 */
const captured: EChartsOption[] = [];
const handlers = new Map<string, (params: unknown) => void>();

vi.mock("echarts/core", () => ({
  format: { getTextRect: (text: string) => ({ width: text.length * 6, height: 11 }) },
  use: () => undefined,
  init: () => ({
    setOption: (option: EChartsOption) => {
      captured.push(option);
    },
    resize: () => undefined,
    dispose: () => undefined,
    on: (name: string, handler: (params: unknown) => void) => handlers.set(name, handler),
    off: () => undefined,
  }),
}));
vi.mock("echarts/charts", () => ({
  BarChart: {},
  HeatmapChart: {},
  LineChart: {},
  PieChart: {},
  ScatterChart: {},
}));
vi.mock("echarts/components", () => ({
  DataZoomComponent: {},
  GraphicComponent: {},
  GridComponent: {},
  LegendComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
  VisualMapComponent: {},
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));

const { CategoryBar, DistributionDonut, RankedBar } = await import("./generic.js");
const { ComparisonScatter, QuarterHeatmap, TrendArea } = await import("./trend.js");
const { baseChartOption, readChartTheme } = await import("./chart.js");

/** 单位文字所需的最小顶部留白（与 baseChartOption 的基准值一致） */
const MIN_TOP = 40;
const theme = readChartTheme();

type AxisLike = { name?: string };
type OptionLike = { grid?: { top?: number }; yAxis?: unknown };

function yAxesOf(option: EChartsOption): AxisLike[] {
  const raw = (option as OptionLike).yAxis;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list as AxisLike[];
}

describe("图表顶部单位不被裁切", () => {
  it("基准 option 的 grid.top 留出单位文字空间", () => {
    expect((baseChartOption(theme) as OptionLike).grid?.top ?? 0).toBeGreaterThanOrEqual(MIN_TOP);
  });

  it("每个带单位名称的图表都留足顶部留白", () => {
    captured.length = 0;
    render(
      <>
        <DistributionDonut items={[{ name: "看过", value: 3 }]} />
        <CategoryBar categories={["2024"]} values={[3]} unit="部" />
        <CategoryBar categories={["2024"]} values={[3]} averageValues={[8]} unit="部" />
        <RankedBar items={[{ name: "日常", value: 3 }]} />
        <TrendArea categories={["2024"]} series={[{ name: "累计收藏", data: [3], area: true }]} />
        <ComparisonScatter points={[{ id: 1, name: "x", myRate: 9, bgmScore: 7, delta: 2 }]} />
        <QuarterHeatmap data={[{ year: 2024, quarter: 1, count: 3 }]} years={[2024]} />
      </>,
    );

    const withUnit = captured.filter((option) =>
      yAxesOf(option).some((axis) => typeof axis.name === "string" && axis.name.length > 0),
    );
    expect(withUnit.length).toBeGreaterThanOrEqual(3);
    for (const option of withUnit) {
      expect((option as OptionLike).grid?.top ?? 0).toBeGreaterThanOrEqual(MIN_TOP);
    }
  });

  it("单位名称只使用「部 / 集 / 人 / 个」这类可读单位", () => {
    const names = captured
      .flatMap((option) => yAxesOf(option))
      .map((axis) => axis.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(6);
  });
});

describe("趋势时间轴保留完整查询数据", () => {
  it("年 / 季 / 月长历史只抽稀刻度，保留所有序列、空评分和日期 Tooltip", () => {
    for (const categories of [
      Array.from({ length: 10 }, (_, i) => `${2017 + i} 年`),
      Array.from({ length: 40 }, (_, i) => `${2017 + Math.floor(i / 4)} 年 Q${i % 4 + 1}`),
      Array.from({ length: 120 }, (_, i) => `${2017 + Math.floor(i / 12)} 年 ${i % 12 + 1} 月`),
    ]) {
      const values = categories.map((_, i) => i + 1);
      const ratings = categories.map((_, i) => i % 2 === 0 ? null : 8);
      captured.length = 0;
      const view = render(<TrendArea categories={categories} dualAxis series={[
        { name: "累计收藏", data: values },
        { name: "平均评分", data: ratings, axis: 1 },
      ]} />);
      const option = captured.at(-1)!;
      expect(option.tooltip).toMatchObject({ trigger: "axis", confine: true });
      const axis = option.xAxis as { data: string[]; axisLabel: Record<string, unknown> };
      const series = option.series as Array<{ data: Array<number | null>; yAxisIndex: number }>;
      expect(axis.data).toEqual(categories);
      expect(axis.axisLabel).toMatchObject({ interval: "auto", showMinLabel: true, showMaxLabel: true, alignMinLabel: "left", alignMaxLabel: "right", hideOverlap: true });
      expect(series.map((item) => item.data)).toEqual([values, ratings]);
      expect(series.map((item) => item.yAxisIndex)).toEqual([0, 1]);
      const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter;
      // An intermediate date may have no visible tick; its Tooltip still uses the full label/value.
      expect(formatter({ seriesName: "累计收藏", name: categories[1], value: values[1] })).toBe(`累计收藏 · ${categories[1]}：2`);
      expect(formatter({ seriesName: "累计收藏", name: categories.at(-1), value: values.at(-1) })).toBe(`累计收藏 · ${categories.at(-1)}：${values.at(-1)}`);
      view.unmount();
    }
  });

  it("只有一个时间点时标签居中，保留零值", () => {
    captured.length = 0;
    render(<TrendArea categories={["2026 年 10 月"]} series={[{ name: "本期变动", data: [0] }]} />);
    const option = captured.at(-1)!;
    expect((option.xAxis as { axisLabel: Record<string, unknown> }).axisLabel.alignMinLabel).toBe("center");
    expect((option.series as Array<{ data: number[] }>)[0]?.data).toEqual([0]);
  });
});

describe('柱图时间浏览', () => {
  it('默认全量；显式时间窗口保留所有月份、null评分，并回传拖动范围', () => {
    const categories = Array.from({ length: 120 }, (_, i) => `月份 ${i}`);
    const values = categories.map((_, i) => i);
    const ratings = categories.map((_, i) => i % 2 ? 8 : null);
    captured.length = 0;
    const onChange = vi.fn();
    const view = render(<CategoryBar categories={categories} values={values} averageValues={ratings} />);
    expect(captured.at(-1)?.dataZoom).toBeUndefined();
    view.rerender(<CategoryBar categories={categories} values={values} averageValues={ratings} timeWindow={{ start: 80, end: 100 }} onTimeWindowChange={onChange} />);
    const option = captured.at(-1)!;
    expect(option.dataZoom).toMatchObject([{ start: 80, end: 100, filterMode: 'filter' }]);
    expect((option.xAxis as { data: string[] }).data).toEqual(categories);
    expect((option.series as Array<{ data: unknown[] }>).map(s => s.data)).toEqual([values, ratings]);
    handlers.get('datazoom')!({ batch: [{ start: 60, end: 80 }] });
    expect(onChange).toHaveBeenCalledWith({ start: 60, end: 80 });
    handlers.get('datazoom')!({ start: NaN, end: 100 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
