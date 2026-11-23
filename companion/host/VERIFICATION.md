# M1-A 桌面宿主与 Runtime 桥接 — 定向交付记录

2026-11-22，UTC+8。**可运行 Windows 技术样例已完成；到 M1-A 停止，等待后续双方联调，不推进 M2。**

## 范围与输入

开始前只读检查 M0 Runtime 的 API/README/VERIFICATION，以及现有 UI Driver/bridge 契约；创建前 `companion/host` 不存在。
本轮只新增 host，**M0 Runtime 无需修改**，没有重建两个 M0 工程、清理主工作树或操作正式 Local。

- 实际宿主：Electron **45.4.1**，Chromium **156.0.8078.100**，框架 Node **24.22.3**。
- Runtime/Analyzer：原始 r2 的随包 Node **24.22.1**、Analyzer 2.0.0、Schema 15。
- ZIP SHA-256：`ef8ea8cb083fb0b5e7b3091fa07eae065a5de3b84ea13b0245078bc3cc613236`，结束仍匹配。
- 187 个正式产品构建输入无漂移；M0 验证记录中的 10 个源码/测试输入 hash 全部保持不变。
- UI 文件只读。工作期间 Antigravity 一侧确有并行演进；**不声称整个 UI 目录全程不变**，也不恢复/覆盖其成果。
  宿主将每次加载的 dist 冻结到自己的 `.work/session-*`，记录逐文件 hash，并检测复制期间的源变动。

## 最终验证结果

| 范围 | 结果 |
|---|---|
| IPC/投影/JSONL 定向单元测试 | **9/9 子用例通过**；Node 含父用例统计 **10/10**，失败/取消/跳过均 0 |
| 实际桌面端到端 | **19/19 检查通过**，2026-11-22 **18:42:08–18:43:04 UTC+8** |
| UI/host 接口类型兼容 | strict、noEmit、types:[]，通过；没有 skipLibCheck，没有运行或重建 UI |
| 原生桌面观察 | Windows Computer Use 识别并前置实际窗口，截图与可访问性文本确认 Home/CODEX RUNTIME；不是仅用 DOM 推测窗口存在 |
| 数据与退出 | 两份全新空库、随机非 8787 端口；安全停止后均 Schema 15、0 收藏、integrity ok；两份应用清单仍通过 |

最终首个自管 Analyzer 端口为 **65336**；外部哨兵、重启等使用各自随机端口。
没有向 8787 发请求，没有读取真实 DB/WAL/SHM/config，没有真实 Bangumi 或付费 AI 请求。

### 真实桌面链路已证明

1. 现有 UI Home 在真实可见的 Windows BrowserWindow 中加载；隔离 bridge v1 存在，renderer 无 require/process。
2. 未就绪时拒绝 open；损坏临时副本 README 后，host 返回 INTEGRITY_FAILED 且没有拉起服务。
3. 恢复该临时副本后，点击**现有 UI 的启动/重试按钮**，真实 Driver → preload → 主进程 → JSONL → M0 → r2，达到 ready/running。
4. start 返回的是已就绪状态；并发重复 start 仍为同一个服务与地址。另一个 host engine 对同一包报 SESSION_LOCKED，不接管。
5. 非所属 host engine 的关闭不影响实际 owner；真实 Runtime open 的系统浏览器交付成功。
6. getLogs 可获取真实 READY 等白名单事件，没有本机路径/凭据；onStatus 推送过渡与 running 快照。
7. 点击**现有 UI 的安全停止按钮**达到 stopped，移除自己的会话锁，独立 B 实例仍健康；再次启动成功。
8. 请求外部随机本机 URL 的页面导航/弹窗/子 frame 均被阻止，占用方 HTTP 请求数为 0。
9. 测试专门建立一个非所属窗口，使用相同 preload 的不可信 data 文档调用 bridge，真实主进程返回 IPC_DENIED。
10. 使用**原生窗口 close 路径**，不是测试框架强关 helper：A 服务与 CLI 安全退出，另一个独立 B 实例仍健康。
11. B 最后由它自己的监督器安全停止；应用文件 hash 不变，M0 源码与原始 ZIP 不变，renderer pageerror 为 0。

默认浏览器交付成功只代表系统处理命令返回成功，不替代用户的浏览器焦点、视觉或交互验收。

### 单元反例

精确 URL/顶层 frame/窗口身份；未知方法与 path/PID/URL 参数；非法/8787 URL；丢弃路径/原始错误；
日志事件白名单；专用协议路径/POST/CSP；JSONL 乱序关联；超时仍保留在途请求、等待迟到响应；
恶意/超长输出；传输死亡不自动重建 CLI；故障投影中 state/rawState/runtime.state 一致且保留 ownsProcess。
这些是**合成传输测试**，不混算为真实 r2 运行验收。

## 没有隐藏的开发失败

- 首轮 Electron ESM 入口在顶层等待 app.whenReady，产生初始化等待环：没有窗口，Playwright 启动超时。
  改为非顶层 await 的异步入口后，窗口实际出现，已重新完成最终验收。
- 为排除自动化因素直接启动的旧引导进程同样挂起。核对精确可执行路径、命令行、PID 4388、无 Runtime Node 子进程且无 Analyzer 会话锁后，
  单独结束了这个**尚未创建 Runtime 的调试引导进程**。这不是优雅停机，也不是最终产品退出流程；没有结束 Analyzer/外部进程树。
- 第一轮窗口内的损坏包反例发现 host 的顶层 error 与嵌套 runtime.state=checking 不一致，使并行更新的 UI 优先读嵌套状态后无法显示重试。
  修复的是 host 投影及契约，UI 文件未改；补了回归断言，最终 UI 按钮重试通过。
- 导航拦截反例已经成功阻止外部请求，但 Playwright 在被阻止的导航后继续等待下一次 locator click，导致中间验收超时。
  将正常 UI 按钮启停放在导航反例之前，再以主进程原生关闭收尾；**未放宽导航限制**，最终全部通过。

这些中间轮次不计为通过；原始失败报告保留在 `.work/desktop-acceptance-3ImVNO`、`0Phub7`、`YuOlPq` 对应目录。
最终通过轮次是 `.work/desktop-acceptance-95HI6w`，单元/桌面日志在 `.work/final-run-ded597d00d3849bd94b285139bd33029`。

## 证据

- [最终桌面验收 JSON](evidence/desktop-verification.json)
- [边界测试结果](evidence/boundary.tap)
- [代码输入、M0/产品源对账及 UI 快照 hash](evidence/inputs.json)
- [最终通过轮次实际使用的 UI 快照](evidence/tested-ui-inputs.json)（session-jo9fUf，3 个静态文件）
- [本轮 8 个独立测试副本的会话锁收尾检查](evidence/cleanup.json)
- [桌面首页空闲截图](evidence/desktop-home-idle.png)
- [桌面首页运行截图](evidence/desktop-home-running.png)

归档文本只替换仓库绝对路径为 `<repository>`；完整原始记录和临时数据库留在忽略的 `.work` 中，不清理、不分发。
截图为实际 Electron UI，不是生成图；Windows 前置观察另见本次工具记录，未冒充用户视觉验收。

## 边界与后续联调

- 正常启动不暴露调试端口；Playwright 的 inspector/CDP 只存在于验收进程。没有开放本地 HTTP 控制 API。
- 只有可信本地顶层页面可以调用白名单 bridge；不是通用 shell/文件管理接口，不接受任意 PID/URL/路径。
- 超时不是取消；CLI 丢失/协议不可信时不自动重建，不接管未知进程。仍有归属或归属不明时，原生关闭保留窗口而不是强杀。
- 不宣称解决同权限恶意进程篡改、主进程硬崩溃恢复、任意挂死资源、断电、其他物理电脑或全业务组合。
- 本机 Electron 依赖已经准备；未交付正式桌面包/安装器/签名，也没有跨机离线安装验收。
- UI 的 Driver 接入正在由另一侧维护。已验证本轮冻结快照的启动、停止、推送和错误重试，但不是整个 UI、账号、同步或偏好的最终验收。
- 启动/退出偏好、UI 自绘窗口按钮、剩余原型入口、日志展示与错误文案仍需双方按 [CONTRACT.md](CONTRACT.md) 联调和用户确认。

**交付后停止。安装、更新、账号体系和 M2 均不在本轮自动继续。**
