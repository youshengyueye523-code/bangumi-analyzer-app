import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "./overlay.js";
import { SelectMenu } from "./form.js";

/**
 * 二级选择统一组件（SelectMenu）。
 *
 * 重点验证：
 *   - 选项内容 / 顺序 / 选中标记正确；
 *   - 选择后回调拿到正确的值；
 *   - 展开层由 Radix Dropdown 渲染（不是原生 <select>），因此能继承设计 token；
 *   - disabled 时不可展开。
 */
function Harness({
  initial = 2,
  disabled = false,
  onChange,
}: {
  initial?: number;
  disabled?: boolean;
  onChange?: (value: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TooltipProvider>
      <SelectMenu
        ariaLabel="翻译并发数"
        value={value}
        disabled={disabled}
        options={[1, 2, 3, 4, 6, 8].map((option) => ({ value: option, label: `${option} 个并发` }))}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </TooltipProvider>
  );
}

function renderMenu(props: Parameters<typeof Harness>[0] = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

describe("SelectMenu（二级选择统一组件）", () => {
  it("默认渲染当前值，并且不使用原生 select", () => {
    const { container } = renderMenu({ initial: 4 });
    expect(screen.getByRole("button", { name: "翻译并发数" }).textContent).toContain("4 个并发");
    // 原生 select 的展开层无法继承设计 token，这里必须是按钮 + 浮层
    expect(container.querySelector("select")).toBeNull();
  });

  it("展开后列出全部选项（顺序与传入一致）并标记当前选中项", async () => {
    renderMenu({ initial: 2 });
    await userEvent.click(screen.getByRole("button", { name: "翻译并发数" }));
    const items = await screen.findAllByRole("menuitem");
    const labels = ["1 个并发", "2 个并发", "3 个并发", "4 个并发", "6 个并发", "8 个并发"];
    expect(items.length).toBe(labels.length);
    labels.forEach((label, index) => {
      expect(items[index]?.textContent).toContain(label);
    });
    // 当前值带选中标记
    expect(items[1]?.textContent).toContain("✓");
    expect(items[0]?.textContent).not.toContain("✓");
  });

  it("选择其他选项会触发回调并更新显示", async () => {
    const onChange = vi.fn();
    renderMenu({ initial: 2, onChange });
    await userEvent.click(screen.getByRole("button", { name: "翻译并发数" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /8 个并发/ }));
    expect(onChange).toHaveBeenCalledWith(8);
    expect(screen.getByRole("button", { name: "翻译并发数" }).textContent).toContain("8 个并发");
  });

  it("键盘可以打开并按方向键选择（保持原生 select 的键盘可用性）", async () => {
    const onChange = vi.fn();
    renderMenu({ initial: 1, onChange });
    const trigger = screen.getByRole("button", { name: "翻译并发数" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.length).toBe(6);
    items[2]!.focus();
    fireEvent.keyDown(items[2]!, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("disabled 时不可展开", async () => {
    renderMenu({ disabled: true });
    const trigger = screen.getByRole("button", { name: "翻译并发数" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    await userEvent.click(trigger);
    expect(screen.queryAllByRole("menuitem").length).toBe(0);
  });
});
