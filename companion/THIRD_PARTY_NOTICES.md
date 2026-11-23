# Bangumi Analyzer Companion 第三方软件与资产许可声明

Bangumi Analyzer Companion 包含并依赖于以下第三方开源组件、模型资产与可选专有运行库。**各自独立适用其原许可协议，不混同或相互重新授权。**

---

## 1. 角色模型资产：Pink Sakura
- **来源**：Ariakage / [live2d-agent-kit](https://github.com/Ariakage/live2d-agent-kit) (`examples/pink-sakura/runtime/`)
- **许可**：Creative Commons Attribution 4.0 International (**CC BY 4.0**) — https://creativecommons.org/licenses/by/4.0/
- **详情**：完整原始来源记录（含 ChatGPT Image2.5 原始参考图说明及 GPT-6 Astra Ultra 制作记录）与本项目修改说明见随附的 `ATTRIBUTION.md` 与 `ASSET-LICENSE.md`。

## 2. Live2D 网页端渲染适配与 WebGL 引擎
- **PixiJS (`v6.5.10`) / `@pixi/unsafe-eval` (`v6.5.10`)**：https://github.com/pixijs/pixijs/tree/v6.5.10  
  - **许可**：MIT License (Copyright (c) 2013-2023 Mathew Groves, Chad Engler)
- **pixi-live2d-display (`v0.4.0`)**：https://github.com/guansss/pixi-live2d-display/tree/v0.4.0  
  - **许可**：MIT License (Copyright (c) 2020 Guan)  
  - **额外包含说明**：其 Cubism 4 构建内嵌 **Live2D Cubism SDK for Web Framework** 代码，该部分受 **Live2D Open Software License Agreement** 约束（https://github.com/Live2D/CubismWebFramework/blob/develop/LICENSE.md）。
- **GestureHandoff 动作过渡工具**：源自 `Ariakage/live2d-agent-kit` (`templates/web-preview/gesture-handoff.js`)  
  - **许可**：MIT License (Copyright (c) 2026 Ariakage)

## 3. Live2D Cubism Core for Web (`live2dcubismcore.min.js`) — 专有运行库
- **提供方**：Live2D Inc. (https://www.live2d.com/en/sdk/download/web/)
- **集成版本与校验**：`CubismSdkForWeb-5-r.5`（Core `06.00.0001`，`live2dcubismcore.min.js`，228,042 字节，SHA-256 `8741f739779b5d5210872bd3d7d99f0f1e56e6c87409e7d26d6bb4b80aa1ef47`），由使用者阅读并同意官方协议后从官方包提取并保留随包 `CORE-LICENSE.md` 与 `RedistributableFiles.txt`。
- **许可**：**Live2D Proprietary Software License Agreement（专有软件许可协议，非开源、非 CC BY 4.0）**
- **商业发行与边界约束（P3 规范）**：
  - **严格区分资产与运行库**：Pink Sakura 模型资产适用 **CC BY 4.0**；PixiJS / `@pixi/unsafe-eval` / `pixi-live2d-display` 本体适用 **MIT License**（其中内置的 Cubism Framework 部分适用 **Live2D Open Software License Agreement**）；而 `live2dcubismcore.min.js` 属于 Live2D Inc. 专有软件，绝不与 MIT 或 CC BY 4.0 混同。
  - **商业年营收门槛**：最近会计年度销售额达到或超过 **1,000 万日元** 的企业/商业主体公开发行时，必须另行取得 **Cubism SDK Release License（发行许可证）**。
  - **Expandable Application 与 Tool Software 特殊限制**：依据 Live2D 官方协议（Section 1.5 等条款），凡允许外部加载或替换不特定数量模型（如可导入第三方 `.moc3` 虚拟形象的桌面/直播/聚合平台，即 **Expandable Application**），或提供给他人制作、生成、加工 Live2D 作品的 **Tool Software（工具软件）**，**无论收入是否低于 1,000 万日元均不豁免**，必须事先接受 Live2D Inc. 审查批准并签订专门发行许可协议。
  - **Companion 架构与公开发布边界**：Companion 仅通过白名单 IPC（`companion:v1:model`）加载内置固定 `pink-sakura` 角色基底，**不提供外部 `.moc3` 模型导入或创作工具功能**（非 Expandable Application / Tool Software）。本软件由个人独立开发者以非商业小规模形式免费提供（远低于 1,000 万日元阈值），编译后的 Windows 发行包按 `Core/RedistributableFiles.txt` 随附 `live2dcubismcore.min.js` 与 `CORE-LICENSE.md`；**公开开源源码仓库不包含 `live2dcubismcore.min.js`**，自编译开发者需自行同意 Live2D 官方协议后从官网下载放入本地目录（缺失时程序自动安全降级至 2D 占位舞台）。如未来用于超门槛商业发行，须另行申请 Live2D 官方 Cubism SDK Release License。

## 4. 桌面宿主与 UI 基础组件
- **Electron** / **Chromium** / **Node.js**：各自遵循 MIT / BSD-3-Clause / 多组件开源许可。
- **React** (`^19.2.0`)、**Lucide React** (`^0.545.0`)、**Vite**：MIT License。

---

*Bangumi Analyzer Companion is not affiliated with, endorsed by, or sponsored by Ariakage, OpenAI, or Live2D Inc.*
