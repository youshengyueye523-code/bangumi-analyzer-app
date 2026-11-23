import { beforeEach, describe, expect, it } from 'vitest';
import { all, dataVersion, getMeta, one, run } from '../src/db/index.js';
import { applySeriesTitleOverride, ensureSeriesEngine, SERIES_ENGINE_VERSION } from '../src/db/series.js';
import { getDiagnosticsReport } from '../src/diagnostics/report.js';
import { FakeBangumiClient, makeCollectionItem, resetDatabase, runSync } from './helpers.js';

describe('Series 引擎版本升级兜底（r2 -> r3 标题契约自动同步）', () => {
  beforeEach(() => resetDatabase());

  it('旧库缺少 series_engine_version 时启动自动按新契约重算一次，并保护人工锁定标题与原始收藏', async () => {
    await runSync(
      new FakeBangumiClient({
        collections: [
          makeCollectionItem({
            subject_id: 70101,
            rate: 9,
            subject: { id: 70101, name: 'Violet Evergarden', name_cn: '紫罗兰永恒花园' },
          }),
          makeCollectionItem({
            subject_id: 70102,
            rate: 8,
            subject: { id: 70102, name: 'Bocchi the Rock!', name_cn: '孤独摇滚！' },
          }),
        ],
      }),
    );

    const lockedRow = one<{ key: string }>(
      `SELECT e.key FROM series_entities e
       JOIN series_entity_members m ON m.series_id = e.id
       WHERE m.subject_id = 70102 AND e.state <> 'stale'`,
    );
    expect(lockedRow).toBeTruthy();
    expect(applySeriesTitleOverride(lockedRow!.key, { mode: 'custom', title: '我的自定义摇滚标题' }).ok).toBe(true);

    // 模拟 r2 遗留派生状态：无 series_engine_version，且单成员系列仍为 r2 时期的 provisional
    run(`DELETE FROM meta WHERE key = 'series_engine_version'`);
    run(
      `UPDATE series_entities
          SET title_state = 'provisional'
        WHERE state <> 'stale' AND key <> :lockedKey`,
      { lockedKey: lockedRow!.key },
    );

    const beforeCollections = all('SELECT * FROM collections ORDER BY subject_id');
    const beforeVersion = dataVersion();

    expect(ensureSeriesEngine()).toBe(true);
    expect(Number(getMeta('series_engine_version'))).toBe(SERIES_ENGINE_VERSION);
    expect(dataVersion()).toBe(beforeVersion + 1);

    // r3 契约下非人工单成员应自动确定为 resolved，人工锁定保持 manual 与原自定义标题
    const autoRow = one<{ title: string; title_state: string }>(
      `SELECT e.title, e.title_state FROM series_entities e
       JOIN series_entity_members m ON m.series_id = e.id
       WHERE m.subject_id = 70101 AND e.state <> 'stale'`,
    );
    expect(autoRow).toEqual({ title: '紫罗兰永恒花园', title_state: 'resolved' });

    const manualAfter = one<{ title: string; title_state: string }>(
      `SELECT title, title_state FROM series_entities WHERE key = :key`,
      { key: lockedRow!.key },
    );
    expect(manualAfter).toEqual({ title: '我的自定义摇滚标题', title_state: 'manual' });

    // 原始收藏数据不受影响
    expect(all('SELECT * FROM collections ORDER BY subject_id')).toEqual(beforeCollections);

    // 数据中枢与实表一致，不再显示旧的 provisional
    const diag = getDiagnosticsReport({ refresh: true });
    const titlesMod = diag.modules.find((m) => m.id === 'titles');
    expect(titlesMod?.details.some((line) => line.includes('暂定 / 未确认：0 个'))).toBe(true);

    // 幂等：再次启动不再重复重算或推进 data_version
    expect(ensureSeriesEngine()).toBe(false);
    expect(dataVersion()).toBe(beforeVersion + 1);
  });

  it('升级重算事务失败时原子回滚且不写入新引擎版本，下次启动可重试恢复', async () => {
    await runSync(
      new FakeBangumiClient({
        collections: [
          makeCollectionItem({
            subject_id: 70201,
            rate: 8,
            subject: { id: 70201, name: 'Frieren', name_cn: '葬送的芙莉莲' },
          }),
        ],
      }),
    );

    run(`DELETE FROM meta WHERE key = 'series_engine_version'`);
    run(`UPDATE series_entities SET title_state = 'provisional' WHERE state <> 'stale'`);
    const beforeVersion = dataVersion();

    run(
      `CREATE TRIGGER fail_engine_upgrade BEFORE UPDATE ON series_entities
       BEGIN SELECT RAISE(ABORT, 'simulated upgrade abort'); END`,
    );
    try {
      expect(() => ensureSeriesEngine()).toThrow('simulated upgrade abort');
      expect(getMeta('series_engine_version')).toBeNull();
      expect(dataVersion()).toBe(beforeVersion);
      expect(one<{ title_state: string }>(`SELECT title_state FROM series_entities WHERE state <> 'stale'`)?.title_state).toBe('provisional');
    } finally {
      run('DROP TRIGGER fail_engine_upgrade');
    }

    expect(ensureSeriesEngine()).toBe(true);
    expect(Number(getMeta('series_engine_version'))).toBe(SERIES_ENGINE_VERSION);
    expect(one<{ title_state: string }>(`SELECT title_state FROM series_entities WHERE state <> 'stale'`)?.title_state).toBe('resolved');
  });
});
