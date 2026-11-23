# 架构与实现说明

## 1. 总体结构

```
浏览器（React SPA）
        │  fetch /api/*
        ▼
本地 Node 服务（Fastify）
        ├── 同步引擎 ──► Bangumi 官方 API（限流 / 重试 / 断点续传）
        ├── 统计层   ──► SQL 聚合（按数据版本缓存）
        └── SQLite（node:sqlite，WAL）
               └── data/bangumi.db + covers/ + backups/
```

设计原则：

1. **本地优先**：同步完成后，界面所有数据都来自 SQLite；只有同步需要联网。
2. **一次写入，随时可重建**：原始 JSON 全部落库，派生字段（年份 / 季度 / 格式 / 制作公司…）
   都可以从原始数据重新计算。
3. **失败不破坏数据**：分页抓取先写暂存表，全部成功后才在一个事务里应用。
4. **口径统一**：所有派生逻辑集中在 `packages/shared`，服务端与前端共用同一套定义。

## 2. 目录结构

```
bangumi-analyzer/
├── packages/
│   ├── shared/                  # 前后端共用的领域模型（纯逻辑，可单测）
│   │   └── src/
│   │       ├── subject.ts       # 状态 / 放送形态 / 季度 / 进度 / 评分档位
│   │       ├── derived.ts       # infobox 解析、别名、系列标题归一化
│   │       ├── bangumi-api.ts   # Bangumi 响应 schema 与容错解析
│   │       └── api-contract.ts  # 本地 API 契约（含查询参数校验）
│   ├── server/                  # 本地服务：同步、统计、导入导出
│   │   ├── scripts/real-sync.ts # 命令行同步（可挂计划任务）
│   │   └── src/
│   │       ├── bangumi/         # HTTP 客户端、限流器、原始数据归一化
│   │       ├── db/              # 连接、迁移、查询构建、系列计算
│   │       ├── sync/            # 同步引擎（分页 / 应用 / 补全 / 进度）
│   │       ├── stats/           # SQL 聚合、缓存、画像推断
│   │       ├── data/            # 导出 / 导入 / 备份
│   │       ├── images/          # 封面离线缓存
│   │       └── http/            # 路由与错误映射
│   └── web/                     # React 前端
│       └── src/
│           ├── components/      # UI 基础组件 / 图表 / 条目卡片 / 布局
│           ├── pages/           # 7 个页面
│           └── lib/             # API 客户端、查询缓存、格式化、筛选
├── e2e/                         # Playwright 端到端与截图走查
├── docs/                        # API 调研与架构说明
└── data/                        # 运行时数据（已 gitignore）
    ├── config.json              # 用户名 / Token（权限 600）
    ├── bangumi.db               # SQLite 数据库
    ├── covers/                  # 封面缓存
    └── backups/                 # 数据库备份
```

## 3. 数据库设计

| 表 | 作用 | 关键点 |
| --- | --- | --- |
| `subjects` | 条目主表 | 结构化字段 + `raw` 原始 JSON；`detail_state` 记录详情同步状态 |
| `collections` | 我的收藏 | 与条目一对一；保留 `raw`；`first_seen_at` 记录本地首次发现时间 |
| `subject_staff` | 制作人员 | 来源区分 `person-api` / `infobox`，便于覆盖与去重 |
| `subject_relations` | 官方条目关系 | 用于系列分组 |
| `series` / `series_members` | 系列分组结果 | 可随时重建；`source` 区分官方关系与标题推测 |
| `sync_runs` | 同步历史 | 计数、告警、错误、耗时 |
| `sync_stage` | 分页暂存区 | 全部页面成功后一次性应用 |
| `meta` | 键值元数据 | `data_version` 用于统计缓存失效 |

索引覆盖了筛选与排序会用到的列：年份、放送形态、评分、系列、详情状态、
收藏状态、我的评分、更新时间，以及人员姓名与关系。

## 4. 同步流程

```
preparing  校验配置；有 Token 时调用 /v0/me 验证
collections 分页拉取收藏（每页 50）→ 写 sync_stage
applying   单个事务写入 subjects + collections；计算 新增/更新/未变化/移除
enriching  条目详情队列（默认 30 天缓存）→ /v0/subjects/{id}
relations  系列关系队列（深度 2）→ /v0/subjects/{id}/subjects
persons    制作人员队列（深度 2）→ /v0/subjects/{id}/persons
series     重建系列分组（并查集 + 标题启发式）
finalizing 记录统计、递增数据版本
```

安全阀：

- 分页未完整抓取时**不执行删除**；
- 单次同步中消失的收藏超过 `max(50, 现有数据 20%)` 时跳过删除并给出告警；
- 连续 5 次网络失败自动中止；
- 取消 / 崩溃时已提交的数据保持可用，进度会写进 `sync_runs`（状态 `cancelled` / `interrupted`）。

## 5. 统计层

- 全部统计由 SQL 聚合得到（`json_each` 处理标签 / 公司 / 导演数组），
  不会把上万条数据拉到内存里循环；
- 结果按 `data_version` 缓存，同步或导入后自动失效；
- 画像分两类输出：`conclusions`（数据直接计算）与 `inferences`（带阈值的推测），
  每条都附带支撑数字与置信度。

## 6. 安全设计

| 风险 | 处理 |
| --- | --- |
| Token 泄露到前端 | 前端只能拿到 `hasToken` 与掩码提示，真实 Token 永不出服务端 |
| Token 进入日志 | pino `redact` + `scrubSecrets()` 双重过滤（含 URL 中的 `access_token=`） |
| Token 进入 Git | `data/` 整体 gitignore；配置文件权限 600，原子写入 |
| 路径穿越 | 备份文件名使用白名单正则，并校验解析后的绝对路径仍在备份目录内 |
| SQL 注入 | 全部查询使用绑定参数；动态条件由白名单字段生成 |
| 开放重定向 | 封面跳转只允许 `*.bgm.tv` 域名 |
| 外部访问 | 服务默认只监听 `127.0.0.1` |

## 7. 前端设计

- **设计令牌**：颜色全部走 CSS 变量（`--surface` / `--accent` / `--chart-1..8`），
  深色与浅色是同一套语义变量的两组取值，图表在主题切换时自动重绘。
- **组件统一**：基础交互组件（按钮 / 卡片 / 输入 / 弹层 / 标签）统一封装，
  表格、图表、卡片共用同一套颜色与圆角规则。
- **URL 即状态**：收藏库的筛选、排序、分页，以及分析页的标签页都保存在 URL 上，
  可分享、可前进后退、刷新后不丢失。
- **性能**：服务端分页（默认 48/页，可调至 192）；
  TanStack Query 做请求缓存与去重；统计结果在服务端缓存。
- **容错**：统一的加载态 / 空状态 / 错误态（错误信息包含原因、是否影响已有数据、处理建议）。
