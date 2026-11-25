import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Play,
  Square,
  ExternalLink,
  RefreshCw,
  Copy,
  Check,
  Folder,
  Database,
  Sparkles,
  TerminalSquare,
  SlidersHorizontal,
  AlertOctagon,
  AlertTriangle,
  BarChart3,
  Library,
  PieChart,
  Layers,
  UserCheck,
  ShieldCheck,
  RotateCcw,
  Heart,
  Clock,
  Wifi,
  Cpu,
  EyeOff,
  Eye,
  Wrench,
  BookOpen,
} from 'lucide-react';
import { Button, CountUp, MockTag, Switch, cx } from '../components/ui';
import { MaintenancePanel } from '../components/MaintenancePanel';
import { Mascot, MASCOT_STATES, type MascotState } from '../components/Mascot';
import { INTERACTION_POOL, type InteractionVariantSpec } from '../assets/xiaofan/PerformanceDirector';
import { ThirdPartyLicensesModal } from '../components/ThirdPartyLicenses';
import { startAndAwaitReady, useAnalyzerStatus, useDriver, type AnalyzerError, type AnalyzerRoute } from '../driver';
import { getProductBridge } from '../driver/product';
import {
  armAutoOpenForNextReady,
  clearAutoOpenError,
  disarmAutoOpen,
  useAutoOpenError,
} from '../state/autoLaunch';
import { useFlow } from '../state/flow';
import { prefs, usePrefs } from '../state/prefs';
import { clearLogs, log, toast, useLogs } from '../state/feedback';
import { playChime } from '../state/sound';
import { scenario, useScenario, wait, jitter } from '../mock/scenario';
import { SAMPLE_TITLES } from '../mock/setup';

const ANALYZER_SHORTCUTS: Array<{
  id: string;
  route: AnalyzerRoute;
  label: string;
  sub: string;
  icon: typeof BarChart3;
}> = [
  { id: 'dashboard', route: '/', label: '仪表盘', sub: '收藏全貌与近期趋势', icon: BarChart3 },
  { id: 'library', route: '/library', label: '收藏库', sub: '多维筛选与条目细节', icon: Library },
  { id: 'stats', route: '/analysis', label: '统计分析', sub: '评分分布与时间轴', icon: PieChart },
  { id: 'series', route: '/series', label: '系列 / IP', sub: '关联作品聚合治理', icon: Layers },
  { id: 'profile', route: '/profile', label: '我的画像', sub: '证据与 AI 报告', icon: UserCheck },
  { id: 'data', route: '/diagnostics', label: '数据中枢', sub: '备份、导出与完整性', icon: ShieldCheck },
];

const TABS: { id: 'overview' | 'maint' | 'logs' | 'prefs'; label: string }[] = [
  { id: 'overview', label: '档案与快捷入口' },
  { id: 'maint', label: '维护与诊断' },
  { id: 'logs', label: '运行日志' },
  { id: 'prefs', label: '启动与偏好' },
];

function fmtUptime(startedAt: number | null, now: number) {
  if (!startedAt) return '—';
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function fmtRelative(ts: number | null) {
  if (!ts) return '尚未同步';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  return `${Math.floor(sec / 3600)} 小时前`;
}

export function HomeScreen({ isFullScreen = false }: { isFullScreen?: boolean }) {
  const flow = useFlow();
  const driver = useDriver();
  const pb = getProductBridge();
  const status = useAnalyzerStatus();
  const p = usePrefs();
  const sc = useScenario();
  const logs = useLogs();

  const [tab, setTab] = useState<'overview' | 'maint' | 'logs' | 'prefs'>('overview');
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [logFilter, setLogFilter] = useState<'all' | 'warn'>('all');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [syncing, setSyncing] = useState(false);
  const [syncPct, setSyncPct] = useState(0);
  const [syncLabel, setSyncLabel] = useState('');
  const [syncError, setSyncError] = useState<{ code: string; msg: string } | null>(null);
  const [openError, setOpenError] = useState<AnalyzerError | null>(null);
  const autoOpenError = useAutoOpenError();
  const activeOpenError = openError ?? autoOpenError;
  const [interactNonce, setInteractNonce] = useState(0);
  const [interactLine, setInteractLine] = useState<string | null>(null);
  const interactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentFallbackRef = useRef<string[]>([]);
  const [previewState, setPreviewState] = useState<MascotState | null>(null);
  const [gpuMode, setGpuMode] = useState<'auto' | 'gl' | 'd3d11' | 'off'>('auto');
  const [wideViewport, setWideViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1360 : false,
  );
  const logBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pb) return;
    void pb.getCompanionState().then((res) => {
      const gm = res?.state?.gpuMode;
      if (gm === 'auto' || gm === 'gl' || gm === 'd3d11' || gm === 'off') setGpuMode(gm);
      const at = res?.state?.analyzerTheme;
      if (at === 'system' || at === 'dark' || at === 'light') {
        prefs.set({ analyzerTheme: at });
      }
    }).catch(() => {});
  }, [pb]);

  useEffect(() => {
    const onResize = () => setWideViewport(window.innerWidth >= 1360);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight });
  }, [logs.length, tab, isFullScreen, wideViewport]);

  useEffect(() => {
    if (status.state !== 'running') setOpenError(null);
  }, [status.state]);

  const splitBento = isFullScreen || wideViewport;
  const nickname = pb ? p.nickname || '本地收藏家' : p.nickname || '汐音';
  const username = pb ? p.username || 'local' : p.username || 'shione_bgm';
  const collections = pb ? p.collections : p.collections || 842;

  const filteredLogs = useMemo(() => {
    if (logFilter === 'all') return logs;
    return logs.filter((l) => l.level === 'warn' || l.level === 'error');
  }, [logs, logFilter]);

  useEffect(() => () => {
    if (interactTimerRef.current) clearTimeout(interactTimerRef.current);
  }, []);

  const showTransientLine = useCallback((line: string, holdMs = 3100) => {
    setInteractLine(line);
    if (interactTimerRef.current) clearTimeout(interactTimerRef.current);
    interactTimerRef.current = setTimeout(() => {
      setInteractLine(null);
      interactTimerRef.current = null;
    }, holdMs);
  }, []);

  const handleInteractionTriggered = useCallback(
    (spec: InteractionVariantSpec) => {
      showTransientLine(spec.line, Math.round(spec.durationSec * 1000) + 600);
    },
    [showTransientLine],
  );

  const triggerXiaofanInteract = useCallback(() => {
    setInteractNonce((n) => n + 1);
    playChime('tap');
    // Fallback bubble if Live2D canvas is unavailable (e.g. pure 2D fallback mode);
    // when Live2D is active, onInteraction immediately overwrites with the chosen variant's line.
    const recent = new Set(recentFallbackRef.current);
    const pool = INTERACTION_POOL.filter((v) => !recent.has(v.id));
    const pick = (pool.length ? pool : INTERACTION_POOL)[Math.floor(Math.random() * (pool.length || INTERACTION_POOL.length))]!;
    recentFallbackRef.current.push(pick.id);
    if (recentFallbackRef.current.length > 3) recentFallbackRef.current.shift();
    showTransientLine(pick.line, 3100);
  }, [showTransientLine]);

  const derivedMascot = useMemo<{ state: MascotState; line: string }>(() => {
    if (previewState) {
      const meta = MASCOT_STATES.find((m) => m.id === previewState)!;
      return { state: previewState, line: `［预览状态：${meta.label}］${meta.when}` };
    }
    if (syncError) return { state: 'worry', line: `同步遇到点状况（${syncError.code}），点「重试同步」就能继续。` };
    if (syncing) return { state: 'work', line: `正在增量同步收藏……${syncLabel ? `「${syncLabel}」` : ''}` };
    if (status.state === 'error') {
      if (status.ownsProcess) {
        return { state: 'worry', line: '安全停止超时，子进程还在收尾中。请再点一次「重试安全停止」。' };
      }
      if (status.error?.code === 'BRIDGE_UNAVAILABLE') {
        return { state: 'think', line: '当前处于浏览器预览，尚未检测到桌面宿主桥接。' };
      }
      return { state: 'worry', line: '服务好像停下来了，我陪你检查一下原因再重启吧。' };
    }
    if (status.state === 'checking') return { state: 'think', line: '正在校验分发包文件完整性（SHA-256），稍等一下～' };
    if (status.state === 'starting') return { state: 'work', line: '正在拉起本机服务并等待健康检查就绪…' };
    if (status.state === 'stopping') return { state: 'think', line: '正在等待数据库安全落盘并关闭…' };
    if (status.state === 'stopped' || status.state === 'unknown') {
      return { state: 'sleep', line: 'Analyzer 正在小憩。需要看数据时点一下「启动 Analyzer」就好。' };
    }
    if (openError) return { state: 'think', line: '网页没能自动打开，不过服务跑得好好的，复制地址去浏览器打开就行～' };
    return { state: 'idle', line: '一切平稳运行中～ 本机服务已为你守护妥当。' };
  }, [previewState, syncError, syncing, syncLabel, status.state, status.ownsProcess, status.error?.code, openError]);

  const handleRefreshStatus = useCallback(async () => {
    const st = await driver.getStatus();
    playChime('tap');
    log('info', `driver.getStatus() → state=${st.state}${st.rawState ? ` (${st.rawState})` : ''}`);
    toast('info', '状态已刷新', `当前：${st.state}${st.url ? ` · ${st.url}` : ''}`);
  }, [driver]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        handleRefreshStatus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleRefreshStatus]);

  const handleStart = async () => {
    setPreviewState(null);
    setOpenError(null);
    clearAutoOpenError();
    if (p.autoOpen) armAutoOpenForNextReady();
    playChime('tap');
    log('info', '调用 driver.startAnalyzer()');
    const st = await startAndAwaitReady(driver);
    if (st.state !== 'running') {
      disarmAutoOpen();
      playChime('warn');
      log('error', `startAnalyzer 未就绪：${st.error?.code ?? st.state} ${st.error?.message ?? ''}`);
      toast('danger', driver.kind === 'mock' ? 'Analyzer 启动失败（模拟）' : 'Analyzer 启动失败', st.error?.message);
      return;
    }
    playChime('ok');
    log('ok', `Analyzer 已就绪 · ${st.url ?? ''}${st.pid ? ` (pid ${st.pid})` : ''}`);
    toast('success', driver.kind === 'mock' ? 'Analyzer 已启动（模拟）' : 'Analyzer 已就绪', st.url ?? undefined);
  };

  const handleStop = async () => {
    setPreviewState(null);
    setOpenError(null);
    clearAutoOpenError();
    disarmAutoOpen();
    playChime('tap');
    log('info', '调用 driver.stopAnalyzer()（安全等待任务与数据库退出）');
    const st = await driver.stopAnalyzer();
    if (st.state !== 'stopped' || st.ownsProcess) {
      playChime('warn');
      log('error', `stopAnalyzer 未完成：${st.error?.runtimeCode ?? st.error?.code ?? st.state} (ownsProcess=${Boolean(st.ownsProcess)})`);
      toast('danger', '安全停止未完成', st.error?.hint ?? st.error?.message);
      return;
    }
    playChime('ok');
    log('ok', 'Analyzer 已安全停止');
    toast('info', driver.kind === 'mock' ? '已安全停止 Analyzer（模拟）' : 'Analyzer 已安全停止', '数据库已安全关闭。');
  };

  const handleOpen = async (route: AnalyzerRoute = '/', label?: string) => {
    if (status.state !== 'running') {
      playChime('warn');
      const title = label ? `无法打开「${label}」` : '请先启动 Analyzer';
      const detail =
        status.state === 'starting' || status.state === 'checking'
          ? 'Analyzer 服务正在启动或校验中，请等待就绪后再打开。'
          : '服务尚未启动，请先点击「启动 Analyzer」等待就绪。';
      log('warn', `${title}（route=${route}，当前状态=${status.state}）`);
      toast('warning', title, detail);
      return;
    }
    setOpenError(null);
    clearAutoOpenError();
    const res = await driver.openAnalyzer(route);
    if (!res.opened) {
      playChime('warn');
      const err = res.error ?? {
        code: 'OPEN_FAILED',
        message: label ? `未能自动打开「${label}」` : '未能自动打开系统默认浏览器',
        hint: '服务仍在运行，可复制本机地址手动打开。',
      };
      setOpenError(err);
      log('warn', `driver.openAnalyzer(${route}) 失败：${err.code}（服务仍在运行）`);
      toast('warning', label ? `未能自动打开「${label}」` : '未能自动打开浏览器', err.hint ?? '服务仍在运行，可复制本机地址手动打开。');
      return;
    }
    playChime('ok');
    const target = res.url;
    log('info', `调用 driver.openAnalyzer(${route}) → ${target}`);
    toast(
      'success',
      label
        ? driver.kind === 'mock'
          ? `打开「${label}」（模拟）`
          : `已打开「${label}」`
        : driver.kind === 'mock'
          ? '已打开 Analyzer（模拟）'
          : '已唤醒默认浏览器',
      target,
    );
  };

  const handleCopy = async () => {
    if (!status.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
    } catch {
      /* ignore */
    }
    playChime('tap');
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
    toast('success', '已复制本机地址', status.url);
  };

  const handleQuickSync = async () => {
    if (syncing) return;
    if (status.state !== 'running') {
      toast('warning', '请先启动 Analyzer 再同步');
      return;
    }
    setPreviewState(null);
    setSyncError(null);
    setSyncing(true);
    setSyncPct(0);

    if (pb) {
      if (!p.username) {
        setSyncing(false);
        toast('warning', '尚未绑定 Bangumi 账号', '请先在 Analyzer 网页端设置用户名，再执行同步。');
        return;
      }
      log('info', '开始真实增量同步 Bangumi 收藏 (POST /api/sync)');
      const started = await pb.startAnalyzerSync({ mode: 'incremental', depth: 1 });
      if (!started.ok || !started.started) {
        setSyncError({ code: 'SYNC_FAILED', msg: started.error ?? '未能触发同步' });
        setSyncing(false);
        playChime('warn');
        toast('danger', '同步失败', started.error);
        return;
      }
      const activeRunId = started.runId ?? null;
      while (true) {
        await wait(450);
        const st = await pb.getSyncStatus();
        if (st.progress && (!activeRunId || !st.progress.runId || st.progress.runId === activeRunId)) {
          setSyncPct((st.progress.percent ?? 0) / 100);
          setSyncLabel(st.progress.message || '正在增量检查收藏…');
        }
        if (!st.running) {
          const run = st.lastRun;
          if (activeRunId && run?.id && run.id !== activeRunId) continue;
          const runStatus = run?.status;
          if (runStatus === 'success') {
            const cur = await pb.getCompanionState();
            const nextCollections = cur.state?.collections ?? collections;
            prefs.set({ collections: nextCollections, lastSyncAt: Date.now() });
            setSyncing(false);
            setSyncLabel('');
            playChime('ok');
            log('ok', `真实增量同步完成 (runId=${run?.id ?? activeRunId})，当前共 ${nextCollections} 部收藏`);
            toast('success', '增量同步完成', `本地共 ${nextCollections} 部作品`);
          } else {
            const msg = run?.error || st.error || '同步中止';
            setSyncError({ code: 'SYNC_ERROR', msg });
            setSyncing(false);
            playChime('warn');
            log('error', `增量同步失败 (${runStatus ?? 'unknown'})：${msg}`);
            toast('danger', '增量同步中断', msg);
          }
          return;
        }
      }
    }

    log('info', '开始增量同步 Bangumi 收藏（模拟）');
    for (let i = 1; i <= 8; i++) {
      await wait(jitter(240));
      setSyncPct(i / 8);
      const title = SAMPLE_TITLES[(i * 3) % SAMPLE_TITLES.length];
      setSyncLabel(title);
      if (i === 4 && scenario.shouldFail('home.sync', sc.sync !== 'ok')) {
        const code = sc.sync === 'rate-limit' ? 'RATE_LIMITED' : sc.sync === 'db-locked' ? 'DATA_LOCKED' : 'NETWORK';
        const msg =
          sc.sync === 'rate-limit'
            ? 'Bangumi 返回 429 限流，断点已保存'
            : sc.sync === 'db-locked'
              ? '数据库被占用，请稍后重试'
              : '网络连接中断';
        setSyncError({ code, msg });
        setSyncing(false);
        playChime('warn');
        log('error', `增量同步中断：${code} ${msg}`);
        toast('danger', '同步中断（模拟）', msg);
        return;
      }
    }
    const added = 3;
    prefs.set({ collections: collections + added, lastSyncAt: Date.now() });
    setSyncing(false);
    setSyncLabel('');
    playChime('ok');
    log('ok', `增量同步完成：新增 ${added} 部，当前共 ${collections + added} 部`);
    toast('success', '增量同步完成（模拟）', `更新 ${added} 条收藏记录`);
  };

  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const visibleTabs = splitBento ? TABS.filter((t) => t.id !== 'logs') : TABS;
    const cur = visibleTabs.findIndex((t) => t.id === tab);
    const next = visibleTabs[(cur + (e.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length];
    setTab(next.id);
  };

  const statusMeta = {
    unknown: { label: '探测中', cls: 'wait' },
    stopped: { label: status.rawState === 'idle' ? '未启动' : '已停止', cls: 'idle' },
    checking: { label: '完整性校验中…', cls: 'wait' },
    starting: { label: '启动中…', cls: 'wait' },
    running: { label: '运行中', cls: 'ok' },
    stopping: { label: '安全停止中…', cls: 'wait' },
    error: { label: status.ownsProcess ? '停止超时（仍持有进程）' : '服务异常', cls: 'err' },
  }[status.state];

  const busy = status.state === 'checking' || status.state === 'starting' || status.state === 'stopping';
  const pkgRev = status.package?.distributionRevision;
  const pkgFiles = status.package?.files;
  const pkgLabel =
    status.package?.state === 'valid'
      ? pkgRev && pkgFiles
        ? `r${pkgRev} · ${pkgFiles} 文件已校验`
        : pkgFiles
          ? `${pkgFiles} 文件已校验`
          : pkgRev
            ? `r${pkgRev} · 完整性已校验`
            : `v${status.version ?? '2.0.0'} · 完整性已校验`
      : status.package?.state === 'checking'
        ? '校验 SHA-256 中…'
        : status.package?.state === 'invalid'
          ? '校验未通过'
          : `v${status.version ?? '2.0.0'}`;

  const overviewContent = (
    <div className="board-pane pop-in">
      {driver.kind === 'codex' && !pb ? (
        <div className="acct-strip">
          <div className="acct-avatar">B</div>
          <div className="acct-info">
            <div className="acct-name">
              本地档案与账号同步待接入 <MockTag title="M1 阶段仅接入 Runtime 启停，账号/同步将在 M2 接入">M2 阶段接入</MockTag>
            </div>
            <div className="acct-sub">
              当前由 Codex Runtime 托管独立副本生命周期；请在启动后进入 Analyzer 网页端管理 Bangumi 账号与收藏。
            </div>
          </div>
          <span className="chip chip-accent">
            <Wifi size={12} /> 仅本机 127.0.0.1
          </span>
        </div>
      ) : (
        <div className="acct-strip">
          <div className="acct-avatar">{nickname.slice(0, 1)}</div>
          <div className="acct-info">
            <div className="acct-name">
              {nickname} {p.username ? <span>@{username}</span> : <span>未绑定账号</span>}
              {!pb && <MockTag title="账号档案与统计展示在 M1 阶段为模拟数据">模拟档案</MockTag>}
            </div>
            <div className="acct-sub">
              本地收录 <b className="numeric"><CountUp value={collections} /></b> 部 · 上次同步 {fmtRelative(p.lastSyncAt)} ·{' '}
              {p.aiConfigured ? `AI: ${p.aiModel}` : 'AI 未启用'}
            </div>
          </div>
          <span className="chip chip-accent">
            <Wifi size={12} /> 仅本机离线可用
          </span>
        </div>
      )}

      <div className="shortcut-grid">
        {ANALYZER_SHORTCUTS.map((s) => {
          const I = s.icon;
          return (
            <button key={s.id} className="shortcut" onClick={() => handleOpen(s.route, s.label)}>
              <span className="sc-ico">
                <I size={16} />
              </span>
              <span className="sc-text">
                <b>{s.label}</b>
                <small>{s.sub}</small>
              </span>
              <ExternalLink size={13} className="sc-go" />
            </button>
          );
        })}
      </div>
    </div>
  );

  const prefsContent = (
    <div className="board-pane pop-in">
      <div className="opt-group">
        <Switch
          checked={p.autoStart}
          onChange={(v) => {
            prefs.set({ autoStart: v });
            void pb?.savePreferences({ autoStart: v });
          }}
          label="启动 Companion 时自动启动 Analyzer"
          desc="日常打开直接进入工作状态"
        />
        <Switch
          checked={p.autoOpen}
          onChange={(v) => {
            prefs.set({ autoOpen: v });
            if (!v) disarmAutoOpen();
            void pb?.savePreferences({ autoOpen: v });
          }}
          label="服务启动后自动打开网页端"
          desc="就绪后自动在默认浏览器打开一次首页（仅触发一次，不重复弹窗）"
        />
        <Switch
          checked={p.skipIntro}
          onChange={(v) => {
            prefs.set({ skipIntro: v });
            void pb?.savePreferences({ skipIntro: v });
          }}
          label="跳过日常启动动画，直达首页"
          desc="老用户快速启动选项"
        />
        <Switch
          checked={p.mascotEnabled}
          onChange={(v) => prefs.set({ mascotEnabled: v })}
          label="显示小番陪伴舞台与气泡互动"
          desc="关闭后将收起角色舞台以获得更纯粹的操作空间"
        />
        <Switch
          checked={p.soundEnabled}
          onChange={(v) => prefs.set({ soundEnabled: v })}
          label="界面状态提示音效"
          desc="服务就绪、异常提示时的轻柔提示音"
        />
        <Switch
          checked={p.reduceMotion}
          onChange={(v) => prefs.set({ reduceMotion: v })}
          label="减弱演出动画"
          desc="保留功能反馈，收起星空流星、樱瓣与粒子"
        />
        <div className="gpu-pref-row">
          <div className="gpu-pref-copy">
            <strong>Live2D 舞台帧率策略</strong>
            <span>智能模式默认稳定 60 FPS 并随高渲染耗时降压；高刷屏可选 120 FPS（动作速度恒定 1.0×）</span>
          </div>
          <div className="seg" role="group" aria-label="Live2D 帧率策略">
            {(
              [
                ['auto', '智能'],
                ['30', '30 FPS 节能'],
                ['60', '60 FPS'],
                ['120', '120 FPS 高刷'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                className={cx('seg-btn', p.live2dFpsMode === mode && 'on')}
                onClick={() => {
                  prefs.set({ live2dFpsMode: mode });
                  void pb?.savePreferences({ live2dFpsMode: mode });
                  toast('info', `Live2D 帧率策略：${label}`);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="gpu-pref-row">
          <div className="gpu-pref-copy">
            <strong>Analyzer 网页端主题</strong>
            <span>控制浏览器打开网页端的明暗外观并同步至本机配置（与 Companion 界面主题相互独立）</span>
          </div>
          <div className="seg" role="group" aria-label="Analyzer 网页端主题">
            {(
              [
                ['system', '跟随系统'],
                ['dark', '深色'],
                ['light', '浅色'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                className={cx('seg-btn', p.analyzerTheme === mode && 'on')}
                onClick={() => {
                  prefs.set({ analyzerTheme: mode });
                  void pb?.savePreferences({ analyzerTheme: mode });
                  toast('info', `Analyzer 网页端主题：${label}`, '新打开或已打开的网页端将同步生效。');
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {pb && (
          <div className="gpu-pref-row">
            <div className="gpu-pref-copy">
              <strong>Live2D GPU 兼容模式（重启生效）</strong>
              <span>自动模式在 Windows 双显卡环境优先启用 ANGLE D3D11，遇崩溃自动安全回退 2D 占位</span>
            </div>
            <div className="seg" role="group" aria-label="GPU 渲染模式">
              {(
                [
                  ['auto', '智能'],
                  ['gl', 'OpenGL'],
                  ['d3d11', 'D3D11'],
                  ['off', '纯 2D'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className={cx('seg-btn', gpuMode === mode && 'on')}
                  onClick={() => {
                    setGpuMode(mode);
                    void pb.savePreferences({ gpuMode: mode }).then(() => {
                      toast('info', `已保存 GPU 模式：${label}`, '下次启动 Companion 后生效。');
                    });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="prefs-foot">
        <div className="pf-path">
          <Folder size={14} /> 安装目录：<code>{driver.kind === 'mock' || pb ? p.installDir : '由宿主安全托管'}</code>
        </div>
        <div className="pf-btns">
          <Button variant="secondary" size="sm" icon={<BookOpen size={13} />} onClick={() => setLicenseOpen(true)}>
            关于 · 第三方许可
          </Button>
          <Button variant="secondary" size="sm" icon={<Clock size={13} />} onClick={() => flow.go('splash')}>
            预览日常启动
          </Button>
          <Button variant="secondary" size="sm" icon={<RotateCcw size={13} />} onClick={() => flow.go('intro')}>
            重播首次引导
          </Button>
        </div>
      </div>
    </div>
  );

  const logsContent = (
    <div className="board-pane pop-in">
      <div className="log-toolbar">
        <span>
          {driver.kind === 'codex'
            ? 'Codex Runtime 事件快照（seq 去重）'
            : 'CompanionDriver 调用与模拟同步记录'}
        </span>
        <div className="log-toolbar-actions">
          <div className="seg">
            <button className={cx('seg-btn', logFilter === 'all' && 'on')} onClick={() => setLogFilter('all')}>
              全部 <em className="numeric">{logs.length}</em>
            </button>
            <button className={cx('seg-btn', logFilter === 'warn' && 'on')} onClick={() => setLogFilter('warn')}>
              告警/异常
            </button>
          </div>
          <Button variant="ghost" size="sm" onClick={clearLogs}>
            清空
          </Button>
        </div>
      </div>
      <div className="console home-console" ref={logBoxRef}>
        {filteredLogs.length === 0 ? (
          <div className="console-empty">
            {logFilter === 'warn' ? '当前无告警或异常事件。' : '暂无日志。尝试启动 / 停止 Analyzer 或刷新状态。'}
          </div>
        ) : (
          filteredLogs.map((l, i) => (
            <div key={l.seq ?? i} className={cx('console-line', `lv-${l.level}`)}>
              <span className="console-t">{new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              <span className="console-lv">{l.level.toUpperCase()}</span>
              <span>{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <section className={cx('home', splitBento && 'home-bento', !p.mascotEnabled && 'mascot-hidden')}>
      <div className="home-left">
        {/* 1. 服务主控卡 */}
        <article className="home-hero glass">
          <div className="hh-head">
            <div className="hh-state">
              <span className={cx('orb', `orb-${statusMeta.cls}`)}>
                <i />
              </span>
              <div>
                <div className="hh-kicker">
                  ANALYZER RUNTIME
                  {driver.kind === 'mock' ? <MockTag /> : <span className="codex-tag">PROTOCOL v{status.protocolVersion ?? 1}</span>}
                  {status.package && (
                    <span className={cx('pkg-pill', `pk-${status.package.state}`)}>
                      <ShieldCheck size={11} /> {pkgLabel}
                    </span>
                  )}
                </div>
                <h1 className="hh-title">
                  本地核心服务 · <span className={cx(`st-text-${statusMeta.cls}`)}>{statusMeta.label}</span>
                </h1>
              </div>
            </div>
            <div className="hh-head-tools">
              {!p.mascotEnabled && (
                <button
                  className="chip chip-action"
                  onClick={() => prefs.set({ mascotEnabled: true })}
                  title="重新展开小番陪伴舞台"
                >
                  <Eye size={12} /> 显示小番
                </button>
              )}
              <button className="icon-btn" onClick={handleRefreshStatus} title="调用 getStatus() 刷新 (快捷键 R)" aria-label="刷新状态">
                <RefreshCw size={15} className={busy ? 'spin' : ''} />
              </button>
            </div>
          </div>

          <div className="hh-meta">
            <div className="hh-cell">
              <span>本机访问地址</span>
              <div className="hh-url">
                <code>{status.url ?? '未监听（仅本机 127.0.0.1）'}</code>
                {status.url && (
                  <button className="icon-btn" onClick={handleCopy} title="复制地址" aria-label="复制本机地址">
                    {copied ? <Check size={13} className="tone-success" /> : <Copy size={13} />}
                  </button>
                )}
              </div>
            </div>
            <div className="hh-cell">
              <span>进程归属 / 版本</span>
              <b className="numeric">
                {status.pid
                  ? `PID ${status.pid}`
                  : status.ownsProcess
                    ? '持有子进程'
                    : '未持有进程'}{' '}
                · v{status.version ?? '2.0.0'}
              </b>
            </div>
            <div className="hh-cell">
              <span>运行时长</span>
              <b className="numeric">{fmtUptime(status.startedAt, now)}</b>
            </div>
            <div className="hh-cell">
              <span>数据目录</span>
              <b className="truncate" title={status.dataDir ?? (driver.kind === 'mock' ? p.installDir : '由宿主安全托管')}>
                {status.dataDir ?? (driver.kind === 'mock' ? p.installDir : '由宿主安全托管')}
              </b>
            </div>
          </div>

          {status.state === 'error' && status.error && (
            <div className="init-error pop-in">
              <AlertOctagon size={19} />
              <div className="init-error-main">
                <div className="init-error-title">
                  {status.error.message} <code>{status.error.runtimeCode ?? status.error.code}</code>
                </div>
                <div className="init-error-hint">{status.error.hint}</div>
              </div>
            </div>
          )}

          {activeOpenError && status.state === 'running' && (
            <div className="banner banner-warn pop-in">
              <AlertTriangle size={17} />
              <div>
                <b>
                  {activeOpenError.message} <code>{activeOpenError.runtimeCode ?? activeOpenError.code}</code>
                </b>
                <span>{activeOpenError.hint}</span>
              </div>
              {status.url && (
                <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={handleCopy}>
                  复制地址
                </Button>
              )}
            </div>
          )}

          <div className="hh-actions">
            {status.state === 'running' ? (
              <>
                <Button variant="primary" size="lg" icon={<ExternalLink size={16} />} onClick={() => handleOpen()}>
                  打开 Analyzer 网页端
                </Button>
                <Button variant="danger" size="lg" icon={<Square size={14} />} onClick={handleStop}>
                  安全停止
                </Button>
              </>
            ) : status.state === 'error' && status.ownsProcess ? (
              <Button variant="danger" size="lg" icon={<Square size={14} />} onClick={handleStop}>
                重试安全停止
              </Button>
            ) : (
              <Button
                variant="primary"
                size="lg"
                loading={busy}
                disabled={driver.kind === 'codex' && status.error?.code === 'BRIDGE_UNAVAILABLE'}
                icon={<Play size={15} />}
                onClick={handleStart}
              >
                {status.state === 'error'
                  ? '重试启动 Analyzer'
                  : status.state === 'checking'
                    ? '正在校验文件…'
                    : busy
                      ? '启动中…'
                      : '启动 Analyzer'}
              </Button>
            )}
            {(driver.kind === 'mock' || pb) && (
              <>
                <Button
                  variant="secondary"
                  size="lg"
                  loading={syncing}
                  disabled={status.state !== 'running'}
                  icon={<RefreshCw size={15} />}
                  onClick={handleQuickSync}
                >
                  {syncError ? '重试同步' : syncing ? `同步中 ${Math.round(syncPct * 100)}%` : '增量同步'}
                </Button>
                {!pb && status.state === 'running' && <MockTag title="增量同步在 M1 阶段仍为模拟状态">同步为模拟</MockTag>}
              </>
            )}
          </div>

          {(syncing || syncError) && (
            <div className={cx('home-sync-bar', syncError && 'err')}>
              <div className="hs-track">
                <span style={{ width: `${Math.max(8, syncPct * 100)}%` }} />
              </div>
              <span className="hs-text">
                {syncError ? `${syncError.msg} (${syncError.code})` : `正在同步：${syncLabel || '准备分页…'}`}
              </span>
            </div>
          )}
        </article>

        {/* 2. 工作区：全屏/宽屏使用双列 Bento（同时显示入口/偏好与实时日志），窄屏使用多标签 */}
        {splitBento ? (
          <div className="home-bento-row">
            <article className="home-board glass">
              <nav className="board-tabs" role="tablist" aria-label="功能与偏好" onKeyDown={onTabKeyDown}>
                <button
                  role="tab"
                  aria-selected={tab === 'overview'}
                  className={cx('btab', (tab === 'overview' || tab === 'logs') && 'on')}
                  onClick={() => setTab('overview')}
                >
                  <Database size={14} /> 档案与快捷入口
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'maint'}
                  className={cx('btab', tab === 'maint' && 'on')}
                  onClick={() => setTab('maint')}
                >
                  <Wrench size={14} /> 维护与诊断
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'prefs'}
                  className={cx('btab', tab === 'prefs' && 'on')}
                  onClick={() => setTab('prefs')}
                >
                  <SlidersHorizontal size={14} /> 启动与偏好
                </button>
              </nav>
              {tab === 'prefs' ? prefsContent : tab === 'maint' ? <MaintenancePanel /> : overviewContent}
            </article>

            <article className="home-board home-board-logs glass">
              <div className="board-head-static">
                <TerminalSquare size={14} />
                <span>实时运行日志</span>
                <em className="numeric">{logs.length}</em>
              </div>
              {logsContent}
            </article>
          </div>
        ) : (
          <article className="home-board glass">
            <nav className="board-tabs" role="tablist" aria-label="首页工作区" onKeyDown={onTabKeyDown}>
              <button role="tab" aria-selected={tab === 'overview'} className={cx('btab', tab === 'overview' && 'on')} onClick={() => setTab('overview')}>
                <Database size={14} /> 档案与快捷入口
              </button>
              <button role="tab" aria-selected={tab === 'maint'} className={cx('btab', tab === 'maint' && 'on')} onClick={() => setTab('maint')}>
                <Wrench size={14} /> 维护与诊断
              </button>
              <button role="tab" aria-selected={tab === 'logs'} className={cx('btab', tab === 'logs' && 'on')} onClick={() => setTab('logs')}>
                <TerminalSquare size={14} /> 运行日志 <em className="numeric">{logs.length}</em>
              </button>
              <button role="tab" aria-selected={tab === 'prefs'} className={cx('btab', tab === 'prefs' && 'on')} onClick={() => setTab('prefs')}>
                <SlidersHorizontal size={14} /> 启动与偏好
              </button>
            </nav>

            {tab === 'overview' && overviewContent}
            {tab === 'maint' && <MaintenancePanel />}
            {tab === 'logs' && logsContent}
            {tab === 'prefs' && prefsContent}
          </article>
        )}
      </div>

      {/* 3. 右侧小番独立展示舞台 */}
      {p.mascotEnabled && (
        <aside className="home-right glass">
          <div className="hr-head">
            <span>
              <Sparkles size={13} /> 小番 · 陪伴舞台
            </span>
            <div className="hr-head-actions">
              <button
                className="hr-poke"
                onClick={triggerXiaofanInteract}
              >
                <Heart size={12} /> 互动一下
              </button>
              <button
                className="icon-btn"
                title="收起小番舞台（可在偏好中重新开启）"
                aria-label="收起小番舞台"
                onClick={() => prefs.set({ mascotEnabled: false })}
              >
                <EyeOff size={13} />
              </button>
            </div>
          </div>

          <div className="hr-status-strip">
            <Cpu size={12} />
            <span>{driver.kind === 'codex' ? '真实 Runtime 监听中' : 'Mock 守护模式'}</span>
            <em>{status.state === 'running' ? '在线' : status.state === 'error' ? '待处理' : '待命'}</em>
          </div>

          <div
            className="hr-stage"
            onClick={triggerXiaofanInteract}
            title="点击与小番互动"
          >
            <div className="hr-arch" aria-hidden />
            <Mascot
              variant="half"
              state={derivedMascot.state}
              line={interactLine ?? derivedMascot.line}
              size={isFullScreen ? 'lg' : 'md'}
              bubbleSide="top"
              interactNonce={interactNonce}
              onInteraction={handleInteractionTriggered}
            />
          </div>

          <div className="hr-states">
            <div className="hrs-head">
              <span>状态动效预览（8 态）</span>
              {previewState && <button onClick={() => setPreviewState(null)}>恢复自动</button>}
            </div>
            <div className="hrs-pills">
              {MASCOT_STATES.map((m) => (
                <button
                  key={m.id}
                  className={cx('hrs-pill', (previewState ?? derivedMascot.state) === m.id && 'on')}
                  onClick={() => {
                    playChime('tap');
                    setPreviewState((cur) => (cur === m.id ? null : m.id));
                  }}
                  title={m.when}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </aside>
      )}
      <ThirdPartyLicensesModal open={licenseOpen} onClose={() => setLicenseOpen(false)} />
    </section>
  );
}
