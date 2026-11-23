import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/toast.js";
import { TooltipProvider } from "../components/ui/overlay.js";

/**
 * 图表用 canvas 渲染，jsdom 没有 canvas 实现；
 * 本测试只验证 KPI 的语义，因此把图表组件替换为空实现。
 */
vi.mock("../components/charts/generic.js", () => ({
  CategoryBar: () => null,
  DistributionDonut: () => null,
  RankedBar: () => null,
  ChartSkeleton: () => null,
}));
vi.mock("../components/charts/trend.js", () => ({
  ComparisonScatter: () => null,
  QuarterHeatmap: () => null,
  TrendArea: () => null,
}));

const { DashboardPage } = await import("./DashboardPage.js");

/**
 * Dashboard KPI 语义测试（v1.4.2.1）。
 *
 * 目标：标题 / 主数字 / 辅助文本 / 分母必须属于同一个统计口径，
 * 不能出现「数学正确但用户会理解错」的指标（例如把集数进度当成收藏完成率）。
 */

const OVERVIEW = {
  total: 432,
  statusCounts: { '1': 217, '2': 203, '3': 0, '4': 12, '5': 0 },
  ratedCount: 228,
  unratedCount: 204,
  averageRate: 8.14,
  medianRate: 8,
  averageBgmScore: 7.9,
  completionRate: 0.4699,
  highRatedCount: 177,
  lowRatedCount: 1,
  unfinishedCount: 229,
  watchedEpisodes: 5002,
  totalEpisodes: 5146,
  progressRatio: 0.972,
  progressCountedSubjects: 215,
  estimatedMinutes: 125100,
  meanDelta: 0.26,
  yearRange: { min: 1947, max: 2026 },
  detailCoverage: { synced: 432, total: 432, ratio: 1 },
  relationsCoverage: { synced: 432, total: 432, ratio: 1 },
  lastSyncAt: '2026-09-17T02:00:00.000Z',
  lastSyncSummary: null,
  dataVersion: 7,
};

function installFetchMock(options: { hideNsfw?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.startsWith("/api/stats/overview")) return json(OVERVIEW);
    if (url.startsWith("/api/config")) return json({ hideNsfw: options.hideNsfw === true });
    if (url.startsWith("/api/stats/dashboard")) {
      return json({
        overview: options.hideNsfw === true ? { ...OVERVIEW, total: 401 } : OVERVIEW,
        hideNsfw: options.hideNsfw === true,
        distributions: {
          status: [],
          rate: [],
          year: [],
          format: [],
          tag: [],
          original: [],
          season: [],
        },
        timeline: { granularity: 'year', note: '', points: [] },
        bias: { count: 0, meanDelta: null, scatter: [], loved: [], disliked: [] },
        recentlyUpdated: [],
        recentlyAdded: [],
        inProgress: [],
      });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
      status: 404,
      headers: { "content-type": 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <DashboardPage />
          </MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("Dashboard KPI 语义", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installFetchMock();
  });

  it("完成率 = 看过 / 收藏总量，辅助文本给出分子分母", async () => {
    renderPage();
    const label = await screen.findByText("完成率");
    const card = label.closest("section") ?? label.parentElement?.parentElement;
    expect(card?.textContent).toContain("47.0%");
    expect(card?.textContent).toContain("已看 203 / 收藏 432");
    // 不能再用「未完成 N 部」这种把搁置数量当未完成的说法
    expect(card?.textContent).not.toContain("未完成");
    expect(screen.queryByText(/未完成 \d+ 部/)).toBeNull();
  });

  it("收藏状态卡片展示 看完 / 收藏 与各状态分布", async () => {
    renderPage();
    expect(await screen.findByText("收藏状态")).toBeTruthy();
    expect(await screen.findByText("203 / 432")).toBeTruthy();
    expect(screen.getByText(/想看 217 · 在看 0 · 搁置 12 · 抛弃 0/)).toBeTruthy();
  });

  it("集数进度单独命名，并说明分母口径", async () => {
    renderPage();
    const label = await screen.findByText("已看集数进度");
    const card = label.closest("section") ?? label.parentElement?.parentElement;
    expect(card?.textContent).toContain("5,002 / 5,146 集");
    expect(card?.textContent).toContain("按 215 部可计算条目的总集数统计");
    expect(card?.textContent).toContain("不含想看");
    // 旧的误导性标题必须消失
    expect(screen.queryByText("累计观看进度")).toBeNull();
    // 97.2% 不能被当成一个独立的「完成度」指标出现
    const percentTexts = screen.queryAllByText(/^97\.2%$/);
    expect(percentTexts.length).toBe(0);
  });

  it("状态数量之和等于收藏总量（渲染出的五个状态 + 总量）", async () => {
    renderPage();
    await screen.findByText("收藏总量");
    const readValue = (label: string) => {
      const el = screen.getByText(label);
      const card = el.closest("section") ?? el.parentElement?.parentElement;
      return Number((card?.querySelector("[data-stat-value]")?.textContent ?? "").replace(/[^\d]/g, ""));
    };
    const total = readValue("收藏总量");
    const sum = ["看过", "想看", "在看", "搁置", "抛弃"].reduce((acc, label) => acc + readValue(label), 0);
    expect(sum).toBe(total);
    await waitFor(() => expect(total).toBe(432));
  });

  it("隐藏关闭时不显示口径说明", async () => {
    renderPage();
    await screen.findByText("收藏总量");
    expect(screen.queryByText(/当前可见口径/)).toBeNull();
  });

  it("隐藏开启时使用确认的当前可见口径文案", async () => {
    installFetchMock({ hideNsfw: true });
    renderPage();
    expect(await screen.findByText('当前可见口径：已隐藏的 NSFW 内容不计入本页统计（数据未被删除，可在「设置」中恢复）。')).toBeTruthy();
  });

  it('Dashboard 根据设置双向切换查询缓存，并保留原有同步时间标签', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPage(client);
    await screen.findByText(/当前可见 432 部动画 · 上次成功同步/);
    installFetchMock({ hideNsfw: true });
    await act(async () => { client.setQueryData(['config'], { hideNsfw: true }); });
    await screen.findByText(/当前可见 401 部动画 · 上次成功同步/);
    expect(screen.queryByText(/当前可见 432 部动画/)).toBeNull();
    installFetchMock({ hideNsfw: false });
    await act(async () => { client.setQueryData(['config'], { hideNsfw: false }); });
    await screen.findByText(/当前可见 432 部动画 · 上次成功同步/);
    expect(screen.queryByText(/当前可见 401 部动画/)).toBeNull();
  });
});
