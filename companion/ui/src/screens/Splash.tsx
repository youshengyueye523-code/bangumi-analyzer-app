import { useEffect, useRef, useState } from 'react';
import { FastForward, Sparkles, CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { Button, LogoMark, MockTag, cx } from '../components/ui';
import { Mascot } from '../components/Mascot';
import { getProductBridge } from '../driver/product';
import { defaultAutoLaunchController } from '../state/autoLaunch';
import { useFlow } from '../state/flow';
import { prefs, usePrefs } from '../state/prefs';
import { startAndAwaitReady, useAnalyzerStatus, useDriver } from '../driver';
import { log } from '../state/feedback';

function greetingByHour() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/**
 * 日常启动过场（老用户打开 Companion 的轻快唤醒演出）
 * - 并行查询 driver.getStatus()，开启 autoStart 时通过 startAndAwaitReady 等待就绪
 * - 支持 Esc / Space / 点击立即跳过直达首页
 */
export function SplashScreen() {
  const flow = useFlow();
  const p = usePrefs();
  const driver = useDriver();
  const status = useAnalyzerStatus();
  const [phase, setPhase] = useState<'boot' | 'checking' | 'ready' | 'error'>('boot');
  const started = useRef(false);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const ac = new AbortController();

    const run = async () => {
      log('info', '日常启动：检查 Analyzer 状态');
      const cur = await driver.getStatus();
      if (ac.signal.aborted) return;

      const pb = getProductBridge();
      const previewOrMock = !pb || defaultAutoLaunchController.getSnapshot().coldAutoStartHandled;
      if (p.autoStart) {
        if (previewOrMock && (cur.state === 'stopped' || cur.state === 'unknown')) {
          log('info', '自动启动已开启：唤醒 Analyzer 服务');
          if (p.autoOpen) defaultAutoLaunchController.armAutoOpenForNextReady();
          const next = await startAndAwaitReady(
            driver,
            (s) => {
              if (s.state === 'checking') setPhase('checking');
              else if (s.state === 'starting') setPhase('boot');
            },
            ac.signal,
          );
          if (ac.signal.aborted) return;
          if (next.state !== 'running') {
            setPhase('error');
            return;
          }
          finishedRef.current = true;
          setPhase('ready');
          doneTimer.current = setTimeout(() => {
            if (!ac.signal.aborted) flow.go('home');
          }, p.reduceMotion ? 350 : 950);
        } else if (cur.state === 'error') {
          setPhase('error');
        } else if (cur.state === 'running') {
          finishedRef.current = true;
          setPhase('ready');
          doneTimer.current = setTimeout(() => {
            if (!ac.signal.aborted) flow.go('home');
          }, p.reduceMotion ? 350 : 950);
        }
        return;
      }

      if (cur.state === 'error') {
        setPhase('error');
        return;
      }
      finishedRef.current = true;
      setPhase('ready');
      doneTimer.current = setTimeout(() => {
        if (!ac.signal.aborted) flow.go('home');
      }, p.reduceMotion ? 350 : 950);
    };
    void run();
    return () => {
      ac.abort();
      if (doneTimer.current) clearTimeout(doneTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!p.autoStart || finishedRef.current) return;
    if (status.state === 'checking') {
      setPhase('checking');
    } else if (status.state === 'starting') {
      setPhase('boot');
    } else if (status.state === 'error') {
      setPhase('error');
    } else if (status.state === 'running') {
      finishedRef.current = true;
      setPhase('ready');
      doneTimer.current = setTimeout(() => {
        flow.go('home');
      }, p.reduceMotion ? 350 : 950);
    }
  }, [status.state, p.autoStart, p.reduceMotion, flow]);

  const skip = () => {
    if (doneTimer.current) clearTimeout(doneTimer.current);
    flow.go('home');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const who = p.nickname || '老朋友';
  const mascotState = phase === 'error' ? 'worry' : phase === 'ready' ? 'happy' : phase === 'checking' ? 'think' : 'greet';
  const line =
    phase === 'error'
      ? '自动启动好像失败了，我们进首页看看具体原因吧。'
      : phase === 'ready'
        ? `${greetingByHour()}，${who}！一切就绪，马上进入桌面主页～`
        : phase === 'checking'
          ? '先核对一下程序文件完整性，马上就好……'
          : `${greetingByHour()}，${who}！正在为你唤醒 Companion…`;

  return (
    <section className="stage-page splash-page">
      <div className="splash-card glass pop-in">
        <div className="splash-visual">
          <div className="splash-orbit" aria-hidden />
          <LogoMark size={64} animated />
        </div>

        <div className="splash-kicker">
          <Sparkles size={13} /> DAILY LAUNCH{' '}
          {driver.kind === 'mock' ? <MockTag /> : <span className="codex-tag">CODEX RUNTIME</span>}
        </div>
        <h1 className="splash-title">
          {greetingByHour()}，<span>{who}</span>
        </h1>
        <p className="splash-sub">
          {phase === 'checking' && '正在校验分发包文件完整性 (SHA-256)…'}
          {phase === 'boot' && (p.autoStart ? '正在检测运行状态并自动唤醒 Analyzer…' : '正在读取本地档案状态…')}
          {phase === 'ready' && '本机服务与档案库已准备妥当，即将进入首页。'}
          {phase === 'error' && (status.error?.message ?? '自动启动未能完成')}
        </p>

        <div className={cx('splash-status', `st-${phase === 'checking' ? 'boot' : phase}`)}>
          {(phase === 'boot' || phase === 'checking') && <span className="splash-pulse" />}
          {phase === 'ready' && <CheckCircle2 size={16} />}
          {phase === 'error' && <AlertTriangle size={16} />}
          <span>
            {phase === 'checking' && (
              <>
                <ShieldCheck size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                校验分发包完整性…
              </>
            )}
            {phase === 'boot' && '正在执行 driver.getStatus / startAnalyzer…'}
            {phase === 'ready' && `Analyzer ${status.state === 'running' ? `运行中 · ${status.url}` : '已待命'}`}
            {phase === 'error' && `${status.error?.code ?? 'ERROR'} · 点击下方进入首页处理`}
          </span>
        </div>

        <div className="splash-actions">
          <Button variant="primary" size="lg" onClick={skip} icon={<FastForward size={15} />} kbd="Space">
            {phase === 'error' ? '前往首页处理' : '立即进入首页'}
          </Button>
          <label className="intro-check">
            <input type="checkbox" checked={p.skipIntro} onChange={(e) => prefs.set({ skipIntro: e.target.checked })} />
            以后直接进首页（跳过此启动动画）
          </label>
        </div>
      </div>

      <div className="splash-mascot">
        <Mascot variant="half" state={mascotState} line={line} size="md" />
      </div>
    </section>
  );
}
