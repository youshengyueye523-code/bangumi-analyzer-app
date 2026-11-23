import { expect, test } from '@playwright/test';
import { expectNoErrorState, gotoAndWait, waitForReady } from './helpers.js';

test.describe('核心页面与交互', () => {
  test('仪表盘展示关键指标与图表', async ({ page }) => {
    await gotoAndWait(page, '/');
    await expectNoErrorState(page);

    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
    await expect(page.getByText('收藏总量')).toBeVisible();
    await expect(page.getByText('看过', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('完成率')).toBeVisible();
    await expect(page.getByText('估算观看时长')).toBeVisible();

    // 图表使用 canvas 渲染
    await expect(page.locator('canvas').first()).toBeVisible();
    expect(await page.locator('canvas').count()).toBeGreaterThanOrEqual(5);
  });

  test('顶栏同步按钮可打开同步面板', async ({ page }) => {
    await gotoAndWait(page, '/');
    await page.getByRole('button', { name: /Bangumi 数据同步|同步/ }).first().click();
    await expect(page.getByText('Bangumi 数据同步')).toBeVisible();
    await expect(page.getByRole('button', { name: '增量同步' })).toBeVisible();
  });

  test('收藏库支持搜索、状态筛选与分页', async ({ page }) => {
    await gotoAndWait(page, '/library');
    await expectNoErrorState(page);

    const cards = page.locator('article');
    await expect(cards.first()).toBeVisible();
    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThan(0);

    // 主搜索栏（顶栏）是收藏库唯一的搜索入口
    const firstTitle = (await cards.first().locator('h3').innerText()).trim();
    const keyword = firstTitle.slice(0, Math.min(4, firstTitle.length));
    const searchBox = page.getByRole('searchbox', { name: /搜索作品 \/ 标签/ });
    await searchBox.fill(keyword);
    await searchBox.press('Enter');
    await expect(page).toHaveURL(/q=/);
    await expect(page.getByText(new RegExp(`全局搜索：「${keyword}」`))).toBeVisible();
    await expect(cards.first()).toBeVisible();
    const filtered = await cards.count();
    expect(filtered).toBeLessThanOrEqual(initialCount);

    // 清除关键词
    await page.getByRole('button', { name: '清除搜索关键词' }).click();
    await expect(page).not.toHaveURL(/q=/);
    await waitForReady(page);

    // 状态筛选
    await page.getByRole('button', { name: /看过/ }).first().click();
    await expect(page).toHaveURL(/status=2/);
    await waitForReady(page);

    // 分页
    const nextButton = page.getByRole('button', { name: '下一页' });
    if (await nextButton.isEnabled()) {
      await nextButton.click();
      await expect(page).toHaveURL(/page=2/);
      await waitForReady(page);
    }
  });

  test('高级筛选可以组合条件并清除', async ({ page }) => {
    await gotoAndWait(page, '/library');
    await page.getByRole('button', { name: /高级筛选/ }).click();
    await expect(page.getByText('高级筛选').first()).toBeVisible();

    await page.getByLabel('起始年份').fill('2015');
    await page.getByLabel('结束年份').fill('2020');
    await page.getByRole('button', { name: '完成' }).click();

    await expect(page).toHaveURL(/yearFrom=2015/);
    await expect(page).toHaveURL(/yearTo=2020/);
    await waitForReady(page);

    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(page).not.toHaveURL(/yearFrom/);
  });

  test('列表视图切换生效', async ({ page }) => {
    await gotoAndWait(page, '/library');
    await page.getByRole('button', { name: '列表视图' }).click();
    await expect(page.getByText(/大众/).first()).toBeVisible();
    await page.getByRole('button', { name: '卡片视图' }).click();
    await expect(page.locator('article').first()).toBeVisible();
  });

  test('作品详情页展示完整信息并可跳转 Bangumi', async ({ page }) => {
    await gotoAndWait(page, '/library');
    await page.locator('article a').first().click();
    await expect(page).toHaveURL(/\/subjects\/\d+/);
    await waitForReady(page);
    await expectNoErrorState(page);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('基本信息')).toBeVisible();
    await expect(page.getByText('制作人员')).toBeVisible();
    await expect(page.getByText('原始数据')).toBeVisible();

    const bangumiLink = page.getByRole('link', { name: /打开 Bangumi 页面/ });
    await expect(bangumiLink).toHaveAttribute('href', /bgm\.tv\/subject\/\d+/);

    await page.getByText('展开条目原始 JSON / 收藏原始 JSON').click();
    await expect(page.locator('pre').first()).toBeVisible();
  });

  test('统计分析的每个标签页都能正常渲染', async ({ page }) => {
    await gotoAndWait(page, '/analysis');
    await expectNoErrorState(page);

    for (const tab of ['年度趋势', '类型与标签', '制作公司与导演', '评分偏差', '观看习惯']) {
      await page.getByRole('tab', { name: tab }).click();
      await page.waitForTimeout(600);
      await expectNoErrorState(page);
      expect(await page.locator('canvas').count()).toBeGreaterThan(0);
    }

    // 时间粒度切换
    await page.getByRole('tab', { name: '年度趋势' }).click();
    await page.getByRole('button', { name: '按季度' }).click();
    await page.waitForTimeout(500);
    await expectNoErrorState(page);
  });

  test('系列页面与系列详情', async ({ page }) => {
    await gotoAndWait(page, '/series');
    await expectNoErrorState(page);

    const cards = page.locator('a[href^="/series/"]');
    const count = await cards.count();
    if (count > 0) {
      await cards.first().click();
      await expect(page).toHaveURL(/\/series\//);
      await waitForReady(page);
      await expect(page.getByRole('heading', { name: /系列成员/ })).toBeVisible();
    } else {
      await expect(page.getByText(/还没有识别出系列/)).toBeVisible();
    }
  });

  test('系列详情页按「我的收藏条目」统计观看状态', async ({ page }) => {
    // 取一个状态混合的真实系列（例如同时有看过与想看）
    const list = await (await page.request.get('/api/series?limit=300')).json();
    const mixed = list.series.find(
      (item: { statusCounts: Record<string, number> }) =>
        item.statusCounts['2'] > 0 && item.statusCounts['1'] > 0,
    );
    expect(mixed, '应当存在状态混合的系列').toBeTruthy();

    const detail = await (
      await page.request.get(`/api/series/${encodeURIComponent(mixed.key)}`)
    ).json();
    await gotoAndWait(page, `/series/${encodeURIComponent(mixed.key)}`);
    await expectNoErrorState(page);

    // 明确区分「已知成员（含未收藏）」与「我的收藏条目数」
    await expect(
      page.getByText(
        new RegExp(`已知成员 ${detail.memberCount} 部 · 我的收藏 ${detail.collectedCount} 部`),
      ),
    ).toBeVisible();

    // v1.8 Entity Analysis B 层：完成度 / 状态结构都来自 analysis（同一口径）
    await expect(page.getByText('我与这个系列的关系')).toBeVisible();
    await expect(
      page.getByText(
        `看过 ${detail.analysis.completion.watched} / 收藏 ${detail.analysis.completion.collectedCount} 部`,
      ),
    ).toBeVisible();
    for (const [status, label, value] of [
      [2, '看过', detail.analysis.statusStructure.counts['2']],
      [1, '想看', detail.analysis.statusStructure.counts['1']],
      [3, '在看', detail.analysis.statusStructure.counts['3']],
      [4, '搁置', detail.analysis.statusStructure.counts['4']],
      [5, '抛弃', detail.analysis.statusStructure.counts['5']],
    ] as Array<[number, string, number]>) {
      const card = page.locator(`[data-status="${status}"]`);
      await expect(card).toBeVisible();
      await expect(card).toContainText(label);
      await expect(card).toContainText(String(value));
    }
    // 没有全部看过时不允许出现「已全部看过」（用词与收藏状态保持一致）
    if (detail.analysis.completion.watched !== detail.analysis.completion.collectedCount) {
      await expect(page.getByText('已全部看过')).toHaveCount(0);
      await expect(page.getByText(/尚未|尚未全部看过/).first()).toBeVisible();
    }

    // 未收藏成员留在成员列表中，带「未收藏」/「仅关系数据」徽标且不进入统计
    const notCollected = detail.members.filter(
      (member: { collected: boolean }) => !member.collected,
    );
    if (notCollected.length > 0) {
      await expect(page.getByText(/未收藏|仅关系数据/).first()).toBeVisible();
    }
  });

  test('全部看过的系列才显示「已全部看过」', async ({ page }) => {
    const list = await (await page.request.get('/api/series?limit=300')).json();
    const allWatched = list.series.find((item: { statusCounts: Record<string, number> }) => {
      const total = Object.values(item.statusCounts as Record<string, number>).reduce(
        (sum, value) => sum + value,
        0,
      );
      return total > 0 && item.statusCounts['2'] === total;
    });
    expect(allWatched, '应当存在全部看过的系列').toBeTruthy();
    await gotoAndWait(page, `/series/${encodeURIComponent(allWatched.key)}`);
    await expect(page.getByText('已全部看过')).toBeVisible();
  });

  test('Franchise 视图：候选家族、模式切换与确认状态', async ({ page }) => {
    await gotoAndWait(page, '/series');
    await page.getByRole('button', { name: 'Franchise' }).click();
    await page.waitForURL(/\/franchises$/);
    await waitForReady(page);
    await expectNoErrorState(page);

    const cards = page.locator('a[href^="/franchises/"]');
    if ((await cards.count()) > 0) {
      await cards.first().click();
      await expect(page).toHaveURL(/\/franchises\//);
      await waitForReady(page);
      // 家族成员是 Series：必须显示每个系列的链接
      await expect(page.locator('a[href^="/series/"]').first()).toBeVisible();
      // 未确认家族必须明确标注状态，而不是伪装成事实
      const stateText = await page
        .getByText(/候选家族|暂定家族|已确认家族|存在争议|已否决/)
        .first();
      await expect(stateText).toBeVisible();
    } else {
      await expect(page.getByText(/暂时没有足够证据的家族/)).toBeVisible();
    }
  });

  test('画像页面区分数据结论与推测', async ({ page }) => {
    await gotoAndWait(page, '/profile');
    await expectNoErrorState(page);
    await expect(page.getByRole('heading', { name: '数据结论' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '基于行为的推测' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '结构明细' })).toBeVisible();
    expect(await page.getByText('数据结论').count()).toBeGreaterThan(1);
    // 阶段快照与 AI 区块都存在；未配置 AI 时应给出说明而不是空白
    await expect(page.getByText('阶段快照与复盘')).toBeVisible();
    await expect(page.getByText('AI 总结').first()).toBeVisible();
    // AI 是否配置取决于本机设置：配置后应能看到报告，未配置时应给出明确指引
    /*
     * AI 状态是异步查询：首帧「已配置」还未知时面板会先渲染未配置分支，
     * 直接读按钮会出现竞态。这里用接口的真实状态决定期望分支，
     * 再用可重试的断言等待 UI 收敛到该状态。
     */
    const aiStatus = await (await page.request.get('/api/profile/ai')).json();
    if (aiStatus.configured) {
      await expect(page.getByRole('button', { name: '重新生成' }).first()).toBeVisible();
      await expect(page.getByText(/基于当前数据|数据已变化/).first()).toBeVisible();
      await expect(page.getByText('与你自己认知可能不同的地方').first()).toBeVisible();
    } else {
      await expect(page.getByText(/当前未启用 AI 总结/)).toBeVisible();
      await expect(page.getByRole('button', { name: '去配置 AI' })).toBeVisible();
    }
  });

  test('设置页不会泄露 Token，且能查看同步历史', async ({ page }) => {
    await gotoAndWait(page, '/settings');
    await expectNoErrorState(page);

    await expect(page.getByText('Bangumi 账号与凭据')).toBeVisible();
    await expect(page.getByText('同步历史')).toBeVisible();
    // 数据管理已经收进独立分区，URL 与内容保持一致
    await page.getByRole('tab', { name: '数据管理' }).click();
    await expect(page.getByText('数据导入 / 导出与备份')).toBeVisible();
    // Token 输入框在「Bangumi」分区里，切回去仍然不回显明文
    await page.getByRole('tab', { name: 'Bangumi' }).click();

    const body = await page.content();
    expect(body).not.toContain('super-secret');
    const tokenInput = page.getByLabel('Access Token');
    await expect(tokenInput).toHaveAttribute('type', 'password');
  });

  test('深浅色主题切换', async ({ page }) => {
    await gotoAndWait(page, '/');
    const html = page.locator('html');
    const initial = await html.getAttribute('class');
    await page.getByRole('button', { name: /切换到/ }).click();
    await page.waitForTimeout(400);
    const after = await html.getAttribute('class');
    expect(after).not.toBe(initial);
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('未知路由显示友好的 404 页面', async ({ page }) => {
    await gotoAndWait(page, '/not-a-real-page');
    await expect(page.getByText('页面不存在')).toBeVisible();
  });

  test('标签筛选器包含全部标签而不是截断列表', async ({ page }) => {
    await gotoAndWait(page, '/library');
    await page.getByRole('button', { name: /高级筛选/ }).click();

    // 标签区块显示总数，并且数量应该与后端一致（不能只有几十个）
    // 等待 facet 加载完成（未加载时会先显示「共 0 个标签」）
    const hint = page.getByText(/共 \d{4,} 个标签/).first();
    await expect(hint).toBeVisible();
    const text = await hint.innerText();
    const total = Number(/共 (\d+) 个标签/.exec(text)?.[1] ?? '0');
    expect(total).toBeGreaterThan(1000);

    // 搜索一个长尾标签（只出现一次的那种）也能找到
    const facetResponse = await page.request.get('/api/subjects/facets');
    const facets = await facetResponse.json();
    const singletons = facets.tags.filter((tag: { count: number }) => tag.count === 1);
    expect(singletons.length).toBeGreaterThan(0);
    const sample = singletons[0].value as string;
    await page.getByPlaceholder('在全部标签中搜索…').fill(sample);
    await expect(page.getByRole('button', { name: new RegExp(`^${sample.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })).toBeVisible();
  });

  test('制作人员 → 作品 → 标签 反向追溯可用', async ({ page }) => {
    await gotoAndWait(page, '/library');
    // 进入任意作品详情
    await page.locator('article a').first().click();
    await expect(page).toHaveURL(/\/subjects\/\d+/);
    await waitForReady(page);

    const staffChip = page.locator('a[href^="/library?"]').first();
    await expect(staffChip).toBeVisible();
    const href = await staffChip.getAttribute('href');
    // 人员一律使用 staff= 查询（直接匹配 subject_staff 里真实存在的姓名），并带上来源作品上下文
    expect(href).toMatch(/staff=/);
    expect(href).toMatch(/fromSubject=\d+/);

    await staffChip.click();
    await expect(page).toHaveURL(/\/library\?/);
    await waitForReady(page);
    await expectNoErrorState(page);

    // 来源作品上下文必须显示出来，并且如实汇报是否命中
    await expect(page.getByText('来源作品上下文')).toBeVisible();
    await expect(page.getByText(/该作品已包含在当前筛选结果中/)).toBeVisible();

    // 结果里确实有作品，并且筛选面板能看到「当前结果的标签」
    await expect(page.locator('article').first()).toBeVisible();
    await page.getByRole('button', { name: /高级筛选/ }).click();
    await expect(page.getByText('当前结果的标签（反向追溯）')).toBeVisible();
    await expect(page.getByText(/\d+ 部作品 · \d+ 个标签/)).toBeVisible();
  });

  test('单次出现的制作人员 / 公司可以搜索到', async ({ page }) => {
    // 从真实数据里取一个只出现一次的公司 / 导演（它们同样存在于 subject_staff 中）
    const facetsResponse = await page.request.get('/api/subjects/facets');
    const facets = await facetsResponse.json();
    const solo = (facets.studios as Array<{ value: string; count: number }>).find(
      (item) => item.count === 1,
    );
    expect(solo, '应当存在只出现一次的制作公司').toBeTruthy();

    await gotoAndWait(page, '/library');
    await page.getByRole('button', { name: /高级筛选/ }).click();
    const search = page.getByPlaceholder('搜索导演 / 音响监督 / 脚本 / 音乐 / 公司…');
    await search.fill(solo!.value);
    await page.waitForTimeout(600);

    const row = page.getByRole('button', {
      name: new RegExp(`^${solo!.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    });
    await expect(row).toBeVisible();
    await expect(page.getByText(/匹配 \d+ 位/)).toBeVisible();

    await row.click();
    await page.getByRole('button', { name: '完成' }).click();
    // 隐藏 NSFW 开启时汇总行是「当前可见 N 部作品 · 真实收藏 M 部」，两种口径都接受
    await expect(page.getByText(/(?:共|当前可见) [\d,]+ 部作品/)).toBeVisible();
    expect(await page.locator('article').count()).toBeGreaterThan(0);
  });

  test('主搜索栏：实体下拉与标签命中', async ({ page }) => {
    // 用真实数据找一个标签（取「黄段子」，没有则退回第一个出现次数较少的标签）
    const facets = await (await page.request.get('/api/subjects/facets')).json();
    const target =
      (facets.tags as Array<{ value: string; count: number }>).find((tag) => tag.value === '黄段子') ??
      (facets.tags as Array<{ value: string; count: number }>).find((tag) => tag.count >= 3)!;
    expect(target, '应当存在可用于测试的标签').toBeTruthy();

    await gotoAndWait(page, '/library');
    const searchBox = page.getByRole('searchbox', { name: /搜索作品 \/ 标签/ });
    await searchBox.fill(target.value);
    await page.waitForTimeout(700);

    // 下拉里应当出现「标签」分组与该标签对应的作品数
    const dropdown = page.getByTestId('global-search-panel');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.getByText('标签', { exact: true })).toBeVisible();
    // 精确匹配「标签名 + 命中类型 + 作品数」，避免和「黄段子学生会」这类相似标签混淆
    const tagRow = dropdown.getByRole('button', {
      name: new RegExp(
        `^${target.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 标签命中 ${target.count} 部作品$`,
      ),
    });
    await expect(tagRow).toBeVisible();

    // 点击标签实体 → 以标签为主检索，结果数与 facet 计数一致
    await tagRow.click();
    await expect(page).toHaveURL(/tags=/);
    await waitForReady(page);
    /*
     * 结果计数与 API 的「当前可见」口径一致：
     * 隐藏 NSFW 开启时 facet 是真实统计，列表只展示当前可见部分，两者可以不同。
     */
    const visible = await (
      await page.request.get(`/api/subjects?tags=${encodeURIComponent(target.value)}&limit=1`)
    ).json();
    const expected = new Intl.NumberFormat('zh-CN').format(visible.total);
    await expect(page.getByText(new RegExp(`(?:共|当前可见) ${expected} 部作品`))).toBeVisible();
  });

  test('主搜索栏：别名搜索命中非主标题', async ({ page }) => {
    await gotoAndWait(page, '/library');
    const searchBox = page.getByRole('searchbox', { name: /搜索作品 \/ 标签/ });
    await searchBox.fill('小镇家族');
    await searchBox.press('Enter');
    await expect(page).toHaveURL(/q=/);
    await waitForReady(page);
    // CLANNAD 的别名「小镇家族」应当出现在结果里，并标注命中原因
    await expect(page.getByText('CLANNAD').first()).toBeVisible();
    await expect(page.getByText('别名命中').first()).toBeVisible();
  });

  test('四级连续检索：每次点击都只保留最新条件（不污染）', async ({ page }) => {
    const uma = await (await page.request.get('/api/subjects?q=%E5%B7%85%E5%B3%B0%E4%B9%8B%E8%B7%AF&pageSize=5')).json();
    expect(uma.total).toBeGreaterThan(0);
    const workId = uma.items[0].id as number;

    // 第 1 层：关键词搜索
    await gotoAndWait(page, '/library');
    const searchBox = page.getByRole('searchbox', { name: /搜索作品 \/ 标签/ });
    await searchBox.fill('巅峰之路');
    await searchBox.press('Enter');
    await expect(page).toHaveURL(/q=/);
    await waitForReady(page);

    // 第 2 层：从作品详情点击标签 → URL 只带 tags + 来源上下文
    await gotoAndWait(page, `/subjects/${workId}`);
    const tagButton = page.locator('button[data-tag]').first();
    await expect(tagButton).toBeVisible();
    await tagButton.click();
    await expect(page).toHaveURL(/tags=/);
    await expect(page).not.toHaveURL(/q=/);
    await expect(page).toHaveURL(new RegExp(`fromSubject=${workId}`));
    await waitForReady(page);

    // 第 3 层：从作品详情点击人员 → 只带 staff + 来源上下文（不再有 tags）
    await gotoAndWait(page, `/subjects/${workId}`);
    const staffLink = page.locator('a[href^="/library?staff="]').first();
    await expect(staffLink).toBeVisible();
    await staffLink.click();
    await expect(page).toHaveURL(/staff=/);
    await expect(page).not.toHaveURL(/tags=/);
    await expect(page).not.toHaveURL(/q=/);
    await waitForReady(page);
    await expect(page.locator('article').first()).toBeVisible();

    // 第 4 层：从搜索结果再点标签 → 仍然只保留最新的标签
    await page.locator('article a').first().click();
    await expect(page).toHaveURL(/\/subjects\/\d+/);
    await waitForReady(page);
    const tagButton2 = page.locator('button[data-tag]').first();
    await tagButton2.click();
    await expect(page).toHaveURL(/tags=/);
    await expect(page).not.toHaveURL(/staff=/);
    await waitForReady(page);

    // 返回后重新搜索，状态干净
    await page.goBack();
    await waitForReady(page);
    await searchBox.fill('黄段子');
    await searchBox.press('Enter');
    await expect(page).toHaveURL(/q=/);
    await expect(page).not.toHaveURL(/tags=/);
  });

  test('个人资料：修改昵称与头像后刷新仍然保持', async ({ page }) => {
    // 记录原值，测试结束后还原，保证可重复运行
    const before = await (await page.request.get('/api/config')).json();
    const nickname = `E2E 昵称 ${Date.now() % 100000}`;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    try {
      await gotoAndWait(page, '/me');
      await expectNoErrorState(page);
      await expect(page.getByRole('heading', { name: '个人资料' })).toBeVisible();
      // 个人资料页只讲身份与状态，不复制仪表盘统计
      await expect(page.getByText('完成率')).toHaveCount(0);

      await page.getByRole('button', { name: '编辑资料' }).click();
      await page.getByLabel('昵称').fill(nickname);
      await page.locator('input[type="file"]').setInputFiles({
        name: 'avatar.png',
        mimeType: 'image/png',
        buffer: png,
      });
      await page.getByRole('button', { name: '保存资料' }).click();
      await expect(page.getByRole('heading', { name: nickname })).toBeVisible();

      // 刷新后（前端重新拉取 /api/config）依然保持
      await gotoAndWait(page, '/me');
      await expect(page.getByRole('heading', { name: nickname })).toBeVisible();
      const saved = await (await page.request.get('/api/config')).json();
      expect(saved.nickname).toBe(nickname);
      expect(saved.avatar.startsWith('data:image/png;base64,')).toBe(true);
      // 头像保存在本地，不产生任何第三方请求
      const avatar = page.locator('img[alt$="的头像"]').first();
      await expect(avatar).toHaveAttribute('src', /^data:image\/png;base64,/);

      // 非图片文件会被拒绝并给出可读提示
      await page.getByRole('button', { name: '编辑资料' }).click();
      await page.locator('input[type="file"]').setInputFiles({
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('not an image'),
      });
      await expect(page.getByText(/不是图片文件/)).toBeVisible();
      await page.getByRole('button', { name: '取消' }).click();
    } finally {
      await page.request.put('/api/config', {
        data: { nickname: before.nickname ?? '', avatar: before.avatar ?? '' },
      });
    }
  });

  test('首次使用引导可跳过，跳过与重置状态在接口上一致', async ({ page }) => {
    const before = await (await page.request.get('/api/config')).json();
    try {
      await page.request.put('/api/config', { data: { onboardingSeen: false } });
      await gotoAndWait(page, '/me');
      const steps = page.getByText('开始使用');
      if ((await steps.count()) > 0) {
        await expect(page.getByText('设置昵称 / 头像')).toBeVisible();
        await page.getByRole('link', { name: '打开设置' }).click();
        await expect(page).toHaveURL(/\/settings\?tab=bangumi/);
      }

      // 在设置里「重新显示引导」不会报错，并且状态可读
      await gotoAndWait(page, '/settings?tab=about');
      await expect(page.getByRole('heading', { name: '首次使用引导' })).toBeVisible();
      await page.getByRole('button', { name: '重新显示引导' }).click();
      await expect(page.getByText(/引导已重新开启/)).toBeVisible();
      const state = await (await page.request.get('/api/profile/local')).json();
      expect(state.seen).toBe(false);
    } finally {
      await page.request.put('/api/config', {
        data: { onboardingSeen: before.onboardingSeen ?? false },
      });
    }
  });

  test('设置页按信息架构分为 5 个分区，URL 与内容一致', async ({ page }) => {
    await gotoAndWait(page, '/settings');
    await expectNoErrorState(page);
    // 默认落在 Bangumi 分区
    await expect(page.getByRole('heading', { name: 'Bangumi 账号与凭据' })).toBeVisible();

    const tabs: Array<[string, string]> = [
      ['AI', 'AI 服务（可选）'],
      ['外观', '主题'],
      ['数据管理', '数据导入 / 导出与备份'],
      ['关于', '关于这个工具'],
    ];
    for (const [tab, expected] of tabs) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page).toHaveURL(new RegExp(`tab=`));
      await expect(page.getByText(expected, { exact: false }).first()).toBeVisible();
    }

    // 深链接直接打开指定分区
    await gotoAndWait(page, '/settings?tab=appearance');
    await expect(page.getByText('当前主题')).toBeVisible();
  });
});
