import { useEffect, useRef, useState } from 'react';
import { toast } from '../state/feedback';

export interface WindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
  isMinimized: boolean;
  contentWidth?: number;
  contentHeight?: number;
  scaleFactor?: number;
}

export interface CompanionWindowBridge {
  getState(): Promise<WindowState>;
  minimize(): Promise<WindowState>;
  toggleMaximize(): Promise<WindowState>;
  toggleFullscreen(): Promise<WindowState>;
  exitFullscreen(): Promise<WindowState>;
  rendererReady?(): Promise<WindowState>;
  close(): Promise<WindowState>;
  onState(cb: (s: WindowState) => void): () => void;
}

declare global {
  interface Window {
    companionWindow?: CompanionWindowBridge;
  }
}

const DEFAULT_STATE: WindowState = { isMaximized: false, isFullScreen: false, isMinimized: false };

export function useWindowController() {
  const native = typeof window !== 'undefined' ? window.companionWindow : undefined;
  const [state, setState] = useState<WindowState>(() => ({
    ...DEFAULT_STATE,
    isFullScreen: typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false,
  }));
  const isFsRef = useRef(state.isFullScreen);
  isFsRef.current = state.isFullScreen;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === 'F11') {
        e.preventDefault();
        if (native) {
          void native.toggleFullscreen();
        } else if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => {});
        } else {
          void document.documentElement.requestFullscreen().catch(() => {});
        }
      } else if (e.key === 'Escape' && isFsRef.current) {
        e.preventDefault();
        if (native) {
          void native.exitFullscreen();
        } else if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => {});
        }
      }
    };
    window.addEventListener('keydown', onKey, true);

    if (native) {
      let alive = true;
      native.getState().then((s) => alive && setState(s)).catch(() => {});
      const off = native.onState((s) => alive && setState(s));
      return () => {
        alive = false;
        off();
        window.removeEventListener('keydown', onKey, true);
      };
    }

    const syncBrowserFs = () => {
      setState((cur) => ({ ...cur, isFullScreen: Boolean(document.fullscreenElement) }));
    };
    document.addEventListener('fullscreenchange', syncBrowserFs);
    return () => {
      document.removeEventListener('fullscreenchange', syncBrowserFs);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [native]);

  const minimize = () => {
    if (native) void native.minimize();
    else toast('info', '已最小化（模拟）', '桌面宿主中将最小化到任务栏。');
  };

  const toggleMaximize = () => {
    if (native) void native.toggleMaximize();
    else setState((s) => ({ ...s, isMaximized: !s.isMaximized }));
  };

  const toggleFullscreen = () => {
    if (native) void native.toggleFullscreen();
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
  };

  const exitFullscreen = () => {
    if (native) void native.exitFullscreen();
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };

  const close = () => {
    if (native) void native.close();
    else toast('info', '关闭窗口（模拟）', '桌面宿主中将先安全停止受管 Analyzer 再退出。');
  };

  const rendererReady = () => {
    if (native) void native.rendererReady?.();
  };

  return {
    isNativeHost: Boolean(native),
    ...state,
    minimize,
    toggleMaximize,
    toggleFullscreen,
    exitFullscreen,
    rendererReady,
    close,
  };
}
