import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

test('真实client来源反例产物经导入/API/页面/Real快照保留身份、人数与NSFW', async ({ page, request }) => {
  const fixture = mkdtempSync(join(tmpdir(), 'bangumi-round14-browser-source-'));
  const moduleUrl = (name: string) => JSON.stringify(new URL(`../packages/server/dist/${name}.js`, import.meta.url).href);
  const script = `
    import { createRequire } from 'node:module';
    import { applyImport } from ${moduleUrl('data/import')};
    import { buildExportPayload } from ${moduleUrl('data/export')};
    import { BangumiClient } from ${moduleUrl('bangumi/client')};
    import { enrichDetails } from ${moduleUrl('sync/enrich')};
    import { ProgressTracker } from ${moduleUrl('sync/progress')};
    import { closeDatabase } from ${moduleUrl('db/index')};
    const require = createRequire(${JSON.stringify(new URL('../packages/server/package.json', import.meta.url).href)});
    const { MockAgent } = require('undici');
    const zero = { wish: 0, collect: 0, doing: 0, on_hold: 0, dropped: 0 };
    const detail = { id: 137, type: 2, name: '可信来源作品', eps: 12, nsfw: true, collection: { ...zero, collect: 400 }, rating: { score: 7, total: 10, rank: 20, count: { '7': 10 } } };
    applyImport({ format: 'bangumi-analyzer-export', version: 1, subjects: [{ id: 137, name: detail.name, eps: 12, score: 7, collection_total: 400, nsfw: 1, raw: detail }], collections: [{ subject_id: 137, type: 2, rate: 9, ep_status: 0 }] });
    const agent = new MockAgent(); agent.disableNetConnect(); const pool = agent.get('https://api.bgm.tv');
    const client = new BangumiClient({ token: '', userAgent: 'round14-browser-fixture', requestIntervalMs: 0, httpProxy: '', dispatcher: agent });
    const missingCounts = { ...detail }; delete missingCounts.collection;
    const missingNsfw = { ...detail, future_evidence: { retained: true } }; delete missingNsfw.nsfw;
    const outcomes = [];
    try {
      for (const body of [{ ...detail, id: 421, name: '错误身份作品', eps: 24, rating: { ...detail.rating, score: 10 } }, missingCounts, missingNsfw]) {
        pool.intercept({ path: '/v0/subjects/137', method: 'GET' }).reply(200, body);
        outcomes.push(await enrichDetails([137], { client, signal: new AbortController().signal, progress: new ProgressTracker(0, 'enrich', 1, () => {}) }));
      }
      applyImport([{ subject_id: 421, subject_type: 2, type: 1,
        subject: { id: 421, type: 2, name: '人数来源未知' } }]);
      console.log(JSON.stringify({ payload: buildExportPayload(), outcomes }));
    } finally { await agent.close(); closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, BANGUMI_DATA_DIR: fixture, BANGUMI_ACCESS_TOKEN: '', BANGUMI_USERNAME: '', AI_API_KEY: '', AI_ENABLED: 'false' }, encoding: 'utf8', timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    const generated = JSON.parse(result.stdout);
    expect(generated.outcomes.map((value: { synced: number }) => value.synced)).toEqual([0, 0, 1]);
    expect((await request.post('/api/data/import', { data: generated.payload })).ok()).toBe(true);
    expect((await request.put('/api/config', { data: { hideNsfw: true, onboardingSeen: true } })).ok()).toBe(true);
    expect((await request.get('/api/subjects/137')).status()).toBe(404);
    expect((await (await request.get('/api/subjects')).json()).total).toBe(1);
    expect((await request.put('/api/config', { data: { hideNsfw: false } })).ok()).toBe(true);
    const detail = await (await request.get('/api/subjects/137')).json();
    expect(detail).toMatchObject({ id: 137, name: '可信来源作品', totalEpisodes: 12, bgmScore: 7, collectionTotal: 400, nsfw: true, rawSubject: { id: 137, future_evidence: { retained: true } } });
    expect(Object.hasOwn(detail.rawSubject, 'nsfw')).toBe(false);
    expect(await (await request.get('/api/stats/overview')).json()).toMatchObject({ watchedEpisodes: 12, averageBgmScore: 7 });
    const snapshot = await request.post('/api/profile/snapshots', { data: { stageLabel: '来源安全修复' } }); expect(snapshot.status()).toBe(201);
    const exported = await (await request.get('/api/data/export/json')).json();
    expect(exported.subjects.find((row: { id: number }) => row.id === 137)).toMatchObject({ nsfw: 1, collection_total: 400 });
    expect(exported.subjects.find((row: { id: number }) => row.id === 421)).toMatchObject({ collection_total_known: 0 });
    expect(await (await request.get('/api/subjects/421')).json()).toMatchObject({ collectionTotal: null });
    expect(await (await request.get('/api/data/export/csv')).text()).not.toContain('错误身份作品');
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/subjects/137'); await expect(page.getByRole('heading', { name: '可信来源作品', exact: true })).toBeVisible();
    await expect(page.getByText('12/12', { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByText('12/12', { exact: true })).toBeVisible();
    await page.goto('/subjects/421'); await expect(page.getByText('人数未知', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    const actual = resolve(fixture);
    if (!actual.startsWith(resolve(tmpdir()) + sep) || !basename(actual).startsWith('bangumi-round14-browser-source-')) throw new Error('fixture cleanup ownership mismatch');
    rmSync(actual, { recursive: true, force: true });
  }
});
