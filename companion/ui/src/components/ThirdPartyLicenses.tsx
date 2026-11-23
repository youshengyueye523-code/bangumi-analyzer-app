import { useEffect, useState } from 'react';
import { BookOpenCheck, CheckCircle2, FileWarning, FolderOpen, X } from 'lucide-react';
import { Button } from './ui';
import { getModelBridge, type CompanionModelStatus } from '../driver/model';
import { toast } from '../state/feedback';

export function ThirdPartyLicensesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mb = getModelBridge();
  const [status, setStatus] = useState<CompanionModelStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !mb) return;
    void mb.getStatus().then(setStatus).catch(() => {});
  }, [open, mb]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleImportCore = async () => {
    if (!mb) return;
    setBusy(true);
    try {
      const res = await mb.importCubismCore();
      if (res.canceled) return;
      if (!res.ok) {
        toast('danger', '导入未完成', res.error ?? '请确认选择官方 live2dcubismcore.min.js');
        return;
      }
      const next = await mb.getStatus();
      setStatus(next);
      toast('success', '已导入官方 Cubism Core', '如当前安全策略允许 WebAssembly 运行，下次打开小番舞台时将自动启用。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="license-backdrop" role="dialog" aria-modal="true" aria-labelledby="tpl-title" onClick={onClose}>
      <div className="license-modal glass pop-in" onClick={(e) => e.stopPropagation()}>
        <header className="license-head">
          <div className="license-title-wrap">
            <BookOpenCheck size={16} />
            <h2 id="tpl-title">关于 · 第三方许可与角色署名</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭许可说明">
            <X size={15} />
          </button>
        </header>

        <div className="license-body">
          <section className="license-sec">
            <h3>1. 角色模型资产：Pink Sakura (CC BY 4.0)</h3>
            <ul>
              <li>
                <b>模型基底与原作者：</b>Pink Sakura · <b>Ariakage</b>（原仓库：
                <code>https://github.com/Ariakage/live2d-agent-kit</code>，示例路径 <code>examples/pink-sakura/runtime/</code>）
              </li>
              <li>
                <b>资产许可协议：</b>Creative Commons Attribution 4.0 International (<b>CC BY 4.0</b>) —{' '}
                <code>https://creativecommons.org/licenses/by/4.0/</code>（离线随附 <code>ATTRIBUTION.md</code> 与 <code>ASSET-LICENSE.md</code>）
              </li>
              <li>
                <b>上游原始来源记录：</b>按上游提供者声明标注——原始参考图「来自 ChatGPT Image2.5 生成（未独立核验服务记录）」；拆层、补画、绑定与超分在 Ariakage 指导下由 <code>GPT-6 Astra Ultra</code> 与 <code>live2d-agent-kit</code> / <code>psd2live</code> 完成。
              </li>
              <li>
                <b>本项目修改内容：</b>为适配桌面窗口渲染与控制内存占用，将 <code>PinkSakura.8192/texture_00.png</code>（8192²）等比例双三次降采样保留 Alpha 通道至 <code>PinkSakura.2048/texture_00.png</code>（2048²），更新 <code>PinkSakura.model3.json</code> 引用；基于上游 CC BY 4.0 原图 <code>arm-parts-v1.png</code> 与 <code>reference.png</code> 通过可复现脚本生成分层袖口与四手型图集（<code>arm-rig-atlas.png</code>），在客户端 WebGL 渲染管线中以双骨骼解剖手臂运动学（<code>ArmRigRenderer</code>）与 <code>PerformanceDirector</code> 替代存在穿模与弯曲畸变的单段袖片手势，适配 Companion 八态动作/表情组合。
              </li>
              <li>
                <b>非背书声明：</b>本软件保留完整出处，不代表或暗示 Ariakage、live2d-agent-kit、OpenAI 或 Live2D Inc. 对本项目提供官方认可或背书。
              </li>
            </ul>
          </section>

          <section className="license-sec">
            <h3>2. 第三方运行库与框架许可（独立授权）</h3>
            <ul>
              <li>
                <b>PixiJS v6.5.10 + @pixi/unsafe-eval v6.5.10：</b>MIT License（WebGL 渲染引擎与严格 CSP 下无 <code>unsafe-eval</code> 的着色器适配）。
              </li>
              <li>
                <b>pixi-live2d-display v0.4.0：</b>MIT License；其 Cubism 4 构建另包含 <b>Live2D Cubism SDK for Web Framework</b> 代码，适用 <b>Live2D Open Software License Agreement</b>。
              </li>
              <li>
                <b>GestureHandoff：</b>源自 <code>Ariakage/live2d-agent-kit</code>（<code>templates/web-preview/gesture-handoff.js</code>），适用 MIT License。
              </li>
              <li>
                <b>Live2D Cubism Core for Web (<code>live2dcubismcore.min.js</code>)：</b>当前受控集成源自用户合法下载的官方 <code>CubismSdkForWeb-5-r.5</code>（Core <code>06.00.0001</code>）。属于 Live2D Inc. 的<b>专有软件</b>（<b>Live2D Proprietary Software License Agreement</b>），非 MIT 亦非 CC BY 4.0。
              </li>
              <li>
                <b>商业发行与 Expandable Application / Tool Software 边界：</b>按 Live2D 官方许可规则，年营收超过 <b>1,000 万日元</b>的企业须取得 <b>Cubism SDK Release License</b>；此外，任何允许外部加载/替换任意第三方 <code>.moc3</code> 模型、用于生成/制作角色或聚合多作品的 <b>Expandable Application（可扩展应用）</b> 或 <b>Tool Software（工具软件）</b> 均须通过 Live2D 官方审查并签订专门发行许可（不受收入门槛豁免）。Companion 已在架构层通过 <code>companion:v1:model</code> 白名单严格锁定仅内置固定小番基底模型（禁止导入外部模型）。开源源码仓库不包含专有 <code>live2dcubismcore.min.js</code>；编译发行包按个人小规模免费分发条款随附该运行库与官方许可文件，缺失该文件时程序可安全降级至 2D 舞台。
              </li>
            </ul>
          </section>

          <section className="license-sec">
            <h3>3. Live2D 运行态与 GPU 兼容诊断</h3>
            <div className="license-status-box">
              <div className="ls-row">
                {status?.modelAssetsReady ? <CheckCircle2 size={14} className="tone-ok" /> : <FileWarning size={14} className="tone-warn" />}
                <span>
                  Pink Sakura 运行资产（<code>PinkSakura.moc3</code> / 14 动作 / 8 表情 / 2048² 纹理）：
                  <b>{status?.modelAssetsReady ? '已就绪' : '仅桌面宿主环境可用'}</b>
                </span>
              </div>
              <div className="ls-row">
                {status?.hasCubismCore ? <CheckCircle2 size={14} className="tone-ok" /> : <FileWarning size={14} className="tone-warn" />}
                <span>
                  官方专有运行库 <code>live2dcubismcore.min.js</code>：
                  <b>{status?.hasCubismCore ? '已检测到用户导入' : '尚未导入（遵循专有许可边界未随开源包镜像）'}</b>
                </span>
              </div>
              {status?.gpuStatus && (
                <div className="ls-row">
                  {status.gpuStatus.webglAllowed ? <CheckCircle2 size={14} className="tone-ok" /> : <FileWarning size={14} className="tone-warn" />}
                  <span>
                    GPU 渲染状态（策略 <code>{status.gpuStatus.policyMode}</code> · 后端 <code>{status.gpuStatus.activeBackend}</code> · 适配器 {status.gpuStatus.adapterCount} 个{status.gpuStatus.displayRefreshHz ? ` · 屏幕 ${status.gpuStatus.displayRefreshHz} Hz` : ''}）：
                    <b>{status.gpuStatus.webglAllowed ? 'WebGL2 可用' : `已自动回退 2D 安全占位（${status.gpuStatus.reason}）`}</b>
                    {!status.gpuStatus.webglAllowed && ' · 可在「启动与偏好 → Live2D GPU 兼容模式」切换后端并重启'}
                  </span>
                </div>
              )}
              {mb && (
                <div className="ls-actions">
                  <Button variant="secondary" size="sm" icon={<FolderOpen size={13} />} loading={busy} onClick={handleImportCore}>
                    导入官方 live2dcubismcore.min.js…
                  </Button>
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="license-foot">
          <span>随安装目录与便携目录附带离线可读的 ATTRIBUTION.md、ASSET-LICENSE.md 与 THIRD_PARTY_NOTICES.md。</span>
          <Button variant="primary" size="sm" onClick={onClose}>
            我已了解
          </Button>
        </footer>
      </div>
    </div>
  );
}
