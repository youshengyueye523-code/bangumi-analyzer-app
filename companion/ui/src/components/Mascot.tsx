import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Moon, Coffee, Heart, AlertCircle, Loader, Hand, PartyPopper } from 'lucide-react';
import { cx } from './ui';
import { Live2DStage } from './Live2DStage';
import type { InteractionVariantSpec } from '../assets/xiaofan/PerformanceDirector';
import { resolveXiaofanAsset, XIAOFAN_IDENTITY, type XiaofanVariant } from './xiaofan/XiaofanRegistry';

export type MascotVariant = XiaofanVariant;

/**
 * 原创站娘「小番 Xiaofan」舞台组件（M1 规范化接入版）
 *
 * 保留既有八种标准状态接口：
 *   idle / greet / think / work / happy / worry / sleep / cheer
 *
 * - 当 src/assets/xiaofan/ 中放入正式透明 PNG 时自动渲染对应全身/半身立绘；
 * - 未放入正式素材前，使用小番专属配色与标志性要素的占位舞台（严禁从设定海报抠图）。
 */
export type MascotState = 'idle' | 'greet' | 'think' | 'work' | 'happy' | 'worry' | 'sleep' | 'cheer';

export const MASCOT_STATES: { id: MascotState; label: string; when: string }[] = [
  { id: 'idle', label: '待机', when: '放松微倚，常驻陪伴' },
  { id: 'greet', label: '招呼', when: '欢迎演出 / 日常启动' },
  { id: 'think', label: '思考', when: '检测中、校验中、等待响应' },
  { id: 'work', label: '工作', when: '安装、启动、同步进行中' },
  { id: 'happy', label: '开心', when: '单步成功 / 服务就绪' },
  { id: 'worry', label: '担心', when: '出现异常，需要关注处理' },
  { id: 'sleep', label: '休息', when: 'Analyzer 已停止或小憩' },
  { id: 'cheer', label: '庆祝', when: '全部完成 / 加油鼓劲' },
];

const STATE_ICON: Record<MascotState, typeof Sparkles> = {
  idle: Coffee,
  greet: Hand,
  think: Loader,
  work: Sparkles,
  happy: Heart,
  worry: AlertCircle,
  sleep: Moon,
  cheer: PartyPopper,
};

export function Mascot({
  state,
  line,
  size = 'lg',
  variant,
  showMeta = true,
  bubbleSide = 'left',
  interactNonce = 0,
  onInteraction,
}: {
  state: MascotState;
  line?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: XiaofanVariant;
  showMeta?: boolean;
  bubbleSide?: 'left' | 'top';
  interactNonce?: number;
  onInteraction?: (spec: InteractionVariantSpec) => void;
}) {
  const Ico = STATE_ICON[state];
  const label = MASCOT_STATES.find((s) => s.id === state)!.label;
  const effectiveVariant: XiaofanVariant = variant ?? (size === 'lg' ? 'full' : 'half');
  const asset = resolveXiaofanAsset(effectiveVariant, state);
  const [live2dReady, setLive2dReady] = useState(false);
  const [live2dUnavailable, setLive2dUnavailable] = useState(false);
  const [fallbackDetail, setFallbackDetail] = useState<string | null>(null);
  const [live2dEpoch, setLive2dEpoch] = useState(0);
  const contextRetryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);

  const handleLive2dReady = useCallback(() => {
    setLive2dReady(true);
    setFallbackDetail(null);
    contextRetryRef.current = 0;
  }, []);

  const handleLive2dFallback = useCallback((reason: string, detail?: string) => {
    setLive2dReady(false);
    if (reason === 'gpu_context_lost' && contextRetryRef.current < 2) {
      contextRetryRef.current += 1;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      const triggerRemount = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', triggerRemount);
        retryTimerRef.current = setTimeout(() => setLive2dEpoch((e) => e + 1), 160);
      };
      if (document.hidden) {
        document.addEventListener('visibilitychange', triggerRemount, { once: true });
      } else {
        triggerRemount();
      }
      return;
    }
    setLive2dUnavailable(true);
    setFallbackDetail(`${reason}:${detail ?? ''}`);
  }, []);

  return (
    <div className={cx('mascot', `mascot-${size}`, `var-${effectiveVariant}`, `m-${state}`)}>
      {line && <SpeechBubble text={line} side={bubbleSide} />}
      <div className="mascot-stage" data-live2d-fallback={fallbackDetail ?? undefined}>
        <div className="mascot-visual">
          <div className="mascot-spot" />
          <div className="mascot-halo-ring" aria-hidden />
          <div className="mascot-pedestal" />

          {!live2dUnavailable && (
            <div className={cx('mascot-live2d-wrap', live2dReady && 'ready')}>
              <Live2DStage
                key={live2dEpoch}
                state={state}
                variant={effectiveVariant}
                interactNonce={interactNonce}
                onReady={handleLive2dReady}
                onFallback={handleLive2dFallback}
                onInteraction={onInteraction}
              />
            </div>
          )}

          {!live2dReady && (
            asset.isFormal && asset.src ? (
              <img
                src={asset.src}
                alt={`${XIAOFAN_IDENTITY.name} (${XIAOFAN_IDENTITY.en}) · ${label}`}
                className={cx('xiaofan-img', `var-${effectiveVariant}`)}
                draggable={false}
              />
            ) : (
              <XiaofanPlaceholder state={state} variant={effectiveVariant} />
            )
          )}

          <MascotFx state={state} />
        </div>
        {showMeta && (
          <div className="mascot-meta">
            <span className="mascot-state" key={state}>
              <Ico size={12} /> {label}
            </span>
            <span className="mascot-slot" title={`资产预留路径：${asset.slotPath}`}>
              {live2dReady
                ? `${XIAOFAN_IDENTITY.name} · Live2D (${effectiveVariant === 'full' ? '全身' : '半身'})`
                : asset.isFormal
                  ? `${XIAOFAN_IDENTITY.name} · ${effectiveVariant === 'full' ? '全身' : '半身'}`
                  : fallbackDetail && /^(gpu_|webgl_)/.test(fallbackDetail)
                    ? `${XIAOFAN_IDENTITY.name} · 2D 安全占位（WebGL 已回退）`
                    : `${XIAOFAN_IDENTITY.name} · ${effectiveVariant === 'full' ? '全身' : '半身'}占位`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function SpeechBubble({ text, side }: { text: string; side: 'left' | 'top' }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const id = setInterval(() => setN((v) => (v >= text.length ? (clearInterval(id), v) : v + 1)), 26);
    return () => clearInterval(id);
  }, [text]);
  return (
    <div className={cx('bubble', `bubble-${side}`)} key={text} role="status" aria-live="polite">
      <span className="bubble-sr">{text}</span>
      <span aria-hidden>
        {text.slice(0, n)}
        <span className={cx('caret', n >= text.length && 'done')} />
      </span>
    </div>
  );
}

/**
 * 小番主题占位舞台（使用小番官方樱粉/玫红/奶白/深灰配色与 TV 符号剪影占位，
 * 非正式立绘，正式透明 PNG 投入 src/assets/xiaofan/ 后将自动切换为正式资产）。
 */
function XiaofanPlaceholder({ state, variant }: { state: MascotState; variant: XiaofanVariant }) {
  const mouth: Record<MascotState, string> = {
    idle: 'M132 146 q8 5 16 0',
    greet: 'M129 144 q11 10 22 0',
    think: 'M135 148 h10',
    work: 'M133 146 q7 4 14 0',
    happy: 'M127 143 q13 13 26 0 z',
    worry: 'M131 150 q9 -6 18 0',
    sleep: 'M134 148 q6 2 12 0',
    cheer: 'M126 142 q14 15 28 0 z',
  };
  const eyesClosed = state === 'sleep' || state === 'happy' || state === 'cheer';
  const viewBox = variant === 'full' ? '0 0 280 430' : '0 20 280 285';

  return (
    <svg className={cx('mascot-figure', `fig-${variant}`)} viewBox={viewBox} aria-hidden>
      <defs>
        <linearGradient id="xf-hair" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F9B6C8" stopOpacity=".72" />
          <stop offset="1" stopColor="#E76B8E" stopOpacity=".46" />
        </linearGradient>
        <linearGradient id="xf-coat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFF6F9" stopOpacity=".66" />
          <stop offset="0.65" stopColor="#F9B6C8" stopOpacity=".36" />
          <stop offset="1" stopColor="#4A3E4E" stopOpacity=".28" />
        </linearGradient>
        <linearGradient id="xf-skirt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4A3E4E" stopOpacity=".72" />
          <stop offset="1" stopColor="#E76B8E" stopOpacity=".32" />
        </linearGradient>
      </defs>

      {/* 小番樱粉背景光环与 TV 小图标装饰（不裁剪海报，纯几何符号占位） */}
      <ellipse cx="140" cy="134" rx="88" ry="22" fill="none" stroke="#F9B6C8" strokeOpacity=".28" strokeWidth="1.2" transform="rotate(-12 140 134)" />
      <g transform="translate(194 74) rotate(8)" opacity=".88">
        <rect x="0" y="0" width="24" height="17" rx="5" fill="#FFF6F9" fillOpacity=".24" stroke="#F9B6C8" strokeWidth="1.3" />
        <path d="M9 5l7 3.5-7 3.5z" fill="#F9B6C8" />
      </g>

      <g className="mf-body-g">
        {/* 科技感短外套 + 领结剪影占位 */}
        <path d="M84 218 C 94 202 186 202 196 218 L 210 295 C 185 304 95 304 70 295 Z" fill="url(#xf-coat)" className="mf-outline" />
        {/* 领结标徽 */}
        <path d="M132 216 l8 5 l8-5 l-2 10 l-12 0 z" fill="#E76B8E" fillOpacity=".75" />
        {/* 工牌小挂件 */}
        <rect x="133" y="256" width="14" height="18" rx="3.5" fill="#FFF6F9" fillOpacity=".4" stroke="#E76B8E" strokeWidth="1.2" />
        {variant === 'full' && (
          <>
            {/* 百褶裙与双腿剪影（全身模式可见） */}
            <path d="M90 295 L 190 295 L 200 342 C 165 348 115 348 80 342 Z" fill="url(#xf-skirt)" className="mf-outline" />
            <rect x="112" y="344" width="16" height="68" rx="8" fill="#F6E4C8" fillOpacity=".38" stroke="#F9B6C8" strokeOpacity=".45" />
            <rect x="152" y="344" width="16" height="68" rx="8" fill="#F6E4C8" fillOpacity=".38" stroke="#F9B6C8" strokeOpacity=".45" />
            {/* 腿环徽记 */}
            <rect x="150" y="362" width="20" height="5" rx="2.5" fill="#E76B8E" fillOpacity=".78" />
            {/* 短靴占位 */}
            <rect x="109" y="396" width="22" height="18" rx="6" fill="#FFF6F9" fillOpacity=".52" stroke="#E76B8E" strokeOpacity=".6" />
            <rect x="149" y="396" width="22" height="18" rx="6" fill="#FFF6F9" fillOpacity=".52" stroke="#E76B8E" strokeOpacity=".6" />
          </>
        )}
      </g>

      <g className="mf-head-g">
        {/* 樱粉长发外轮廓 + 右侧蝴蝶结发饰剪影 */}
        <path d="M84 128 C 76 74 114 48 140 48 C 166 48 204 74 196 128 C 204 172 192 206 178 220 C 160 212 120 212 102 220 C 88 206 76 172 84 128 Z" fill="url(#xf-hair)" />
        {/* 标志性呆毛 */}
        <path d="M138 50 C 134 32 150 28 154 44" fill="none" stroke="#F9B6C8" strokeWidth="3" strokeLinecap="round" />
        {/* 面部轮廓 */}
        <circle cx="140" cy="128" r="54" fill="#FFF6F9" fillOpacity=".18" stroke="#F9B6C8" strokeOpacity=".62" strokeWidth="1.6" />
        {/* 右侧发饰蝴蝶结 */}
        <path d="M180 78 l12 -7 l0 14 z M180 78 l-10 -6 l0 12 z" fill="#E76B8E" fillOpacity=".82" />

        {state === 'worry' && (
          <>
            <path d="M110 112 l14 -4" className="mf-brow" />
            <path d="M170 112 l-14 -4" className="mf-brow" />
          </>
        )}
        {state === 'think' && <path d="M153 109 q7 -4 14 1" className="mf-brow" />}

        <g className={cx('mf-eyes', eyesClosed && 'closed')}>
          {eyesClosed ? (
            <>
              <path d="M111 128 q8 -7 16 0" className="mf-line" />
              <path d="M153 128 q8 -7 16 0" className="mf-line" />
            </>
          ) : (
            <>
              <ellipse cx="119" cy="128" rx="6.5" ry="8.8" className="mf-eye xiaofan-eye" />
              <circle cx="121.5" cy="124.5" r="2.2" className="mf-catchlight" />
              <ellipse cx="161" cy="128" rx="6.5" ry="8.8" className="mf-eye xiaofan-eye" />
              <circle cx="163.5" cy="124.5" r="2.2" className="mf-catchlight" />
            </>
          )}
        </g>
        <circle cx="106" cy="145" r="8" className="mf-blush" />
        <circle cx="174" cy="145" r="8" className="mf-blush" />
        <path d={mouth[state]} className={cx('mf-line', 'mf-mouth', (state === 'happy' || state === 'cheer') && 'filled')} />
      </g>

      <g className="mf-arm" style={{ transformOrigin: '196px 245px' }}>
        <path d="M194 245 C 214 222 222 198 226 178" className="mf-line mf-arm-line" />
        <circle cx="227" cy="174" r="8.5" fill="#F9B6C8" fillOpacity=".45" className="mf-outline" />
      </g>
    </svg>
  );
}

function MascotFx({ state }: { state: MascotState }) {
  if (state === 'think')
    return (
      <div className="fx fx-think">
        <i />
        <i />
        <i />
      </div>
    );
  if (state === 'sleep')
    return (
      <div className="fx fx-sleep">
        <b>Z</b>
        <b>z</b>
        <b>z</b>
      </div>
    );
  if (state === 'worry') return <div className="fx fx-worry" />;
  if (state === 'work')
    return (
      <div className="fx fx-work">
        <i />
        <i />
        <i />
      </div>
    );
  if (state === 'happy' || state === 'cheer' || state === 'greet')
    return (
      <div className={cx('fx', 'fx-spark', state === 'cheer' && 'big')}>
        {Array.from({ length: state === 'cheer' ? 10 : 5 }, (_, i) => (
          <i key={i} style={{ ['--i' as string]: i }} />
        ))}
      </div>
    );
  return null;
}
