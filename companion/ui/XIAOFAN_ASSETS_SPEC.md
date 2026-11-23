# 小番（Xiaofan）舞台与素材接入规范

## 1. 角色唯一基准
- **角色名称**：小番（Xiaofan）
- **身份定位**：Bangumi Analyzer Companion 官方原创站娘 / 番剧数据整理助手
- **唯一视觉基准**：以设计稿**左侧全身立绘**为准（樱粉长发 + TV 蝴蝶结发饰 + 科技感白粉短外套 + 深灰百褶短裙 + TV 工牌 + 腿环挂包 + 粉白短靴），所有状态均需保持统一脸型、发饰与服装结构。
- **主色条**：
  - 樱粉主色 `#F9B6C8`
  - 玫红强调 `#E76B8E`
  - 奶白基调 `#FFF6F9`
  - 中性深灰 `#4A3E4E`
  - 暖奶杏点缀 `#F6E4C8`

## 2. 八种标准状态接口（已锁定，不破坏既有组件契约）
| 状态 ID | 触发场景 | 建议表情与姿态 |
| --- | --- | --- |
| `idle` | 默认待机 / 守护运行中 | 轻松微笑，自然站姿/托腮 |
| `greet` | 欢迎演出 / 日常问候 / 互动 | 开心挥手打招呼 |
| `think` | 环境检查 / 完整性校验 / 等待响应 | 轻点下巴思考 |
| `work` | 初始化建库 / 同步 / 启动服务 | 专注操作面板 |
| `happy` | 单步校验成功 / 服务就绪 | 弯眼灿笑 |
| `worry` | 端口占用 / 损坏包 / 超时告警 | 微微蹙眉担心 |
| `sleep` | Analyzer 未启动 / 已停止 | 趴桌/闭眼小憩 |
| `cheer` | 首次设置全部完成 | 握拳加油欢呼 |

## 3. UI 容器与位置适配
- **`variant="full"`**（全身舞台）：用于欢迎页（`Intro`）、完成引导（`Ready`）、唤醒页（`Launch`），预留完整身高比例，绝不遮挡主按钮。
- **`variant="half"`**（半身舞台）：用于向导侧栏（`SetupShell`）、日常启动（`Splash`）、日常首页（`Home` 右侧陪伴卡），腰部以上居中裁切对齐。
- **全屏自适应（`F11` / `Esc`）**：窗口进入无边框全屏时舞台等比放大但保留操作安全区。

## 4. 尚待交付的正式素材清单
1. `src/assets/xiaofan/illustration/full.png`（透明背景全身立绘，建议 `>= 4000px` 高）
2. `src/assets/xiaofan/illustration/half.png`（透明背景半身立绘，建议 `>= 2000px` 高）
3. `src/assets/xiaofan/expressions/{idle,greet,think,work,happy,worry,sleep,cheer}.png`（8 态透明素材，支持按 `full-<state>.png` / `half-<state>.png` 精细区分）
4. 可选：后续 M2 阶段的分层 PSD / Live2D / Spine 动画包
