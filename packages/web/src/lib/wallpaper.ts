import {
  type WallpaperSetting,
  WALLPAPER_DEFAULT,
  WALLPAPER_MAX_BYTES,
  WALLPAPER_MIME_TYPES,
  WALLPAPER_BLUR_MAX,
} from '@bangumi-analyzer/shared';

export { WALLPAPER_BLUR_MAX, WALLPAPER_DEFAULT, WALLPAPER_MAX_BYTES };
export type { WallpaperSetting };

/** 文件选择器的 accept 与提示文案（只支持静态位图，不支持 GIF / 视频）。 */
export const WALLPAPER_ACCEPT = WALLPAPER_MIME_TYPES.join(',');
export const WALLPAPER_SIZE_HINT = `支持 PNG / JPEG / WebP，单张不超过 ${
  WALLPAPER_MAX_BYTES / 1024 / 1024
} MB。图片保存到本机 data/wallpapers，不会上传到任何第三方服务。`;

export function isPreviewDataUrl(image: string): boolean {
  return image.startsWith('data:');
}

/**
 * 背景图地址：预览态直接使用本地 data URL（还没有落盘），
 * 正式配置走服务端的静态路由。
 */
export function wallpaperSrc(image: string): string | null {
  if (!image) return null;
  return isPreviewDataUrl(image) ? image : `/api/wallpaper/${encodeURIComponent(image)}`;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 归一化设置：所有字段都收敛到合法范围，避免脏配置把界面带偏。 */
export function clampWallpaper(setting: Partial<WallpaperSetting>): WallpaperSetting {
  return {
    image: typeof setting.image === 'string' ? setting.image : WALLPAPER_DEFAULT.image,
    focusX: clamp(Number(setting.focusX), 0, 100, WALLPAPER_DEFAULT.focusX),
    focusY: clamp(Number(setting.focusY), 0, 100, WALLPAPER_DEFAULT.focusY),
    blur: clamp(Number(setting.blur), 0, WALLPAPER_BLUR_MAX, WALLPAPER_DEFAULT.blur),
    strength: clamp(Number(setting.strength), 0, 100, WALLPAPER_DEFAULT.strength),
  };
}

/** 「背景强度」0–100 → CSS 变量 --wp-strength 使用的 0–1。 */
export function strengthRatio(strength: number): number {
  return clamp(strength, 0, 100, WALLPAPER_DEFAULT.strength) / 100;
}

/** 「模糊度」→ CSS 长度（只在背景层使用，不作用于任何内容）。 */
export function blurLength(blur: number): string {
  return `${clamp(blur, 0, WALLPAPER_BLUR_MAX, WALLPAPER_DEFAULT.blur)}px`;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * 拖动的最小可移动量（相对预览框尺寸）。
 *
 * 当图片与预览框比例完全一致时没有任何裁切余量，如果严格按几何换算，
 * 拖动会「怎么拖都不动」，用户会以为坏了。这里给一个下限，保证构图焦点
 * 始终可调（焦点是百分比，在真实背景上按同样的语义生效）。
 */
export const MIN_DRAG_SLACK = 0.12;

/**
 * cover 方式下图片相对容器的渲染尺寸。
 * 用来把拖动距离换算成焦点百分比，实现「图片跟着指针走」的手感。
 */
export function coverSize(image: Size, frame: Size): Size {
  if (image.width <= 0 || image.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return { width: frame.width, height: frame.height };
  }
  const scale = Math.max(frame.width / image.width, frame.height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

/**
 * 拖动换算：把指针位移换算成 background-position 的百分比。
 *
 * 焦点百分比越大，图片越往左 / 上移动，所以指针向右拖时百分比要减小，
 * 这样视觉上就是「图片跟着手走」。图片在该方向上没有可移动余量时保持不变。
 * 拿不到原图尺寸（还没加载完）时按容器尺寸的 30% 作为可移动距离的估计值。
 */
export function dragFocus(
  start: { focusX: number; focusY: number },
  delta: { x: number; y: number },
  frame: Size,
  image: Size | null,
): { focusX: number; focusY: number } {
  const covered = image ? coverSize(image, frame) : null;
  const travelX = Math.max(covered ? covered.width - frame.width : 0, frame.width * MIN_DRAG_SLACK);
  const travelY = Math.max(covered ? covered.height - frame.height : 0, frame.height * MIN_DRAG_SLACK);
  const shift = (travel: number, deltaValue: number): number =>
    travel <= 1 ? 0 : (deltaValue / travel) * 100;
  return {
    focusX: clamp(start.focusX - shift(travelX, delta.x), 0, 100, start.focusX),
    focusY: clamp(start.focusY - shift(travelY, delta.y), 0, 100, start.focusY),
  };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败，请重试'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/** 选择文件后的本地校验：类型 / 体积在浏览器侧先拦一次（服务端还会再校验一次）。 */
export async function readWallpaperFile(file: File): Promise<string> {
  if (!(WALLPAPER_MIME_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(`「${file.name}」不是受支持的图片格式，请使用 PNG / JPEG / WebP`);
  }
  if (file.size > WALLPAPER_MAX_BYTES) {
    throw new Error(
      `图片过大（${(file.size / 1024 / 1024).toFixed(1)} MB），请压缩到 ${
        WALLPAPER_MAX_BYTES / 1024 / 1024
      } MB 以内`,
    );
  }
  return readAsDataUrl(file);
}

/**
 * 读取图片原始尺寸：只用于拖动换算，加载不出来（或环境不支持）时返回 0×0，
 * 调用方按「尺寸未知」处理，不影响任何功能。
 */
export function loadImageSize(src: string): Promise<Size> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve({ width: 0, height: 0 });
      return;
    }
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = src;
  });
}

/** 小图放大后容易糊：给一个提示，不阻止使用。 */
export function wallpaperSizeNote(size: Size | null): string | null {
  if (!size || size.width <= 0 || size.height <= 0) return null;
  if (size.width < 1280 || size.height < 720) {
    return `图片较小（${size.width}×${size.height}），铺满屏幕后可能偏模糊。`;
  }
  return null;
}
