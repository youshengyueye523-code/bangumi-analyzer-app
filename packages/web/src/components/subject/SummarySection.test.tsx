import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { SubjectSummaryState } from "@bangumi-analyzer/shared";
import { ToastProvider } from "../ui/toast.js";
import { SummarySection } from "./SummarySection.js";

function makeState(patch: Partial<SubjectSummaryState> = {}): SubjectSummaryState {
  return {
    subjectId: 1,
    chinese: "",
    chineseSource: "none",
    bilingual: false,
    original: "「かぐや様は告らせたい」の赤坂アカ原作による人気コミックをアニメ化した作品。",
    originalLanguage: "ja",
    translatable: true,
    unsupportedReason: "",
    status: "pending",
    stale: false,
    translationModel: "",
    translationProvider: "",
    translationUpdatedAt: null,
    translationError: null,
    queued: true,
    jobId: 1,
    attempts: 0,
    ...patch,
  };
}

function renderSection(state: SubjectSummaryState) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <SummarySection state={state} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("作品简介双语展示", () => {
  it("没有简介时显示暂无简介，不出现任何翻译操作", () => {
    renderSection(makeState({ original: "", originalLanguage: "empty", translatable: false, status: "idle" }));
    expect(screen.getByText(/暂无简介/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "立即翻译" })).toBeNull();
  });

  it("纯官方中文简介（没有原文段）：正常显示，不显示暂无简介、不提供翻译按钮", () => {
    const chinese = "这是一个来自 Bangumi 的官方中文简介，内容足够长用于展示。";
    renderSection(
      makeState({
        chinese,
        chineseSource: "bangumi",
        original: "",
        originalLanguage: "zh",
        translatable: false,
        status: "idle",
      }),
    );
    expect(screen.getByText("官方中文")).toBeTruthy();
    expect(screen.getByText(chinese)).toBeTruthy();
    expect(screen.queryByText(/暂无简介/)).toBeNull();
    expect(screen.queryByRole("button", { name: /翻译/ })).toBeNull();
  });

  it("AI 翻译：中文在上、原文默认折叠，可独立展开", () => {
    const chinese = "这是一段由本地 AI 生成的中文简介，用来验证展示顺序与折叠行为。";
    renderSection(
      makeState({ chinese, chineseSource: "ai", status: "completed", queued: false, translationModel: "mock" }),
    );
    expect(screen.getAllByText("AI 翻译").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(chinese)).toBeTruthy();
    // 原文默认折叠
    const toggle = screen.getByRole("button", { name: /Bangumi 原文/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/かぐや様は告らせたい/)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/かぐや様は告らせたい/)).toBeTruthy();
    // 展开原文不影响中文
    expect(screen.getByText(chinese)).toBeTruthy();
  });

  it("只有日文原文时默认展开，避免出现空白区域", () => {
    renderSection(makeState({ status: "pending" }));
    expect(screen.getByText(/かぐや様は告らせたい/)).toBeTruthy();
    expect(screen.getByText("待翻译")).toBeTruthy();
  });

  it("翻译失败时显示原因与重试按钮，并且不显示假的译文", () => {
    renderSection(makeState({ status: "failed", translationError: "AI 接口限流", queued: false }));
    expect(screen.getAllByText(/翻译失败/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/AI 接口限流/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试失败" })).toBeTruthy();
  });

  it("AI 未配置：显示待配置提示而不是空白", () => {
    renderSection(makeState({ status: "waiting_ai", translationError: "缺少 AI API Key", queued: false }));
    expect(screen.getAllByText(/待配置 AI/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/缺少 AI API Key/)).toBeTruthy();
  });

  it("语言无法识别：保留原文并说明原因，不调用 AI", () => {
    renderSection(
      makeState({
        original: "A story about a girl and a robot travelling through space.",
        originalLanguage: "other",
        translatable: false,
        unsupportedReason: "暂无法识别语言，已保留原文（未调用 AI）",
        status: "idle",
        queued: false,
      }),
    );
    expect(screen.getByText(/暂无法识别语言/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "立即翻译" })).toBeNull();
  });

  it("英文简介同样进入翻译队列，并提供立即翻译入口", () => {
    renderSection(
      makeState({
        original: "A high school girl discovers a mysterious robot and travels across the galaxy.",
        originalLanguage: "en",
        translatable: true,
        status: "pending",
        queued: true,
      }),
    );
    // 原文语言标注为英文
    expect(screen.getByText(/Bangumi 原文（英文）/)).toBeTruthy();
    expect(screen.getByText(/已进入翻译队列/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消任务" })).toBeTruthy();
  });

  it("语言无法识别：保留原文并提示未调用 AI", () => {
    renderSection(
      makeState({
        original: "1234 / 5678 / 9012",
        originalLanguage: "unknown",
        translatable: false,
        unsupportedReason: "暂无法识别语言，已保留原文（未调用 AI）",
        status: "idle",
        queued: false,
      }),
    );
    expect(screen.getByText(/暂无法识别语言/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "立即翻译" })).toBeNull();
  });

  it("原文更新后仍显示旧译文，并明确标注基于旧版原文", () => {
    const chinese = "这是一段基于旧版原文的中文翻译，仍然可以阅读。";
    renderSection(makeState({ chinese, chineseSource: "ai", status: "pending", stale: true }));
    expect(screen.getByText(chinese)).toBeTruthy();
    expect(screen.getAllByText(/基于旧版原文/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/重新翻译完成后会自动替换/)).toBeTruthy();
  });

  it("中文与原文使用同一级正文字号（不做成小字备注）", () => {
    const chinese = "这是一段由本地 AI 生成的中文简介，用来验证字号与原文保持一致。";
    renderSection(makeState({ chinese, chineseSource: "ai", status: "completed", queued: false }));
    fireEvent.click(screen.getByRole("button", { name: /Bangumi 原文/ }));

    const zh = screen.getByText(chinese);
    const ja = screen.getByText(/かぐや様は告らせたい/);
    for (const node of [zh, ja]) {
      expect(node.className).toContain("text-body");
      expect(node.className).toContain("leading-7");
    }
    // 中文不再使用更小的 note 字号
    expect(zh.className).not.toContain("text-note");
  });

  it("Bangumi 双语简介：中文标注来源并说明结构，原文可对照", () => {
    const chinese = "出生良好家庭，亲朋好友团聚，时哭时笑，这是谁都拥有的日常生活。";
    renderSection(
      makeState({
        chinese,
        chineseSource: "bangumi",
        bilingual: true,
        status: "idle",
        queued: false,
        translatable: false,
      }),
    );
    expect(screen.getByText(/Bangumi 官方中文简介（Bangumi 双语简介）/)).toBeTruthy();
    expect(screen.getByText(/这条简介在 Bangumi 上就是「日文原文 \+ 官方中文」结构/)).toBeTruthy();
    // 分隔标记绝不能出现在页面上
    expect(screen.queryByText(/\[中文简介\]/)).toBeNull();
    expect(screen.queryByRole("button", { name: /翻译/ })).toBeNull();
  });
});
