import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { paths } from '../src/config.js';
import { closeDatabase, dataVersion, getDatabase, getMeta, one, run } from '../src/db/index.js';
import { ensureSeriesEngine } from '../src/db/series.js';
import { getSeriesDetail, listSeries } from '../src/db/query.js';
import { assertIsolatedTestDatabase, FakeBangumiClient, makeCollectionItem, resetDatabase, runSync } from './helpers.js';

function exitAfterWrite(commit: boolean): void {
  assertIsolatedTestDatabase();
  closeDatabase();
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
    db.exec("INSERT INTO subjects(id,name,name_cn,created_at,updated_at) VALUES(990090,'interrupted fixture','interrupted fixture','2026-01-01','2026-01-01')");
    db.exec("INSERT INTO collections(subject_id,type,rate,first_seen_at,synced_at) VALUES(990090,2,9,'2026-01-01','2026-01-01')");
    db.exec("INSERT INTO meta(key,value) VALUES('sync_projection_pending','1') ON CONFLICT(key) DO UPDATE SET value='1'");
    ${commit ? 'db.exec("COMMIT");' : ''}
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, paths.dbFile], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  getDatabase();
}

describe('隔离进程退出与派生恢复', () => {
  beforeEach(() => resetDatabase());

  it('进程在未提交事务中退出：原始、收藏、恢复标记均回滚', async () => {
    await runSync(new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 })] }));
    const version = dataVersion();
    exitAfterWrite(false);
    expect(one('SELECT id FROM subjects WHERE id = 990090')).toBeUndefined();
    expect(one('SELECT subject_id FROM collections WHERE subject_id = 990090')).toBeUndefined();
    expect(getMeta('sync_projection_pending')).toBe('0');
    expect(dataVersion()).toBe(version);
    expect(ensureSeriesEngine()).toBe(false);
    expect(getDatabase().prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('进程在来源提交后退出：启动恢复重建新 Series 并推进版本，第二次启动不重复恢复', async () => {
    await runSync(new FakeBangumiClient({ collections: [makeCollectionItem({ subject_id: 1 })] }));
    const version = dataVersion();
    exitAfterWrite(true);
    expect(getMeta('sync_projection_pending')).toBe('1');
    expect(ensureSeriesEngine()).toBe(true);
    const restored = listSeries({ includeSingletons: true }).find((entry) => entry.title === 'interrupted fixture');
    expect(restored).toBeTruthy();
    expect(getSeriesDetail(restored!.key)?.members.map((member) => member.subjectId)).toEqual([990090]);
    expect(dataVersion()).toBe(version + 1);
    expect(getMeta('sync_projection_pending')).toBe('0');
    expect(ensureSeriesEngine()).toBe(false);
    expect(dataVersion()).toBe(version + 1);
  });

  it('恢复重建失败时保留待恢复标记，不提交一半的派生或版本', () => {
    exitAfterWrite(true);
    const version = dataVersion();
    run(`CREATE TRIGGER audit_recovery_failure BEFORE INSERT ON series_entities BEGIN SELECT RAISE(ABORT, 'fixture recovery failure'); END`);
    try {
      expect(() => ensureSeriesEngine()).toThrow('fixture recovery failure');
      expect(getMeta('sync_projection_pending')).toBe('1');
      expect(dataVersion()).toBe(version);
      expect(one('SELECT key FROM series_entities')).toBeUndefined();
      expect(one('SELECT id FROM subjects WHERE id = 990090')).toBeTruthy();
    } finally { run('DROP TRIGGER audit_recovery_failure'); }
    expect(ensureSeriesEngine()).toBe(true);
  });
});
