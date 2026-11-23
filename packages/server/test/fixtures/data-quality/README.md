# 数据异常验证样本目录

DC-BATCH-02 首批来源表示样本；只有合成数据，无真实 DB/Key/Token。

`source-snapshots.json` 的 `expected` 是手工声明的 Oracle，不调用生产解析器生成答案。Subject raw 与 Collection envelope 均重放；JSON 解析成功不代表 provenance/身份/真实性成立。数据库 BLOB、超预算内容和故障不能用 JSON 文件直接表示，使用下列确定性构造，不能遗漏这些样本后宣称完整覆盖。

| 样本/测试 ID | 构造与预期 | 覆盖追溯 |
| --- | --- | --- |
| SRC-N01～04 | 合法 SQL NULL、旧 `{}`、未来字段/异代次 ID、Collection 的状态 type；无 source 错误，不推断身份冲突 | Q03，risk:source.snapshot-representation / source.identity |
| SRC-U01～03 | 合法非对象 JSON、JSON null、大整数标量；nonObject，不能假定完整 Subject detail 或回写取整 ID | Q03，risk:source.provenance |
| SRC-E01～03 | 最小坏 JSON、包含私密旧名的坏 JSON、非空槽的空文本；确定本地表示异常，保留原文 | Q03，source.snapshot-invalid |
| SRC-library / SRC-combined | 两张来源表混合；合法 JSON 字节 BLOB 仍为非文本存储；独立期望分类和计数 | 两表各自列登记，risk:source.snapshot-representation |
| SRC-scale | 1,207 坏快照 + 单条 >1 MiB；全数检出、20 样本、1 条 unchecked，不假健康 | Q03/Q06，truth:source-format-scope |
| SRC-failure / SRC-future-schema | iterate 抛错 / user_version=14；抛受控 incomplete；自身 SAVEPOINT 释放，外层事务不提交 | path:source-diagnostics，truth:incomplete |
| SRC-recheck / SRC-HTTP | 只在夹具用可靠表示补正，人工/历史不变；强制 Repair 拒绝；Visible/指标 Real/调查参数不授予记录 ID；确认双信号后有界定位 | Q03/Q07，path:source-consumer |
| CROSS-SRC-01 | 另一组 ID/嵌套内容，以 SQLite json_valid + typeof 统计，非复用生产 JSON.parse Oracle | 本批开发者交叉验证，不是外部审计 |
| CROSS-SRC-02 | 万条，5,000 坏/5,000 对象，独立期望总数、20 样本、耗时/响应/内存 | 本机合成规模，不是 SLA |
| MUT-SRC-01～06 | 忽略解析错、以样本限扫描、缺失报错、超预算报正常、跳过未知 Schema、Visible ID 泄露 | 每项必须实际 AssertionError，启动失败不算；仅隔离副本，finally 恢复 |

正式测试入口：`packages/server/test/diagnostics-source-snapshots.test.ts`；消费者/交叉夹具、精确隔离命令、哈希及原始 JSON/log 见 `docs/audits/dc-batch02-2026-11-06/` 的报告/封存包。复现时用新隔离源码/数据/cache/临时端口，保留原失败；不要直接在正式仓库运行会生成 dist 的 build。

未来每种样本追加唯一 ID、所属不变量、预期与不能证明的事实、适用 Schema、直接消费者、失败路径和 mutation。新增 fixture 不自动将登记状态标 verified；由实际结果和冻结源码证据回填。
