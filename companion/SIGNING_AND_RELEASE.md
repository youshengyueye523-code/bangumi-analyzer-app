# Bangumi Analyzer Companion 打包、签名与发布说明

## 1. 发行包构建方式

运行以下命令即可在 `companion/dist/` 生成图形安装器 `Bangumi-Analyzer-Companion-Setup-2.0.0-rc4-win-x64.exe`、便携包目录 `Bangumi-Analyzer-Companion-Portable-win-x64/`、便携压缩包 `Bangumi-Analyzer-Companion-Portable-2.0.0-rc4-win-x64.zip`、`SHA256SUMS.txt` 与 `RELEASE_MANIFEST.json`：

```powershell
node .\companion\dist-scripts\package-companion.mjs
```

打包脚本执行以下动作：
1. 核验内置正式分发包 `Bangumi-Analyzer-2.0.0-windows-x64-r3.zip` 的 SHA-256 摘要（支持通过环境变量 `ANALYZER_BUNDLE_ZIP` 显式指定）。
2. 以 `VITE_RELEASE_BUILD=1` 编译 `companion/ui`，**正式发行包自动隐藏开发/模拟调试控制台 (`DevPanel`)**。
3. 组装干净的 `host/`（排除 `.work`、`test` 与开发临时脚本）、`runtime/`、`ui/dist/`、`bundle/`、`models/pink-sakura/`、用户按官方协议放置的 `models/vendor/`（含 `CORE-LICENSE.md` 与 `RedistributableFiles.txt`，缺失时自动降级 2D 舞台）、离线许可文档（`ATTRIBUTION.md` / `ASSET-LICENSE.md` / `THIRD_PARTY_NOTICES.md`）及原生图形启动/卸载/安装入口（`Bangumi-Analyzer-Companion.exe` / `Uninstall-Companion.exe` / `Setup.exe`）。
4. 生成逐文件清单 `release-checksums.json`、`RELEASE_MANIFEST.json` 与 `SHA256SUMS.txt`，记录全部交付文件的字节大小与 SHA-256。

> **注意**：正式仓库内的 `data/`、`packages/`、`dist/`（主 Analyzer 分发）、`site/` 与 `CubismSdkForWeb-5-r.5/` 源目录在打包过程中均保持只读，不受任何修改；且重建时自动保留便携目录中已存在的 `companion-data/` 用户数据。

## 2. 本地数据与安装路径规范

| 类别 | 默认路径 | 说明 |
| --- | --- | --- |
| Companion 配置与窗口状态 | `%LOCALAPPDATA%\BangumiAnalyzerCompanion\`（便携版为 `<便携目录>\companion-data\`） | 保存 `companion.json`（无凭据）与 `window-state.json` |
| Analyzer 程序与数据库 | 用户首次安装时选定（如 `C:\BangumiAnalyzer\`） | 内含受管 `v2.0.0 r3` 程序文件与 `data\bangumi.db`、`data\backups\` |
| 测试与验收隔离目录 | `companion/host/.work\`（仅开发环境） | 仅开发自检使用，不包含在发行包中 |

## 3. 未签名 Windows 安装包的已知限制与后续签名规划

### 当前构建（无代码签名证书）说明
1. **Windows SmartScreen / 未知发布者提示**：
   - 当前 Pre-release 发行包尚未进行 Authenticode 代码签名。首次下载并运行安装器或便携版 EXE 时，Windows SmartScreen 可能会弹出「Windows 已保护你的电脑 / 未知发布者」提示。
   - 请务必先从官方 GitHub Releases 核对 `SHA256SUMS.txt` 文件摘要，确认来源与完整性无误后再按系统提示选择是否继续运行。**切勿关闭 Windows Defender 或全局禁用 SmartScreen。**
2. **杀毒软件启发式误报提示**：
   - 未签名的 Electron 宿主配合本机子进程拉起（`127.0.0.1` Node 服务端），在部分安全软件的严格模式下可能提示授权放行。

### 正式公开版的代码签名与许可边界
1. **应用可执行文件与启动器签名**：
   - 后续如具备受信任 Authenticode 代码签名证书（EV/OV 或 Azure Trusted Signing），可对 `Setup.exe`、`Bangumi-Analyzer-Companion.exe`、`Uninstall-Companion.exe` 与宿主可执行文件执行 SHA-256 RFC 3161 时间戳签名。
2. **Live2D 角色舞台与 Cubism Core 许可边界**：
   - 「小番（Xiaofan）」角色舞台接入真实 **Pink Sakura** Live2D 模型（`CC BY 4.0`，原作者 `Ariakage`，`PinkSakura.moc3`、14 动作、8 表情、2048² 纹理及衍生 `arm-rig-atlas.png`），配合 `pixi.js@6.5.10` + `@pixi/unsafe-eval@6.5.10` + `pixi-live2d-display@0.4.0` 与 `CubismSdkForWeb-5-r.5`（Core `06.00.0001`），保留严格 CSP（仅增 `'wasm-unsafe-eval'`）、`sandbox: true`、`contextIsolation: true`、`connect-src 'none'` 与 IPC 白名单。
   - 公开开源源码仓库**不包含**专有 `live2dcubismcore.min.js`；编译后的个人小规模免费预发行包按 `Core/RedistributableFiles.txt` 随附该运行库与 `CORE-LICENSE.md`（Companion 严格锁定内置固定角色，非 Expandable Application / Tool Software）。若后续用于超 1,000 万日元商业主体发行，须另行申请 Live2D 官方 Cubism SDK Release License。
