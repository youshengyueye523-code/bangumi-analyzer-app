# Changelog

所有面向公开用户的桌面发行版本与本地核心更新记录均记录于此。过往 RC 预发行产物保留在 GitHub Releases 历史归档中。

---

## [v2.0.0] - 2026-11-25（正式版）

**交付组件**：`Bangumi Analyzer Companion v2.0.0` + `Bangumi Analyzer v2.0.0 (r5)`（Series Engine v3）

### 修复与稳定性强化
- **F01 · 修复首页六个快捷入口路由直达**
  - 为 `仪表盘` (`/`)、`收藏库` (`/library`)、`统计分析` (`/analysis`)、`系列 / IP` (`/series`)、`我的画像` (`/profile`)、`数据中枢` (`/diagnostics`) 建立端到端白名单路由透传（`Home.tsx` → `driver` → `preload.cjs` → IPC `contract.mjs` → `engine.mjs` → `runtime/cli.mjs` → `supervisor.mjs`）。
  - 严格保留回环地址 `127.0.0.1`、禁止 `8787` 与未允许路径的安全限制；服务未就绪时弹出清晰提示与日志反馈，不静默失败。
- **F02 · Analyzer 网页端主题跨端口持久化与双向同步**
  - 修复此前仅依赖单端口 `localStorage` 导致每次随机端口重启都回退默认主题的问题：将 `theme` (`system` / `dark` / `light`) 正式持久化至 `data/config.json`，并新增 `/api/theme.js` 首屏脚本实现新端口零闪屏（FOUC-free）首帧应用。
  - 在 Companion「启动与偏好」新增 **Analyzer 网页端主题** 设置项，与网页端主题切换保持双向一致，并与 Companion 自身外观主题相互独立；未显式选择的新用户保持跟随系统默认行为。
- **F03 · Windows 高 DPI 窗口布局、GPU 兼容策略与小番 Live2D 稳定性**
  - 优化 Windows 10/11 混合双显卡默认策略为更稳定的 **ANGLE D3D11**（仅在 D3D11 失败时安全尝试 GL 恢复，且 `markGpuHealthy` 不再清空已记录失败后端导致回退乒乓），并新增 `--disable-dx12-gpu-info-collection` / `--disable-vulkan-gpu-info-collection`。
  - 增加渲染层 `rendererReady` 双 rAF 首帧就绪握手及 `maximize` / `unmaximize` / `restore` / `leave-full-screen` / `display-metrics-changed` 视口强制重排同步，消除启动黑屏及窗口切换偶发缩在左上角的问题，并在全屏退出后正确恢复此前的最大化状态。
  - 加固 `cubism5Compat.ts`、`Live2DStage.tsx`、`Mascot.tsx` 与 `Backdrop.tsx`：立即释放 WebGL 探测上下文、阶段引用计数保护共享纹理缓存、窗口最小化/隐藏时暂停动画并重置恢复时钟、支持 `gpu_context_lost`/`webgl_unavailable` 有限退避自动重挂载与真 GPU 崩溃安全降级 2D 占位。
- **F04 · 修复自动启动后自动打开网页端行为**
  - 新增 `autoLaunch` 单周期协调器，统一管理 `SkipIntro` 首页直达、`Splash` 启动动画（含提前跳过不中断启动）、`Launch` 首次完成与老用户重连路径；在服务真正就绪后仅自动打开首页一次，不因状态轮询或窗口恢复重复弹出标签页；关闭偏好立即解除触发，打开失败显式展示 `OPEN_FAILED` 警示与地址复制入口。
- **版本展示与离线分发一致性**
  - 在 IPC/UI 契约中透传真实 `distributionRevision` 与校验文件数（取消此前硬编码占位显示），桌面与发行清单真实一致反映 `v2.0.0` 与 `r5 · 3249 文件已校验`。

### 发行产物
- `Bangumi-Analyzer-Companion-Setup-2.0.0-win-x64.exe`（Windows 图形安装版）
- `Bangumi-Analyzer-Companion-Portable-2.0.0-win-x64.zip`（Windows 绿色便携版，已含小番 Live2D 与 Node 24）
- `Bangumi-Analyzer-2.0.0-windows-x64-r5.zip`（Analyzer 独立离线运行包，可供手动升级或独立使用）
- `SHA256SUMS.txt` & `RELEASE_MANIFEST.json`

---

## [v2.0.0-rc5] - 2026-11-23（Pre-release 归档）
- 内置 Analyzer `v2.0.0 r4`（Series Engine v3 自动标题升级与 `r3` 契约收敛）；
- 新增欢迎页老安装重连（`reconnectExistingInstall`）、首次向导目录占用实时校验、7 类 Bangumi 网络错误分类诊断与安全更新/回滚机制。

## [v2.0.0-rc4] - 2026-11-23（Pre-release 归档）
- 内置 Analyzer `v2.0.0 r3` 恢复系列自动标题判定契约；加固 Companion GPU 策略与小番 Live2D 阶段资源清理。

## [v2.0.0-rc3] - 2026-11-22（Pre-release 归档）
- Companion 桌面伴侣首次公开预发行版（内置 Analyzer `v2.0.0 r2`、小番 Pink Sakura Live2D 舞台、C# 原生安装器/启动器/卸载器）。
