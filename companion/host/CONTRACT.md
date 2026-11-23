# Companion Bridge v1 — M1-A 单一联调契约

状态：M1-A 实施契约；选择 Electron 不构成永久架构决定。
UI 文件由 Antigravity 维护；本宿主只读其 dist 的快照，不重建 M0 UI。

## 入口

可信顶层本地文档 `companion://ui/index.html?driver=codex&screen=home` 的隔离 preload 暴露：

```ts
window.companionBridge = {
  bridgeVersion: 1,
  getStatus(): Promise<CompanionStatus>,
  startAnalyzer(): Promise<CompanionStatus>,
  stopAnalyzer(): Promise<CompanionStatus>,
  openAnalyzer(): Promise<OpenResult>,
  getLogs(): Promise<CompanionLog[]>,
  onStatus(cb: (s: CompanionStatus) => void): () => void,
  onLogs(cb: (logs: CompanionLog[]) => void): () => void,
}
```

前四方法保持 `companion/ui/src/driver/codexDriver.ts` 的返回形状。完整声明见 `bridge.d.ts`。
所有动作无参数；不存在网页传入的 path、PID、URL、环境变量、shell、配置或文件读取能力。
已知运行/传输错误 resolve 为结构化结果，不向 UI 抛出带路径/原始异常的 Error。

## 状态

基础字段完全兼容 M0 `AnalyzerStatus`：state/url/port/pid/version/startedAt/dataDir/error。
Runtime 未暴露的 pid/startedAt/dataDir 保持 **null**，不猜测、不泄露本机路径。

| Runtime | UI state |
|---|---|
| idle | unknown |
| checking / starting | starting |
| ready | running |
| stopping | stopping |
| stopped | stopped |
| failed | error |

新增只读 `runtime: {state,ownsProcess,packageState}` 与递增 `revision`，UI 可选择使用。
兼容正在接入的 UI Driver，同时提供顶层 `protocolVersion:1 / rawState / package / ownsProcess / logs`（均为白名单投影，无路径）。
宿主监督链路失败时 rawState 与 runtime.state 均为 failed，避免 UI 按不同优先级读取时相互矛盾。
这不证明底层服务已经退出；ownsProcess 保守保留，必须通过同一 Runtime 安全停止确认，不得接管外部进程。
仅 running 返回经过校验的数字端口 loopback URL（禁止 8787）；不可据此接管进程。
状态推送为宿主每 400ms 向私有 JSONL 查询后发布的变化快照，不是假定 Runtime 原生事件流。
`onStatus` 在订阅后发送当前快照；返回函数解除订阅。`onLogs` 同理，日志为最近 100 条完整快照，按 seq 去重。

## 动作完成语义

- getStatus：获取当前状态（宿主初次完整性检查未完成时可为 starting）。
- startAnalyzer：等待 ready、failed 或停止后返回；**不返回“已发起”来冒充运行成功**。重复调用共享同一启动任务。
- stopAnalyzer：等待当前 Runtime 管理的服务结束；超时返回 error 且 `runtime.ownsProcess` 可仍为 true，不强杀、不谎报 stopped。
- openAnalyzer：Runtime 再验就绪后交给系统浏览器；返回 `{opened,url,error?}`。false 时 url 为空，不静默改开其他地址。
- getLogs：只取内存中白名单事件码，不读 Analyzer 的 data/logs 或任意文件。
- 失败重试：调用 getStatus 确认状态；若 ownsProcess 为 true，先重试 stop 并等待安全退出；否则可以再次 start。
  包损坏/锁冲突需先由可信宿主操作者处理独立副本，网页不能删除锁或修改文件。

## 错误

保留现有 UI 的 error.code 联合类型，并增加可选 `runtimeCode` 精确诊断：

| 精确码 | UI code |
|---|---|
| PORT_IN_USE / PORT_UNAVAILABLE / INVALID_PORT | PORT_IN_USE |
| SESSION_LOCKED | DATA_LOCKED |
| PACKAGE_* / UNSAFE_PATH / PLATFORM_UNSUPPORTED | INTEGRITY_FAILED |
| SERVICE_EXITED / SPAWN_FAILED | PROCESS_EXITED |
| START_TIMEOUT / STOP_TIMEOUT / HOST_TIMEOUT | TIMEOUT |
| HOST_UNAVAILABLE / HOST_PROTOCOL / IPC_DENIED / HOST_CLOSING | BRIDGE_UNAVAILABLE |
| BUSY（并发上限或已有操作） | UNKNOWN |
| 其他已知运行错误 | UNKNOWN |

message/hint 由宿主白名单生成；不转发原始 stderr、解析异常、路径、凭据。
浏览器打开失败不将仍健康的服务永久改成 error；OpenResult.error 报动作失败。

## 传输与超时

Renderer → 隔离 preload → Electron 主进程固定 invoke 通道 → 只属于该宿主的 Runtime CLI stdin/stdout。
主进程仅允许所属窗口的**可信顶层 frame、精确文档 URL**；额外参数、未知方法、子 frame、远程/其他文档均拒绝。
Runtime JSONL 仍是 `{id:非负整数,method}` → `{id,ok,status,error?}`，按 id 关联，最多 8 在途请求。
主进程不向 renderer 暴露原始 IPC 对象或 JSONL。

- 单次 getStatus JSONL：5s；start JSONL：60s；stop JSONL：60s；open JSONL：10s。
- 整个 start（含包预检及等待就绪）：90s；整个 stop/关闭：65s。
- 超时**不是取消**，不重新创建另一个 CLI，也不自动重复发送 start。保留在途结果和保守归属，先查状态。
- Runtime CLI 死亡/协议错误：停止自动重建，不接管未知进程。若此前 ownsProcess=true，保守保留所有权不明标记。

## 窗口退出

原生窗口 X/Alt+F4 先拦截 → 请求同一 Runtime stop → 确认无归属进程 → stdin EOF → 等 CLI 真正退出 → 销毁窗口。
超时/归属不明保持窗口与 IPC，显示固定错误，可再点原生 X 重试；没有“按 PID 强杀”或后台自动推进。
若 UI 仍保留自绘的“关闭到托盘（模拟）”入口，它不代表已实现托盘生命周期；M1-A 使用 Windows 原生窗口控制按钮。

## 尚待 Antigravity

- 只需沿用四方法及 onStatus；可接入可选 getLogs/onLogs、runtime.ownsProcess 和 runtimeCode。
- 去除/区分 Home 的模拟成功 toast、假账号/统计、模拟同步与模拟托盘文案；不能把真实 Runtime 状态当整个 UI 已真实化。
- start 期间优先展示推送状态；stop 失败不可无条件 toast “安全停止”。关闭宿主应由原生关闭流程处理。
- 本轮不实现账号、安装、更新、同步桥接，也不自行进入 M2。

工作期间 UI 一侧已并行演进，最终冻结快照的按钮启停、推送、错误重试已通过 host 端到端测试；上述清单是联调核对项，不要求重做已经完成的 Driver 工作。
