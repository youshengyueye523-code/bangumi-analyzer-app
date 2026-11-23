import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { assertIsolatedServer, isolatedDataDir } from './test-isolation.js';

test('AUD-089：HTTP预览/执行拒绝已知空白人数，页面及JSON往返保留可信来源', async ({ page, request }) => {
  const projectRoot = resolve(import.meta.dirname, '..');
  const directory = isolatedDataDir(process.env.E2E_DATA_DIR, projectRoot);
  const health = await (await request.get('/api/health')).json();
  assertIsolatedServer(health, directory, projectRoot); expect(health.collections).toBe(0);
  const envelope = (subjects: Record<string, unknown>[], collections: Record<string, unknown>[] = []) => ({
    format: 'bangumi-analyzer-export', version: 1, subjects, collections,
  });
  expect((await request.put('/api/config', { data: { hideNsfw: false, onboardingSeen: true } })).ok()).toBe(true);
  const badNew = envelope([{ id: 901, name: '虚构零人数', collection_total: ' \t ', collection_total_known: 1 }], [{ subject_id: 901, type: 2 }]);
  expect(await (await request.post('/api/data/import?dryRun=true', { data: badNew })).json()).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: 2 });
  expect(await (await request.post('/api/data/import', { data: badNew })).json()).toMatchObject({ applied: true, newSubjects: 0, skipped: 2 });
  expect((await request.get('/api/subjects/901')).status()).toBe(404);
  const trusted = { id: 902, name: '可信人数作品', eps: 12, score: 7, collection_total: 400, collection_total_known: 1 };
  expect((await request.post('/api/data/import', { data: envelope([trusted], [{ subject_id: 902, type: 2, rate: 8 }]) })).ok()).toBe(true);
  const badUpdate = envelope([{ id: 902, name: '不能覆盖', collection_total: '\n\t', collection_total_known: 1 }]);
  expect(await (await request.post('/api/data/import?dryRun=1', { data: badUpdate })).json()).toMatchObject({ updatedSubjects: 0, skipped: 1 });
  expect(await (await request.post('/api/data/import', { data: badUpdate })).json()).toMatchObject({ updatedSubjects: 0, skipped: 1 });
  expect(await (await request.get('/api/subjects/902')).json()).toMatchObject({ name: trusted.name, collectionTotal: 400 });
  expect((await (await request.get('/api/subjects')).json()).items[0]).toMatchObject({ id: 902, collectionTotal: 400 });
  const exported = await (await request.get('/api/data/export/json')).json();
  expect(exported.subjects.find((row: { id: number }) => row.id === 902)).toMatchObject({ collection_total: 400, collection_total_known: 1 });
  expect(exported.subjects.some((row: { id: number }) => row.id === 901)).toBe(false);
  expect((await request.post('/api/data/import', { data: exported })).ok()).toBe(true);
  expect(await (await request.get('/api/subjects/902')).json()).toMatchObject({ collectionTotal: 400 });
  expect(await (await request.get('/api/stats/overview')).json()).toMatchObject({ watchedEpisodes: 12, averageBgmScore: 7 });
  expect((await request.get('/api/data/integrity')).ok()).toBe(true);
  expect(await (await request.get('/api/data/integrity')).json()).toMatchObject({ ok: true });
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/subjects/902'); await expect(page.getByText('400', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('400', { exact: true })).toBeVisible();
  expect((await request.post('/api/data/import', { data: envelope([{ ...trusted, collection_total: ' \t0\n ' }]) })).ok()).toBe(true);
  expect(await (await request.get('/api/subjects/902')).json()).toMatchObject({ collectionTotal: 0 });
  expect((await request.post('/api/data/import', { data: envelope([{ id: 904, name: '未知来源作品', collection_total: ' ', collection_total_known: 0 }], [{ subject_id: 904, type: 1 }]) })).ok()).toBe(true);
  expect(await (await request.get('/api/subjects/904')).json()).toMatchObject({ collectionTotal: null });
  await page.goto('/subjects/904'); await expect(page.getByText('人数未知', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
