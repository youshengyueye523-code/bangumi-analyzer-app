import { beforeEach, expect, it, vi } from 'vitest';
import { all, dataVersion, getMeta } from '../src/db/index.js';
import { enrichDetails, enrichRelations, enrichPersons } from '../src/sync/enrich.js';
import { ProgressTracker } from '../src/sync/progress.js';
import { SyncEngine } from '../src/sync/engine.js';
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase, runSync, testConfig } from './helpers.js';

beforeEach(async () => {
  resetDatabase();
  await runSync(new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 })], subjects: { 1: makeSubject({ id: 1 }) } }), { depth: 2 });
});

const stages = [
  { name: '详情', method: 'getSubject', enrich: enrichDetails, response: makeSubject({ id: 1, name: 'late changed title' }) },
  { name: '关系', method: 'getSubjectRelations', enrich: enrichRelations, response: [{ id: 99, type: 2, name: 'late relation', relation: '续集' }] },
  { name: '人员', method: 'getSubjectPersons', enrich: enrichPersons, response: [{ id: 99, name: 'late director', relation: '导演', type: 1 }] },
] as const;

for (const stage of stages) {
  it.each(['success', 'failure'] as const)(`${stage.name}在取消后返回%s：不写来源、状态、重试计数或派生标记`, async (outcome) => {
    const client = new FakeBangumiClient(); const controller = new AbortController();
    let resolve!: (value: unknown) => void; let reject!: (error: Error) => void;
    const pending = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    vi.spyOn(client, stage.method).mockImplementation(() => pending as never);
    const snapshot = () => ({ subjects: all('SELECT * FROM subjects'), relations: all('SELECT * FROM subject_relations'),
      staff: all('SELECT * FROM subject_staff'), jobs: all('SELECT * FROM translation_jobs'), version: dataVersion(), projection: getMeta('sync_projection_pending') });
    const before = snapshot();
    const task = stage.enrich([1], { client, signal: controller.signal, progress: new ProgressTracker(1, 'enrich', 2, () => {}) });
    controller.abort(); if (outcome === 'success') resolve(stage.response); else reject(new Error('late network error'));
    expect(await task).toMatchObject({ synced: 0, failed: 0, cancelled: true });
    expect(snapshot()).toEqual(before);
  });
}

it('应用阶段通知同步取消时，已获取的暂存收藏不进入正式来源', async () => {
  const version = dataVersion();
  const client = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 99 })] });
  const engine = new SyncEngine({ client, getConfig: () => testConfig(), onChange: (progress) => {
    if (progress.phase === 'applying') engine.cancel();
  } });
  engine.start({ mode: 'incremental', depth: 1 }); await engine.whenIdle();
  expect(all('SELECT subject_id FROM collections')).toEqual([{ subject_id: 1 }]);
  expect(dataVersion()).toBe(version); expect(engine.getStatus().lastRun?.status).toBe('cancelled');
});
