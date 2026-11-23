import { useCallback, useEffect, useMemo, useState } from 'react';
import { Backdrop } from './components/Backdrop';
import { DevPanel, TitleBar, Toasts } from './components/Chrome';
import { cx } from './components/ui';
import type { MascotState } from './components/Mascot';
import { DriverContext, selectDriver } from './driver';
import { getProductBridge } from './driver/product';
import { useWindowController } from './driver/window';
import { AccountScreen } from './screens/Account';
import { AiScreen } from './screens/AiConfig';
import { EnvScreen } from './screens/EnvCheck';
import { HomeScreen } from './screens/Home';
import { InitScreen } from './screens/Initialize';
import { InstallDirScreen } from './screens/InstallDir';
import { IntroScreen } from './screens/Intro';
import { LaunchScreen } from './screens/Launch';
import { ReadyScreen } from './screens/Ready';
import { SetupShell } from './screens/SetupShell';
import { SplashScreen } from './screens/Splash';
import { FlowContext, SCREEN_ORDER, type FlowApi, type Screen, type SetupDraft } from './state/flow';
import { prefs, usePrefs } from './state/prefs';

const VALID_SCREENS = new Set<Screen>(SCREEN_ORDER);

function initialScreen(firstRunCompleted: boolean, skipIntro: boolean): Screen {
  const q = new URLSearchParams(location.search).get('screen') as Screen | null;
  if (q && VALID_SCREENS.has(q)) return q;
  if (getProductBridge()) return 'splash';
  if (firstRunCompleted) return skipIntro ? 'home' : 'splash';
  return 'intro';
}

export function App() {
  const p = usePrefs();
  const driver = useMemo(() => selectDriver(), []);
  const productBridge = useMemo(() => getProductBridge(), []);
  const winCtrl = useWindowController();
  const [productReady, setProductReady] = useState(!productBridge);
  const [screen, setScreen] = useState<Screen>(() => initialScreen(p.firstRunCompleted, p.skipIntro));
  const [dir, setDir] = useState<1 | -1>(1);
  const [mascotState, setMascotState] = useState<{ state: MascotState; line?: string }>({ state: 'idle' });
  const [draft, setDraftState] = useState<SetupDraft>(() => ({
    installDir: p.installDir || 'C:\\BangumiAnalyzer',
    account: null,
    accountSkipped: false,
    ai: null,
    desktopShortcut: true,
    autoStart: true,
    syncedCount: 0,
    elapsedMs: 0,
    warnings: [],
  }));

  useEffect(() => {
    if (!productBridge) return;
    let alive = true;
    productBridge
      .getCompanionState()
      .then((res) => {
        if (!alive || !res?.ok || !res.state) return;
        const s = res.state;
        const defaultDir = s.installDir || 'C:\\BangumiAnalyzer';
        prefs.set({
          firstRunCompleted: s.firstRunCompleted,
          skipIntro: s.skipIntro,
          autoStart: s.autoStart,
          autoOpen: s.autoOpen,
          live2dFpsMode: s.live2dFpsMode ?? 'auto',
          installDir: defaultDir,
          nickname: s.nickname || '',
          username: s.username || '',
          collections: s.collections || 0,
          aiConfigured: Boolean(s.aiConfigured),
          aiModel: s.aiModel || '',
          lastSyncAt: s.lastSyncAt ? Date.parse(s.lastSyncAt) || null : null,
        });
        setDraftState((cur) => ({ ...cur, installDir: defaultDir }));
        const q = new URLSearchParams(location.search).get('screen') as Screen | null;
        if (!q || !VALID_SCREENS.has(q)) {
          setScreen(s.firstRunCompleted ? (s.skipIntro ? 'home' : 'splash') : 'intro');
        }
      })
      .finally(() => {
        if (alive) setProductReady(true);
      });
    return () => {
      alive = false;
    };
  }, [productBridge]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', p.theme === 'dark');
    root.classList.toggle('light', p.theme === 'light');
    root.classList.toggle('reduce-motion', p.reduceMotion);
  }, [p.theme, p.reduceMotion]);

  const [initBusy, setInitBusy] = useState(false);

  const go = useCallback(
    (next: Screen) => {
      if (next !== 'init') setInitBusy(false);
      const a = SCREEN_ORDER.indexOf(screen);
      const b = SCREEN_ORDER.indexOf(next);
      setDir(b >= a ? 1 : -1);
      setScreen(next);
    },
    [screen],
  );

  const next = useCallback(() => {
    const idx = SCREEN_ORDER.indexOf(screen);
    if (idx >= 0 && idx < SCREEN_ORDER.length - 1) {
      if (SCREEN_ORDER[idx + 1] !== 'init') setInitBusy(false);
      setDir(1);
      setScreen(SCREEN_ORDER[idx + 1]);
    }
  }, [screen]);

  const back = useCallback(() => {
    const idx = SCREEN_ORDER.indexOf(screen);
    if (idx > 0) {
      setInitBusy(false);
      setDir(-1);
      setScreen(SCREEN_ORDER[idx - 1]);
    }
  }, [screen]);

  const setDraft = useCallback((patch: Partial<SetupDraft>) => {
    setDraftState((cur) => ({ ...cur, ...patch }));
  }, []);

  const mascot = useCallback((state: MascotState, line?: string) => {
    setMascotState({ state, line });
  }, []);

  const flowApi = useMemo<FlowApi>(
    () => ({ screen, dir, initBusy, setInitBusy, go, next, back, draft, setDraft, mascot }),
    [screen, dir, initBusy, go, next, back, draft, setDraft, mascot],
  );

  const isSetup = screen === 'env' || screen === 'dir' || screen === 'account' || screen === 'ai' || screen === 'init';
  const backdropMode =
    screen === 'intro' || screen === 'splash'
      ? 'intro'
      : screen === 'ready' || screen === 'launch'
        ? 'ready'
        : screen === 'home'
          ? 'home'
          : 'setup';

  return (
    <DriverContext.Provider value={driver}>
      <FlowContext.Provider value={flowApi}>
        <div
          className={cx(
            'window-frame',
            winCtrl.isFullScreen && 'is-fullscreen',
            winCtrl.isMaximized && 'is-maximized',
          )}
        >
          <Backdrop mode={backdropMode} reduceMotion={p.reduceMotion} />
          <TitleBar subtle={screen === 'intro' || screen === 'splash'} winCtrl={winCtrl} />
          <main className="stage-host">
            {productReady && (
              <>
                {screen === 'intro' && <IntroScreen />}
                {isSetup && (
                  <SetupShell mascot={mascotState}>
                    {screen === 'env' && <EnvScreen />}
                    {screen === 'dir' && <InstallDirScreen />}
                    {screen === 'account' && <AccountScreen />}
                    {screen === 'ai' && <AiScreen />}
                    {screen === 'init' && <InitScreen />}
                  </SetupShell>
                )}
                {screen === 'ready' && <ReadyScreen />}
                {screen === 'launch' && <LaunchScreen />}
                {screen === 'splash' && <SplashScreen />}
                {screen === 'home' && <HomeScreen isFullScreen={winCtrl.isFullScreen} />}
              </>
            )}
          </main>
          <Toasts />
          <DevPanel />
        </div>
      </FlowContext.Provider>
    </DriverContext.Provider>
  );
}
