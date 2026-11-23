import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  clarityRatio,
  clampMaterial,
  frostRatio,
  type MaterialSetting,
} from '../../lib/material.js';
import { useConfig } from '../../lib/queries.js';

interface MaterialContextValue {
  /** 已保存的正式配置 */
  applied: MaterialSetting;
  /** 编辑中的预览（null 表示没有正在编辑） */
  preview: MaterialSetting | null;
  /** 当前实际生效：预览优先 */
  active: MaterialSetting;
  dirty: boolean;
  updatePreview: (patch: Partial<MaterialSetting>) => void;
  cancelPreview: () => void;
  finishApply: () => void;
}

const MaterialContext = createContext<MaterialContextValue | null>(null);

/**
 * 界面材质状态（全局单实例）。
 *
 * 与背景板同一套模式：数据源只有 `GET /api/config` 的 `material`，
 * 编辑先进入预览态（整站立刻生效），点「应用」才写正式配置。
 * 这里只把用户可理解的两个比例写进 CSS 变量，底层 blur / alpha 由
 * styles.css 按层级映射（不同层级自动形成差异）。
 */
export function MaterialProvider({ children }: { children: ReactNode }) {
  const { data } = useConfig();
  const applied = useMemo(() => clampMaterial(data?.material ?? {}), [data?.material]);
  const [preview, setPreview] = useState<MaterialSetting | null>(null);
  const active = preview ?? applied;

  const updatePreview = useCallback(
    (patch: Partial<MaterialSetting>) => {
      setPreview((current) => clampMaterial({ ...(current ?? applied), ...patch }));
    },
    [applied],
  );

  const cancelPreview = useCallback(() => setPreview(null), []);
  const finishApply = useCallback(() => setPreview(null), []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--mat-clarity', clarityRatio(active.clarity).toFixed(3));
    root.style.setProperty('--mat-frost', frostRatio(active.frosted).toFixed(3));
  }, [active.clarity, active.frosted]);

  const value = useMemo<MaterialContextValue>(
    () => ({
      applied,
      preview,
      active,
      dirty: preview !== null,
      updatePreview,
      cancelPreview,
      finishApply,
    }),
    [applied, preview, active, updatePreview, cancelPreview, finishApply],
  );

  return <MaterialContext.Provider value={value}>{children}</MaterialContext.Provider>;
}

export function useMaterial(): MaterialContextValue {
  const value = useContext(MaterialContext);
  if (!value) throw new Error('useMaterial 必须在 MaterialProvider 内使用');
  return value;
}
