# 第三方软件、角色资产与许可声明 (Third-Party Notices)

Bangumi Analyzer 与 Bangumi Analyzer Companion 包含并依赖于以下第三方开源组件、角色模型资产及（仅限编译后 Windows 发行包的）专有运行库。**各部分严格独立适用其原许可协议，不混同、不相互重新授权。**

---

## 1. 本项目自主源码

- **范围**：`packages/`（Analyzer 服务端、前端与共享契约）、`companion/host/`、`companion/runtime/`、`companion/ui/`、`companion/installer/`、`companion/dist-scripts/`、`scripts/`、`e2e/` 与文档。
- **许可**：[MIT License](./LICENSE)（Copyright (c) 2026 youshengyueye523-code）。

---

## 2. 角色模型资产：Pink Sakura 与派生 ArmRig 图集 (CC BY 4.0)

- **目录**：`companion/models/pink-sakura/`
- **上游来源**：[Ariakage / live2d-agent-kit](https://github.com/Ariakage/live2d-agent-kit) (`examples/pink-sakura/runtime/`)，制作统筹 **Ariakage**。
- **许可协议**：**Creative Commons Attribution 4.0 International (CC BY 4.0)**  
  - 许可概要：https://creativecommons.org/licenses/by/4.0/  
  - 完整正文：https://creativecommons.org/licenses/by/4.0/legalcode.en  
- **上游原始来源记录（按上游公开声明保留，未冒充完全原创）**：
  - 原始参考图按上游标注来自 `ChatGPT Image2.5` 生成（未独立核验服务记录）；
  - 隐藏区域补画、拆层与绑定由 Ariakage 指导并借助 `GPT-6 Astra Ultra` 与 `live2d-agent-kit` / `psd2live` 完成。
- **本项目修改说明**：
  1. 将原始 `8192 × 8192` 纹理等比双三次降采样（保留 Alpha 通道）至 `PinkSakura.2048/texture_00.png`（`2048 × 2048`）以适配桌面端显存占用；
  2. 基于上游 CC BY 4.0 原图 `arm-parts-v1.png` 与 `reference.png`，通过脚本 `companion/dist-scripts/build-arm-rig-assets.mjs` 生成派生分层袖口与手型图集 `arm-rig-atlas.png` / `arm-rig-meta.json`（同样遵循 CC BY 4.0），结合客户端双骨骼渲染管线修复袖口穿模与手臂弯曲畸变；
  3. 适配 Companion 八态状态机与 7 种独立短暂随机互动变体。
- **离线详细记录**：见 [companion/ATTRIBUTION.md](./companion/ATTRIBUTION.md) 与 [companion/ASSET-LICENSE.md](./companion/ASSET-LICENSE.md)。

---

## 3. Live2D Cubism Core for Web (`live2dcubismcore.min.js`) — 专有运行库（不包含于公开源码仓库）

- **提供方**：Live2D Inc.（官方下载：https://www.live2d.com/en/sdk/download/web/）
- **许可协议**：**Live2D Proprietary Software License Agreement**（专有软件许可，**非开源、非 MIT、非 CC BY 4.0**）。
- **开源仓库排除说明**：
  - 本公开 GitHub 源码仓库**不包含** `live2dcubismcore.min.js` 及 `CubismSdkForWeb-*` 目录。
  - 从源码构建的开发者如需要启用 Live2D 实时渲染，请先阅读并同意 Live2D 官方许可协议，自行从 Live2D 官网下载 `Cubism SDK for Web`（本工程验证版本：`CubismSdkForWeb-5-r.5` / Core `06.00.0001`），并将 `Core/live2dcubismcore.min.js`、`Core/LICENSE.md`（重命名为 `CORE-LICENSE.md`）与 `Core/RedistributableFiles.txt` 放入 `companion/models/vendor/`。
  - **缺失时的安全降级**：未放置 `live2dcubismcore.min.js` 时，Companion 仍可正常构建与启动，角色舞台会自动安全回退至 2D 占位状态，不影响 Analyzer 安装、同步与分析功能。
- **编译后 Windows 发行包再分发说明**：
  - GitHub Releases 提供的编译后 Windows 安装包与便携包由个人独立开发者以非商业免费方式分发（远低于 Live2D 许可规定的 1,000 万日元年度营收阈值），且 Companion 架构仅加载内置固定小番基底模型、不提供外部 `.moc3` 模型导入或创作工具（非 Expandable Application / Tool Software）。
  - 发行包依据官方 `Core/RedistributableFiles.txt` 随附 `live2dcubismcore.min.js` 与 `CORE-LICENSE.md`。若任何主体将其用于超过阈值或受限类别的商业发行，须另行向 Live2D Inc. 取得 **Cubism SDK Release License**。

---

## 4. 主要第三方开源依赖

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| **Node.js** / **Electron** / **Chromium** | MIT / BSD-3-Clause / 多组件开源许可 | 本地服务端与 Windows 桌面宿主 |
| **Fastify** / **Zod** / **Undici** | MIT | 本地 HTTP API 与参数校验 |
| **React** / **Vite** / **Tailwind CSS** / **Radix UI** / **ECharts** / **Lucide** | MIT / Apache-2.0 | Analyzer Web 界面与 Companion 界面 |
| **PixiJS v6.5.10** / **`@pixi/unsafe-eval` v6.5.10** | MIT | WebGL 渲染引擎与严格 CSP 兼容 |
| **pixi-live2d-display v0.4.0** | MIT（内嵌 Cubism Web Framework 适用 Live2D Open Software License Agreement） | Live2D 渲染桥接层 |
| **GestureHandoff** (`Ariakage/live2d-agent-kit`) | MIT | 手势过渡衔接辅助控制器 |

---

## 5. 非背书声明 (No Endorsement)

本项目为独立个人开源工具，**与 Bangumi (bgm.tv) 官方、Ariakage、OpenAI 或 Live2D Inc. 没有任何隶属、赞助或官方背书关系**。  
*Bangumi Analyzer and Companion are independent open-source software and are not affiliated with, endorsed by, or sponsored by Bangumi, Ariakage, OpenAI, or Live2D Inc.*
