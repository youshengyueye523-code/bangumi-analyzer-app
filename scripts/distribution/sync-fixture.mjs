// Acceptance-only harness. NOT included in the ZIP. Uses shipped modules unchanged.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const root = process.argv[2], resultFile = process.argv[3];
const moduleAt = path => import(pathToFileURL(join(root, 'packages/server/dist', path)));
const requests = [];
function subject(id) {
  return { id, type: 2, name: `Distribution fixture ${id}`, name_cn: `分发测试作品${id}`, summary: '仅供隔离验证的中文简介。', nsfw: false, date: '2026-01-01', platform: 'TV', eps: 12, total_episodes: 12, images: {}, infobox: [], tags: [{ name: '隔离验证', count: 1, total_count: 1 }], rating: { rank: 0, total: 1, score: 7, count: {} }, collection: { wish: 0, collect: 1, doing: 0, on_hold: 0, dropped: 0 } };
}
const rows = Array.from({ length: 51 }, (_, i) => ({ subject_id: i + 1, subject_type: 2, type: 2, rate: 8, ep_status: 12, vol_status: 0, comment: 'synthetic', private: false, updated_at: '2026-11-22T00:00:00Z', tags: ['隔离验证'], subject: subject(i + 1) }));
const upstream = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'); requests.push(url.pathname + url.search);
  let payload;
  if (url.pathname === '/v0/users/distribution-fixture') payload = { id: 987654321, username: 'distribution-fixture', nickname: 'Synthetic user', avatar: {} };
  else if (/\/users\/distribution-fixture\/collections$/.test(url.pathname)) {
    const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
    payload = { total: rows.length, offset, limit, data: rows.slice(offset, offset + limit) };
  } else if (/\/subjects\/\d+$/.test(url.pathname)) payload = subject(Number(url.pathname.split('/').at(-1)));
  else if (/\/subjects\/\d+\/(subjects|persons)$/.test(url.pathname)) payload = [];
  else { res.writeHead(404); res.end('{}'); return; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload));
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
let app, client, database;
try {
  const config = await moduleAt('config.js');
  assert.equal(config.paths.dataDir, join(root, 'data'));
  database = await moduleAt('db/index.js'); database.openDatabase();
  config.saveConfig({ username: 'distribution-fixture', nickname: '隔离新用户', cacheCovers: false, summaryAutoTranslate: false, requestIntervalMs: 0 });
  const { BangumiClient } = await moduleAt('bangumi/client.js');
  client = new BangumiClient({ token: '', userAgent: 'analyzer-distribution-fixture', requestIntervalMs: 0, httpProxy: '', baseUrl: `http://127.0.0.1:${upstream.address().port}`, maxRetries: 1 });
  const { SyncEngine } = await moduleAt('sync/engine.js');
  const engine = new SyncEngine({ client, getConfig: config.loadConfig });
  const { CoverCache } = await moduleAt('images/coverCache.js');
  const { buildApp } = await moduleAt('app.js');
  app = await buildApp({ deps: { client, engine, coverCache: new CoverCache(client) }, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, method = 'GET', body) {
    const res = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const payload = await res.json(); assert.ok(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(payload).slice(0,300)}`); return payload;
  }
  await api('/api/sync', 'POST', { mode: 'full', depth: 2 }); await engine.whenIdle();
  assert.equal(engine.getStatus().lastRun.status, 'success', JSON.stringify({ status: engine.getStatus(), requests }));
  assert.equal(database.countRows('collections'), 51);
  assert.ok(requests.some(p => /offset=50/.test(p)), 'must fetch page 2');
  assert.equal((await api('/api/profile/local')).steps.find(x => x.id === 'sync').done, true);
  assert.equal((await api('/api/subjects?q=' + encodeURIComponent('分发测试作品51'))).total, 1);
  const series = (await api('/api/series?includeSingletons=1')).series;
  assert.ok(series.length >= 2);
  const command = { action: 'create', title: '隔离人工家族', series: series.slice(0, 2).map(x => x.key) };
  const preview = await api('/api/manual-franchises/preview', 'POST', command);
  const family = await api('/api/manual-franchises', 'POST', { command, token: preview.token });
  assert.equal(family.ok, true);
  await api('/api/franchises/' + encodeURIComponent(family.key));
  assert.equal((await api('/api/subjects/1/user-hide', 'PUT')).changed, true);
  const hidden = await fetch(base + '/api/subjects/1'); assert.equal(hidden.status, 404);
  assert.equal(database.one('SELECT nsfw FROM subjects WHERE id=1').nsfw, 0);
  const hiddenList = await (await fetch(base + '/api/settings/user-hidden-subjects', { headers: { 'x-analyzer-private-intent': 'hidden-works' } })).json();
  const restored = await fetch(base + '/api/settings/user-hidden-subjects/' + hiddenList.items[0].handle, { method: 'DELETE', headers: { 'x-analyzer-private-intent': 'hidden-works' } });
  assert.equal(restored.status, 200);
  await api('/api/subjects/1');
  const exportData = await api('/api/data/export/json'); assert.equal(exportData.collections.length, 51);
  const importPreview = await api('/api/data/import?dryRun=true', 'POST', exportData); assert.ok(importPreview);
  await api('/api/data/import', 'POST', exportData); assert.equal(database.countRows('collections'), 51);
  const backup = (await api('/api/data/backups', 'POST', {})).backup; assert.ok(backup);
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(join(root, 'data/backups', backup.fileName), { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM collections').get().n, 51); copy.close();
  for (const path of ['/api/stats/overview', '/api/stats/timeline', '/api/profile/dataset', '/api/diagnostics?refresh=1']) await api(path);
  assert.equal(database.integrityCheck(), 'ok');
  assert.deepEqual(database.all('PRAGMA foreign_key_check'), []);
  writeFileSync(resultFile, JSON.stringify({ ok: true, synthetic: true, realExternalServices: false, collections: 51, upstreamRequests: requests, assertions: ['actual shipped BangumiClient via loopback HTTP', 'full sync pagination', 'deep enrichment', 'onboarding sync success', 'search page-2 item', 'manual franchise preview and write', 'hide and restore without NSFW mutation', 'export and import', 'backup SQLite contents', 'stats/profile/diagnostics', 'integrity and foreign keys'] }, null, 2));
} finally {
  if (app) await app.close();
  else if (client) await client.close?.();
  database?.closeDatabase();
  await new Promise(r => upstream.close(r));
}
