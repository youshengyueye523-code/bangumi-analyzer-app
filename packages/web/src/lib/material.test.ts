import { describe, expect, it } from 'vitest';
import {
  clarityRatio,
  clampMaterial,
  frostRatio,
  matchingPreset,
  MATERIAL_DEFAULT,
  MATERIAL_PRESETS,
} from './material.js';

describe('材质设置纯逻辑', () => {
  it('归一化：越界与缺失值都收敛到合法范围，非法倾向回落到平衡', () => {
    expect(clampMaterial({})).toEqual(MATERIAL_DEFAULT);
    expect(clampMaterial({ preset: 'frosted', clarity: 999, frosted: -10 })).toEqual({
      preset: 'frosted',
      clarity: 100,
      frosted: 0,
    });
    expect(clampMaterial({ preset: 'nope' as never }).preset).toBe('balanced');
    expect(clampMaterial({ clarity: Number.NaN }).clarity).toBe(MATERIAL_PRESETS.balanced.clarity);
  });

  it('倾向与滑块的关系：预设写入两个值，微调后不再匹配任何预设', () => {
    expect(matchingPreset({ preset: 'clear', ...MATERIAL_PRESETS.clear })).toBe('clear');
    expect(matchingPreset({ preset: 'balanced', ...MATERIAL_PRESETS.balanced })).toBe('balanced');
    expect(matchingPreset({ preset: 'clear', clarity: 60, frosted: 22 })).toBeNull();
    expect(matchingPreset({ preset: 'frosted', clarity: 30, frosted: 80 })).toBeNull();
  });

  it('通透度 / 磨砂度映射为 0–1，且预设顺序符合直觉（清透更透、磨砂更模糊）', () => {
    expect(clarityRatio(0)).toBe(0);
    expect(clarityRatio(50)).toBe(0.5);
    expect(clarityRatio(200)).toBe(1);
    expect(frostRatio(-5)).toBe(0);

    expect(MATERIAL_PRESETS.clear.clarity).toBeGreaterThan(MATERIAL_PRESETS.frosted.clarity);
    expect(MATERIAL_PRESETS.clear.frosted).toBeLessThan(MATERIAL_PRESETS.frosted.frosted);
  });
});
