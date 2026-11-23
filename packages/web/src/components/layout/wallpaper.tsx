import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useConfig } from '../../lib/queries.js';
import {
  blurLength,
  clampWallpaper,
  strengthRatio,
  wallpaperSrc,
  type WallpaperSetting,
} from '../../lib/wallpaper.js';

interface WallpaperContextValue {
  /** 已保存的正式配置 */
  applied: WallpaperSetting;
  /** 编辑中的预览（null 表示没有正在编辑） */
  preview: WallpaperSetting | null;
  /** 当前实际显示：预览优先，否则正式配置 */
  active: WallpaperSetting;
  /** 预览与正式配置是否有差异 */
  dirty: boolean;
  updatePreview: (patch: Partial<WallpaperSetting>) => void;
  cancelPreview: () => void;
  /** 应用成功后的收尾：清掉预览态（正式值以 config 查询为准） */
  finishApply: () => void;
}

const WallpaperContext = createContext<WallpaperContextValue | null>(null);

/**
 * 背景板状态（全局单实例，挂在 AppShell 外层）。
 *
 * 数据源只有一处：`GET /api/config` 的 `wallpaper`。编辑时先进入预览态，
 * 只有在用户点「应用」时才写正式配置，取消 / 离开设置页都会回到已保存状态。
 */
export function WallpaperProvider({ children }: { children: ReactNode }) {
  const { data } = useConfig();
  const applied = useMemo(() => clampWallpaper(data?.wallpaper ?? {}), [data?.wallpaper]);
  const [preview, setPreview] = useState<WallpaperSetting | null>(null);
  const active = preview ?? applied;

  const updatePreview = useCallback(
    (patch: Partial<WallpaperSetting>) => {
      setPreview((current) => clampWallpaper({ ...(current ?? applied), ...patch }));
    },
    [applied],
  );

  const cancelPreview = useCallback(() => setPreview(null), []);
  const finishApply = useCallback(() => setPreview(null), []);

  /*
   * 把背景参数写进 <html>：面板透明度由 CSS 依据 --wp-strength 计算
   * （见 styles.css），这里只负责强度、模糊半径与「是否启用背景」。
   * 没有背景时移除属性，视觉与 v1.4.2.2 完全一致。
   */
  useEffect(() => {
    const root = document.documentElement;
    if (!active.image) {
      root.removeAttribute('data-wallpaper');
      root.style.removeProperty('--wp-strength');
      root.style.removeProperty('--wp-blur');
      return;
    }
    root.dataset.wallpaper = 'on';
    root.style.setProperty('--wp-strength', strengthRatio(active.strength).toFixed(3));
    root.style.setProperty('--wp-blur', blurLength(active.blur));
  }, [active.image, active.blur, active.strength]);

  const value = useMemo<WallpaperContextValue>(
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

  return <WallpaperContext.Provider value={value}>{children}</WallpaperContext.Provider>;
}

export function useWallpaper(): WallpaperContextValue {
  const value = useContext(WallpaperContext);
  if (!value) throw new Error('useWallpaper 必须在 WallpaperProvider 内使用');
  return value;
}

/**
 * 全局背景板图层：背景图 → Blur → 暗化，位于页面底色之上、所有内容之下。
 * 固定定位 + pointer-events:none，不参与布局、不产生滚动条、不遮挡交互。
 */
export function WallpaperLayer() {
  const { active } = useWallpaper();
  const src = wallpaperSrc(active.image);
  if (!src) return null;
  return (
    <div className="wallpaper-layer" data-testid="wallpaper-layer" aria-hidden>
      <div
        className="wallpaper-image"
        data-testid="wallpaper-image"
        style={{
          backgroundImage: `url("${src}")`,
          backgroundPosition: `${active.focusX}% ${active.focusY}%`,
        }}
      />
      <div className="wallpaper-scrim" data-testid="wallpaper-scrim" />
    </div>
  );
}
