import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Check, AlertTriangle, X, Loader2 } from 'lucide-react';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

/* ───────── Button ───────── */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  loading?: boolean;
  icon?: ReactNode;
  trailing?: ReactNode;
  kbd?: string;
}
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, trailing, kbd, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx('btn', `btn-${variant}`, `btn-${size}`, loading && 'is-loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {variant === 'primary' && <span className="btn-shine" aria-hidden />}
      {loading ? <Loader2 className="spin" size={16} /> : icon}
      {children && <span className="btn-label">{children}</span>}
      {trailing}
      {kbd && <kbd className="btn-kbd">{kbd}</kbd>}
    </button>
  );
});

/* ───────── Field ───────── */
interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  prefix?: ReactNode;
  suffix?: ReactNode;
  optional?: boolean;
}
export function Field({ label, hint, error, prefix, suffix, optional, className, id, ...rest }: FieldProps) {
  const fid = id ?? `f-${label}`;
  const [shakeKey, setShakeKey] = useState(0);
  const prev = useRef(error);
  useEffect(() => {
    if (error && error !== prev.current) setShakeKey((k) => k + 1);
    prev.current = error;
  }, [error]);
  return (
    <div className={cx('field', error && 'has-error', className)}>
      <label htmlFor={fid} className="field-label">
        {label}
        {optional && <span className="field-optional">可选</span>}
      </label>
      <div key={shakeKey} className={cx('field-control', shakeKey > 0 && 'shake')}>
        {prefix && <span className="field-affix">{prefix}</span>}
        <input id={fid} className="field-input" aria-invalid={!!error} {...rest} />
        {suffix && <span className="field-affix field-affix-end">{suffix}</span>}
      </div>
      {error ? (
        <p className="field-msg field-error" role="alert">
          <AlertTriangle size={13} /> {error}
        </p>
      ) : (
        hint && <p className="field-msg">{hint}</p>
      )}
    </div>
  );
}

/* ───────── Switch ───────── */
export function Switch({
  checked,
  onChange,
  label,
  desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  desc?: string;
}) {
  return (
    <label className="switch-row">
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {desc && <span className="switch-desc">{desc}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={cx('switch', checked && 'on')}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </label>
  );
}

/* ───────── Mock tag ───────── */
export function MockTag({ children = '模拟', title }: { children?: ReactNode; title?: string }) {
  return (
    <span className="mock-tag" title={title ?? '此处行为为模拟，未执行真实操作'}>
      <span className="mock-dot" />
      {children}
    </span>
  );
}

/* ───────── 状态图标（带描边绘制动画） ───────── */
export function StateIcon({ state, size = 22 }: { state: 'pending' | 'running' | 'ok' | 'warn' | 'fail'; size?: number }) {
  return (
    <span className={cx('state-icon', `s-${state}`)} style={{ width: size, height: size }}>
      {state === 'running' && <span className="state-spinner" />}
      {state === 'ok' && (
        <svg viewBox="0 0 24 24" className="draw-check">
          <path d="M6 12.5l4 4 8-9" />
        </svg>
      )}
      {state === 'warn' && <AlertTriangle size={size * 0.6} />}
      {state === 'fail' && <X size={size * 0.62} strokeWidth={2.6} />}
      {state === 'pending' && <span className="state-dot" />}
    </span>
  );
}

/* ───────── 进度环 ───────── */
export function ProgressRing({
  value,
  size = 168,
  stroke = 10,
  tone = 'accent',
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: 'accent' | 'danger' | 'warning' | 'success';
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={cx('ring', `ring-${tone}`)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="55%" stopColor="var(--aurora)" />
            <stop offset="100%" stopColor="var(--sakura)" />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className="ring-bar"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/* ───────── 动态数字 ───────── */
export function CountUp({ value, duration = 600, format = (n: number) => Math.round(n).toLocaleString() }: { value: number; duration?: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(a + (value - a) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className="numeric">{format(shown)}</span>;
}

/* ───────── Logo (Unified Companion TV + Analytics + Sakura Mark) ───────── */
export function LogoMark({ size = 28, animated = false }: { size?: number; animated?: boolean }) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" className={cx('logo-mark', animated && 'logo-animated')} aria-label="Bangumi Analyzer Companion">
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#191F3A" />
          <stop offset="55%" stopColor="#121629" />
          <stop offset="100%" stopColor="#221938" />
        </linearGradient>
        <linearGradient id={`${uid}-rim`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFC2D4" />
          <stop offset="52%" stopColor="#E76B8E" />
          <stop offset="100%" stopColor="#7B93FF" />
        </linearGradient>
        <linearGradient id={`${uid}-tv`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFD4E2" />
          <stop offset="55%" stopColor="#F79BB7" />
          <stop offset="100%" stopColor="#DF6289" />
        </linearGradient>
        <linearGradient id={`${uid}-ba`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9EB4FF" />
          <stop offset="100%" stopColor="#5E7CFF" />
        </linearGradient>
        <linearGradient id={`${uid}-bb`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFD0DF" />
          <stop offset="100%" stopColor="#F27BA0" />
        </linearGradient>
      </defs>
      <rect x="10" y="10" width="236" height="236" rx="56" fill={`url(#${uid}-bg)`} />
      <rect x="13" y="13" width="230" height="230" rx="53" fill="none" stroke={`url(#${uid}-rim)`} strokeWidth="6" opacity="0.92" />
      <circle cx="128" cy="136" r="78" fill="#F9B6C8" opacity="0.11" />
      <path d="M84 74 L66 44 C63 39 70 33 76 38 L104 66 Z" fill={`url(#${uid}-tv)`} />
      <path d="M172 74 L190 44 C193 39 186 33 180 38 L152 66 Z" fill={`url(#${uid}-tv)`} />
      <rect x="44" y="64" width="168" height="132" rx="34" fill={`url(#${uid}-tv)`} />
      <rect x="60" y="80" width="136" height="100" rx="22" fill="#0F1324" />
      <rect x="60" y="80" width="136" height="100" rx="22" fill="none" stroke="#FFFFFF" strokeOpacity="0.18" strokeWidth="2.5" />
      <rect x="82" y="130" width="22" height="34" rx="7" fill={`url(#${uid}-ba)`} />
      <rect x="117" y="112" width="22" height="52" rx="7" fill={`url(#${uid}-bb)`} />
      <rect x="152" y="96" width="22" height="68" rx="7" fill="#FFF2F7" />
      <path className="logo-star" d="M95 96 L99 106 L109 110 L99 114 L95 124 L91 114 L81 110 L91 106 Z" fill="#FFC9DA" />
      <rect x="84" y="202" width="30" height="10" rx="5" fill="#F48FB1" />
      <rect x="142" y="202" width="30" height="10" rx="5" fill="#89A0FF" />
      {animated && (
        <ellipse className="logo-orbit" cx="128" cy="128" rx="116" ry="44" fill="none" stroke="rgba(255,226,163,.65)" strokeWidth="4.5" transform="rotate(-22 128 128)" />
      )}
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Icon({ ok }: { ok: boolean }) {
  return ok ? <Check size={14} /> : <X size={14} />;
}
