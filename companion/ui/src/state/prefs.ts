/** 本地偏好（桌面端/原型持久化配置） */
import { useSyncExternalStore } from 'react';

export interface Prefs {
  firstRunCompleted: boolean;
  /** 以后启动时跳过开场演出 */
  skipIntro: boolean;
  /** 打开 Companion 时自动启动 Analyzer */
  autoStart: boolean;
  /** 准备完成后自动在浏览器打开 */
  autoOpen: boolean;
  reduceMotion: boolean;
  /** 小番角色互动与台词气泡开关 */
  mascotEnabled: boolean;
  /** Live2D 舞台帧率策略 */
  live2dFpsMode: 'auto' | '30' | '60' | '120';
  /** 轻量界面提示音效（Web Audio 合成，无外部请求） */
  soundEnabled: boolean;
  theme: 'dark' | 'light';
  /** Analyzer 网页端主题偏好（与 Companion 自身主题相互独立） */
  analyzerTheme: 'system' | 'dark' | 'light';
  installDir: string;
  nickname: string;
  username: string;
  collections: number;
  aiConfigured: boolean;
  aiModel: string;
  lastSyncAt: number | null;
}

const DEFAULT: Prefs = {
  firstRunCompleted: false,
  skipIntro: false,
  autoStart: true,
  autoOpen: false,
  reduceMotion: false,
  mascotEnabled: true,
  live2dFpsMode: 'auto',
  soundEnabled: true,
  theme: 'dark',
  analyzerTheme: 'system',
  installDir: 'D:\\Analyzer',
  nickname: '',
  username: '',
  collections: 0,
  aiConfigured: false,
  aiModel: '',
  lastSyncAt: null,
};

const KEY = 'companion.m0.prefs';
let state: Prefs = (() => {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULT;
  }
})();
const ls = new Set<() => void>();

export const prefs = {
  get: () => state,
  set(patch: Partial<Prefs>) {
    state = { ...state, ...patch };
    localStorage.setItem(KEY, JSON.stringify(state));
    ls.forEach((l) => l());
  },
  reset() {
    state = { ...DEFAULT, theme: state.theme };
    localStorage.setItem(KEY, JSON.stringify(state));
    ls.forEach((l) => l());
  },
  subscribe(l: () => void) {
    ls.add(l);
    return () => ls.delete(l);
  },
};

export const usePrefs = () => useSyncExternalStore(prefs.subscribe, prefs.get);
