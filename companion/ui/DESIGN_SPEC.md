# Bangumi Analyzer Companion · M0 设计规范与联调说明

## 1. 定位与视觉亲缘关系

Companion 是 **Bangumi Analyzer** 的独立桌面伴侣外壳（安装引导、服务守护、快速入口、日常陪伴），不是替换 Analyzer 网页端，也不是通用工具面板。

- **视觉继承（与 `packages/web/src/styles.css` 同源）**
  - 中性底色与材质层级：`--bg-rgb (9 11 17)`、`--surface-rgb (18 21 29)`、浅色对应 `#f6f7f9 / #ffffff`；玻璃仅用于表达悬浮与层级，卡片保持信息高可读性。
  - 品牌主色与语义色：`--accent (#6d8bff / #3f6cf5)`、`--success`、`--warning`、`--danger`、`--ring` 完全一致。
  - 圆角与控件阶梯：`chip(8)` / `control(10)` / `menu(12)` / `card(14)`，表单控件统一 `30 / 34 / 40px`，新增窗口舞台级 `stage(20)` 与主按钮 `44px`。
  - 字体与数字：`Inter + PingFang SC / Microsoft YaHei UI`，所有统计数、端口、倒计时使用 `tabular-nums`（`.numeric`）。
- **Companion 独有舞台语汇**
  - 在 Analyzer 的蓝紫主调上扩展 **星紫 `--aurora (#a184ff)`**、**樱粉 `--sakura (#ff8fb1)`** 与 **星光 `--star (#ffe2a3)`**，构成深空极光与地平线辉光。
  - **演出分级**：`intro / ready` 强演出（星空、流星、扫光、花瓣星芒）；`setup` 向导阶段压暗极光与粒子以突出表单；`home` 居中平衡。
  - **效率与可跳过**：首次引导支持 `Enter` 连贯前进与 `Esc/Space` 跳过欢迎演出；老用户可通过 `skipIntro` 跳过日常过场直达首页，或通过 `reduceMotion` 收起装饰动画。

## 2. 站娘占位与 8 态动效契约 (`src/components/Mascot.tsx`)

当前采用中性几何剪影占位，**最终形象由用户与 GPT 另行定稿**。替换立绘时只需替换 `<MascotFigure>`（PNG 序列 / Spine / Live2D 皆可），以下 8 个状态枚举与语义保持稳定：

| 状态 | 触发时机 | 动作与氛围 |
| --- | --- | --- |
| `idle` | 无事发生 / 表单待输入 | 轻柔呼吸、自然眨眼 |
| `greet` | 欢迎演出结束 / 日常启动问候 | 挥手打招呼、微倾头 |
| `think` | 环境检测、网络请求、磁盘提示警告 | 歪头思考、悬浮省略点 |
| `work` | 初始化建库、分页同步、补全详情 | 轻快律动、工作星粒 |
| `happy` | 单步校验或启动成功 | 弯眼微笑、红晕与星芒 |
| `worry` | 端口占用、账号/Token 报错、429 限流、服务异常 | 低头微垂、警示标记 |
| `sleep` | 日常首页中 Analyzer 处于 `stopped` | 闭眼小憩、漂浮 `Zzz` |
| `cheer` | 首次设置全部完成（`Ready`） | 欢呼跳跃、双倍庆贺星芒 |

## 3. Codex Runtime 适配接口 (`src/driver/types.ts` · `codexDriver.ts`)

对齐 `companion/runtime/API.md` 与 `supervisor.d.mts`（`protocolVersion: 1`）：

- **驱动选择规则 (`selectDriver()`)**：
  - `?driver=mock`：强制使用 `mockDriver`。
  - `?driver=codex`：强制使用 `codexDriver`；若未检测到 `window.companionBridge` 则显式报错 `BRIDGE_UNAVAILABLE`，绝不伪造成功。
  - 默认：宿主注入了 `window.companionBridge` 时自动切换 `codexDriver`，否则使用 `mockDriver`。
- **真实生命周期语义**：
  - `startAnalyzer()` 返回 `{ ok: true, status }` 但 `state` 为 `checking` 或 `starting` 时，UI 保持过渡态并通过 `useAnalyzerStatus` / `startAndAwaitReady` 每 350ms 轮询 `getStatus()` 直到 `ready`（归一化为 `running`）或 `failed`（归一化为 `error`）。
  - `openAnalyzer()` 返回 `ok: false`（如 `OPEN_FAILED`）时，主服务仍维持 `running`，UI 弹出非致命警告并提供手动复制本机地址的兜底按钮。
  - `stopAnalyzer()` 超时（`STOP_TIMEOUT` 且 `ownsProcess: true`）时，保留错误诊断并提示“重试安全停止”，绝不假装服务已停止。
  - `status.logs`（至多 100 条 `{ seq, at, level, event }`）通过 `ingestRuntimeLogs` 按 `seq` 去重写入日志面板。

## 4. 尚未完成的真实能力（M0 → 后续里程碑）

以下能力在 M0 中全部为明确标注的模拟实现，待与 Codex `companion/runtime` 及后续阶段联调落地：

1. **真实进程与端口管理**：通过 `window.companionBridge` 接入本地 Node 24 + Fastify 服务拉起、空闲端口探测、优雅 `stopAnalyzer` 退出等待、崩溃捕获与真实运行日志流。
2. **真实本机环境检查与目录选择**：调用系统原生文件夹选择框、检查盘符空间/写权限/网盘路径与 `checksums.json` 完整性校验。
3. **真实初始化与数据流**：解压/部署运行包到目标目录、写入 `data/config.json`、执行 Bangumi 账号与 Token 校验、分页同步收藏与断点续传、AI 连通性测试。
4. **桌面壳原生能力**：系统托盘驻留、关闭按钮最小化到托盘、可选桌面快捷方式与开机启动开关、通过系统默认浏览器打开 `openAnalyzer` 地址。
5. **站娘定稿资产接入**：将 `<MascotFigure>` 替换为最终定稿角色立绘与分态动画资源。
