# Companion M0 运行核心 — 定向验证交付

2026-11-22，UTC+8。**可运行样例已完成，停止在双方 UI/宿主联调之前。**
这是开发侧的定向运行验收，不是全仓审计、历史 Final Gate、正式 Local 验收、GUI 验收或用户体验签收。

## 已交付

- `package-check.mjs`：独立分发完整性与路径检查。
- `supervisor.mjs`：启动/就绪/失败状态、当前子进程归属、私有 IPC 优雅停止、ready-only 浏览器打开。
- `cli.mjs`：可直接运行的私有 JSONL 宿主入口，无服务端依赖或 HTTP 控制端口。
- `supervisor.d.mts`、[API.md](API.md)：四个最小方法、类型、状态、错误和联调边界。
- [README.md](README.md)：用原始 r2 ZIP 创建全新副本并运行的完整命令。
- `test/`：合成反例、真实 r2 窄验收和可编译接口契约。

## 基线与隔离

- 原始 r2 ZIP SHA-256：`ef8ea8cb083fb0b5e7b3091fa07eae065a5de3b84ea13b0245078bc3cc613236`。
- Windows x64、随包 Node 24.22.1、产品 2.0.0、distributionRevision 2。
- 187 个实际产品构建输入在本轮开始、验收前后均与当前工作树一致；没有用 HEAD 替代未提交源码。
- 原始 ZIP 不变；两份解包副本各自拥有临时 `data`，初次启动前没有任何 data。
- 正式 Local、8787、真实 DB/WAL/SHM/config、已有分发目录与主工作树既有成果未用于测试，也未重启或清理。
- 只新增 `companion/runtime`。开始时无目录冲突；另一侧后来创建的 `companion/ui` 未读写。
- 原产品源码、构建器、Constitution、依赖和锁文件无本轮改动；没有新的长期语义裁决需要回写 Constitution。

## 最终结果

| 范围 | 实际结果 |
|---|---|
| 合成安全/生命周期 | **18/18 子用例通过**；Node 统计含父用例为 **19/19**，失败/取消/跳过均 0 |
| 原始 r2 新解包运行验收 | **19/19 检查通过**，2026-11-22 18:11:02–18:12:12 UTC+8 |
| 接口类型契约 | 独立 `test/tsconfig.json`，strict、noEmit，通过；未用 skipLibCheck |
| 运行入口语法 | package-check / supervisor / cli / acceptance 的 `node --check` 通过 |
| 产品输入/分发原件 | 187 输入无漂移，原 ZIP SHA-256 不变，两份程序文件校验仍通过 |

### 合成反例覆盖

拒绝 8787/非法端口和正式路径；环境凭据隔离；缺损/额外文件；清单穿越/重复/遗漏/不支持版本；
package 祖先 junction 与 data 内链接；不回收旧锁、不接管 PID；占用端口不发 HTTP；
检查期间取消；重复启动/停止；原始输出/错误 canary 不泄露；锁被替换不删除；两个监督器竞争最多一个实例；
坏可执行文件不回退系统 Node；open 重新检查健康；没有私有监听证据就零健康探测；错误身份拒绝就绪；
进程异常退出、启动早期停止、停止超时仍保留所有权，以及 open/stop 竞态。

这些使用明确标注的**合成包/服务**，不能替代下面真实 r2 的运行证明。

### 真实 r2 证明

1. 两次从原始 ZIP 解包，中文、空格、`&` 路径，逐文件 SHA-256 全通过：3249 个清单文件，加 checksums.json 共 3250 文件。
2. 实际启动随包 Node 与未改动 r2 `service.mjs`，观察 checking → starting → ready。
   最终一轮首次两个端口分别为 **57441、57443**；重启、旧启动器和 JSONL 也使用其各自随机非 8787 端口。
3. `/api/health` 确认正确版本、空收藏、各自 dataDir；分发模式能力存在，账号/Token/AI 均为空，合成继承凭据未进入服务。
4. 同一目录的新监督器与原便携启动器均拒绝重复启动；无归属监督器的 stop 不影响现有实例。
5. `openAnalyzer` 已就绪后重新检查健康；适配器读取真实 SPA 与非空 JS/CSS。
   最终同一个 open 操作内调用 Windows 默认浏览器，系统处理程序命令返回 0。
6. stop A 触发正式屏障并等待退出，删除本会话锁；B 同时仍健康。
   A 停止后不能打开；再启动时临时昵称配置仍在，未丢弃/清理数据。
7. 两份临时 SQLite 在安全停机后，以只读方式自检：Schema 15、收藏 0、integrity ok、FK 违规 0。
8. 用**独立旧便携启动器**启动 r2，再由一个新监督器尝试 start/stop：拒绝接管，旧实例保持健康，最终由其自己的输入通道关闭。
9. 实际 CLI 子进程经过 JSONL 的 get/start/status、非法/超长帧拒绝、canary 不回显与 EOF 安全关机；最终没有遗留该服务的锁。
10. 所有已启动的验收实例最终都经过其所属通道安全停止；没有 taskkill/强杀、真实账号请求或付费 AI。

**浏览器命令成功 ≠ 页面真实可见/获得焦点 ≠ 用户视觉验收。** 本轮未声称完成这三项。

## 证据与复现

可归档的脱敏证据：

- [真实验收 JSON](evidence/r2-verification.json)
- [安全测试原始结果（仅替换仓库绝对路径）](evidence/safety.tap)
- [最终代码/测试 hash 与接口检查记录](evidence/runtime-inputs.json)

完整原始证据保留在本目录忽略的隔离区，不自动删除：

- `.work/final-run-c99dd5a674f7464ba134931110c6ff61/safety.tap`
- `.work/final-run-c99dd5a674f7464ba134931110c6ff61/acceptance.log`
- `.work/r2-acceptance-bp05jN/verification.json` 及两份实际运行副本
- `.work/safety-Iu3G9E/` 合成测试夹具

此前的预检/首轮验收副本也保留，不将它们混为最后一轮；最终可执行代码和测试 hash 见上面的 runtime-inputs.json。

复现命令见 README；接口契约额外检查命令：

```powershell
& .\.runtime\node-v24.22.1-win-x64\node.exe .\node_modules\typescript\bin\tsc -p companion/runtime/test/tsconfig.json
```

## 实际遇到的限制，没有掩盖

- **沙箱预检失败**：对全新解包目录的 realpath 返回 EPERM；保留保护，申请限定的宿主验证后同一检查通过。
  最终安全/运行测试在获准的宿主环境执行，不能说受限沙箱里的真实启动也已通过。
- **首次接口编译命令失败**：显式引入仓库 Node ambient types 后出现 undici-types 解析失败。
  改为只检查本目录公开契约的独立 `types:[]` 配置后通过，没有安装依赖、改主仓配置或跳过库检查。
  这是接口声明检查，不是对运行核心全部 JS 或全仓做 TypeScript 验收。
- 仅适配 Windows x64 / Node 24 / 当前 r2 监听日志与 IPC；没有安装器、更新器或 GUI。
- 不自动回收残留锁、不恢复/接管跨监督器会话、不做心跳/自动重启。ready 是最近确认值；进程退出立即失败，open 再验健康。
- 停止超时仍可能有活进程，保留归属/锁并明确失败，不强杀；任意挂死程序的最终退出、父进程硬崩溃恢复未保证。
- SHA-256 不是签名；同权限恶意本机进程/校验后替换文件不在 M0 安全保证内。
- 未验证 Antigravity 的宿主桥接、用户 GUI 交互、真实账号/上游网络/AI、其他物理电脑与全部业务组合。

**下一步仅为双方联调四方法、状态轮询和退出生命周期；本轮到此停止。**
