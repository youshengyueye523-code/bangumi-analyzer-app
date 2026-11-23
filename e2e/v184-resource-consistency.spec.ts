import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertIsolatedServer, isolatedDataDir } from './test-isolation.js';

test('可变封面重新读取、背景上传交接与异常详情计数跨层一致', async ({ page, request }) => {
  const root = resolve(import.meta.dirname, '..');
  const directory = isolatedDataDir(process.env.E2E_DATA_DIR, root);
  const health = await (await request.get('/api/health')).json();
  assertIsolatedServer(health, directory, root);
  expect(health.collections).toBe(0);
  const id = 950001;
  expect((await request.post('/api/data/import', { data: { format: 'bangumi-analyzer-export', version: 1,
    subjects: [{ id, name: '资源一致性夹具', eps: 12, format: 'TV' }],
    collections: [{ subject_id: id, type: 2, rate: 8 }],
  } })).ok()).toBe(true);
  expect((await request.put('/api/config', { data: { onboardingSeen: true } })).ok()).toBe(true);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/settings?tab=appearance');
  const images = await page.evaluate(() => ['red', 'blue'].map((color) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return canvas.toDataURL('image/png');
  }));
  const file = resolve(directory, 'covers', `${id}.png`);
  writeFileSync(file, Buffer.from(images[0]!.split(',')[1]!, 'base64'));
  const db = new DatabaseSync(health.dbPath);
  try {
    db.prepare("UPDATE subjects SET cover_path=?, cover_cached_at='2026-10-10', rating_dist='null', collection_stats='null' WHERE id=?").run(`${id}.png`, id);
  } finally { db.close(); }
  const readCover = () => page.evaluate(async (subjectId) => {
    const response = await fetch(`/api/covers/${subjectId}`);
    return { cache: response.headers.get('cache-control'), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  }, id);
  const first = await readCover();
  expect(first.cache).toBe('no-cache');
  writeFileSync(file, Buffer.from(images[1]!.split(',')[1]!, 'base64'));
  const second = await readCover();
  expect(second.bytes).toEqual(Array.from(Buffer.from(images[1]!.split(',')[1]!, 'base64')));
  expect(second.bytes).not.toEqual(first.bytes);
  const uploaded = [];
  for (const dataUrl of images) {
    const result = await request.post('/api/wallpaper', { data: { dataUrl } });
    expect(result.ok()).toBe(true);
    uploaded.push((await result.json()).image);
  }
  for (const image of uploaded) {
    expect((await request.put('/api/config', { data: { wallpaper: { image } } })).ok()).toBe(true);
    expect((await request.get(`/api/wallpaper/${image}`)).ok()).toBe(true);
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-wallpaper', 'on');
  const detail = await (await request.get(`/api/subjects/${id}`)).json();
  expect(detail.ratingDistribution).toEqual({});
  expect(detail.collectionBreakdown).toEqual({});
  await page.goto(`/subjects/${id}`);
  await expect(page.getByRole('heading', { name: '资源一致性夹具', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
