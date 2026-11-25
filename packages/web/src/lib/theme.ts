import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api.js';

export type ThemeMode = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'bangumi-analyzer-theme';
const CHANGE_EVENT = 'bangumi-analyzer-theme-change';
let pendingThemeWrites = 0;
let lastServerSyncedTheme: ThemeMode | null = null;

function subscribeTheme(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

function readStored(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system';
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'dark' || value === 'light' ? value : 'system';
}

function writeStored(mode: ThemeMode): void {
  if (typeof localStorage === 'undefined') return;
  if (mode === 'system') localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, mode);
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function subscribeSystemTheme(listener: () => void): () => void {
  if (!window.matchMedia) return () => undefined;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.dataset.theme = resolved;
}

/** 从服务端持久化配置同步主题到本地存储与文档根节点，避免跨端口漂移。 */
export function syncThemeFromServerConfig(serverMode?: ThemeMode | null): void {
  if (serverMode !== 'dark' && serverMode !== 'light' && serverMode !== 'system') return;
  if (pendingThemeWrites > 0) return;
  if (lastServerSyncedTheme === serverMode) return;
  lastServerSyncedTheme = serverMode;
  if (readStored() === serverMode) {
    applyTheme(serverMode);
    return;
  }
  writeStored(serverMode);
  applyTheme(serverMode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function resetThemeSyncStateForTest(): void {
  pendingThemeWrites = 0;
  lastServerSyncedTheme = null;
}

/** 主题切换：默认跟随系统，可显式指定深色 / 浅色，并持久化至本机配置。 */
export function useTheme(): {
  mode: ThemeMode;
  resolved: 'dark' | 'light';
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
} {
  const mode = useSyncExternalStore(subscribeTheme, readStored, () => 'system' as ThemeMode);
  const systemDark = useSyncExternalStore(subscribeSystemTheme, systemPrefersDark, () => true);
  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    applyTheme(mode);
  }, [mode, resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    writeStored(next);
    applyTheme(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
    pendingThemeWrites += 1;
    void api
      .updateConfig({ theme: next })
      .then((updated) => {
        if (updated?.theme) lastServerSyncedTheme = updated.theme;
      })
      .catch(() => undefined)
      .finally(() => {
        pendingThemeWrites = Math.max(0, pendingThemeWrites - 1);
      });
  }, []);
  const toggle = useCallback(
    () =>
      setMode((mode === 'system' ? resolved : mode) === 'dark' ? 'light' : 'dark'),
    [mode, resolved, setMode],
  );

  return { mode, resolved, setMode, toggle };
}

/**
 * 读取当前实际生效的主题（深色 / 浅色）。
 * 通过监听 <html> 的 class 变化，让图表等需要在主题切换时重绘的组件自动更新。
 */
export function useResolvedTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    typeof document === 'undefined' || document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light',
  );

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
