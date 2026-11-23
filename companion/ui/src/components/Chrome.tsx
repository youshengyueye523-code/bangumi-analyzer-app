import { useEffect, useState } from 'react';
import {
  Minus,
  Square,
  Copy,
  Maximize2,
  Minimize2,
  X,
  Sun,
  MoonStar,
  FlaskConical,
  RotateCcw,
  Play,
  ChevronDown,
  CheckCircle2,
  Info,
  AlertTriangle,
  XCircle,
  Cpu,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { LogoMark, MockTag, cx } from './ui';
import { usePrefs, prefs } from '../state/prefs';
import { scenario, useScenario, type Scenario } from '../mock/scenario';
import { useToasts, dismiss, toast } from '../state/feedback';
import { useFlow, type Screen } from '../state/flow';
import { useAnalyzerStatus, useDriver } from '../driver';
import { getProductBridge } from '../driver/product';
import type { useWindowController } from '../driver/window';

type WindowCtrl = ReturnType<typeof useWindowController>;

/* ───────── 无边框自绘标题栏（支持拖动、双击最大化、F11/Esc 全屏与安全关闭） ───────── */
export function TitleBar({ subtle, winCtrl }: { subtle?: boolean; winCtrl: WindowCtrl }) {
  const p = usePrefs();
  const driver = useDriver();
  const status = useAnalyzerStatus();
  const bridgeLost = driver.kind === 'codex' && status.error?.code === 'BRIDGE_UNAVAILABLE';

  return (
    <header
      className={cx('titlebar', subtle && 'titlebar-subtle', winCtrl.isFullScreen && 'is-fs')}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        winCtrl.toggleMaximize();
      }}
    >
      <div className="tb-brand">
        <LogoMark size={18} />
        <span className="tb-name">
          Bangumi Analyzer <em>Companion</em>
        </span>
        <span className="tb-ver">{getProductBridge() ? 'v2.0' : 'M1'}</span>
        {driver.kind === 'mock' ? (
          <MockTag title="当前使用 mock driver：不启动进程、不访问网络、不写入文件">MOCK DRIVER</MockTag>
        ) : (
          <span
            className={cx('codex-tag', bridgeLost && 'lost')}
            title={
              bridgeLost
                ? '未检测到 window.companionBridge，真实模式等待宿主桥接'
                : '已连接 window.companionBridge（protocolVersion 1）'
            }
          >
            <Cpu size={11} />
            {bridgeLost ? 'RUNTIME 未桥接' : 'CODEX RUNTIME'}
          </span>
        )}
        {winCtrl.isFullScreen && (
          <button
            className="fs-pill"
            onClick={winCtrl.exitFullscreen}
            title="点击或按 Esc / F11 退出全屏"
          >
            <Minimize2 size={11} /> 全屏模式 · Esc 退出
          </button>
        )}
      </div>

      <div className="tb-actions">
        <button
          className="tb-btn"
          title={p.soundEnabled ? '关闭提示音效' : '开启提示音效'}
          aria-label={p.soundEnabled ? '关闭提示音效' : '开启提示音效'}
          onClick={() => prefs.set({ soundEnabled: !p.soundEnabled })}
        >
          {p.soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        <button
          className="tb-btn"
          title={p.theme === 'dark' ? '切换到浅色' : '切换到深色'}
          aria-label={p.theme === 'dark' ? '切换到浅色' : '切换到深色'}
          onClick={() => prefs.set({ theme: p.theme === 'dark' ? 'light' : 'dark' })}
        >
          {p.theme === 'dark' ? <Sun size={14} /> : <MoonStar size={14} />}
        </button>
        <button
          className={cx('tb-btn', winCtrl.isFullScreen && 'active')}
          title={winCtrl.isFullScreen ? '退出全屏 (F11 / Esc)' : '无边框全屏 (F11)'}
          aria-label={winCtrl.isFullScreen ? '退出全屏' : '进入全屏'}
          onClick={winCtrl.toggleFullscreen}
        >
          {winCtrl.isFullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        {(winCtrl.isNativeHost || driver.kind === 'mock') && (
          <>
            <span className="tb-sep" />
            <button
              className="tb-btn"
              title="最小化"
              aria-label="最小化"
              onClick={winCtrl.minimize}
            >
              <Minus size={14} />
            </button>
            <button
              className="tb-btn"
              title={winCtrl.isMaximized ? '向下还原' : '最大化'}
              aria-label={winCtrl.isMaximized ? '向下还原' : '最大化'}
              onClick={winCtrl.toggleMaximize}
            >
              {winCtrl.isMaximized ? <Copy size={11} /> : <Square size={11} />}
            </button>
            <button
              className="tb-btn tb-close"
              title={winCtrl.isNativeHost ? '安全停止服务并关闭窗口' : '关闭（模拟）'}
              aria-label="关闭"
              onClick={winCtrl.close}
            >
              <X size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}

/* ───────── Toasts ───────── */
const TOAST_ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle };
export function Toasts() {
  const items = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => {
        const I = TOAST_ICON[t.tone];
        return (
          <div key={t.id} className={cx('toast', `toast-${t.tone}`)} onClick={() => dismiss(t.id)}>
            <I size={16} />
            <div>
              <div className="toast-title">{t.title}</div>
              {t.body && <div className="toast-body">{t.body}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────── 模拟控制台 ───────── */
type Opt<T> = { v: T; l: string }[];
const ENV: Opt<Scenario['env']> = [
  { v: 'ok', l: '全部通过' },
  { v: 'port-busy', l: '端口占用' },
  { v: 'offline', l: '离线' },
  { v: 'low-disk', l: '空间不足' },
  { v: 'no-write', l: '无写权限' },
];
const ACC: Opt<Scenario['account']> = [
  { v: 'ok', l: '成功' },
  { v: 'not-found', l: '用户不存在' },
  { v: 'token-invalid', l: 'Token 无效' },
  { v: 'timeout', l: '超时' },
];
const AI: Opt<Scenario['ai']> = [
  { v: 'ok', l: '成功' },
  { v: 'unauthorized', l: '401' },
  { v: 'timeout', l: '超时' },
];
const SYNC: Opt<Scenario['sync']> = [
  { v: 'ok', l: '顺利' },
  { v: 'db-locked', l: '数据库占用' },
  { v: 'rate-limit', l: '429 限流' },
  { v: 'network-drop', l: '网络中断' },
];
const DRV: Opt<Scenario['driver']> = [
  { v: 'ok', l: '正常' },
  { v: 'start-fail', l: '启动失败' },
  { v: 'crash', l: '运行中崩溃' },
  { v: 'stop-timeout', l: '停止超时' },
  { v: 'open-fail', l: '打开失败' },
];
const SCREENS: { v: Screen; l: string }[] = [
  { v: 'intro', l: '欢迎演出' },
  { v: 'env', l: '环境检查' },
  { v: 'dir', l: '安装目录' },
  { v: 'account', l: '账号' },
  { v: 'ai', l: 'AI' },
  { v: 'init', l: '初始化' },
  { v: 'ready', l: '完成' },
  { v: 'launch', l: '进入 Analyzer' },
  { v: 'splash', l: '日常启动' },
  { v: 'home', l: '首页' },
];

function Seg<T extends string>({ value, opts, onChange }: { value: T; opts: Opt<T>; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {opts.map((o) => (
        <button key={o.v} className={cx('seg-btn', value === o.v && 'on', o.v !== 'ok' && 'risk')} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

export function DevPanel() {
  const s = useScenario();
  const p = usePrefs();
  const flow = useFlow();
  const driver = useDriver();
  const [open, setOpen] = useState(false);

  const isReleaseHidden = import.meta.env.VITE_RELEASE_BUILD === '1';

  useEffect(() => {
    if (isReleaseHidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isReleaseHidden]);

  if (isReleaseHidden) return null;

  const risky = s.env !== 'ok' || s.account !== 'ok' || s.ai !== 'ok' || s.sync !== 'ok' || s.driver !== 'ok';

  return (
    <div className={cx('devpanel', open && 'open')}>
      <button
        className={cx('dev-fab', risky && 'risky')}
        onClick={() => setOpen((o) => !o)}
        title="模拟控制台（Alt+M）"
        aria-expanded={open}
      >
        <FlaskConical size={14} />
        <span>模拟控制台</span>
        {risky && <span className="dev-fab-dot" />}
        <ChevronDown size={13} className="dev-chev" />
      </button>
      {open && (
        <div className="dev-body">
          <div className="dev-head">
            <strong>模拟场景</strong>
            <span>{driver.kind === 'codex' ? '已连接 Codex Driver · 仅引导步骤为模拟' : '仅原型 · 不执行真实操作'}</span>
          </div>
          <div className="dev-row">
            <label>环境检查</label>
            <Seg value={s.env} opts={ENV} onChange={(env) => scenario.set({ env })} />
          </div>
          <div className="dev-row">
            <label>账号验证</label>
            <Seg value={s.account} opts={ACC} onChange={(account) => scenario.set({ account })} />
          </div>
          <div className="dev-row">
            <label>AI 测试</label>
            <Seg value={s.ai} opts={AI} onChange={(ai) => scenario.set({ ai })} />
          </div>
          <div className="dev-row">
            <label>初始化 / 同步</label>
            <Seg value={s.sync} opts={SYNC} onChange={(sync) => scenario.set({ sync })} />
          </div>
          {driver.kind === 'mock' && (
            <div className="dev-row">
              <label>Analyzer 驱动</label>
              <Seg value={s.driver} opts={DRV} onChange={(drv) => scenario.set({ driver: drv })} />
            </div>
          )}
          <div className="dev-row dev-inline">
            <label className="dev-check">
              <input type="checkbox" checked={s.recoverOnRetry} onChange={(e) => scenario.set({ recoverOnRetry: e.target.checked })} />
              失败一次后，重试即恢复
            </label>
            <div className="seg">
              {[0.5, 1, 2, 4].map((v) => (
                <button key={v} className={cx('seg-btn', s.speed === v && 'on')} onClick={() => scenario.set({ speed: v })}>
                  {v}×
                </button>
              ))}
            </div>
          </div>
          <div className="dev-head">
            <strong>跳转页面</strong>
            <span>当前：{SCREENS.find((x) => x.v === flow.screen)?.l}</span>
          </div>
          <div className="dev-screens">
            {SCREENS.map((x) => (
              <button key={x.v} className={cx('seg-btn', flow.screen === x.v && 'on')} onClick={() => flow.go(x.v)}>
                {x.l}
              </button>
            ))}
          </div>
          <div className="dev-foot">
            <button
              className="seg-btn"
              onClick={() => {
                prefs.reset();
                scenario.reset();
                toast('info', '已重置为全新用户');
                flow.go('intro');
              }}
            >
              <RotateCcw size={12} /> 重置为全新用户
            </button>
            <button className="seg-btn" onClick={() => flow.go('intro')}>
              <Play size={12} /> 重播开场
            </button>
            <label className="dev-check">
              <input type="checkbox" checked={p.reduceMotion} onChange={(e) => prefs.set({ reduceMotion: e.target.checked })} />
              减少动效
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
