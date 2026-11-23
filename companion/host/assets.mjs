import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { normalPath, sha256 } from '../runtime/package-check.mjs';

const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.woff':'font/woff','.woff2':'font/woff2' };
const extension = name => name.slice(name.lastIndexOf('.')).toLowerCase();
export const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export async function snapshotUi(source, target) {
  await normalPath(source); await mkdir(target);
  const inventory = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name), rel = relative(source, file);
      if (entry.isSymbolicLink() || rel.startsWith('..') || entry.name.includes(':')) throw new Error('UI_INVALID');
      if (entry.isDirectory()) await walk(file);
      else {
        await normalPath(file, false);
        if (!mime[extension(file)] || inventory.length > 1000) throw new Error('UI_INVALID');
        const bytes = await readFile(file); if (bytes.length > 16 * 1024 * 1024) throw new Error('UI_INVALID');
        const out = join(target, rel); await mkdir(dirname(out), { recursive: true }); await writeFile(out, bytes, { flag: 'wx' });
        inventory.push({ path: rel.split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await walk(source);
  for (const item of inventory) if (await sha256(join(source, item.path)) !== item.sha256) throw new Error('UI_CHANGED_DURING_SNAPSHOT');
  if (!inventory.some(e => e.path === 'index.html')) throw new Error('UI_INVALID');
  return inventory;
}
export function assetPath(url, root) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'companion:' || parsed.hostname !== 'ui' || parsed.username || parsed.password || parsed.port) return null;
    const name = decodeURIComponent(parsed.pathname);
    if (!/^\/[A-Za-z0-9_./-]+$/.test(name) || name.split('/').some(p => p === '..' || p === '.')) return null;
    const file = resolve(root, '.' + name);
    if (!file.startsWith(resolve(root) + sep) || !mime[extension(file)]) return null;
    return { file, contentType: mime[extension(file)] };
  } catch { return null; }
}
export async function serveAsset(request, root) {
  const safe = assetPath(request.url, root);
  if (!safe || request.method !== 'GET') return new Response('Denied', { status: 403 });
  try {
    await normalPath(safe.file, false);
    return new Response(await readFile(safe.file), { headers: { 'Content-Type': safe.contentType, 'Content-Security-Policy': CSP,
      'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store', 'Cross-Origin-Resource-Policy':'same-origin' } });
  } catch { return new Response('Not found', { status: 404 }); }
}
