# 第三阶段分发工程：维护者操作说明

本流程生成完整 Local Windows x64 便携 ZIP，不是 Public Demo，不是第四阶段安装桥梁。
使用当前工作树文件（包括未提交成果），不能改用 Git HEAD / git archive，也不能直接压缩工作目录。

当前分发修订为 r5（v2.0.0 正式版：跨端口网页主题持久化 + 账号断开 + Series Engine v3），产品版本为 2.0.0；ZIP 名包含 -r5，release.json 记录 distributionRevision=5。
便携启动器给服务设置 BANGUMI_DISTRIBUTION=1，通过只读 canDisconnectBangumi 能力显示设置入口并注册退出路由。
普通 Local 不设置该标识，不显示新入口、不注册该路由；没有维护第二套源码、增加个人配置字段或升级 Schema。

## 构建前提

- Windows x64；可重分发的 Node 24 完整发行目录，node.exe 同级必须有上游 LICENSE。
- 当前仓库三包生产源码、构建配置、锁文件和已安装依赖完整。构建不联网、不 install、不执行依赖安装脚本。
- TypeScript/Vite 等工具仅用于维护者离线构建；最终用户不需要这些工具或 pnpm。
- 先读 Constitution 和本阶段发布记录。不要启动根目录旧 start-bangumi.bat，不要访问正式 data 或 8787。

当前机器可从项目根目录执行：

```powershell
& .\.runtime\node-v24.22.1-win-x64\node.exe scripts/distribution/build.mjs
```

通用维护环境可用同版本可信 Node 的完整绝对路径代替上述运行时。
Node 的完整 LICENSE 必须和执行的 node.exe 同级，否则构建拒绝继续。

输出为全新独占的 dist/distribution-随机值，不覆盖任何既有结果。最后输出 release、zip、work 三个路径。
构建期间若沙箱禁止创建 junction，应申请仅限本隔离构建的宿主执行许可；普通用户使用成品不需要这些权限。

## 安全边界与构建过程

1. 仅读根 package/锁文件/tsconfig，三包 package/tsconfig、src 中非测试 TS/TSX/CSS，以及 Web index/vite.config。
   不遍历仓库根进行打包，不读取 data、配置、备份、日志、正式 runtime 部署、历史审计、Public Demo、Website、已有 dist。
2. 在独立 build 副本建立已安装构建依赖链接；Shared 指向这个副本刚编译的 Shared，不借用正式 Shared dist。
3. Shared tsc → Server tsc → Web 类型检查 → Vite。只在副本关闭 sourcemap/declarationMap；
   Shared 声明保留到构建结束，分发时仅取运行 JS。原源码和三个正式 dist 均不变。
4. 按 Server package.json 的 dependencies 递归实体化生产闭包；依赖版本必须存在于当前锁文件。
   不复制整个 node_modules，不把构建工具放入包。运行依赖不得带 .node 原生扩展；变化时显式复审。
5. 按原目录层级放置 Server/Web/Shared 构建，复制正在使用的 node.exe 和 LICENSE。
   只加入 portable 下四个启动/完整性文件、新用户 README、依赖授权说明与生成的清单。
6. 记录 187 个本次实际产品构建输入的相对路径/hash，并在打包前再次核对，若源文件中途变化则失败。
   记录运行时 hash、生产闭包清单；文件数随后续合法源码变化而变化，不写死为验收门槛。
7. 拒绝链接、DB/WAL/SHM、配置、备份、日志、map、环境文件、机器用户路径及常见字面密钥模式。
   正式源码的 packages/server/dist/data/backup.js 等模块是程序代码，不是私人 data。
8. checksums.json 覆盖其余交付文件，ZIP 后另写 .zip.sha256。原始 staging 不启动；所有测试针对 ZIP 的新解包副本。

没有新增产品配置项、修改正式业务逻辑、升级依赖、改锁文件或升版。源码里的默认配置继续由正式 config.ts 管理。
依赖锁版本一致检查不等于重新向 npm 验证每个已安装字节；维护者需确保本机安装依赖与 Node 来源可信。
SHA-256 防传输损坏，不是数字签名，也不抵御攻击者同时修改包和清单。

## 自动验证

```powershell
& .\.runtime\node-v24.22.1-win-x64\node.exe --test scripts/distribution/safety.test.mjs
& .\.runtime\node-v24.22.1-win-x64\node.exe scripts/distribution/verify.mjs '<本次生成的 ZIP 完整路径>'
```

verify 需要维护者已安装的 @playwright/test 和本机 Edge；不下载浏览器，不把测试工具带给用户。
受限沙箱可能阻断自己的 loopback 请求，此时保留失败记录，在经批准的宿主隔离环境重跑，不推断正式 Local 离线。

验证会在 ZIP 同级创建 acceptance-随机值/全新用户 空格 & 离线：

- 完整解包、隐私排除和逐文件 hash；无任何 data 起步。
- PATH 仅保留 Windows 系统目录，从实际 BAT 启动；使用随机 loopback 端口而非 8787。
- 伪造的继承账号、AI Key 和数据目录哨兵不被带入服务。
- 空库初始化 Schema 15、默认配置和真实 Edge 首次引导；配置写入、重复启动保护、安全退出。
- sync-fixture 使用解包的正式模块和真正 BangumiClient，通过本机合成 HTTP 上游同步 51 条数据、跨两页并深度补充。
  是合成上游验证，不是实际 Bangumi 账号/Token 验证；不向外部站点发请求。
- 搜索、家族预览/执行、主动隐藏/恢复、JSON 导入导出、SQLite 备份、统计/画像/检测，重启持久化。
- Edge 离线页面加载、无 pageerror、端口冲突避让、应用 hash 不变、原 ZIP 不变与最终 DB 自检。

同步夹具不被复制进包；不需要用户修改源码。浏览器自动打开默认浏览器的物理交互、真实 Token/AI、
其他电脑/系统/防病毒，以及所有业务动作组合，仍需分别验收，不用本工程验证替代。

## 启动器边界

- 只运行随包 Node，固定本机地址和该副本 data；不继承开发终端的账号/AI/代理/Node flags。
- 默认 8787，仅做监听可用性检查；占用则选空闲端口，不探测、打开或停止占用方。
- 独占会话文件防止同一目录重复启动；死亡会话可清理，活 PID 不强杀。
- 回车通过私有 IPC 触发正式服务既有 SIGINT 关闭屏障，不用 Windows taskkill/child.kill 冒充优雅退出。
- 无注册表/计划任务/全局环境变更、安装器、自动更新或云服务。
- 分发模式退出保留 collection_owner_uid；停止并等待同步收尾后，只清用户名/Token，独立 AI 设置不变。
- 原包完整性检查允许运行后生成的 data 和会话锁；不要压缩用户已运行的副本再分发。

不自动清理构建/验收目录，以保留失败与成功证据。交付仅指定的干净 ZIP 及其 SHA-256，
不要交付整个 dist/distribution-*（其中可能包含合成测试数据、日志和构建期工作区链接）。
