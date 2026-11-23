import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { assertIsolatedServer, isolatedDataDir } from './test-isolation.js';

test('导入、治理验证失败回滚、冻结异常证据、Repair 与损坏 Real 快照跨层一致', async ({ page, request }) => {
  const projectRoot = resolve(import.meta.dirname, '..');
  const directory = isolatedDataDir(process.env.E2E_DATA_DIR, projectRoot);
  const health = await (await request.get('/api/health')).json();
  assertIsolatedServer(health, directory, projectRoot);
  expect(health.collections).toBe(0);
  expect(health.subjects).toBe(0);
  // 只允许对已经核验的临时夹具注入旧数据；不打开应用的真实 data/。
  function fixtureSql(sql: string, ...params: (string | number)[]) {
    const db = new DatabaseSync(health.dbPath);
    try { db.prepare(sql).run(...params); } finally { db.close(); }
  }
  function governanceSnapshot() {
    const db = new DatabaseSync(health.dbPath);
    try {
      return ['subjects', 'collections', 'subject_relations', 'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'franchise_member_exclusions', 'entity_aliases', 'candidate_decisions', 'entity_events', 'meta']
        .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    } finally { db.close(); }
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ids = [940001, 940002];
  expect((await request.post('/api/data/import', { data: {
    format: 'bangumi-analyzer-export', version: 1,
    collections: ids.map((id) => ({ subject_id: id, type: 2, rate: 8 })),
    subjects: [
      ...ids.map((id) => ({ id, name: `组合夹具 ${id}`, format: 'TV', eps: 12, tag_names: ['科幻', '科幻'], studios: ['夹具公司', '夹具公司'] })),
      { kind: 'relation', subject_id: ids[0], related_id: ids[1], type: 2, relation: '不同演绎' },
      { kind: 'relation', subject_id: ids[1], related_id: ids[0], type: 2, relation: '不同演绎' },
    ],
  } })).ok()).toBe(true);
  expect((await request.put('/api/config', { data: { onboardingSeen: true } })).ok()).toBe(true);
  const key = (await (await request.get('/api/franchises')).json()).franchises[0].key;
  expect((await request.post(`/api/franchises/${key}/confirm`)).ok()).toBe(true);
  const named = await request.post(`/api/franchises/${key}/governance`, { data: { kind: 'adopt-franchise-title', title: '治理回滚前夹具' } });
  expect(named.ok()).toBe(true);
  expect((await named.json()).verification.verified).toBe(true);
  const version = (await (await request.get('/api/diagnostics?refresh=1')).json()).dataVersion;
  const stateBeforeFailure = governanceSnapshot();
  fixtureSql(`CREATE TRIGGER audit_verify_failure BEFORE UPDATE ON series_entities
    WHEN CAST((SELECT value FROM meta WHERE key='data_version') AS INTEGER) > ${version}
    BEGIN SELECT RAISE(ABORT, 'injected verification rebuild failure'); END`);
  try {
    const failed = await request.post(`/api/franchises/${key}/governance`, { data: { kind: 'adopt-franchise-title', title: '冻结组合夹具' } });
    expect(failed.status()).toBe(500);
    expect((await failed.json()).error.dataIntact).toBe(true);
    expect(governanceSnapshot()).toEqual(stateBeforeFailure);
  } finally { fixtureSql('DROP TRIGGER audit_verify_failure'); }
  await page.goto(`/franchises/${key}`);
  await expect(page.getByRole('heading', { name: '治理回滚前夹具', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '治理回滚前夹具', exact: true })).toBeVisible();
  const retried = await request.post(`/api/franchises/${key}/governance`, { data: { kind: 'adopt-franchise-title', title: '冻结组合夹具' } });
  expect(retried.ok()).toBe(true);
  expect((await retried.json()).verification.verified).toBe(true);
  expect((await (await request.get('/api/diagnostics?refresh=1')).json()).dataVersion).toBe(version + 1);
  await page.reload();
  await expect(page.getByRole('heading', { name: '冻结组合夹具', exact: true })).toBeVisible();
  fixtureSql('UPDATE franchise_entities SET title_candidates=?, average_rate=NULL WHERE key=?', '[null]', key);
  const before = await (await request.get('/api/diagnostics?refresh=1')).json();
  expect(before.issues.some((issue: { id: string }) => issue.id === 'titles.franchise-candidates-invalid')).toBe(true);
  await page.goto('/diagnostics');
  await expect(page.getByText('家族历史候选证据结构异常', { exact: true })).toBeVisible();
  await expect(page.getByText(/需要单独核对历史候选证据/)).toBeVisible();
  const driftCard = page.getByText('Franchise 派生数据与成员 Series 不一致', { exact: true }).locator('..').locator('..').locator('..');
  await driftCard.getByRole('button', { name: '重建 Franchise 派生数据', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '执行修复', exact: true }).click();
  await expect(page.getByRole('main').getByText('修复完成并已验证', { exact: true })).toBeVisible();
  const after = await (await request.get('/api/diagnostics?refresh=1')).json();
  expect(after.dataVersion).toBe(before.dataVersion + 1);
  expect(after.issues.some((issue: { id: string }) => issue.id === 'franchise.counter-drift')).toBe(false);
  expect(after.issues.some((issue: { id: string }) => issue.id === 'titles.franchise-candidates-invalid')).toBe(true);
  await page.reload();
  await expect(page.getByText('家族历史候选证据结构异常', { exact: true })).toBeVisible();
  await page.goto(`/franchises/${key}`);
  await expect(page.getByRole('heading', { name: '冻结组合夹具', exact: true })).toBeVisible();
  expect(await (await request.get(`/api/franchises/${key}`)).json()).toMatchObject({ title: '冻结组合夹具', state: 'confirmed', averageRate: 8, titleCandidates: [] });

  const first = await (await request.post('/api/profile/snapshots', { data: { stageLabel: '合法 Real 阶段' } })).json();
  const second = await (await request.post('/api/profile/snapshots', { data: { stageLabel: '异常 Real 阶段' } })).json();
  expect((await (await request.get('/api/profile/compare')).json()).available).toBe(true);
  fixtureSql('UPDATE profile_snapshots SET members=? WHERE id=?', 'null', second.snapshot.id);
  const comparison = await request.get(`/api/profile/compare?from=${first.snapshot.id}&to=${second.snapshot.id}`);
  expect(comparison.ok()).toBe(true);
  expect(await comparison.json()).toMatchObject({ available: false, comparison: null });
  await page.goto('/profile');
  await expect(page.getByText(/统计\/成员结构异常/)).toBeVisible();
  await expect(page.getByText('异常 Real 阶段', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(/统计\/成员结构异常/)).toBeVisible();
  await page.getByRole('button', { name: '删除快照 异常 Real 阶段' }).click();
  await expect(page.getByText('异常 Real 阶段', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/目前只有 1 个阶段快照/)).toBeVisible();
  expect(errors).toEqual([]);
});
