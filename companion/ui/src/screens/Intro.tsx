import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FastForward, Sparkles } from 'lucide-react';
import { Button, Kbd, LogoMark, cx } from '../components/ui';
import { Mascot } from '../components/Mascot';
import { useFlow } from '../state/flow';
import { prefs, usePrefs } from '../state/prefs';

/**
 * 欢迎演出（约 3.0s）
 * 0 星空 → 1 光带掠过 + 星轨展开 + Logo 绽放 → 2 标题逐字 → 3 标语 + 站娘登场 → 4 行动按钮
 * 任何时刻：Esc / Space / 点击「跳过演出」立即到第 4 幕；第 4 幕按 Enter 开始设置。
 */
const TIMELINE = [0, 220, 980, 1920, 2850];
const TITLE = 'Bangumi Analyzer';

export function IntroScreen() {
  const flow = useFlow();
  const p = usePrefs();
  const [phase, setPhase] = useState(p.reduceMotion ? 4 : 0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (p.reduceMotion) {
      setPhase(4);
      return;
    }
    timers.current = TIMELINE.map((t, i) => setTimeout(() => setPhase((ph) => Math.max(ph, i)), t));
    return () => timers.current.forEach(clearTimeout);
  }, [p.reduceMotion]);

  const skip = () => {
    timers.current.forEach(clearTimeout);
    setPhase(4);
  };
  const start = () => flow.go('env');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      if (e.key === 'Escape' || e.key === ' ') {
        if (e.key === 'Escape' && document.querySelector('.window-frame.is-fullscreen')) return;
        e.preventDefault();
        skip();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (phase >= 4) start();
        else skip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <section className={cx('intro', `ph-${phase}`, phase === 4 && 'settled')}>
      <div className="intro-sweep" />
      <div className="intro-rings" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      <div className="intro-bokeh" aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </div>

      <div className="intro-copy">
        <div className="intro-logo">
          <LogoMark size={92} animated />
          <span className="intro-logo-glow" />
        </div>
        <div className="intro-kicker">
          <Sparkles size={12} />
          <span>LOCAL-FIRST ANIME ARCHIVE</span>
          <span className="intro-kicker-line" />
        </div>
        <h1 className="intro-title" aria-label={TITLE}>
          {TITLE.split('').map((ch, i) => (
            <span key={i} style={{ ['--i' as string]: i }} aria-hidden>
              {ch === ' ' ? '\u00a0' : ch}
            </span>
          ))}
        </h1>
        <div className="intro-sub">
          <span className="intro-companion-pill">Companion</span>
          <span className="intro-tagline">把你的番剧记忆，安放在自己的电脑里。</span>
        </div>

        <div className="intro-cta">
          <div className="intro-cta-row">
            <Button variant="primary" size="xl" onClick={start} trailing={<ArrowRight size={18} />} kbd="Enter">
              开始设置
            </Button>
            {p.firstRunCompleted && (
              <Button variant="secondary" size="xl" onClick={() => flow.go('home')}>
                直接进入首页
              </Button>
            )}
          </div>
          <div className="intro-cta-meta">
            <span>约 3 分钟 · 全程可返回修改</span>
            <label className="intro-check">
              <input type="checkbox" checked={p.skipIntro} onChange={(e) => prefs.set({ skipIntro: e.target.checked })} />
              以后启动时跳过开场
            </label>
          </div>
        </div>
      </div>

      <div className="intro-mascot">
        <Mascot
          variant="full"
          state={phase >= 4 ? 'greet' : 'idle'}
          line={phase >= 4 ? '初次见面！我是小番，一起把番剧生活整理得更有条理吧～' : undefined}
        />
      </div>

      <button className={cx('intro-skip', phase >= 4 && 'hidden')} onClick={skip}>
        <FastForward size={14} /> 跳过演出 <Kbd>Esc</Kbd>
      </button>

      <footer className="intro-foot">
        <span>v2.0.0 · 桌面伴侣</span>
        <span className="dot" />
        <span>数据只保存在这台电脑</span>
        <span className="dot" />
        <span>无需管理员权限</span>
      </footer>
    </section>
  );
}
