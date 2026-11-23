/**
 * Renders companion/brand/companion-icon.svg into crisp multi-resolution PNGs
 * and builds a standard Win32 hybrid ICO (32-bit BMP for 16..128px, PNG for 256px)
 * compatible with csc.exe /win32icon, System.Drawing.Icon, Explorer, and Electron.
 */
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const require = createRequire(path.join(REPO, 'package.json'));
const { _electron } = require('@playwright/test');
const ELECTRON_EXE = path.join(REPO, 'companion/host/node_modules/electron/dist/electron.exe');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SVG_PATH = path.join(REPO, 'companion/brand/companion-icon.svg');

function rgbaToBmpDib(rgba, w, h) {
  const xorSize = w * h * 4;
  const maskStride = Math.ceil(w / 32) * 4;
  const andSize = maskStride * h;
  const buf = Buffer.alloc(40 + xorSize + andSize);
  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(w, 4);
  buf.writeInt32LE(h * 2, 8); // color + AND mask height
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16); // BI_RGB
  buf.writeUInt32LE(xorSize + andSize, 20);
  // Bottom-up BGRA pixel rows
  let pos = 40;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      buf[pos++] = rgba[si + 2]; // B
      buf[pos++] = rgba[si + 1]; // G
      buf[pos++] = rgba[si];     // R
      buf[pos++] = rgba[si + 3]; // A
    }
  }
  // AND mask (1 bit per pixel, 1 where alpha == 0)
  const andOffset = 40 + xorSize;
  for (let y = h - 1; y >= 0; y--) {
    const rowOff = andOffset + (h - 1 - y) * maskStride;
    for (let x = 0; x < w; x++) {
      const a = rgba[(y * w + x) * 4 + 3];
      if (a < 16) {
        buf[rowOff + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
  }
  return buf;
}

function buildIco(entries) {
  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes each)
  const headerSize = 6 + entries.length * 16;
  let offset = headerSize;
  const dirBuf = Buffer.alloc(headerSize);
  dirBuf.writeUInt16LE(0, 0); // reserved
  dirBuf.writeUInt16LE(1, 2); // type 1 = ICO
  dirBuf.writeUInt16LE(entries.length, 4);

  const payloads = [];
  entries.forEach((ent, i) => {
    const rec = 6 + i * 16;
    dirBuf[rec] = ent.size >= 256 ? 0 : ent.size;
    dirBuf[rec + 1] = ent.size >= 256 ? 0 : ent.size;
    dirBuf[rec + 2] = 0;
    dirBuf[rec + 3] = 0;
    dirBuf.writeUInt16LE(1, rec + 4);
    dirBuf.writeUInt16LE(32, rec + 6);
    dirBuf.writeUInt32LE(ent.data.length, rec + 8);
    dirBuf.writeUInt32LE(offset, rec + 12);
    offset += ent.data.length;
    payloads.push(ent.data);
  });
  return Buffer.concat([dirBuf, ...payloads]);
}

async function main() {
  const svgText = await readFile(SVG_PATH, 'utf8');
  const svgB64 = Buffer.from(svgText, 'utf8').toString('base64');
  const dataUri = `data:image/svg+xml;base64,${svgB64}`;

  const previewDir = path.join(REPO, 'companion/brand/preview');
  await mkdir(previewDir, { recursive: true });
  await mkdir(path.join(REPO, 'companion/host/assets'), { recursive: true });
  await mkdir(path.join(REPO, 'companion/installer'), { recursive: true });
  await mkdir(path.join(REPO, 'companion/ui/src/assets/brand'), { recursive: true });

  const tmpEntry = path.join(tmpdir(), `companion-icon-render-${process.pid}.cjs`);
  await writeFile(
    tmpEntry,
    'const { app, BrowserWindow } = require("electron"); app.whenReady().then(() => { const w = new BrowserWindow({ show: false, width: 512, height: 512, webPreferences: { offscreen: false } }); void w.loadURL("about:blank"); });',
    'utf8',
  );
  const app = await _electron.launch({
    executablePath: ELECTRON_EXE,
    args: [tmpEntry],
  });
  try {
    const page = await app.firstWindow();
    const entries = [];
    let png256 = null;

    for (const size of SIZES) {
      const res = await page.evaluate(async ({ uri, size }) => {
        const img = new Image();
        img.src = uri;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size, size);
        const rgba = Array.from(ctx.getImageData(0, 0, size, size).data);
        const pngB64 = c.toDataURL('image/png').split(',')[1];
        return { rgba, pngB64 };
      }, { uri: dataUri, size });

      const pngBuf = Buffer.from(res.pngB64, 'base64');
      await writeFile(path.join(previewDir, `icon-${size}.png`), pngBuf);
      if (size === 256) png256 = pngBuf;
      entries.push({
        size,
        data: size === 256 ? pngBuf : rgbaToBmpDib(Uint8Array.from(res.rgba), size, size),
      });
    }

    const icoBuf = buildIco(entries);
    const installerIco = path.join(REPO, 'companion/installer/companion-icon.ico');
    const hostIco = path.join(REPO, 'companion/host/assets/companion-icon.ico');
    const hostPng = path.join(REPO, 'companion/host/assets/companion-icon-256.png');
    await writeFile(installerIco, icoBuf);
    await writeFile(hostIco, icoBuf);
    await writeFile(hostPng, png256);
    await copyFile(SVG_PATH, path.join(REPO, 'companion/ui/src/assets/brand/companion-icon.svg'));
    await copyFile(SVG_PATH, path.join(REPO, 'companion/host/assets/companion-icon.svg'));
    console.log(`Built multi-size ICO (${icoBuf.length} bytes, sizes: ${SIZES.join(',')}) & PNG previews.`);
  } finally {
    await app.close().catch(() => {});
    await rm(tmpEntry, { force: true }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
