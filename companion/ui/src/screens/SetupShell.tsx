import { useEffect, type ReactNode } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
import { Mascot } from '../components/Mascot';
import { LogoMark, cx } from '../components/ui';
import { SETUP_STEPS, useFlow, type Screen } from '../state/flow';
import { getProductBridge } from '../driver/product';
import type { MascotState } from '../components/Mascot';

export function SetupShell({ children, mascot }: { children: ReactNode; mascot: { state: MascotState; line?: string } }) {
  const flow = useFlow();
  const pb = getProductBridge();
  const idx = SETUP_STEPS.findIndex((s) => s.id === flow.screen);
  return (
    <section className="setup">
      <aside className="rail glass">
        <div className="rail-brand">
          <LogoMark size={30} />
          <div>
            <div className="rail-title">首次设置</div>
            <div className="rail-sub">First-run Setup</div>
          </div>
        </div>
        <ol className="rail-steps" style={{ ['--progress' as string]: Math.max(0, idx) / (SETUP_STEPS.length - 1) }}>
          {SETUP_STEPS.map((s, i) => {
            const st = i < idx ? 'done' : i === idx ? 'current' : 'todo';
            return (
              <li key={s.id} className={cx('rail-step', st)}>
                <button
                  className="rail-step-btn"
                  disabled={st === 'todo' || (flow.screen === 'init' && flow.initBusy)}
                  onClick={() => flow.go(s.id as Screen)}
                  title={st === 'done' ? '返回修改' : undefined}
                >
                  <span className="rail-dot">{st === 'done' ? <Check size={12} strokeWidth={3} /> : s.no}</span>
                  <span className="rail-text">
                    <span className="rail-label">
                      {s.label}
                      {s.optional && <em>可选</em>}
                    </span>
                    <span className="rail-en">{s.en}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="rail-foot">
          <ShieldCheck size={14} />
          <span>
            {pb
              ? '所有检测、部署与同步均安全隔离在所选专用目录内，绝不影响外部数据。'
              : '本原型所有检测、安装、绑定与同步均为模拟，不会改动你的电脑。'}
          </span>
        </div>
      </aside>

      <div className="setup-main">
        <div key={flow.screen} className={cx('step-anim', flow.dir > 0 ? 'fwd' : 'back')}>
          {children}
        </div>
      </div>

      <aside className="setup-mascot">
        <Mascot variant="half" size="md" state={mascot.state} line={mascot.line} />
      </aside>
    </section>
  );
}

/** 每一步的统一骨架：章节号 → 标题 → 说明 → 内容 → 底部操作 */
export function StepFrame({
  no,
  en,
  title,
  desc,
  children,
  footer,
  onEnter,
}: {
  no: string;
  en: string;
  title: string;
  desc: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  /** Enter 快捷键触发的主操作（老用户一路回车即可） */
  onEnter?: () => void;
}) {
  useEffect(() => {
    if (!onEnter) return;
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === 'Enter' && !e.altKey && tag !== 'TEXTAREA' && tag !== 'BUTTON') {
        e.preventDefault();
        onEnter();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onEnter]);
  return (
    <div className="step glass">
      <header className="step-head">
        <div className="step-kicker">
          <span className="step-no">STEP {no}</span>
          <span className="step-en">{en}</span>
        </div>
        <h2 className="step-title">{title}</h2>
        <p className="step-desc">{desc}</p>
      </header>
      <div className="step-body">{children}</div>
      <footer className="step-foot">{footer}</footer>
    </div>
  );
}
