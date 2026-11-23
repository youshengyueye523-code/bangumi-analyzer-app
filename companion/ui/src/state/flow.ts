import { createContext, useContext } from 'react';
import type { MascotState } from '../components/Mascot';
import type { BangumiProfile } from '../mock/setup';

export type Screen = 'intro' | 'env' | 'dir' | 'account' | 'ai' | 'init' | 'ready' | 'launch' | 'splash' | 'home';

export const SETUP_STEPS: { id: Screen; no: string; label: string; en: string; optional?: boolean }[] = [
  { id: 'env', no: '01', label: '环境检查', en: 'ENVIRONMENT' },
  { id: 'dir', no: '02', label: '安装位置', en: 'LOCATION' },
  { id: 'account', no: '03', label: 'Bangumi 账号', en: 'ACCOUNT' },
  { id: 'ai', no: '04', label: 'AI 助手', en: 'AI · OPTIONAL', optional: true },
  { id: 'init', no: '05', label: '初始化与同步', en: 'INITIALIZE' },
];

export const SCREEN_ORDER: Screen[] = ['intro', 'env', 'dir', 'account', 'ai', 'init', 'ready', 'launch', 'splash', 'home'];

/** 首次设置过程中收集的数据（只存在于内存 / mock prefs；凭据仅内存暂存并在初始化写入本地 Analyzer 后清空） */
export interface SetupDraft {
  installDir: string;
  account: (BangumiProfile & { tokenSet: boolean }) | null;
  accountSkipped: boolean;
  accountToken?: string;
  ai: { provider: string; model: string; baseUrl?: string; apiKey?: string } | null;
  desktopShortcut?: boolean;
  autoStart?: boolean;
  syncedCount: number;
  elapsedMs: number;
  warnings: string[];
}

export interface FlowApi {
  screen: Screen;
  dir: 1 | -1;
  initBusy: boolean;
  setInitBusy(busy: boolean): void;
  go(screen: Screen): void;
  next(): void;
  back(): void;
  draft: SetupDraft;
  setDraft(patch: Partial<SetupDraft>): void;
  mascot(state: MascotState, line?: string): void;
}

export const FlowContext = createContext<FlowApi | null>(null);
export const useFlow = () => {
  const f = useContext(FlowContext);
  if (!f) throw new Error('FlowContext missing');
  return f;
};
