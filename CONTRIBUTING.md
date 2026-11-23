# 开发者与构建指南 (Contributing & Building from Source)

如果你只是想在 Windows 上使用 Bangumi Analyzer，**不需要阅读本页或自行编译源码**，请直接前往 [GitHub Releases](https://github.com/youshengyueye523-code/bangumi-analyzer-app/releases/tag/v2.0.0-rc4) 下载安装版或便携版。

本指南面向希望阅读源码、运行测试、本地开发或自行构建发行包的开发者。

---

## 1. 仓库结构

```text
.
├── packages/
│   ├── shared/              # 领域类型、API 契约、解析与诊断规则
│   ├── server/              # Fastify API + SQLite (node:sqlite) + 同步 / 诊断 / 静态托管
│   └── web/                 # React 19 + Vite + Tailwind v4 + ECharts 前端界面
├── companion/
│   ├── host/                # Electron 桌面宿主（sandbox + contextIsolation + IPC 白名单）
│   ├── runtime/             # 受管 Analyzer 生命周期与端口隔离桥接
│   ├── ui/                  # Companion 桌面 UI + 小番 Live2D / 2D 舞台
│   ├── models/pink-sakura/  # Pink Sakura 角色资产与 ArmRig 派生图集 (CC BY 4.0)
│   ├── installer/           # Windows 原生图形安装器 / 启动器 / 卸载器 (C#)
│   └── dist-scripts/        # Companion 发行包与 ArmRig 构建脚本
├── scripts/distribution/    # Analyzer Windows 便携核心分发包构建脚本
├── e2e/                     # Playwright 端到端测试
└── docs/                    # 架构、API、时间趋势与构建文档
```

> 说明：产品展示官网 `site/` 维护于独立静态仓库 [bangumi-analyzer-site](https://github.com/youshengyueye523-code/bangumi-analyzer-site)；在线只读展品 `public-demo` 独立部署于 Vercel，不在本源码仓库内混杂部署配置。

---

## 2. 环境要求

- **操作系统**：Windows 10 / 11 (x64)（Analyzer 服务端/前端核心理论上支持 Node.js 24 跨平台运行；Companion 图形安装器与启动器面向 Windows x64）
- **Node.js**：`24.x`（依赖内置 `node:sqlite`）
- **包管理器**：`pnpm`（建议 10.x）
- **可选（构建 Windows 安装器 EXE）**：Windows 自带 `.NET Framework 4.x` `csc.exe`

---

## 3. 快速开发与测试

### 3.1 安装依赖与构建 Analyzer

```bash
pnpm install
pnpm build
```

### 3.2 启动本地开发模式

```bash
pnpm dev
```

默认监听 `http://127.0.0.1:8787`（个人数据保存在本地 `data/` 目录，已被 `.gitignore` 排除）。

### 3.3 运行测试

```bash
# 类型检查
pnpm typecheck

# 服务端与前端单元测试
pnpm -C packages/server run test
pnpm -C packages/web run test

# Companion 宿主安全、GPU 策略、安装恢复与启动快捷方式单测
node --test companion/host/test/boundary.test.mjs companion/host/test/gpu-policy.test.mjs companion/host/test/setup-recovery.test.mjs companion/host/test/startup-shortcut.test.mjs
```

---

## 4. 可选：为 Companion 接入官方 Live2D Cubism Core

由于许可要求，本公开仓库**不包含** Live2D Inc. 专有文件 `live2dcubismcore.min.js`。

- **无 Core 运行**：直接构建与运行 Companion 时，角色舞台会自动安全回退至 2D 占位模式，所有安装、同步、备份与 Analyzer 管理功能均完全可用。
- **启用完整 Live2D 渲染**：
  1. 前往 Live2D 官网下载页：https://www.live2d.com/en/sdk/download/web/
  2. 阅读并同意 **Live2D Proprietary Software License Agreement** 后下载 `Cubism SDK for Web`（本工程验证版本：`CubismSdkForWeb-5-r.5`，Core `06.00.0001`）。
  3. 解压后将以下文件复制到 `companion/models/vendor/`：
     - `Core/live2dcubismcore.min.js`
     - `Core/LICENSE.md` → 重命名为 `CORE-LICENSE.md`
     - `Core/RedistributableFiles.txt`
  4. 也可以在运行 Companion 后，于界面「设置 → 关于 → 第三方许可」中使用本地导入按钮加载已下载的 `live2dcubismcore.min.js`。

> 请勿将 `live2dcubismcore.min.js` 或解压后的 `CubismSdkForWeb-*` 提交至公开 Git 仓库。

---

## 5. 从源码构建 Windows 发行包

### 第一步：构建 Analyzer 便携核心包

```powershell
# 安装依赖并编译 shared / server / web
pnpm install
pnpm build

# 打包带独立 Node 24 运行时的 Analyzer Windows 分发包
node scripts/distribution/build.mjs
```

执行后会在 `dist/distribution-<id>/` 下生成 `Bangumi-Analyzer-2.0.0-windows-x64-r3.zip` 及对应的 SHA-256。

### 第二步：安装 Companion 依赖并打包 Windows Setup.exe 与 Portable.zip

```powershell
# 安装 Companion UI 与 Electron 宿主依赖
npm --prefix companion/ui install
npm --prefix companion/host install

# 传入上一步生成的 Analyzer ZIP 路径与校验值（或留空 ANALYZER_BUNDLE_SHA256 跳过固定哈希匹配）
$env:ANALYZER_BUNDLE_ZIP = ".\dist\distribution-<id>\Bangumi-Analyzer-2.0.0-windows-x64-r3.zip"
$env:ANALYZER_BUNDLE_SHA256 = ""
node companion/dist-scripts/package-companion.mjs
```

产物输出在 `companion/dist/`：
- `Bangumi-Analyzer-Companion-Setup-2.0.0-rc4-win-x64.exe`
- `Bangumi-Analyzer-Companion-Portable-2.0.0-rc4-win-x64.zip`
- `SHA256SUMS.txt` 与 `RELEASE_MANIFEST.json`

---

## 6. 安全与隐私提交红线

提交 Issue 或 Pull Request 前请确认：
- 不提交任何 `data/` 数据库、私人收藏快照、Bangumi Access Token、AI API Key、代理凭据或本机用户绝对路径；
- 不放宽 Electron `sandbox: true`、`contextIsolation: true`、严格 CSP（禁止普通 `'unsafe-eval'` / `'unsafe-inline'`）或 IPC 调用方白名单校验；
- 不提交任何 Live2D 专有 SDK 文件。
