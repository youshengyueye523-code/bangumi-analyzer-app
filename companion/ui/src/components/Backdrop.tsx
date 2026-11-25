import { useEffect, useRef } from 'react';
import { cx } from './ui';

/**
 * 夜空舞台背景（Layer 0）：星空（canvas）+ 极光（CSS 模糊色块）+ 樱花轻飘 + 地平线透视辉光。
 * intensity 决定演出强度：intro/ready 最强，setup 收敛保证表单可读，home 居中平衡。
 */
export function Backdrop({ mode, reduceMotion }: { mode: 'intro' | 'setup' | 'home' | 'ready'; reduceMotion: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    let w = 0,
      h = 0,
      raf = 0,
      resizeRaf = 0,
      winMinimized = false,
      disposed = false;
    type Star = { nx: number; ny: number; r: number; p: number; s: number; warm: boolean };
    const stars: Star[] = Array.from({ length: 220 }, () => ({
      nx: Math.random(),
      ny: Math.pow(Math.random(), 1.6) * 0.85,
      r: Math.random() < 0.08 ? 1.4 + Math.random() : 0.4 + Math.random() * 0.8,
      p: Math.random() * Math.PI * 2,
      s: 0.6 + Math.random() * 1.6,
      warm: Math.random() < 0.18,
    }));
    let shooting: { x: number; y: number; vx: number; vy: number; life: number } | null = null;

    const light = () => document.documentElement.classList.contains('light');
    const drawFrame = (t: number) => {
      if (w < 2 || h < 2) return;
      ctx.clearRect(0, 0, w, h);
      const isLight = light();
      const m = modeRef.current;
      const k = m === 'intro' || m === 'ready' ? 1 : m === 'home' ? 0.75 : 0.55;
      const activeCount = Math.min(stars.length, Math.max(70, Math.round((w * h) / 7500)));
      for (let i = 0; i < activeCount; i += 1) {
        const st = stars[i]!;
        const tw = reduceMotion ? 0.8 : 0.55 + 0.45 * Math.sin(st.p + (t / 1000) * st.s);
        const a = tw * k * (isLight ? 0.35 : 1);
        ctx.beginPath();
        ctx.fillStyle = isLight
          ? `rgba(110,120,200,${a * 0.7})`
          : st.warm
            ? `rgba(249,182,200,${a})`
            : `rgba(220,228,255,${a})`;
        ctx.arc(st.nx * w, st.ny * h, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduceMotion && !isLight) {
        if (!shooting && Math.random() < (m === 'intro' ? 0.012 : 0.003)) {
          shooting = { x: w * (0.2 + Math.random() * 0.7), y: h * Math.random() * 0.3, vx: -7, vy: 3.2, life: 1 };
        }
        if (shooting) {
          const s = shooting;
          const g = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 14, s.y - s.vy * 14);
          g.addColorStop(0, `rgba(249,220,232,${s.life})`);
          g.addColorStop(1, 'rgba(249,220,232,0)');
          ctx.strokeStyle = g;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - s.vx * 14, s.y - s.vy * 14);
          ctx.stroke();
          s.x += s.vx;
          s.y += s.vy;
          s.life -= 0.018;
          if (s.life <= 0) shooting = null;
        }
      }
    };

    const stopLoop = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const tick = (t: number) => {
      raf = 0;
      if (disposed || document.hidden || winMinimized) return;
      drawFrame(t);
      if (!reduceMotion) {
        raf = requestAnimationFrame(tick);
      }
    };

    const scheduleFrame = () => {
      if (disposed || document.hidden || winMinimized) return;
      if (reduceMotion) {
        drawFrame(performance.now());
        return;
      }
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const resize = () => {
      if (disposed || document.hidden || winMinimized) return;
      const cw = cv.clientWidth;
      const ch = cv.clientHeight;
      if (cw < 2 || ch < 2) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.round(cw * dpr);
      const ph = Math.round(ch * dpr);
      if (cw !== w || ch !== h || cv.width !== pw || cv.height !== ph) {
        w = cw;
        h = ch;
        cv.width = pw;
        cv.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduceMotion) drawFrame(performance.now());
    };

    const scheduleResize = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        resize();
        scheduleFrame();
      });
    };

    resize();
    scheduleFrame();

    const ro = new ResizeObserver(scheduleResize);
    ro.observe(cv);

    const onVisibility = () => {
      if (document.hidden || winMinimized) {
        stopLoop();
      } else {
        scheduleResize();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const unsubWin = window.companionWindow?.onState((ws) => {
      const nextMin = Boolean(ws.isMinimized);
      if (nextMin !== winMinimized) {
        winMinimized = nextMin;
        onVisibility();
      } else if (!nextMin) {
        scheduleResize();
      }
    });
    const themeObs = new MutationObserver(() => {
      if (reduceMotion) drawFrame(performance.now());
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      disposed = true;
      stopLoop();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      unsubWin?.();
      themeObs.disconnect();
    };
  }, [reduceMotion]);

  return (
    <div className={cx('backdrop', `backdrop-${mode}`)} aria-hidden>
      <div className="sky" />
      <div className="aurora a1" />
      <div className="aurora a2" />
      <div className="aurora a3" />
      <canvas ref={canvas} className="stars" />
      {!reduceMotion && mode !== 'setup' && (
        <div className="petals">
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} style={{ ['--i' as string]: i }} />
          ))}
        </div>
      )}
      <div className="horizon" />
      <div className="horizon-grid" />
      <div className="grain" />
      <div className="vignette" />
    </div>
  );
}
