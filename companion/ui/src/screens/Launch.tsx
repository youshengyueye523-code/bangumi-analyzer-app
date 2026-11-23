import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Home,
  RefreshCw,
  Copy,
  Check,
  AlertOctagon,
  AlertTriangle,
  Globe,
  BarChart3,
  Library,
  Sparkles,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import { Button, MockTag, ProgressRing, cx } from '../components/ui';
import { Mascot } from '../components/Mascot';
import { startAndAwaitReady, useAnalyzerStatus, useDriver, type AnalyzerError } from '../driver';
import { useFlow } from '../state/flow';
import { usePrefs } from '../state/prefs';
import { log, toast } from '../state/feedback';

export function LaunchScreen() {
  const flow = useFlow();
  const driver = useDriver();
  const status = useAnalyzerStatus();
  const p = usePrefs();
  const [phase, setPhase] = useState<'checking' | 'booting' | 'opening' | 'opened' | 'open-failed' | 'error'>('booting');
  const [copied, setCopied] = useState(false);
  const [openResultUrl, setOpenResultUrl] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<AnalyzerError | null>(null);
  const bootedRef = useRef(false);
  const acRef = useRef<AbortController | null>(null);

  const launchSequence = useCallback(async () => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setOpenErr(null);
    setPhase('checking');
    log('info', '调用 driver.getStatus() 检查 Analyzer 状态');
    const cur = await driver.getStatus();
    if (ac.signal.aborted) return;

    let active = cur;
    if (cur.state !== 'running') {
      log('info', '调用 driver.startAnalyzer() 并轮询至就绪');
      active = await startAndAwaitReady(
        driver,
        (s) => {
          if (s.state === 'checking') setPhase('checking');
          else if (s.state === 'starting') setPhase('booting');
        },
        ac.signal,
      );
      if (ac.signal.aborted) return;
    }

    if (active.state !== 'running') {
      setPhase('error');
      log('error', `启动未就绪：${active.error?.code ?? active.state} ${active.error?.message ?? ''}`);
      return;
    }

    setPhase('opening');
    log('info', `调用 driver.openAnalyzer() 打开 ${active.url ?? ''}`);
    const res = await driver.openAnalyzer();
    if (ac.signal.aborted) return;

    const targetUrl = res.url || active.url || '';
    setOpenResultUrl(targetUrl);
    if (!res.opened) {
      setOpenErr(res.error ?? { code: 'OPEN_FAILED', message: '未能自动打开系统默认浏览器' });
      setPhase('open-failed');
      log('warn', `openAnalyzer 失败 (${res.error?.code ?? 'OPEN_FAILED'})，服务仍在运行：${targetUrl}`);
      toast('warning', '服务已启动，但浏览器未能自动打开', '请复制下方本机地址手动打开。');
      return;
    }

    setPhase('opened');
    log('ok', `已进入 Analyzer（${driver.kind === 'mock' ? '模拟浏览器打开' : '已交给默认浏览器'} ${targetUrl}）`);
    toast('success', driver.kind === 'mock' ? '已唤醒 Analyzer（模拟）' : '已唤醒 Analyzer', `本机地址 ${targetUrl}`);
  }, [driver]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    launchSequence();
    return () => acRef.current?.abort();
  }, [launchSequence]);

  useEffect(() => {
    if (status.state === 'error') setPhase('error');
  }, [status.state]);

  const reopen = async () => {
    setOpenErr(null);
    const res = await driver.openAnalyzer();
    const targetUrl = res.url || status.url || '';
    if (targetUrl) setOpenResultUrl(targetUrl);
    if (!res.opened) {
      setOpenErr(res.error ?? { code: 'OPEN_FAILED', message: '未能自动打开浏览器' });
      setPhase('open-failed');
      log('warn', `openAnalyzer 失败：${res.error?.code ?? 'OPEN_FAILED'}`);
      toast('warning', '自动打开浏览器失败', res.error?.hint ?? '请复制地址手动访问');
      return;
    }
    setPhase('opened');
    log('info', `再次调用 driver.openAnalyzer() → ${targetUrl}`);
    toast('info', driver.kind === 'mock' ? '已模拟打开浏览器标签页' : '已请求默认浏览器打开', targetUrl);
  };

  const copyUrl = async () => {
    const url = openResultUrl || status.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* ignore clipboard deny in headless */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
    toast('success', '已复制本机地址', url);
  };

  const url = openResultUrl || status.url || (driver.kind === 'mock' ? 'http://127.0.0.1:5173/' : '等待分配端口…');
  const hasRealUrl = Boolean(openResultUrl || status.url);
  const ringVal =
    phase === 'checking'
      ? 0.28
      : phase === 'booting'
        ? 0.62
        : phase === 'opening'
          ? 0.88
          : phase === 'opened' || phase === 'open-failed'
            ? 1
            : 0.35;
  const mascotState = phase === 'error' ? 'worry' : phase === 'opened' ? 'happy' : phase === 'open-failed' ? 'think' : 'work';
  const mascotLine =
    phase === 'error'
      ? '启动的时候卡住了……看看提示，点「重试启动」试试？'
      : phase === 'open-failed'
        ? '服务已经跑起来啦，只是没能自动拉起浏览器。复制地址手动打开就行～'
        : phase === 'opened'
          ? driver.kind === 'mock'
            ? '浏览器窗口已经打开啦（模拟）～ Companion 会在后台默默守着服务。'
            : '浏览器已经唤起～ 关闭标签页不会停止服务哦。'
          : phase === 'checking'
            ? '正在核对安装包文件校验和，确保启动安全……'
            : '正在唤醒本机服务，马上把页面递给你……';

  return (
    <section className="stage-page launch-page">
      <div className="launch-shell">
        <div className="launch-card glass pop-in">
          <div className="launch-top">
            <span className="launch-badge">
              <Globe size={13} /> ENTER ANALYZER
            </span>
            {driver.kind === 'mock' ? (
              <MockTag title="M0/M1-A Mock 模式下不会真的打开浏览器标签页">模拟打开网页端</MockTag>
            ) : (
              <span className="codex-tag">CODEX RUNTIME</span>
            )}
          </div>

          <div className="launch-hero">
            <ProgressRing
              value={ringVal}
              size={146}
              stroke={9}
              tone={phase === 'error' ? 'danger' : phase === 'open-failed' ? 'warning' : phase === 'opened' ? 'success' : 'accent'}
            >
              {phase === 'checking' || phase === 'booting' || phase === 'opening' ? (
                <Loader2 size={32} className="spin tone-accent" />
              ) : phase === 'error' ? (
                <AlertOctagon size={34} className="tone-danger" />
              ) : phase === 'open-failed' ? (
                <AlertTriangle size={34} className="tone-warning" />
              ) : (
                <ExternalLink size={32} className="tone-success" />
              )}
            </ProgressRing>

            <div className="launch-info">
              <h1 className="launch-title">
                {phase === 'checking' && '正在校验分发包完整性…'}
                {phase === 'booting' && '正在启动 Analyzer…'}
                {phase === 'opening' && '正在打开本机界面…'}
                {phase === 'opened' && 'Analyzer 已在浏览器中就绪'}
                {phase === 'open-failed' && '服务已就绪，请手动打开地址'}
                {phase === 'error' && 'Analyzer 未能启动'}
              </h1>
              <p className="launch-desc">
                {phase === 'opened'
                  ? '关闭网页标签不会停止服务；需要退出时，请回到 Companion 首页点「安全停止」。'
                  : phase === 'open-failed'
                    ? '主服务已健康运行在 127.0.0.1，浏览器交付失败不会中断本地服务。'
                    : phase === 'error'
                      ? status.error?.message ?? '服务启动异常'
                      : '通过 CompanionDriver (getStatus → startAnalyzer → openAnalyzer) 安全拉起本地服务。'}
              </p>

              <div className="launch-urlbar">
                <span className={cx('status-pill', status.state === 'running' ? 'ok' : status.state === 'error' ? 'err' : 'wait')}>
                  <i />
                  {status.state === 'running' ? '运行中' : status.state === 'error' ? '异常' : status.state === 'checking' ? '校验中' : '启动中'}
                </span>
                <code>{url}</code>
                {status.pid && <span className="port-tag">PID {status.pid}</span>}
                {!status.pid && status.ownsProcess && <span className="port-tag">持有子进程</span>}
                {hasRealUrl && (
                  <button className="icon-btn" onClick={copyUrl} title="复制本机地址">
                    {copied ? <Check size={14} className="tone-success" /> : <Copy size={14} />}
                  </button>
                )}
              </div>
            </div>
          </div>

          {phase === 'error' && status.error && (
            <div className="init-error pop-in">
              <AlertOctagon size={20} />
              <div className="init-error-main">
                <div className="init-error-title">
                  {status.error.message} <code>{status.error.code}</code>
                </div>
                <div className="init-error-hint">{status.error.hint}</div>
              </div>
            </div>
          )}

          {phase === 'open-failed' && openErr && (
            <div className="banner banner-warn pop-in">
              <AlertTriangle size={18} />
              <div>
                <b>
                  {openErr.message} <code>{openErr.runtimeCode ?? openErr.code}</code>
                </b>
                <span>{openErr.hint}</span>
              </div>
              {hasRealUrl && (
                <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={copyUrl}>
                  复制地址
                </Button>
              )}
            </div>
          )}

          {(phase === 'opened' || phase === 'open-failed') && (
            <div className="analyzer-preview pop-in">
              <div className="ap-bar">
                <span className="ap-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="ap-addr">{url}</span>
                <span className="ap-mock">浏览器视图示意 · 仅监听 127.0.0.1</span>
              </div>
              <div className="ap-body">
                <div className="ap-side">
                  <div className="ap-brand">B · 动画数据库</div>
                  <div className="ap-nav on">
                    <BarChart3 size={13} /> 仪表盘
                  </div>
                  <div className="ap-nav">
                    <Library size={13} /> 收藏库 ({p.collections || 860})
                  </div>
                  <div className="ap-nav">
                    <Sparkles size={13} /> 我的画像
                  </div>
                  <div className="ap-nav">
                    <ShieldCheck size={13} /> 数据中枢
                  </div>
                </div>
                <div className="ap-main">
                  <div className="ap-hello">
                    {p.nickname ? `${p.nickname} 的动画资料库` : '本地动画数据库'} · v{status.version ?? '2.0.0'}
                  </div>
                  <div className="ap-cards">
                    <div className="ap-kpi">
                      <span>已同步作品</span>
                      <b className="numeric">{p.collections || 860}</b>
                    </div>
                    <div className="ap-kpi">
                      <span>AI 能力</span>
                      <b>{p.aiConfigured ? '已接入' : '未配置'}</b>
                    </div>
                    <div className="ap-kpi">
                      <span>运行模式</span>
                      <b>仅本机 127.0.0.1</b>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <footer className="launch-foot">
            {phase === 'error' ? (
              <>
                <Button variant="ghost" icon={<Home size={16} />} onClick={() => flow.go('home')}>
                  回到首页处理
                </Button>
                <div className="foot-spacer" />
                <Button variant="primary" size="lg" icon={<RefreshCw size={16} />} onClick={launchSequence}>
                  重试启动
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  icon={<ExternalLink size={15} />}
                  disabled={phase !== 'opened' && phase !== 'open-failed'}
                  onClick={reopen}
                >
                  {phase === 'open-failed' ? '重试打开浏览器' : '再次打开网页端'}
                </Button>
                <div className="foot-spacer" />
                <Button variant="primary" size="lg" icon={<Home size={16} />} onClick={() => flow.go('home')}>
                  进入 Companion 日常首页
                </Button>
              </>
            )}
          </footer>
        </div>

        <div className="launch-mascot">
          <Mascot variant="full" state={mascotState} line={mascotLine} />
        </div>
      </div>
    </section>
  );
}
