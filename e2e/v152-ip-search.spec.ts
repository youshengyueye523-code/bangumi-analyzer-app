import { expect, test } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

/**
 * v1.5.2 Series / IP 域内「伪全局搜索」。
 *
 * 覆盖：部分匹配、成员作品聚合、别名召回、单成员系列（列表隐藏但可搜索）、
 * URL 状态（刷新 / 返回）、Franchise 模式聚合、空状态。
 */

test.describe('Series / IP 域内搜索', () => {
  test('输入稳定性：连续输入 / 退格 / 替换 / 粘贴都不重建输入框、不丢焦点', async ({ page }) => {
    await gotoAndWait(page, '/series');
    const input = page.getByPlaceholder(/搜索 Series/);
    await input.click();
    // 记录初始 DOM 节点与位置，用于验证「结果刷新不会重建 input」
    await page.evaluate(() => {
      const el = document.querySelector('input[placeholder*="搜索 Series"]');
      (window as unknown as { __searchInput?: Element | null; __searchTop?: number }).__searchInput = el;
      (window as unknown as { __searchTop?: number }).__searchTop =
        el?.getBoundingClientRect().top ?? 0;
    });

    await input.pressSequentially('孤独', { delay: 60 });
    await page.waitForTimeout(600);
    const afterTyping = await page.evaluate(() => {
      const state = window as unknown as { __searchInput?: Element | null; __searchTop?: number };
      const el = document.querySelector('input[placeholder*="搜索 Series"]') as HTMLInputElement;
      return {
        sameNode: el === state.__searchInput,
        focused: document.activeElement === el,
        value: el.value,
        stableTop: Math.abs(el.getBoundingClientRect().top - (state.__searchTop ?? 0)) < 1,
      };
    });
    expect(afterTyping).toEqual({ sameNode: true, focused: true, value: '孤独', stableTop: true });
    await expect(page.locator('a[href^="/series/"]').first()).toContainText('孤独摇滚！');

    // 退格
    await input.press('Backspace');
    await page.waitForTimeout(300);
    await expect(input).toHaveValue('孤');
    await expect(input).toBeFocused();

    // Ctrl/Cmd+A 全选替换
    await input.press('ControlOrMeta+a');
    await input.pressSequentially('物语', { delay: 60 });
    await page.waitForTimeout(500);
    await expect(input).toHaveValue('物语');
    await expect(input).toBeFocused();

    // 粘贴（等价 insertText）
    await input.press('ControlOrMeta+a');
    await page.keyboard.insertText('石头门');
    await page.waitForTimeout(600);
    await expect(input).toHaveValue('石头门');
    await expect(input).toBeFocused();
    await expect(page.locator('a[href^="/series/"]').first()).toContainText('命运石之门');

    // 清空：结果消失、恢复普通列表、不残留旧结果
    await input.press('ControlOrMeta+a');
    await input.press('Backspace');
    await page.waitForTimeout(500);
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(page.getByText(/系列共 \d+ 部/).first()).toBeVisible();
  });

  test('中文输入法组合阶段不会重建输入框（composition 事件）', async ({ page }) => {
    await gotoAndWait(page, '/series');
    const input = page.getByPlaceholder(/搜索 Series/);
    await input.click();
    await page.evaluate(() => {
      const el = document.querySelector('input[placeholder*="搜索 Series"]');
      (window as unknown as { __searchInput?: Element | null }).__searchInput = el;
      el?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await page.keyboard.insertText('物');
    await page.evaluate(() => {
      const el = document.querySelector('input[placeholder*="搜索 Series"]');
      el?.dispatchEvent(new CompositionEvent('compositionupdate', { data: '物', bubbles: true }));
    });
    await page.keyboard.insertText('语');
    await page.evaluate(() => {
      const el = document.querySelector('input[placeholder*="搜索 Series"]');
      el?.dispatchEvent(new CompositionEvent('compositionend', { data: '物语', bubbles: true }));
    });
    await page.waitForTimeout(600);

    const state = await page.evaluate(() => {
      const ref = (window as unknown as { __searchInput?: Element | null }).__searchInput;
      const el = document.querySelector('input[placeholder*="搜索 Series"]') as HTMLInputElement;
      return { sameNode: el === ref, focused: document.activeElement === el, value: el.value };
    });
    expect(state).toEqual({ sameNode: true, focused: true, value: '物语' });
    await expect(page.locator('a[href^="/series/"]').first()).toContainText('物语系列');
  });

  test('成员作品命中聚合成 Series，并且可以进入详情 / 返回 / 刷新', async ({ page }) => {
    await gotoAndWait(page, '/series');
    const input = page.getByPlaceholder(/搜索 Series/);
    await input.fill('Fine');

    const results = page.locator('a[href^="/series/"]');
    await expect(results.first()).toContainText('路人女主的养成方法');
    await expect(results.first()).toContainText(/命中成员/);

    await results.first().click();
    await page.waitForURL(/\/series\/[^/]+$/);
    await waitForReady(page);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('路人女主的养成方法');

    // 返回后搜索状态保留
    await page.goBack();
    await page.waitForURL(/\/series\?q=Fine/);
    await expect(page.getByPlaceholder(/搜索 Series/)).toHaveValue('Fine');
    await expect(page.locator('a[href^="/series/"]').first()).toContainText('路人女主的养成方法');

    // 刷新后仍然保留查询
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByPlaceholder(/搜索 Series/)).toHaveValue('Fine');
    await expect(page.locator('a[href^="/series/"]').first()).toContainText('路人女主的养成方法');
  });

  test('别名与单成员系列都可以被搜到（含列表默认隐藏的实体）', async ({ page }) => {
    await gotoAndWait(page, '/series');
    const input = page.getByPlaceholder(/搜索 Series/);

    await input.fill('小镇家族');
    await expect(page.locator('a[href^="/series/"]').first()).toContainText('CLANNAD');

    await input.fill('超辉夜姬');
    const singleton = page.locator('a[href^="/series/"]').first();
    // 单成员系列的展示标题允许被人工确认修改（例如「超辉夜姬」→「超时空辉夜姬！」），
    // 因此这里只断言「可以通过旧名称召回同一实体」，不锁定具体标题文本。
    await expect(singleton).toContainText('辉夜姬');
    await expect(singleton).toContainText(/已知 1 部/);
    await singleton.click();
    await page.waitForURL(/\/series\/sr_369$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('辉夜姬');
  });

  test('Franchise 模式：成员 / Series 命中聚合到家族并可进入详情', async ({ page }) => {
    // 从 Series 模式带 query 切换过去：query 必须连续
    await gotoAndWait(page, '/series');
    await page.getByPlaceholder(/搜索 Series/).fill('物语');
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Franchise' }).click();
    await page.waitForURL(/\/franchises\?q=/);

    const input = page.getByPlaceholder(/搜索 Franchise/);
    await expect(input).toHaveValue('物语');

    const first = page.locator('a[href^="/franchises/"]').first();
    await expect(first).toContainText('物语系列');
    await first.click();
    await page.waitForURL(/\/franchises\/[^/]+$/);
    await waitForReady(page);
    await expectNoErrorState(page);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('物语系列');
  });

  test('无结果时给出明确空状态', async ({ page }) => {
    await gotoAndWait(page, '/series');
    await page.getByPlaceholder(/搜索 Series/).fill('不存在的系列名称XYZ');
    await expect(page.getByText(/没有找到匹配的 Series/)).toBeVisible();
    await expect(page.getByText(/搜索域是全部 Series/)).toBeVisible();
  });

  test('命中原因语义去重：同一名称不会同时显示别名与成员两条', async ({ page }) => {
    await gotoAndWait(page, '/series');
    await page.getByPlaceholder(/搜索 Series/).fill('化物语');

    const first = page.locator('a[href^="/series/"]').first();
    await expect(first).toContainText('物语系列');
    const reasonLine = first.locator('p.text-caption.text-muted');
    await expect(reasonLine).toHaveText('命中成员：化物语');
    // 同一文本只出现一次，且不出现「等 N 条命中」
    const text = (await reasonLine.textContent()) ?? '';
    expect((text.match(/化物语/g) ?? []).length).toBe(1);
    expect(text).not.toContain('等');
  });
});
