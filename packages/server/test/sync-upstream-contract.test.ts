import { MockAgent } from 'undici';
import { beforeEach, describe, expect, it } from 'vitest';
import { BangumiClient } from '../src/bangumi/client.js';
import { all, run } from '../src/db/index.js';
import { getSeriesDetail, listSeries } from '../src/db/query.js';
import { FakeBangumiClient, makeCollectionItem, makeSubject, resetDatabase, runSync } from './helpers.js';

describe('上游响应 → DB → 实体身份跨层边界', () => {
  beforeEach(() => resetDatabase());

  it.each([{}, [{ id: 2, relation: '续集' }, { id: 'invalid', relation: '续集' }]])('异常关系响应保留原始关系和 Series 身份：%j', async (payload) => {
    const fake = new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 }), makeCollectionItem({ subject_id: 2 })], subjects: {
      1: makeSubject({ id: 1, name: '关系契约系列', name_cn: '关系契约系列' }),
      2: makeSubject({ id: 2, name: '关系契约系列 第二季', name_cn: '关系契约系列 第二季' }),
    }, relations: {
      1: [{ id: 2, type: 2, name: 'two', name_cn: '', relation: '续集' }],
      2: [{ id: 1, type: 2, name: 'one', name_cn: '', relation: '前传' }],
    } });
    await runSync(fake, { depth: 2 });
    const key = listSeries({ includeSingletons: true })[0]!.key;
    const relations = all('SELECT * FROM subject_relations ORDER BY rowid');
    expect(getSeriesDetail(key)?.memberCount).toBe(2);
    run('UPDATE subjects SET relations_synced_at = NULL');
    const agent = new MockAgent();
    agent.disableNetConnect();
    const client = new BangumiClient({ token: '', userAgent: 'audit-fixture', requestIntervalMs: 0, httpProxy: '', dispatcher: agent });
    for (const id of [1, 2]) agent.get('https://api.bgm.tv').intercept({ path: `/v0/subjects/${id}/subjects`, method: 'GET' }).reply(200, payload);
    fake.getSubjectRelations = client.getSubjectRelations.bind(client);
    try {
      const status = await runSync(fake, { mode: 'enrich', depth: 2 });
      expect(status.lastRun?.counters.relationsFetched).toBe(0);
      expect(all('SELECT * FROM subject_relations ORDER BY rowid')).toEqual(relations);
      expect(getSeriesDetail(key)?.memberCount).toBe(2);
      expect(listSeries({ includeSingletons: true }).map((series) => series.key)).toEqual([key]);
      expect(all('SELECT relations_state FROM subjects ORDER BY id')).toEqual([{ relations_state: 'failed' }, { relations_state: 'failed' }]);
    } finally { await agent.close(); }
  });
});
