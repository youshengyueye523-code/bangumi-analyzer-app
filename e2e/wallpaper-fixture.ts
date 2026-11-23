import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { APIRequestContext } from '@playwright/test';

/**
 * 测试用的真实位图（PNG）：
 * 不依赖任何图形库，直接按 PNG 规范拼字节，因此可以自由生成
 * 16:9 / 竖图 / 超宽 / 过小等各种比例，用于验证不同图片的适配。
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** painter(x, y, w, h) → [r, g, b] */
export function png(
  width: number,
  height: number,
  painter: (x: number, y: number, w: number, h: number) => [number, number, number],
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = painter(x, y, width, height);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 亮色高饱和图：亮度与饱和度都偏高，用来验证「角色图不会盖住信息」 */
export function brightPainter(
  x: number,
  y: number,
  w: number,
  h: number,
): [number, number, number] {
  const u = x / w;
  const v = y / h;
  const sun = Math.max(0, 1 - Math.hypot(u - 0.72, v - 0.28) * 2.6);
  return [
    Math.min(255, Math.round(40 + 215 * Math.min(1, sun * 1.2 + u * 0.35))),
    Math.min(255, Math.round(60 + 190 * Math.min(1, sun * 0.9 + (1 - v) * 0.4))),
    Math.min(255, Math.round(120 + 130 * Math.min(1, sun * 0.6 + v * 0.5))),
  ];
}

/** 暗色冷调图：模拟夜景截图 */
export function darkPainter(x: number, y: number, w: number, h: number): [number, number, number] {
  const u = x / w;
  const v = y / h;
  const glow = Math.max(0, 1 - Math.hypot(u - 0.3, v - 0.65) * 3);
  return [
    Math.round(10 + 90 * glow + 30 * v),
    Math.round(14 + 60 * glow + 20 * u),
    Math.round(30 + 120 * glow),
  ];
}

export function pngDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

/** 生成一个真实文件，供 `setInputFiles` 使用（模拟系统文件选择器） */
export function writeFixture(name: string, buffer: Buffer): string {
  const dir = join('test-results', 'wallpaper-fixtures');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, buffer);
  return file;
}

export const DEFAULT_WALLPAPER = {
  image: '',
  focusX: 50,
  focusY: 50,
  blur: 10,
  strength: 60,
};

/** 每个用例结束后把背景恢复成「无背景」，避免污染真实配置 */
export async function resetWallpaper(request: APIRequestContext): Promise<void> {
  await request.put('/api/config', { data: { wallpaper: DEFAULT_WALLPAPER } });
}

export async function readWallpaper(
  request: APIRequestContext,
): Promise<typeof DEFAULT_WALLPAPER> {
  const response = await request.get('/api/config');
  const config = (await response.json()) as { wallpaper: typeof DEFAULT_WALLPAPER };
  return config.wallpaper;
}
