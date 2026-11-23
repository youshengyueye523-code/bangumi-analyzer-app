# 小番（Xiaofan）正式透明素材投放目录

本目录用于接收最终定稿的「小番 Xiaofan」透明背景立绘与 8 态表情素材。

> 请勿把设定参考海报直接裁剪/抠图后当作正式资产。

## 目录结构约定（放入后重新构建 `companion/ui` 即可生效）

```text
src/assets/xiaofan/
  illustration/
    full.png            # 全身透明立绘（建议高度 >= 4000px，用于欢迎页 / 完成页 / 全屏）
    half.png            # 半身透明立绘（建议高度 >= 2000px，用于向导侧栏 / 日常首页）
  expressions/
    idle.png            # 待机
    greet.png           # 招呼
    think.png           # 思考
    work.png            # 工作
    happy.png           # 开心
    worry.png           # 担心
    sleep.png           # 休息
    cheer.png           # 庆祝 / 加油
    # 可选：区分全身/半身分态时使用 full-<state>.png 或 half-<state>.png（优先匹配）
```

在正式素材尚未交付前，UI 将自动使用带有小番配色与 8 态动效的占位舞台保证工程独立运行。
