import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FolderOpen, Pause, Play, RotateCw, TerminalSquare, ChevronDown, SkipForward, AlertOctagon, CircleDashed, CheckCircle2, MinusCircle, Loader2, XCircle } from 'lucide-react';
import { Button, CountUp, MockTag, ProgressRing, cx } from '../components/ui';
import { STAGES, SAMPLE_TITLES, plannedFailure, type StageId, type StageFailure } from '../mock/setup';
import { wait, jitter } from '../mock/scenario';
import { useFlow } from '../state/flow';
import { getProductBridge } from '../driver/product';
import { startAndAwaitReady, useDriver } from '../driver';
import { log, useLogs, clearLogs } from '../state/feedback';
import { usePrefs } from '../state/prefs';

type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
interface StageState {
  status: StageStatus;
  progress: number;
  note: string;
}

const PAGE_SIZE = 30;

export function InitScreen() {
  const flow = useFlow();
  const pb = getProductBridge();
  const p = usePrefs();
  const driver = useDriver();
  const account = flow.draft.account;
  const total = account?.collections ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const [stages, setStages] = useState<Record<StageId, StageState>>(
    () => Object.fromEntries(STAGES.map((s) => [s.id, { status: 'pending', progress: 0, note: s.desc }])) as Record<StageId, StageState>,
  );
  const [failure, setFailure] = useState<{ stage: StageId; err: StageFailure } | null>(null);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  const [ticker, setTicker] = useState('');
  const [fetched, setFetched] = useState(0);
  const [detailed, setDetailed] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [skippedDetails, setSkippedDetails] = useState(false);
  const pausedRef = useRef(false);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const startedAt = useRef(Date.now());
  const stagesRef = useRef(stages);
  stagesRef.current = stages;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const set = (id: StageId, p: Partial<StageState>) => setStages((cur) => ({ ...cur, [id]: { ...cur[id], ...p } }));

  const gate = async (signal: AbortSignal) => {
    while (pausedRef.current) await wait(150, signal);
  };

  const runRealFrom = useCallback(
    async (fromIdx: number, sig: AbortSignal) => {
      if (!pb) return;
      if (fromIdx <= 1) {
        set('prepare', { status: 'running', progress: 0.35, note: `准备核验并安装到 ${flow.draft.installDir}…` });
        log('info', `安装解压：校验 Analyzer v2.0.0 r3 发行包 SHA-256 并写入 ${flow.draft.installDir}`);
        const inst = await pb.installAndExtract({ installDir: flow.draft.installDir });
        if (sig.aborted) return;
        if (!inst.ok) {
          const code = inst.code ?? 'INSTALL_FAILED';
          const msg = inst.error ?? '安装解包失败';
          const hint =
            inst.hint ??
            (code === 'SESSION_LOCKED'
              ? '该目录当前已有另一个运行中的 Analyzer 实例。请先关闭原窗口后重试，或点击「更换安装目录」选择新的空白文件夹。'
              : '请检查目录权限和磁盘空间，或点击「更换安装目录」选择其他文件夹。');
          set('prepare', { status: 'failed', note: msg });
          log('error', `安装解包失败 (${code})：${msg}`);
          setFailure({ stage: 'prepare', err: { code, message: msg, hint } });
          return;
        }
        set('prepare', { status: 'done', progress: 1, note: inst.installDir || flow.draft.installDir });
        set('integrity', { status: 'running', progress: 0.7, note: '校验 checksums.json 与节点签名…' });
        await wait(120, sig);
        set('integrity', { status: 'done', progress: 1, note: 'checksums.json · 完整校验通过' });
        log('ok', `程序文件部署完成：${inst.installDir}`);
      }

      if (sig.aborted) return;
      if (fromIdx <= 3) {
        set('database', { status: 'running', progress: 0.45, note: '初始化 SQLite 结构与安全配置…' });
        set('service', { status: 'running', progress: 0.35, note: '正在启动本地 Analyzer (127.0.0.1)…' });
        const cfgRes = await pb.configureAndStartAnalyzer({
          username: account?.username,
          token: flow.draft.accountToken,
          nickname: account?.nickname,
          uid: account?.uid,
          collections: account?.collections,
          ai: flow.draft.ai
            ? { enabled: true, baseUrl: flow.draft.ai.baseUrl, model: flow.draft.ai.model, key: flow.draft.ai.apiKey }
            : { enabled: false },
          desktopShortcut: flow.draft.desktopShortcut ?? true,
          autoStart: flow.draft.autoStart ?? true,
          autoOpen: p.autoOpen,
          skipIntro: p.skipIntro,
        });
        // Clear transient secrets immediately from renderer memory after handoff to Analyzer config.
        flow.setDraft({
          accountToken: undefined,
          ai: flow.draft.ai ? { provider: flow.draft.ai.provider, model: flow.draft.ai.model } : null,
        });
        if (sig.aborted) return;
        if (!cfgRes.ok) {
          const code = cfgRes.code ?? 'SERVICE_FAILED';
          const msg = cfgRes.error ?? 'Analyzer 启动或配置写入失败';
          const hint = cfgRes.hint ?? '确认无其他占用后点击重试，或返回更换安装目录。';
          set('database', { status: 'failed', note: '等待服务启动完成后初始化' });
          set('service', { status: 'failed', note: msg });
          log('error', `Analyzer 启动/配置失败 (${code})：${msg}`);
          setFailure({ stage: 'service', err: { code, message: msg, hint } });
          return;
        }
        set('database', { status: 'done', progress: 1, note: 'SQLite 数据库与个人配置已就绪' });
        set('service', { status: 'done', progress: 1, note: `已就绪 · ${cfgRes.url}` });
        log('ok', `Analyzer 已就绪 ${cfgRes.url}`);
      }

      if (sig.aborted) return;
      let syncedTotal = total;
      if (fromIdx <= 5) {
        if (!account) {
          set('sync', { status: 'skipped', progress: 1, note: '已跳过：未绑定 Bangumi 账号' });
          set('details', { status: 'skipped', progress: 1, note: '已跳过：未绑定 Bangumi 账号' });
        } else {
          set('sync', { status: 'running', progress: 0.05, note: '正在向本地 Analyzer 发起首次收藏同步 (POST /api/sync)…' });
          log('info', '步骤 1/3：Bangumi 配置已写入 Analyzer (PUT /api/config)，正在触发收藏同步 (POST /api/sync)…');
          const startSync = await pb.startAnalyzerSync({ mode: 'full', depth: 1 });
          if (sig.aborted) return;
          if (!startSync.ok || !startSync.started) {
            const msg = startSync.error ?? '配置已保存，但未能发起 Bangumi 收藏同步';
            set('sync', { status: 'failed', note: msg });
            log('error', `步骤 2/3 同步触发失败：${msg}`);
            setFailure({ stage: 'sync', err: { code: 'SYNC_FAILED', message: msg, hint: '配置已写入。请重试发起同步，或先进入首页稍后再同步。' } });
            return;
          }
          const activeRunId = startSync.runId ?? null;
          log('info', `步骤 2/3：已确认发起同步任务 runId=${activeRunId ?? 'active'}，开始轮询真实进度…`);
          let done = false;
          while (!done && !sig.aborted) {
            await wait(450, sig);
            const st = await pb.getSyncStatus();
            if (sig.aborted) return;
            const progMatches = !activeRunId || !st.progress?.runId || st.progress.runId === activeRunId;
            if (st.progress && progMatches) {
              const progPct = Math.max(0.05, Math.min(0.99, (st.progress.percent ?? 0) / 100));
              const fetchedCount = st.progress.counters?.fetched ?? 0;
              const detailsCount = st.progress.counters?.detailsFetched ?? 0;
              setFetched(fetchedCount);
              setDetailed(detailsCount);
              if (fetchedCount > 0) syncedTotal = Math.max(syncedTotal, fetchedCount);
              const phase = st.progress.phase;
              if (phase === 'enriching' || phase === 'relations' || phase === 'persons' || phase === 'series' || phase === 'finalizing') {
                set('sync', { status: 'done', progress: 1, note: `已拉取 ${fetchedCount} 部收藏` });
                set('details', { status: 'running', progress: progPct, note: st.progress.message || '正在补全条目详情…' });
              } else {
                set('sync', { status: 'running', progress: progPct, note: st.progress.message || '正在分页拉取 Bangumi 收藏…' });
              }
            }
            if (!st.running) {
              const run = st.lastRun;
              if (activeRunId && run?.id && run.id !== activeRunId) {
                continue;
              }
              const finalStatus = run?.status;
              if (finalStatus === 'success') {
                const finalFetched = run?.counters?.fetched ?? st.progress?.counters?.fetched ?? syncedTotal;
                syncedTotal = finalFetched;
                setFetched(finalFetched);
                set('sync', { status: 'done', progress: 1, note: `同步完成 · 共 ${finalFetched} 部收藏 (runId=${run?.id ?? activeRunId})` });
                set('details', { status: 'done', progress: 1, note: `${run?.counters?.detailsFetched ?? finalFetched} 部详情已处理` });
                log('ok', `步骤 3/3 真实同步成功 (runId=${run?.id ?? activeRunId})：${finalFetched} 部`);
                done = true;
              } else if (finalStatus === 'cancelled') {
                set('sync', { status: 'failed', note: '用户暂停/取消了当前同步' });
                setFailure({ stage: 'sync', err: { code: 'SYNC_PAUSED', message: '同步已暂停', hint: '点击「从断点继续」可续传，或点「先进入，稍后补全」。' } });
                return;
              } else {
                const errMsg = run?.error || st.error || '未能确认同步任务完成（请勿把配置写入当作同步完成）';
                set('sync', { status: 'failed', note: errMsg });
                log('error', `首次同步未完成 (${finalStatus ?? 'no_run'})：${errMsg}`);
                setFailure({ stage: 'sync', err: { code: 'SYNC_ERROR', message: errMsg, hint: '配置已保留。可重试同步，或先进入桌面助手。' } });
                return;
              }
            }
          }
        }
      }

      if (sig.aborted) return;
      set('snapshot', { status: 'running', progress: 0.6, note: '正在保存首次设置与快捷方式…' });
      await pb.finishFirstRun({
        collections: syncedTotal,
        desktopShortcut: flow.draft.desktopShortcut ?? true,
        skipIntro: p.skipIntro,
        autoStart: flow.draft.autoStart ?? true,
        autoOpen: p.autoOpen,
      });
      set('snapshot', { status: 'done', progress: 1, note: '桌面助手初始化已落盘' });
      flow.setDraft({ syncedCount: syncedTotal });
      setFinished(true);
      log('ok', '首次真实安装与初始化完成');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pb, account, flow.draft.installDir, flow.draft.desktopShortcut, flow.draft.autoStart, p.autoOpen, p.skipIntro, total],
  );

  const runFrom = useCallback(
    async (fromIdx: number) => {
      if (runningRef.current) return;
      runningRef.current = true;
      flow.setInitBusy(true);
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const sig = ac.signal;
      setFailure(null);
      try {
        if (pb) {
          await runRealFrom(fromIdx, sig);
          return;
        }
        for (let i = fromIdx; i < STAGES.length; i++) {
          const def = STAGES[i];
          const cur = stagesRef.current[def.id];
          if (cur.status === 'done' || cur.status === 'skipped') continue;
          if (def.needsAccount && !account) {
            set(def.id, { status: 'skipped', progress: 1, note: '已跳过：未绑定 Bangumi 账号' });
            log('warn', `${def.label}：跳过（未绑定账号）`);
            continue;
          }
          const resumeAt = cur.progress;
          set(def.id, { status: 'running' });
          log('info', resumeAt > 0 ? `${def.label}：从断点 ${Math.round(resumeAt * 100)}% 继续` : `${def.label}：开始`);
          const fail = plannedFailure(def.id);

          if (def.id === 'service') {
            set(def.id, { note: '正在检查运行时并启动服务…' });
            const st = await startAndAwaitReady(
              driver,
              (cur) => {
                if (cur.state === 'checking') {
                  set(def.id, { progress: 0.4, note: '正在校验分发包完整性 (SHA-256)…' });
                } else if (cur.state === 'starting') {
                  set(def.id, { progress: 0.75, note: '正在拉起本机服务并等待就绪…' });
                }
              },
              sig,
            );
            if (sig.aborted) return;
            if (st.state !== 'running') {
              const err = { code: st.error?.code ?? 'UNKNOWN', message: st.error?.message ?? '启动失败', hint: st.error?.hint ?? '' };
              set(def.id, { status: 'failed', note: err.message });
              log('error', `${def.label}：${err.message}`);
              setFailure({ stage: def.id, err });
              return;
            }
            set(def.id, { status: 'done', progress: 1, note: `已就绪 · ${st.url}` });
            log('ok', `Analyzer 已就绪 ${st.url ?? ''}${st.pid ? `（mock pid ${st.pid}）` : ''}`);
            continue;
          }

          const steps = def.id === 'sync' ? pages : def.id === 'details' ? 24 : 8;
          const stepMs = def.id === 'sync' ? 210 : def.id === 'details' ? 170 : 170;
          for (let k = Math.round(resumeAt * steps) + 1; k <= steps; k++) {
            await gate(sig);
            await wait(jitter(stepMs), sig);
            const prog = k / steps;
            if (fail && prog >= fail.at) {
              set(def.id, { status: 'failed', note: fail.err.message });
              log('error', `${def.label}：${fail.err.code} ${fail.err.message}`);
              setFailure({ stage: def.id, err: fail.err });
              return;
            }
            let note = def.desc;
            if (def.id === 'sync') {
              const n = Math.min(total, k * PAGE_SIZE);
              setFetched(n);
              setTicker(SAMPLE_TITLES[(k * 7) % SAMPLE_TITLES.length]);
              note = `第 ${k} / ${steps} 页 · 已获取 ${n} 部`;
              if (k % 6 === 0) log('info', `收藏分页 ${k}/${steps}，累计 ${n}`);
            } else if (def.id === 'details') {
              const n = Math.round(prog * total);
              setDetailed(n);
              setTicker(SAMPLE_TITLES[(k * 5 + 3) % SAMPLE_TITLES.length]);
              note = `${n} / ${total} 部 · 制作人员与关联作品`;
              if (k % 8 === 0) log('info', `条目详情 ${n}/${total}`);
            }
            set(def.id, { progress: prog, note });
          }
          set(def.id, {
            status: 'done',
            progress: 1,
            note: def.id === 'sync' ? `共 ${total} 部收藏` : def.id === 'details' ? `${total} 部详情已补全` : '完成',
          });
          log('ok', `${def.label}：完成`);
        }
        setTicker('');
        setFinished(true);
        log('ok', '首次初始化完成');
      } catch {
        /* aborted */
      } finally {
        if (abortRef.current === ac) {
          runningRef.current = false;
          flow.setInitBusy(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, driver, pages, total, pb, runRealFrom],
  );

  useEffect(() => {
    clearLogs();
    log('info', pb ? `真实部署目标：${flow.draft.installDir}` : `安装位置 ${flow.draft.installDir}（模拟，不写入磁盘）`);
    startedAt.current = Date.now();
    void runFrom(0);
    return () => {
      abortRef.current?.abort();
      runningRef.current = false;
      flow.setInitBusy(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 完成后稍作停留，再进入「准备完成」 */
  useEffect(() => {
    if (!finished) return;
    flow.setDraft({ syncedCount: total, elapsedMs: Date.now() - startedAt.current, warnings: skippedDetails ? [...flow.draft.warnings, '条目详情未补全'] : flow.draft.warnings });
    const t = setTimeout(() => flow.go('ready'), 1300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  const overall = useMemo(() => {
    const sum = STAGES.reduce((a, s) => a + s.weight, 0);
    const got = STAGES.reduce((a, s) => {
      const st = stages[s.id];
      return a + s.weight * (st.status === 'done' || st.status === 'skipped' ? 1 : st.progress);
    }, 0);
    return got / sum;
  }, [stages]);

  const current = STAGES.find((s) => stages[s.id].status === 'running' || stages[s.id].status === 'failed');
  const elapsed = (now - startedAt.current) / 1000;
  const eta = overall > 0.04 && !finished ? Math.max(1, Math.round((elapsed / overall) * (1 - overall))) : null;

  useEffect(() => {
    if (failure) flow.mascot('worry', failure.err.code === 'RATE_LIMITED' ? 'Bangumi 让我们慢一点……进度已经存好啦。' : '遇到点小麻烦，看看右边的说明？');
    else if (finished) flow.mascot('cheer', '全部搞定！');
    else if (paused) flow.mascot('idle', '暂停中，随时可以继续。');
    else if (current?.id === 'sync') flow.mascot('work', `正在搬运收藏……${ticker ? `「${ticker}」` : ''}`);
    else if (current?.id === 'details') flow.mascot('work', '补全制作人员和关联作品，快好了！');
    else flow.mascot('work', '正在布置你的本地资料库～');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failure, finished, paused, current?.id, Math.floor(fetched / 150)]);

  const togglePause = () => {
    if (pb) {
      void pb.cancelSync();
      log('info', '已发送暂停同步指令…');
      return;
    }
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    log('info', pausedRef.current ? '已暂停（当前请求完成后停止）' : '继续');
  };
  const resume = () => {
    if (runningRef.current || !failure) return;
    const idx = STAGES.findIndex((s) => s.id === failure.stage);
    set(failure.stage, { status: 'pending', progress: failure.stage === 'prepare' || failure.stage === 'service' ? 0 : stagesRef.current[failure.stage].progress });
    void runFrom(Math.max(0, idx));
  };
  const goBackStep = () => {
    abortRef.current?.abort();
    runningRef.current = false;
    flow.setInitBusy(false);
    flow.back();
  };
  const goChangeDir = () => {
    abortRef.current?.abort();
    runningRef.current = false;
    flow.setInitBusy(false);
    flow.go('dir');
  };
  const skipDetails = () => {
    set('sync', { status: stagesRef.current.sync.status === 'done' ? 'done' : 'skipped', note: '已跳过：可在首页随时触发同步' });
    set('details', { status: 'skipped', note: '已跳过：将在下次同步时补全' });
    setSkippedDetails(true);
    log('warn', '用户选择跳过剩余同步步骤，先完成本地初始化');
    runFrom(STAGES.findIndex((s) => s.id === 'snapshot'));
  };

  const pausable = current && (current.id === 'sync' || current.id === 'details') && !failure;
  const tone = failure ? 'danger' : finished ? 'success' : 'accent';

  return (
    <div className="step glass init">
      <header className="step-head">
        <div className="step-kicker">
          <span className="step-no">STEP 05</span>
          <span className="step-en">INITIALIZE &amp; SYNC</span>
        </div>
        <h2 className="step-title">{finished ? '准备就绪' : failure ? '初始化已暂停' : '正在初始化'}</h2>
        <p className="step-desc">
          {account ? `为 ${account.nickname} 建立本地资料库并同步收藏。` : '建立本地资料库（未绑定账号，跳过同步）。'}可以随时暂停，中断后从断点继续。 {!pb && <MockTag />}
        </p>
      </header>

      <div className="init-body">
        <div className="init-left">
          <ProgressRing value={overall} size={failure && showLog ? 142 : 184} stroke={11} tone={tone}>
            <div className="ring-pct">
              <CountUp value={overall * 100} duration={400} format={(n) => Math.floor(n).toString()} />
              <small>%</small>
            </div>
            <div className="ring-cap">{finished ? '完成' : failure ? '已暂停' : paused ? '暂停中' : current?.label ?? '准备中'}</div>
          </ProgressRing>
          <div className="init-stats">
            <div>
              <span>已获取</span>
              <b className="numeric">
                <CountUp value={fetched} duration={300} />
              </b>
              <em>/ {total || '—'}</em>
            </div>
            <div>
              <span>详情</span>
              <b className="numeric">
                <CountUp value={detailed} duration={300} />
              </b>
            </div>
            <div>
              <span>{eta ? '预计剩余' : '用时'}</span>
              <b className="numeric">{eta ? fmtSec(eta) : fmtSec(Math.round(elapsed))}</b>
            </div>
          </div>
          <div className={cx('ticker', ticker && 'on')}>
            <span className="ticker-label">{current?.id === 'details' ? '补全' : '同步'}</span>
            <span className="ticker-title" key={ticker}>
              {ticker || '—'}
            </span>
          </div>
        </div>

        <ol className="stage-list">
          {STAGES.map((s) => {
            const st = stages[s.id];
            const I = { pending: CircleDashed, running: Loader2, done: CheckCircle2, skipped: MinusCircle, failed: XCircle }[st.status];
            return (
              <li key={s.id} className={cx('stage', `st-${st.status}`)}>
                <I size={17} className={st.status === 'running' ? 'spin' : ''} />
                <div className="stage-main">
                  <div className="stage-label">{s.label}</div>
                  <div className="stage-note">{st.note}</div>
                  {(st.status === 'running' || (st.status === 'failed' && st.progress > 0)) && s.id !== 'service' && (
                    <div className="stage-bar">
                      <span style={{ width: `${st.progress * 100}%` }} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {failure && (
        <div className="init-error pop-in">
          <AlertOctagon size={20} />
          <div className="init-error-main">
            <div className="init-error-title">
              {failure.err.message} <code>{failure.err.code}</code>
            </div>
            <div className="init-error-hint">{failure.err.hint}</div>
          </div>
        </div>
      )}

      {showLog && <LogConsole />}

      <footer className="step-foot">
        <Button variant="ghost" icon={<TerminalSquare size={15} />} trailing={<ChevronDown size={14} className={cx('chev', showLog && 'up')} />} onClick={() => setShowLog((s) => !s)}>
          运行日志
        </Button>
        {failure && (
          <>
            <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={goBackStep}>
              返回上一步
            </Button>
            {(failure.stage === 'prepare' || failure.stage === 'integrity' || failure.stage === 'service') && (
              <Button variant="secondary" icon={<FolderOpen size={15} />} onClick={goChangeDir}>
                更换安装目录
              </Button>
            )}
          </>
        )}
        <div className="foot-spacer" />
        {failure ? (
          <>
            {(failure.stage === 'details' || (pb && failure.stage === 'sync')) && (
              <Button variant="secondary" icon={<SkipForward size={15} />} onClick={skipDetails}>
                先进入，稍后同步
              </Button>
            )}
            <Button variant="primary" size="lg" icon={<RotateCw size={15} />} onClick={resume}>
              {failure.stage === 'sync' || failure.stage === 'details' ? '从断点继续' : '重试'}
            </Button>
          </>
        ) : finished ? (
          <Button variant="primary" size="lg" onClick={() => flow.go('ready')}>
            查看结果
          </Button>
        ) : (
          <Button variant="secondary" icon={paused ? <Play size={15} /> : <Pause size={15} />} onClick={togglePause} disabled={!pausable && !paused}>
            {paused ? '继续' : '暂停'}
          </Button>
        )}
      </footer>
    </div>
  );
}

function LogConsole() {
  const logs = useLogs();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [logs.length]);
  return (
    <div className="console pop-in" ref={ref}>
      {logs.slice(-80).map((l, i) => (
        <div key={i} className={cx('console-line', `lv-${l.level}`)}>
          <span className="console-t">{new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })}</span>
          <span className="console-lv">{l.level.toUpperCase()}</span>
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

export function fmtSec(s: number) {
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
