# Companion Runtime M0 / protocolVersion 1

## 传输选择

没有现存桌面宿主协议可复用，因此先交付两个同源最小入口：

1. Node 模块 `supervisor.mjs`，类型声明 `supervisor.d.mts`。
2. `cli.mjs --packageRoot <绝对路径> [--port <端口>]` 的私有 JSON Lines stdio。

这不是 GUI 联调完成声明。Antigravity 可以选择宿主后端直接 import，或以子进程适配 JSONL；运行核心不侵入 `companion/ui`。

```js
import { AnalyzerSupervisor } from './supervisor.mjs';
const runtime = new AnalyzerSupervisor({ packageRoot: absoluteIndependentR2Copy, port: 0 });
const started = await runtime.startAnalyzer();
// UI 继续轮询 runtime.getStatus()，不要把 started.ok 当 ready。
// state === 'ready' 后：await runtime.openAnalyzer();
// 关闭宿主前：await runtime.stopAnalyzer(); 并确认 ownsProcess === false。
```

构造参数由可信宿主决定，所有公开动作均无参数：

| 方法 | 返回 | 语义 |
|---|---|---|
| `getStatus()` | `RuntimeStatus`（同步） | 缓存状态快照，无副作用、不枚举进程、不访问其他服务 |
| `startAnalyzer()` | `Promise<RuntimeResult>` | 完整性检查、独占锁、发起子进程；返回通常是 `starting`，不自动开网页 |
| `stopAnalyzer()` | `Promise<RuntimeResult>` | 仅停止此对象亲自启动且仍持有的进程；无归属时为安全 no-op，不接管 |
| `openAnalyzer()` | `Promise<RuntimeResult>` | 必须已 ready，再次确认健康及同一会话，交给系统默认浏览器 |

## JSONL 帧

请求 UTF-8，一行一帧，必须换行；仅允许非负安全整数 `id` 和上述 `method`：

```json
{"id":12,"method":"startAnalyzer"}
```

响应示例（实际 URL、hash、日志以运行结果为准）：

```json
{"id":12,"ok":true,"status":{"protocolVersion":1,"state":"starting","package":{"state":"valid","version":"2.0.0","distributionRevision":2,"files":3249,"checksumsSha256":"<64位hash>"},"ownsProcess":true,"url":null,"error":null,"logs":[]}}
```

`getStatus` 在 JSONL 中也包装为 `{id,ok:true,status}`。响应可能乱序，按 id 关联。
每帧上限 4096 个 UTF-16 码元、最多 8 个并行请求；超出、未知方法、额外字段/参数、非整数 id 都拒绝。
无效请求统一 `id:null`，不回显原始输入。繁忙请求返回 `BUSY`。
轮询建议 250–500ms；日志按 `seq` 去重，仅为快照中的最近 100 条，不保证无限历史。

EOF/Ctrl+C 会先请求停止，发送 `{event:"transportClosing",ok,status}`。若停止超时，CLI 不强制退出；仍保持当前子进程的 IPC。
宿主应在收到成功停机、`ownsProcess:false` 后关闭传输，而不是以杀死 CLI 代替关机。

## 状态与错误

主要路径：`idle → checking → starting → ready → stopping → stopped`；任何必要检查/运行失败可进入 `failed`。
`checking` 可能持续数秒（逐文件哈希），可以并行查询状态或请求取消；取消要等当前只读检查结束，不会跳过检查后启动。
重复 start/stop 不创建第二个实例；stop 后可显式 start。同一对象存在未退出子进程时，失败状态下也不会再启动一个实例。

```ts
type RuntimeStatus = {
  protocolVersion: 1;
  state: 'idle'|'checking'|'starting'|'ready'|'stopping'|'stopped'|'failed';
  package: { state: 'unknown'|'checking'|'valid'|'invalid'; version?: string;
    distributionRevision?: number; files?: number; checksumsSha256?: string };
  ownsProcess: boolean;
  url: string|null; // 仅 ready 时出现；不能用于识别、接管或结束其他服务
  error: {code:string; message:string}|null;
  logs: {seq:number; at:string; level:'info'|'error'; event:string}[];
};
type RuntimeResult = {ok:boolean; status:RuntimeStatus; error?:{code:string;message:string}};
```

`ok` 是该动作结果，不是全局服务健康度。尤其：
- start 的 `ok:true` 不保证已就绪。
- stop 无当前实例时 `ok:true`，但保留先前的失败诊断，不把失败伪装成运行正常。
- 浏览器交付失败通过动作 `error` 返回，ready 实例仍可继续使用；不把开网页失败当成服务崩溃。
- stop 超时可为 `failed + ownsProcess:true`；此时不能退出宿主或声称实例已关闭，应重试 stop/等待收束。
- 晚到的安全退出可转为 stopped；历史错误仍在日志/`error`，下一次 start 会清除本次错误。

常见错误码：

| 错误码 | 处理 |
|---|---|
| `PACKAGE_MISSING / PACKAGE_DAMAGED / PACKAGE_INVALID` | 核对独立分发目录，重新解包到新目录，不覆盖用户数据 |
| `PACKAGE_UNSUPPORTED / PLATFORM_UNSUPPORTED` | 当前仅支持 r2 / 2.0.0 / Windows x64 / Node 24 |
| `UNSAFE_PATH / PACKAGE_ACCESS` | 拒绝链接或正式路径；使用可写的独立普通目录 |
| `SESSION_LOCKED` | 已有锁，未接管；回到其原宿主窗口，M0 不自动清理 |
| `PORT_IN_USE / PORT_UNAVAILABLE / INVALID_PORT` | 换随机端口或明确非 8787 端口；不会请求占用方 |
| `SPAWN_FAILED / SERVICE_EXITED / START_TIMEOUT` | 状态不就绪；保留数据；超时只请求优雅退出，不强杀 |
| `STOP_TIMEOUT / STOP_FAILED` | 检查 ownsProcess，保持宿主，重试安全停止 |
| `NOT_READY / HEALTH_FAILED` | 不开网页；等待或停止当前实例后重试 |
| `OPEN_FAILED` | 系统默认浏览器调用失败；ready 时可使用 status.url 手动打开 |
| `LOCK_CHANGED`（日志） | 仅停自己的进程，未删除变化后的锁，需人工核查 |

## 明确限制（联调前必须知道）

- 仅适配现行 r2 的 `service.mjs` 和正式 Fastify 监听日志格式；升级包或改日志格式需显式适配、再验证。
- SHA-256 是完整性检查，不是数字签名；不能抵御恶意者同时改包和清单。只能运行来自可信来源的副本。
- 路径/锁保护针对普通本地误操作，不宣称能防御同权限恶意进程在校验后替换文件的 TOCTOU 攻击。
- 健康确认依赖自己的监听证据、IPC 连接及 dataDir，不根据发现到的 PID/健康响应接管任何实例。
- `getStatus` 不持续健康探测；ready 表示最近确认已就绪，进程退出会立即转失败，open 时会再次检查。
  进程活着但卡死，可能直到 open 才发现；不实现自动重启、自愈或心跳系统。
- stop 超时不强杀，不能承诺任意挂死的程序都能立即退出。父进程非正常死亡后的完整恢复/看门狗未验收。
  r2 已有的 IPC disconnect 安全退出仍保留，但残留锁不自动回收，不能新建监督器接管旧进程。
- 浏览器交付成功只代表 Windows 默认处理程序命令退出 0，不代表页面可见、焦点正确或用户已接受。
- 原应用自身的 loopback 无认证边界未改变；M0 不向网页提供后台命令执行服务。
- 尚未验证 Antigravity GUI 宿主、真实账号/网络/AI、其他物理电脑、非 Windows 平台或全部业务组合。
- 没有安装、更新、迁移、后台守护、开机启动、注册表/计划任务、更换端口的自动恢复或全仓审计。
