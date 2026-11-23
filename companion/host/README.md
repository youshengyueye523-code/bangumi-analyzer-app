# Companion M1-A — Windows 桌面宿主技术样例

**已经能实际运行，不是设计稿。** 承载现有 UI 的只读构建快照，通过隔离 preload → 主进程 → 私有 JSONL → 未修改的 M0 Runtime 控制独立 Analyzer。
范围止于 M1-A，不含正式安装器、更新器、账号/AI 配置、同步桥接、托盘或 M2。

## 直接启动

本机开发依赖已准备好。从项目根执行：

```powershell
& .\.runtime\node-v24.22.1-win-x64\node.exe companion/host/scripts/run.mjs
```

不带参数时，每次从已核对 SHA-256 的原始 r2 ZIP 在 `companion/host/.work/manual-*` 新解包一份空白副本。
这使本轮样例默认不可能沿用正式 Local 数据；不是正式安装流程。
会打开真正的 Windows 桌面窗口，直接进入现有 UI 首页，强制 `driver=codex`，没有注入 mock。

日常操作：

1. 点击 **启动 Analyzer**，观察校验/启动状态。宿主等待确认 ready 才将启动动作返回为 running。
2. 点击 **打开网页端**，由真实 Runtime 再次确认健康后交给默认浏览器。
3. 点击 **安全停止**；若失败且 ownsProcess=true，保持窗口，等待或重试，不能当成已停止。
4. 用 **Windows 原生标题栏 X / Alt+F4** 退出；宿主先停止自管服务，再关闭 CLI，最后退出窗口。
   若未确认安全停止会保持窗口并提示，不会按 PID 强杀。

要保留同一独立副本的临时数据，可显式传绝对路径（不要传正式 Local 或其 data）：

```powershell
& .\.runtime\node-v24.22.1-win-x64\node.exe companion/host/scripts/run.mjs 'D:\Independent Analyzer r2'
```

也可使用 `companion/host/Start-Companion.ps1 [-PackageRoot <绝对目录>]`；若系统不允许运行 PowerShell 脚本，使用上面的 Node 命令，**不要修改系统安全策略**。
启动辅助脚本使用维护者现有可信 Node 24；真正 Runtime/Analyzer 始终使用经校验的 r2 随包 Node 24.22.1。

## 首次依赖准备（其他维护环境）

只在本目录操作，不改根 workspace 或 UI/Runtime 的依赖：

```powershell
Set-Location companion/host
npm ci --ignore-scripts --no-audit --no-fund --cache .work/npm-cache
# 用可信 Node 24 执行锁定的官方 Electron 下载脚本；校验值来自锁定的包。
$env:electron_config_cache = Join-Path (Get-Location).Path '.work/electron-cache'
node node_modules/electron/install.js
```

需要网络的是依赖/桌面框架准备；依赖就绪后，本轮空库桌面样例可离线启动。
Electron 固定 45.4.1、lockfile 随源码保留，安装脚本没有自动执行其他依赖脚本。
本目录没有正式桌面成品打包，不能只复制一个 electron.exe 给别人；也不分发 `.work` 或使用过的数据目录。

## 技术选型（仅 M1-A）

| 方案 | 本机条件与本轮代价 | 结论 |
|---|---|---|
| Tauri 2 | 未找到 Rust/Cargo；需补 Rust 与 Windows 原生构建链，再做 Node sidecar/权限配置 | 当前最小样例的准备成本高，未安装这些工具链 |
| Electron | 已有 Node/npm；只需 host 独立依赖，可直接隔离 preload、校验 frame、接 stdio；实际框架 dist 约 357 MiB | **本轮采用**，实现成本低但分发体积明显更大 |
| WebView2 原生/.NET | 本机已有 WebView2 Runtime、.NET 8 Desktop Runtime，但 `dotnet --list-sdks` 为空；还需 SDK/编译器集成及托管桥 | 可能更小，但不是“已有 Runtime 就已具备开发环境” |

选型没有写入项目 Constitution，**不自动成为永久架构决定**。未以体积优化为由另造不受保护的本地 HTTP 命令服务。

## 接口和安全

**单一联调文档：[CONTRACT.md](CONTRACT.md)**；完整类型：`bridge.d.ts`。
前四方法兼容 M0 Driver，另有 getLogs/onStatus/onLogs。当前 UI 同步演进时，宿主兼容其顶层 Runtime 元数据，但不修改 UI 文件。

- 只加载 `companion/ui/dist` 的只读校验快照，不运行 UI 构建，不加载 dev server。
- 本地专用协议、CSP、拒绝导航/弹窗/子 frame、禁止所有网页权限与下载。
- sandbox/contextIsolation 开启、Node integration 关闭、正常启动无调试端口、网页拿不到 require/process/原始 ipcRenderer。
- 主进程校验所属窗口、**同一个顶层 frame 对象和精确文档 URL**；方法白名单，不接受 path/PID/URL/命令参数。
- 执行随包 Node **之前**先调用 M0 包校验；CLI 路径为固定可信源码，不接受网页替换。
- Runtime CLI stdout 只解析白名单结构；stderr 排空、不进 UI；日志只允许已知事件码/时间/级别，路径和原始错误不透出。
- 默认随机非 8787 端口，所有已有包锁均拒绝接管；停止/原生关闭只走所属 CLI 的 stop/EOF，再等待实际退出。
- 普通 close 路径无 kill/taskkill/按 PID 终止、无注册表、计划任务或开机启动。

每次启动的 UI 偏好/浏览器缓存也隔离在 `.work/session-*/profile`；UI 快照 hash 保留在该 session 的 `ui-inputs.json`。
不自动清理工作目录；历史失败证据、合成数据和独立副本都保留，不混进可交付源码。

## 定向复现

从项目根执行：

```powershell
& .\.runtime\node-v24.22.1-win-x64\node.exe --test companion/host/test/boundary.test.mjs
& .\.runtime\node-v24.22.1-win-x64\node.exe companion/host/test/desktop.mjs
& .\.runtime\node-v24.22.1-win-x64\node.exe .\node_modules\typescript\bin\tsc -p companion/host/test/tsconfig.json
```

桌面验收复用维护者已有 Playwright，仅测试进程启用自动化调试通道，正常启动不启用。
它会真正打开桌面/浏览器，以现有 UI 按钮测试 r2 启停；所有数据库均来自新解包空库，不访问正式 Local。
首次沙箱无法进行必要的宿主验证时，应申请仅限这些独立测试的权限，不能跳过路径/IPC 检查或改测 8787。

结果、失败历史和真实限制见 [VERIFICATION.md](VERIFICATION.md)。

## 后续联调，不自动推进

- Antigravity 可沿用四方法和推送，并接入 runtimeCode/ownsProcess/日志；对照 CONTRACT，不再猜测启动成功和超时语义。
- 本轮 UI 侧有并行演进，实际验收以冻结快照为准；未读写真实账号/设置，未代替 Antigravity 的完整 UI 与用户验收。
- 需要继续确认原生窗口按钮与 UI 自绘按钮的职责、停止失败时的提示，以及剩余原型入口的明确标识。
- 安装/更新、账号、AI、同步、托盘、异常退出恢复和正式桌面打包都不属于本轮；完成交付后停止。
