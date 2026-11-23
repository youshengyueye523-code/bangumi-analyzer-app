import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw, Wrench, Cpu, HardDrive, FolderLock, Plug, Globe, Monitor } from 'lucide-react';
import { Button, MockTag, StateIcon, cx } from '../components/ui';
import { StepFrame } from './SetupShell';
import { getProductBridge } from '../driver/product';
import { ENV_ITEMS, runEnvCheck, type EnvCheck } from '../mock/setup';
import { useFlow } from '../state/flow';

const ICONS = { os: Monitor, runtime: Cpu, disk: HardDrive, write: FolderLock, port: Plug, network: Globe };

export function EnvScreen() {
  const flow = useFlow();
  const pb = getProductBridge();
  const [items, setItems] = useState<EnvCheck[]>(() => ENV_ITEMS.map((i) => ({ ...i, state: 'pending', detail: '等待检查' })));
  const [running, setRunning] = useState(false);
  const [round, setRound] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const run = useCallback(async (only?: EnvCheck['id'][]) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);
    setRound((r) => r + 1);
    setItems((cur) => cur.map((it) => (!only || only.includes(it.id) ? { ...it, state: 'pending', detail: '等待检查', fix: undefined } : it)));
    try {
      for (const it of ENV_ITEMS) {
        if (only && !only.includes(it.id)) continue;
        setItems((cur) => cur.map((x) => (x.id === it.id ? { ...x, state: 'running', detail: '检查中…' } : x)));
        const res = pb
          ? await pb.runEnvCheck({ id: it.id, targetDir: flow.draft.installDir })
          : await runEnvCheck(it.id, ac.signal);
        if (ac.signal.aborted) return;
        setItems((cur) => cur.map((x) => (x.id === it.id ? { ...x, ...res } : x)));
      }
    } catch {
      return;
    }
    setRunning(false);
  }, [pb, flow.draft.installDir]);

  useEffect(() => {
    run();
    return () => abort.current?.abort();
  }, [run]);

  const done = items.filter((i) => i.state === 'ok' || i.state === 'warn' || i.state === 'fail').length;
  const fails = items.filter((i) => i.state === 'fail');
  const warns = items.filter((i) => i.state === 'warn');
  const verdict = running ? 'running' : fails.length ? 'fail' : warns.length ? 'warn' : 'ok';

  useEffect(() => {
    if (verdict === 'running') flow.mascot('think', round > 1 ? '再仔细看一遍……' : '先让我看看这台电脑的状态～');
    else if (verdict === 'fail') flow.mascot('worry', `有 ${fails.length} 项需要你处理一下，处理好点「重新检测」就行。`);
    else if (verdict === 'warn') flow.mascot('idle', '网络暂时连不上 Bangumi，不过可以先装好，之后再同步。');
    else flow.mascot('happy', '环境完美！我们继续吧。');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdict, round]);

  const canNext = verdict === 'ok' || verdict === 'warn';
  const next = () => {
    if (!canNext) return;
    flow.setDraft({ warnings: warns.map((w) => w.label) });
    flow.next();
  };

  return (
    <StepFrame
      no="01"
      en="ENVIRONMENT CHECK"
      title="检查运行环境"
      desc={
        <>
          确认这台电脑可以运行 Analyzer。只读取状态，不安装任何系统组件。 {!pb && <MockTag />}
        </>
      }
      onEnter={canNext ? next : undefined}
      footer={
        <>
          <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => flow.go('intro')}>
            返回
          </Button>
          <div className="foot-spacer" />
          {fails.length > 0 && !running && (
            <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => run(fails.map((f) => f.id))}>
              仅重测失败项
            </Button>
          )}
          <Button variant="secondary" icon={<RefreshCw size={15} className={running ? 'spin' : ''} />} onClick={() => run()} disabled={running}>
            重新检测
          </Button>
          <Button variant="primary" size="lg" disabled={!canNext} onClick={next} trailing={<ArrowRight size={16} />} kbd={canNext ? 'Enter' : undefined}>
            继续
          </Button>
        </>
      }
    >
      <div className={cx('env-summary', `v-${verdict}`)}>
        <div className="env-summary-bar">
          <span style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
        <div className="env-summary-text">
          {verdict === 'running' && (
            <>
              正在检查 <b className="numeric">{Math.min(done + 1, items.length)}</b> / {items.length}
            </>
          )}
          {verdict === 'ok' && <>全部 {items.length} 项通过，环境就绪</>}
          {verdict === 'warn' && <>可以继续，但有 {warns.length} 项需要留意</>}
          {verdict === 'fail' && <>有 {fails.length} 项未通过，处理后重新检测</>}
        </div>
      </div>

      <ul className="check-list">
        {items.map((it, i) => {
          const I = ICONS[it.id];
          return (
            <li key={it.id} className={cx('check', `c-${it.state}`)} style={{ ['--i' as string]: i }}>
              <span className="check-ico">
                <I size={16} />
              </span>
              <div className="check-main">
                <div className="check-label">{it.label}</div>
                <div className="check-detail">{it.detail}</div>
                {it.fix && (
                  <div className="check-fix">
                    <Wrench size={12} /> {it.fix}
                  </div>
                )}
              </div>
              {it.state === 'fail' && !running && (
                <button className="check-retry" onClick={() => run([it.id])}>
                  <RefreshCw size={12} /> 重试
                </button>
              )}
              <StateIcon state={it.state} />
            </li>
          );
        })}
      </ul>
    </StepFrame>
  );
}
