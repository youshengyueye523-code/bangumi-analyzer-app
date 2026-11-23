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
      raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    type Star = { x: number; y: number; r: number; p: number; s: number; warm: boolean };
    let stars: Star[] = [];
    let shooting: { x: number; y: number; vx: number; vy: number; life: number } | null = null;

    const resize = () => {
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round((w * h) / 7000);
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.pow(Math.random(), 1.6) * h * 0.85,
        r: Math.random() < 0.08 ? 1.4 + Math.random() : 0.4 + Math.random() * 0.8,
        p: Math.random() * Math.PI * 2,
        s: 0.6 + Math.random() * 1.6,
        warm: Math.random() < 0.18,
      }));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);

    const light = () => document.documentElement.classList.contains('light');
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const isLight = light();
      const m = modeRef.current;
      const k = m === 'intro' || m === 'ready' ? 1 : m === 'home' ? 0.75 : 0.55;
      for (const st of stars) {
        const tw = reduceMotion ? 0.8 : 0.55 + 0.45 * Math.sin(st.p + (t / 1000) * st.s);
        const a = tw * k * (isLight ? 0.35 : 1);
        ctx.beginPath();
        ctx.fillStyle = isLight
          ? `rgba(110,120,200,${a * 0.7})`
          : st.warm
            ? `rgba(249,182,200,${a})`
            : `rgba(220,228,255,${a})`;
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
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
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
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
