# Companion M0 — 可运行监督器

本目录只负责运行核心，不是 GUI、安装器、更新器或新的 Analyzer 服务实现。
零第三方依赖，Windows x64 / Node 24；直接运行独立分发 r2 随包的 Node 即可。
**不运行仓库源码、不使用 HEAD 快照、不触碰正式 Local、不接管已有服务。**

## 基线与范围

- 已阅读 `ANALYZER_CONSTITUTION.md`、`docs/distribution/BUILD.md`、分发用户说明和 r2 发布记录。
- 当前产品版本 2.0.0、分发修订 2、随包 Node 24.22.1。
- 依据现行工作树（包含未提交成果）。本轮开始和真实验收结束时，r2 的 187 个产品构建输入与现行源码 hash 一致。
- 本轮选用原始 `dist/distribution-fr6uZl/Bangumi-Analyzer-2.0.0-windows-x64-r2.zip`，SHA-256：
  `ef8ea8cb083fb0b5e7b3091fa07eae065a5de3b84ea13b0245078bc3cc613236`。
- 创建前 `companion` 不存在；只新增 `companion/runtime`。UI 后续由另一侧创建，未读写其内容。
- 不修改产品源码、Constitution、构建器、分发 ZIP、主工作树既有改动或 `companion/ui`。

## 立即运行（独立副本）

在项目根目录的 PowerShell 执行。下面只创建新目录，不覆盖或删除任何已有目录：

```powershell
$Repo = (Get-Location).Path
$Runtime = Join-Path $Repo 'companion/runtime'
$Zip = Join-Path $Repo 'dist/distribution-fr6uZl/Bangumi-Analyzer-2.0.0-windows-x64-r2.zip'
if ((Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLower() -ne 'ef8ea8cb083fb0b5e7b3091fa07eae065a5de3b84ea13b0245078bc3cc613236') { throw 'ZIP hash mismatch' }
$Package = Join-Path $Runtime ('.work/manual-' + [guid]::NewGuid().ToString('N') + '/Analyzer')
New-Item -ItemType Directory -Path $Package -ErrorAction Stop | Out-Null
Expand-Archive -LiteralPath $Zip -DestinationPath $Package
& (Join-Path $Package 'runtime/node.exe') (Join-Path $Runtime 'cli.mjs') --packageRoot $Package
```

保持这个终端，逐行输入（每次一行，必须按回车）：

```json
{"id":1,"method":"getStatus"}
{"id":2,"method":"startAnalyzer"}
{"id":3,"method":"getStatus"}
```

轮询 `getStatus`，直到 `state` 为 `ready`，再输入：

```json
{"id":4,"method":"openAnalyzer"}
{"id":5,"method":"stopAnalyzer"}
```

`startAnalyzer` 返回 `ok: true` 只表示检查后已发起启动，不等于就绪。
只有 `ready` 才返回可打开的 URL。`stopAnalyzer` 成功且 `ownsProcess: false` 后再关闭终端。
Ctrl+C 或 stdin EOF 也会请求安全关闭；**不会用强杀伪造关闭成功**。
关闭网页不会停止服务，启动默认不自动打开网页。指定端口可另加 `--port 19091`；默认 `0` 为随机空闲端口，始终拒绝 8787。

## UI 联调

见 [API.md](API.md) 和 `supervisor.d.mts`。

- UI 宿主若具备 Node 后端：直接导入 `AnalyzerSupervisor`。
- 纯 Web UI：由其宿主进程启动本 CLI，通过私有 stdio 交换 JSONL；不要让网页直接执行命令。
- M0 **没有** HTTP/CORS 接口；无需为联调增加全网监听或放开任意网页调用权限。
- `packageRoot` 由可信宿主启动时设置，不能从网页每条请求任意更换。
- 不接受任意 PID、URL、命令、环境变量或数据路径参数。

## 实现与安全

1. 自己实现只读完整性检查，不先导入包内校验脚本：验证 3249 个清单文件、必须的运行文件、r2 元数据、Node hash 和目录额外文件。
   拒绝路径穿越、链接/junction、硬链接文件、UNC、缺损文件和正式数据/部署路径；仅检查独立副本的数据目录元数据，不读配置内容。
2. 独占创建兼容便携版的 `.analyzer-session.json`，包含本监督器 PID、实际服务 PID 与随机会话标识。
   **任何已有锁均拒绝**，不根据 PID 猜测死亡，不清理旧锁，不接管实例。
3. 固定 `127.0.0.1` 和该副本的 `data`，只启动其 `runtime/node.exe service.mjs`。
   不继承账号、Token、AI Key、代理、Node flags 或外部数据路径；无系统 Node 回退。
4. 必须先收到当前子进程私有 stdout 中的实际监听记录，再以无环境代理的原生 HTTP 检查同一地址的健康、版本及独立 dataDir。
   绑定竞态失败即失败，不探测或附着其他占用服务。健康响应有总超时、大小上限，不跟随跳转。
5. 停止只通过内存中当前 `ChildProcess` 的私有 IPC 发送 `shutdown`，复用未改动 r2 `service.mjs` → 正式 SIGINT 关闭屏障。
   允许后台任务和 SQLite 收束，超时保留进程归属、锁和失败状态，可重试；不调用 taskkill 或按 PID 发送终止信号。
6. 退出后只删除仍与本会话 nonce/文件身份匹配的锁；不删 data、不改配置、不动他人的锁。
7. 默认日志只有最多 100 条时间戳/事件码。stdout/stderr 只排空，原始内容不转发、不落盘、不拼进 UI 错误；错误信息为固定白名单。
   原 Analyzer 可能自行写入其副本 `data/logs`，不属于 Companion 日志，M0 不读取、打包或向 UI 暴露它们。

## 验证入口

均从项目根执行，使用可信 Node 24；不安装依赖、不重构、不运行全仓测试：

```powershell
& .\.runtime\node-v24.22.1-win-x64\node.exe --test companion/runtime/test/supervisor.test.mjs
& .\.runtime\node-v24.22.1-win-x64\node.exe companion/runtime/test/acceptance.mjs
# 仅需验证系统默认浏览器交付时，显式添加：--open-browser
```

安全用例为合成的最小包；真实验收另外从上述已核对 ZIP 新解包两份，使用正式分发代码、真正 HTTP 和临时 SQLite。
测试目录均在 `.work`，不自动清理；被本目录 `.gitignore` 排除。不要把测试副本/临时数据库当干净产品分发。
真实验收脚本固定本次 r2 基线，不会自动寻找最新版或重新构建。

沙箱首次预检曾在隔离目录 `realpath` 得到 EPERM，宿主同一检查通过；没有为了适应沙箱跳过路径验证。
需要宿主许可时只能批准这些隔离验证，不应改为访问正式 Local。

最终结果和真实限制见 [VERIFICATION.md](VERIFICATION.md)。本轮到运行核心交付为止，等待双方联调。
