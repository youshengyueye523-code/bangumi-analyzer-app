import { describe, expect, it } from 'vitest';
import {
  blurLength,
  clampWallpaper,
  coverSize,
  dragFocus,
  isPreviewDataUrl,
  strengthRatio,
  wallpaperSizeNote,
  wallpaperSrc,
} from './wallpaper.js';

describe('背景板纯逻辑', () => {
  it('归一化：越界 / 缺失的值都会收敛到合法范围', () => {
    expect(clampWallpaper({})).toEqual({ image: '', focusX: 50, focusY: 50, blur: 10, strength: 60 });
    expect(clampWallpaper({ focusX: 999, focusY: -20, blur: 999, strength: -1 })).toEqual({
      image: '',
      focusX: 100,
      focusY: 0,
      blur: 40,
      strength: 0,
    });
    expect(clampWallpaper({ blur: Number.NaN }).blur).toBe(10);
  });

  it('背景强度 0–100 映射为 0–1，模糊度映射为 CSS 长度', () => {
    expect(strengthRatio(0)).toBe(0);
    expect(strengthRatio(60)).toBe(0.6);
    expect(strengthRatio(200)).toBe(1);
    expect(blurLength(0)).toBe('0px');
    expect(blurLength(40)).toBe('40px');
    expect(blurLength(-3)).toBe('0px');
  });

  it('背景地址：预览态用本地 data URL，正式配置走服务端静态路由', () => {
    expect(wallpaperSrc('')).toBeNull();
    expect(wallpaperSrc('wp-0123456789abcdef.png')).toBe('/api/wallpaper/wp-0123456789abcdef.png');
    expect(isPreviewDataUrl('data:image/png;base64,AAA')).toBe(true);
    expect(wallpaperSrc('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
    expect(isPreviewDataUrl('wp-0123456789abcdef.png')).toBe(false);
  });

  it('cover 尺寸换算：按较大比例铺满容器', () => {
    expect(coverSize({ width: 1920, height: 1080 }, { width: 960, height: 540 })).toEqual({
      width: 960,
      height: 540,
    });
    // 竖图铺满横向容器：宽度贴合容器、纵向溢出（纵向因此可以上下调整构图）
    const portrait = coverSize({ width: 900, height: 1600 }, { width: 800, height: 450 });
    expect(portrait.width).toBeCloseTo(800, 5);
    expect(portrait.height).toBeGreaterThan(450);
    // 尺寸未知时退回容器尺寸，调用方按估计值处理
    expect(coverSize({ width: 0, height: 0 }, { width: 800, height: 450 })).toEqual({
      width: 800,
      height: 450,
    });
  });

  it('拖动换算：图片跟着指针走，可移动余量为 0 时保持不变', () => {
    const frame = { width: 800, height: 800 };
    const wide = { width: 1920, height: 1080 };
    // 横向可移动 622.2px：拖满九成以上距离 → 焦点被夹到 0%
    const draggedRight = dragFocus({ focusX: 50, focusY: 50 }, { x: 520, y: 0 }, frame, wide);
    expect(draggedRight.focusX).toBe(0);
    expect(draggedRight.focusY).toBe(50);
    // 方向：向右拖（看图片左半部分）焦点减小；向左拖焦点增大
    expect(dragFocus({ focusX: 50, focusY: 50 }, { x: -100, y: 0 }, frame, wide).focusX).toBeGreaterThan(50);
    // 图片与容器等比（没有裁切余量）时仍可调整：按最小可移动量换算，避免「怎么拖都不动」
    const slackless = dragFocus(
      { focusX: 50, focusY: 50 },
      { x: 96, y: 0 },
      { width: 800, height: 450 },
      wide,
    );
    expect(slackless.focusX).toBe(0);
    expect(slackless.focusY).toBe(50);
    // 尺寸未知时同样有兜底，且结果不会越界
    const fallback = dragFocus({ focusX: 50, focusY: 50 }, { x: 9999, y: 9999 }, frame, null);
    expect(fallback).toEqual({ focusX: 0, focusY: 0 });
  });

  it('过小的图片给出提示，正常尺寸不提示', () => {
    expect(wallpaperSizeNote(null)).toBeNull();
    expect(wallpaperSizeNote({ width: 1920, height: 1080 })).toBeNull();
    expect(wallpaperSizeNote({ width: 320, height: 180 })).toContain('320×180');
    expect(wallpaperSizeNote({ width: 0, height: 0 })).toBeNull();
  });
});
