# 小番 (Xiaofan) 角色模型署名与来源说明 (Pink Sakura)

本应用桌面端角色模型基于开源示例模型 **Pink Sakura** 集成：

- **上游项目名称**：[Ariakage / live2d-agent-kit](https://github.com/Ariakage/live2d-agent-kit)
- **模型示例名称**：**Pink Sakura**（制作统筹：**Ariakage**）
- **素材许可协议**：**Creative Commons Attribution 4.0 International (CC BY 4.0)**  
  - 许可概要：https://creativecommons.org/licenses/by/4.0/  
  - 完整正文：https://creativecommons.org/licenses/by/4.0/legalcode.en  
  - 随包许可说明：见同目录 `ASSET-LICENSE.md`

## 上游原始来源记录（按上游说明保留）

根据上游仓库 `examples/pink-sakura/ATTRIBUTION.md` 的公开记录：

1. **原始参考图**：按上游提供者说明标注为 **「此图片来自 ChatGPT Image2.5 生成」**（此为用户提供的来源说明，未独立核验生成服务记录）。
2. **隐藏区域补画与拆层制作**：在 **Ariakage** 指导下使用 **GPT-6 Astra Ultra** 与 `live2d-agent-kit` / `psd2live` 制作（包含肩腰躯干动态、衣袖裙摆发饰物理、14 组动作、8 组表情，以及 2026-10-22 手势补画）。部分局部补画使用宿主内置图像生成工具，真实服务版本未独立核验。
3. **本应用非完全原创声明**：本软件未将 Pink Sakura 参考图或上游模型声明为完全独立原创，按 CC BY 4.0 保留上游完整出处与贡献分层。

## 本项目（Bangumi Analyzer Companion）的修改说明

在本软件中我们对上游 `examples/pink-sakura/runtime/` 模型作了以下工程化适配修改：

1. **桌面性能纹理降采样**：将 `PinkSakura.8192/texture_00.png`（`8192 × 8192`，48.6 MB）按同比例双三次（HighQualityBicubic）保留 Alpha 通道降采样为 `PinkSakura.2048/texture_00.png`（`2048 × 2048`），并在 `PinkSakura.model3.json` 中更新纹理引用路径，以降低桌面端显存占用与加载卡顿；`.moc3` 几何、UV 映射、物理（`.physics3.json`）、动作（`.motion3.json`）及表情（`.exp3.json`）均直接沿用上游交付文件。
2. **ArmRig 派生图集与双骨骼防穿模渲染**：基于上游 CC BY 4.0 原图 `arm-parts-v1.png` 与 `reference.png`，通过可复现脚本 `companion/dist-scripts/build-arm-rig-assets.mjs` 生成 `arm-rig-atlas.png` 与 `arm-rig-meta.json`（仍受 CC BY 4.0 约束），拆分袖口内壁与前侧罗纹袖口并在客户端 WebGL 管线中以双骨骼解剖运动学（`ArmRigRenderer`）消除手腕穿模与弯曲畸变。
3. **八态状态机映射与独立短暂随机互动**：将 Companion 八种业务状态（`idle` / `greet` / `think` / `work` / `happy` / `worry` / `sleep` / `cheer`）与 7 种独立短暂互动变体映射至 Pink Sakura 真实动作、表情与 ArmRig 组合，并复用上游 MIT 协议 `GestureHandoff` 过渡控制器平滑衔接。对于上游未单独命名 `Worry` 的表情，使用真实 `Shake` 摇头动作搭配 `Surprised` 表情组合进行近似表达。

## 非背书声明 (No Endorsement)

使用本模型及上述来源说明，**不暗示或构成 Ariakage、live2d-agent-kit 项目、OpenAI 或 Live2D Inc. 对 Bangumi Analyzer Companion 的任何官方认可、赞助或背书**。  
This application is not affiliated with or endorsed by Ariakage, OpenAI, or Live2D Inc.
