import {
  type MaterialPreset,
  type MaterialSetting,
  MATERIAL_DEFAULT,
  MATERIAL_PRESET_LABEL,
  MATERIAL_PRESETS,
} from '@bangumi-analyzer/shared';

export { MATERIAL_DEFAULT, MATERIAL_PRESET_LABEL, MATERIAL_PRESETS };
export type { MaterialPreset, MaterialSetting };

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 归一化材质设置：三个值都收敛到合法范围。 */
export function clampMaterial(setting: Partial<MaterialSetting>): MaterialSetting {
  const preset: MaterialPreset =
    setting.preset === 'clear' || setting.preset === 'balanced' || setting.preset === 'frosted'
      ? setting.preset
      : MATERIAL_DEFAULT.preset;
  return {
    preset,
    clarity: clamp(Number(setting.clarity), 0, 100, MATERIAL_PRESETS[preset].clarity),
    frosted: clamp(Number(setting.frosted), 0, 100, MATERIAL_PRESETS[preset].frosted),
  };
}

/**
 * 当前值是否正好等于某个预设。
 * 用户单独拖动滑块后不再匹配任何预设（界面就不会高亮任何一个倾向），
 * 这样「预设」与「微调」不会互相撒谎。
 */
export function matchingPreset(setting: MaterialSetting): MaterialPreset | null {
  const found = (Object.keys(MATERIAL_PRESETS) as MaterialPreset[]).find(
    (preset) =>
      MATERIAL_PRESETS[preset].clarity === setting.clarity &&
      MATERIAL_PRESETS[preset].frosted === setting.frosted,
  );
  return found ?? null;
}

/** 通透度 / 磨砂度 → CSS 变量使用的 0–1 比例。 */
export function clarityRatio(clarity: number): number {
  return clamp(clarity, 0, 100, MATERIAL_DEFAULT.clarity) / 100;
}

export function frostRatio(frosted: number): number {
  return clamp(frosted, 0, 100, MATERIAL_DEFAULT.frosted) / 100;
}

/** 材质只在与背景板配合时才可见：没有背景就没有可模糊的环境。 */
export const MATERIAL_NEEDS_WALLPAPER_HINT =
  '材质需要背景作为「环境」：当前未设置背景，界面会保持完全不透明，效果在设置背景后生效。';

export const MATERIAL_HINT =
  '通透度作用于侧栏、顶栏与浮层（内容卡片仍由「背景强度」控制）；磨砂度决定这些层的模糊程度。';
