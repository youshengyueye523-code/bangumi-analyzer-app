# Bangumi 官方 API 调研结论

调研时间：2026-09-15。结论全部来自实际请求验证（`api.bgm.tv`）与官方 OpenAPI 规范。

## 1. 结论速览

| 项目 | 结论 |
| --- | --- |
| 基础地址 | `https://api.bgm.tv` |
| 规范来源 | `https://github.com/bangumi/api` → `open-api/v0.yaml` |
| 认证方式 | `Authorization: Bearer <个人 Access Token>`（可选；不配置只能读公开数据） |
| Token 获取 | `https://next.bgm.tv/demo/access-token`（个人令牌页面） |
| User-Agent | **必须**自定义，格式建议 `应用名/版本 (联系方式或项目主页)`，默认 UA 会被拒绝 |
| 分页 | `limit` / `offset`，官方标注 `limit` 最大 50（实测 100 也生效，本工具保守使用 50） |
| 限流 | 未公开阈值；实测连续 12 次请求均返回 200，但服务端响应时间被拉长到约 0.7s/次 |
| 错误格式 | `{ "title": "...", "description": "...", "details": {...}, "request_id": "..." }` |

## 2. 使用的接口

| 用途 | 接口 | 认证 |
| --- | --- | --- |
| 校验令牌 / 获取用户信息 | `GET /v0/me` | 需要 Token |
| 分页获取用户收藏 | `GET /v0/users/{username}/collections` | 可选（私有收藏需要 Token） |
| 条目详情（扩展数据源） | `GET /v0/subjects/{id}` | 可选 |
| 条目关联（系列关系） | `GET /v0/subjects/{id}/subjects` | 可选 |
| 条目制作人员 | `GET /v0/subjects/{id}/persons` | 可选 |

`username` 既接受用户名字符串，也接受数字 UID。

## 3. 收藏接口返回结构（实测）

```jsonc
{
  "total": 509, "limit": 1, "offset": 0,
  "data": [
    {
      "subject_id": 497110,
      "subject_type": 2,
      "type": 2,                 // 1想看 2看过 3在看 4搁置 5抛弃
      "rate": 6,                 // 0 表示未评分
      "ep_status": 0,
      "vol_status": 0,
      "comment": null,
      "tags": ["日本", "2025"],  // 用户自己打的标签
      "private": false,
      "updated_at": "2026-09-15T03:27:37+08:00",
      "subject": {               // 即 SlimSubject
        "id": 497110, "type": 2,
        "name": "ニンジャバットマン対ヤクザリーグ",
        "name_cn": "忍者蝙蝠侠对极道联盟",
        "date": "2025-03-21",
        "images": { "large": "...", "common": "...", "medium": "...", "small": "...", "grid": "..." },
        "score": 6.9, "rank": 2867, "collection_total": 316,
        "eps": 1, "volumes": 0,
        "short_summary": "...",
        "tags": [{ "name": "剧场版", "count": 43, "total_count": 728847 }, ...]   // 仅前 10 个
      }
    }
  ]
}
```

**重要限制**：`SlimSubject` 不包含 `platform`（TV / OVA / 剧场版…）、`infobox`（制作公司、导演、原作）、
`rating.count`（评分分布）与 `meta_tags`。这些字段必须通过 `GET /v0/subjects/{id}` 获取，
因此本工具把同步拆成「收藏列表」与「条目详情」两个阶段。

### 条目详情（实测字段）

```jsonc
{
  "id": 497110, "type": 2, "name": "...", "name_cn": "...", "summary": "...",
  "date": "2025-03-21", "platform": "WEB",       // TV / WEB / OVA / 剧场版 / 动态漫画…
  "eps": 1, "total_episodes": 1, "volumes": 0,
  "nsfw": false, "locked": false, "series": false,
  "images": {...},
  "infobox": [ { "key": "导演", "value": "..." },
               { "key": "动画制作", "value": "神风动画" },
               { "key": "别名", "value": [ { "v": "Batman Ninja vs. Yakuza League" } ] } ],
  "rating": { "rank": 2867, "total": 131, "score": 6.9,
              "count": { "1": 1, "2": 1, "3": 1, "4": 2, "5": 8, "6": 33, "7": 39, "8": 39, "9": 4, "10": 3 } },
  "collection": { "wish": 93, "collect": 187, "doing": 18, "on_hold": 5, "dropped": 13 },
  "meta_tags": ["科幻", "日本", "漫画改", "战斗", "WEB"],
  "tags": [ { "name": "...", "count": 0, "total_count": 0 }, ... ]   // 最多 30 个
}
```

### 关联与人员（实测）

- `GET /v0/subjects/{id}/subjects` → `[{ id, type, name, name_cn, relation: "前传" | "续集" | ..., images }]`
- `GET /v0/subjects/{id}/persons` → `[{ id, name, type, career, relation: "导演" | "动画制作" | "脚本" | ..., images }]`

## 4. 增量同步方案

官方收藏接口**没有提供**「按更新时间增量拉取」或「游标」参数，也没有任何 webhook。
因此本工具的增量策略是：

1. 每次同步都分页拉取**完整**收藏列表（509 条约 11 个请求，≈10 秒），写入暂存区；
2. 在本地与数据库逐字段比较（状态 / 评分 / 进度 / 短评 / 标签 / 更新时间），
   分别统计「新增 / 更新 / 未变化 / 移除」；
3. 只有全部分页成功后才把暂存区一次性应用（单个事务）；
4. 条目详情使用**本地缓存时间**做增量：默认 30 天内不重复抓取，
   离开缓存的条目才会重新请求，避免每次同步都打满 500+ 次请求。

## 5. 限流与重试策略

- 默认请求间隔 1000ms（约 1 req/s），可在设置中调整；
- 收到 `429` 时读取 `Retry-After`，否则冷却 5 秒，并把间隔翻倍（上限 8 秒），随后逐步恢复；
- `5xx` / 网络超时 / 连接错误按指数退避 + 抖动重试（默认最多 4 次尝试）；
- `401` / `403` / `404` 视为不可重试错误，立即中止并给出具体处理建议；
- 连续 5 次网络失败自动中止同步，已同步的数据保持可用。

## 6. 数据准确性说明

- `updated_at` 的官方注释明确说明「本时间并不代表条目的收藏时间」，
  因此所有与时间相关的曲线在界面上都标注为「按最后更新时间近似」；
- `ep_status` 在「看过」的条目上常常是 0，本工具在计算进度时把「看过」一律视为 100%；
- 条目类型 / 放送形态优先使用官方 `platform`，缺失时才用标签与标题推断，
  推断结果与官方值共用同一套分类口径（TV / Movie / OVA / ONA / Special / Music / 其他）。
