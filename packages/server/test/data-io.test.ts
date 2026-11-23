import { existsSync, readFileSync, copyFileSync, linkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBackup, listBackups, resolveBackupPath } from '../src/data/backup.js';
import { buildCsv, buildExportPayload } from '../src/data/export.js';
import { applyImport, previewImport } from '../src/data/import.js';
import { all, dataVersion, one, run, transaction } from '../src/db/index.js';
import { paths } from '../src/config.js';
import { applySeriesTitleOverride } from '../src/db/series.js';
import { getSeriesDetail, listSeries } from '../src/db/query.js';
import { listSubjects } from '../src/db/query.js';
import { buildProfileDataset } from '../src/stats/profile.js';
import { ApiError } from '@bangumi-analyzer/shared';
import { FakeBangumiClient, resetDatabase, runSync } from './helpers.js';
import { libraryCollectionItems, librarySubjects } from './fixtures.js';

describe('CSV 与旧 JSON 的只读兼容', () => {
  beforeEach(() => resetDatabase());
  it.each(['tag_names', 'studios', 'directors', 'user_tags'])('%s 的旧异常 JSON 不阻断导出、不伪造元数据', (column) => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 1, name: 'CSV旧字段', eps: 24, total_episodes: 32 }],
      collections: [{ subject_id: 1, type: 2, ep_status: 0 }] });
    const table = column === 'user_tags' ? 'collections' : 'subjects';
    const field = column === 'user_tags' ? 'tags' : column;
    const id = column === 'user_tags' ? 'subject_id' : 'id';
    for (const raw of ['not-json', '{}', 'null', '[null,123,"合法项"]']) {
      run(`UPDATE ${table} SET ${field}=:raw WHERE ${id}=1`, { raw });
      const source = one(`SELECT * FROM ${table} WHERE ${id}=1`);
      const version = dataVersion();
      const lines = buildCsv().trim().split('\r\n');
      const headers = lines[0]!.replace(/^\uFEFF/, '').split(',');
      const csvColumn = column === 'tag_names' ? 'tags' : column;
      expect(lines[1]!.split(',')[headers.indexOf(csvColumn)]).toBe(raw.startsWith('[') ? '合法项' : '');
      expect(one(`SELECT * FROM ${table} WHERE ${id}=1`)).toEqual(source);
      expect(dataVersion()).toBe(version);
    }
  });
});

async function seed(): Promise<void> {
  const client = new FakeBangumiClient({
    collections: libraryCollectionItems(),
    subjects: librarySubjects(),
  });
  await runSync(client, { depth: 2 });
}

function countCollections(): number {
  return Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM collections')?.n ?? 0);
}

describe('数据导入 / 导出 / 备份', () => {
  beforeEach(() => {
    resetDatabase();
  });

  it.each([
    ['score', true], ['score', [9]], ['score', 11], ['score', 'Infinity'],
    ['eps', -1], ['total_episodes', 2.5], ['volumes', {}], ['rank', -1],
    ['rating_total', 'NaN'], ['collection_total', -2], ['year', [2020]], ['month', 13],
    ['id', [1]], ['id', 9007199254740992], ['type', 5],
  ])('导出格式拒绝非法 subject 数值 %s=%j，不制造原始事实', (field, value) => {
    const payload = { format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 1, name: '非法数值', [field as string]: value }],
      collections: [{ subject_id: 1, type: 2 }] };
    const version = dataVersion();
    expect(previewImport(payload)).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: 2 });
    expect(dataVersion()).toBe(version);
    expect(applyImport(payload)).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: 2 });
    expect(one('SELECT id FROM subjects')).toBeUndefined();
    expect(one('SELECT subject_id FROM collections')).toBeUndefined();
  });

  it('旧数值字符串和合法零值保留；字段冲突不会被导入猜测修正', () => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: '1', type: '2', eps: '24', total_episodes: '32', score: '7.5', rank: '0',
        rating_total: '0', collection_total: '0', year: '2000', date: '2020-01-01', month: '0' }],
      collections: [{ subject_id: '1', type: '2', rate: '0', ep_status: '0' }] });
    expect(one('SELECT eps,total_episodes,score,rank,rating_total,collection_total,year,month FROM subjects WHERE id=1'))
      .toEqual({ eps: 24, total_episodes: 32, score: 7.5, rank: 0, rating_total: 0, collection_total: 0, year: 2000, month: 0 });
    expect(listSubjects({}).items[0]).toMatchObject({ totalEpisodes: 24, rate: 0, watchedEpisodes: 24, bgmScore: 7.5 });
  });

  it('旧 SQLite 64 位整数超出 JS 安全范围不阻断读取和备份导出，精确十进制文本保留来源', () => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 1, eps: 24 }], collections: [{ subject_id: 1, type: 3 }] });
    run('UPDATE collections SET ep_status=9007199254740993 WHERE subject_id=1');
    const version = dataVersion();
    expect(one('SELECT ep_status FROM collections WHERE subject_id=1')).toEqual({ ep_status: '9007199254740993' });
    expect(all('SELECT ep_status FROM collections')).toEqual([{ ep_status: '9007199254740993' }]);
    expect(buildExportPayload().collections[0]).toMatchObject({ ep_status: '9007199254740993' });
    expect(listSubjects({}).items[0]).toMatchObject({ epStatus: 0, watchedEpisodes: 0, progress: 0 });
    expect(dataVersion()).toBe(version);
    expect(one('SELECT CAST(ep_status AS TEXT) AS source FROM collections')).toEqual({ source: '9007199254740993' });
  });

  it.each([['1e999', 'Infinity'], ['-1e999', '-Infinity']])('旧 SQLite 非有限 REAL %s 导出显式文本，不能静默 JSON 序列化为缺失', (literal, expected) => {
    applyImport({ format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 1, eps: 24 }], collections: [{ subject_id: 1, type: 3 }] });
    run(`UPDATE collections SET ep_status=${literal} WHERE subject_id=1`);
    const version = dataVersion();
    expect(one('SELECT ep_status FROM collections')).toEqual({ ep_status: expected });
    const exported = JSON.parse(JSON.stringify(buildExportPayload()));
    expect(exported.collections[0].ep_status).toBe(expected);
    expect(listSubjects({}).items[0]).toMatchObject({ epStatus: 0, watchedEpisodes: 0, progress: 0 });
    expect(one('SELECT typeof(ep_status) AS storage FROM collections')).toEqual({ storage: 'real' });
    expect(dataVersion()).toBe(version);
  });

  it('导入重建和版本提交是单一事务；版本写入失败也回滚实体', () => {
    const version = dataVersion();
    run(`CREATE TRIGGER audit_version_failure BEFORE INSERT ON meta WHEN NEW.key = 'data_version'
         BEGIN SELECT RAISE(ABORT, 'injected mutation failure'); END`);
    try {
      expect(() => applyImport({ format: 'bangumi-analyzer-export', version: 1,
        subjects: [{ id: 990002, name: 'rollback fixture' }],
        collections: [{ subject_id: 990002, type: 2 }],
      })).toThrow('injected mutation failure');
      expect(countCollections()).toBe(0);
      expect(one('SELECT id FROM subjects')).toBeUndefined();
      expect(one('SELECT key FROM series_entities')).toBeUndefined();
      expect(one('SELECT id FROM entity_events')).toBeUndefined();
      expect(dataVersion()).toBe(version);
    } finally { run('DROP TRIGGER audit_version_failure'); }
  });

  it('嵌套事务：内部失败可独立回滚，外部失败撤销全部已释放的 savepoint', () => {
    transaction(() => {
      run("INSERT INTO meta(key,value) VALUES('outer','1')");
      expect(() => transaction(() => {
        run("INSERT INTO meta(key,value) VALUES('inner','1')");
        throw new Error('inner failure');
      })).toThrow('inner failure');
      expect(one("SELECT value FROM meta WHERE key='inner'")).toBeUndefined();
    });
    expect(one("SELECT value FROM meta WHERE key='outer'")).toEqual({ value: '1' });
    expect(() => transaction(() => {
      transaction(() => run("INSERT INTO meta(key,value) VALUES('released','1')"));
      throw new Error('outer failure');
    })).toThrow('outer failure');
    expect(one("SELECT value FROM meta WHERE key='released'")).toBeUndefined();
  });

  it('旧元数据 → 导入评分 → 人工身份保留；提交故障完整回滚源数据及投影', async () => {
    await seed();
    const entity = listSeries({ includeSingletons: true })[0]!;
    const subjectId = getSeriesDetail(entity.key)!.members.find((member) => member.collected)!.subjectId;
    expect(applySeriesTitleOverride(entity.key, { mode: 'custom', title: '组合回归人工名称' }).ok).toBe(true);
    run("UPDATE subjects SET tag_names='{}', studios='not-json', directors='[null,123]', originals='{}' WHERE id=:id", { id: subjectId });
    const sourceBefore = one('SELECT * FROM subjects WHERE id=:id', { id: subjectId });
    const version = dataVersion();
    const payload = { format: 'bangumi-analyzer-export', version: 1, subjects: [],
      collections: [{ subject_id: subjectId, subject_type: 2, type: 2, rate: 9 }] };
    expect(previewImport(payload).updatedCollections).toBe(1);
    expect(applyImport(payload).updatedCollections).toBe(1);
    expect(dataVersion()).toBeGreaterThan(version);
    expect(getSeriesDetail(entity.key)).toMatchObject({ key: entity.key, title: '组合回归人工名称', titleState: 'manual' });
    expect(one('SELECT rate FROM collections WHERE subject_id=:id', { id: subjectId })).toEqual({ rate: 9 });
    expect(one('SELECT * FROM subjects WHERE id=:id', { id: subjectId })).toEqual(sourceBefore);
    expect(buildProfileDataset('real').sample.total).toBe(countCollections());
    const tables = ['subjects', 'collections', 'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'entity_events', 'meta'];
    const before = tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`));
    run(`CREATE TRIGGER audit_cross_commit_failure BEFORE INSERT ON meta WHEN NEW.key='data_version'
         BEGIN SELECT RAISE(ABORT, 'cross-module commit failure'); END`);
    try {
      expect(() => applyImport({ ...payload, collections: [{ ...payload.collections[0]!, rate: 1 }] })).toThrow('cross-module commit failure');
      expect(tables.map((table) => all(`SELECT * FROM ${table} ORDER BY rowid`))).toEqual(before);
    } finally { run('DROP TRIGGER audit_cross_commit_failure'); }
  });

  it('导出 JSON 包含条目、收藏、人员与关系，且不包含任何凭据', async () => {
    await seed();
    const payload = buildExportPayload();

    expect(payload.format).toBe('bangumi-analyzer-export');
    expect(payload.counts.collections).toBe(10);
    expect(payload.counts.subjects).toBe(10);
    expect(payload.counts.staff).toBeGreaterThan(0);
    expect(JSON.stringify(payload)).not.toContain('token');
    expect(JSON.stringify(payload)).not.toContain('accessToken');
  });

  it('导出 CSV 包含 BOM、表头与全部行', async () => {
    await seed();
    const csv = buildCsv();
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(11);
    expect(lines[0]).toContain('name_cn');
    expect(csv).toContain('冰菓');
    expect(csv).toContain('https://bgm.tv/subject/2');
  });

  it('Excel CSV 将外部标题/评论作为文本，保留数值评分差而不输出公式', async () => {
    await seed();
    run("UPDATE subjects SET name = '=1+1', name_cn = '@SUM(1,1)', score = 9 WHERE id=1");
    run("UPDATE collections SET comment = '+1+1', rate = 7 WHERE subject_id=1");
    const csv = buildCsv();
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@SUM(1,1)");
    expect(csv).toContain("'+1+1");
    expect(csv).not.toContain("'-2");
  });

  it('导入超过上限时拒绝整个输入，不能静默截断后宣称成功', () => {
    const subjects = Array.from({ length: 200001 }, () => ({ id: 1, name: 'oversized fixture' }));
    expect(() => previewImport({ format: 'bangumi-analyzer-export', version: 1, subjects })).toThrowError(ApiError);
    expect(one('SELECT id FROM subjects')).toBeUndefined();
  });

  it('可以把导出的数据完整导入到空数据库', async () => {
    await seed();
    const payload = buildExportPayload();
    resetDatabase();
    expect(countCollections()).toBe(0);

    const preview = previewImport(payload);
    expect(preview.detectedFormat).toBe('bangumi-analyzer-export');
    expect(preview.newCollections).toBe(10);

    const result = applyImport(payload);
    expect(result.applied).toBe(true);
    expect(countCollections()).toBe(10);
    expect(listSubjects({ q: '冰菓' }).items[0]?.nameCn).toBe('冰菓');

    const staff = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM subject_staff WHERE name = '京都动画'",
    );
    expect(Number(staff?.n ?? 0)).toBeGreaterThan(0);
  });

  it('重复导入不会产生重复数据', async () => {
    await seed();
    const payload = buildExportPayload();
    applyImport(payload);
    applyImport(payload);

    expect(countCollections()).toBe(10);
    const subjects = one<{ n: number }>('SELECT COUNT(*) AS n FROM subjects');
    expect(Number(subjects?.n ?? 0)).toBe(10);
  });

  it('完整详情受到保护时，预览不能宣称该作品会被更新', async () => {
    await seed();
    const before = one('SELECT name, platform, infobox, updated_at FROM subjects WHERE id=1');
    const payload = { format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 1, name: 'older imported title', platform: 'older platform' }], collections: [] };
    expect(previewImport(payload)).toMatchObject({ updatedSubjects: 0, skipped: 1 });
    expect(applyImport(payload)).toMatchObject({ updatedSubjects: 0, skipped: 1 });
    expect(one('SELECT name, platform, infobox, updated_at FROM subjects WHERE id=1')).toEqual(before);
  });

  it.each([{ tags: {} }, { studios: [123] }, { tag_names: [null] }, { meta_tags: { broken: 1 } }])(
    '异常 JSON 字段不能导入后令实体或画像崩溃：%j', (fields) => {
      const payload = { format: 'bangumi-analyzer-export', version: 1,
        subjects: [{ id: 990003, name: 'invalid shape fixture', ...fields }], collections: [{ subject_id: 990003, type: 2 }] };
      expect(previewImport(payload)).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: 2 });
      expect(applyImport(payload).skipped).toBe(2);
      expect(() => buildProfileDataset()).not.toThrow();
      expect(countCollections()).toBe(0);
    },
  );

  it('导入预览与结果不把孤立收藏计为成功新增；重复 ID 按最终写入统计', () => {
    const orphan = { format: 'bangumi-analyzer-export', version: 1, subjects: [], collections: [{ subject_id: 999999, type: 2 }] };
    expect(previewImport(orphan)).toMatchObject({ newCollections: 0, skipped: 1 });
    expect(applyImport(orphan)).toMatchObject({ newCollections: 0, skipped: 1 });
    expect(countCollections()).toBe(0);
    const duplicate = { format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 1, name: 'first' }, { id: 1, name: 'last' }],
      collections: [{ subject_id: 1, type: 2, rate: 7 }, { subject_id: 1, type: 2, rate: 9 }],
    };
    expect(previewImport(duplicate)).toMatchObject({ newSubjects: 1, newCollections: 1 });
    expect(applyImport(duplicate)).toMatchObject({ newSubjects: 1, newCollections: 1 });
    expect(one('SELECT name FROM subjects WHERE id = 1')).toEqual({ name: 'last' });
    expect(one('SELECT rate FROM collections WHERE subject_id = 1')).toEqual({ rate: 9 });
  });

  it('支持导入 Bangumi 官方收藏接口返回的原始数组', async () => {
    const raw = libraryCollectionItems();
    const preview = previewImport(raw);
    expect(preview.detectedFormat).toBe('bangumi-collection-array');
    expect(preview.newCollections).toBe(10);

    applyImport(raw);
    expect(countCollections()).toBe(10);
    expect(listSubjects({ q: '虫师' }).items[0]?.id).toBe(8);
  });

  it.each([{ type: 0 }, { type: 'broken' }, { rate: 11 }, { rate: -1 }, { ep_status: -2 },
    { private: 'false' }, { tags: {} }, { subject_type: 0 }])('导出格式中的异常收藏不能绕过同步契约写入旧收藏：%j', async (invalid) => {
    await seed();
    const before = one('SELECT * FROM collections WHERE subject_id=1');
    const payload = { format: 'bangumi-analyzer-export', version: 1, subjects: [],
      collections: [{ subject_id: 1, type: 2, rate: 8, ...invalid }] };
    expect(previewImport(payload)).toMatchObject({ updatedCollections: 0, skipped: 1 });
    expect(applyImport(payload)).toMatchObject({ updatedCollections: 0, skipped: 1 });
    expect(one('SELECT * FROM collections WHERE subject_id=1')).toEqual(before);
  });

  it.each([false, true])('收藏类型须与实际写入目标作品一致，包括保护既有作品：%s', async (existing) => {
    if (existing) await seed();
    const before = one('SELECT * FROM collections WHERE subject_id=1');
    const payload = { format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 1, name: 'identity fixture', type: existing ? 6 : 2 }],
      collections: [{ subject_id: 1, subject_type: existing ? 6 : 4, type: 2, rate: 9 }] };
    expect(previewImport(payload)).toMatchObject({ newCollections: 0, updatedCollections: 0 });
    expect(applyImport(payload)).toMatchObject({ newCollections: 0, updatedCollections: 0 });
    expect(one('SELECT * FROM collections WHERE subject_id=1')).toEqual(before);
    expect(one('SELECT type FROM subjects WHERE id=1')).toEqual({ type: 2 });
  });

  it('合法非动画类型与 SQLite 布尔值的旧导出仍能预检、写入和重复导入', () => {
    const payload = { format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 990005, type: 6, name: 'game fixture', nsfw: 0, locked: 1,
        infobox: '[{"key":"开发","value":"fixture"}]', images: '{"large":null}', rating_dist: '{"8":3}' }],
      collections: [{ subject_id: 990005, subject_type: 6, type: 2, rate: 8, private: 1, tags: '["fixture"]' }] };
    expect(previewImport(payload)).toMatchObject({ newSubjects: 1, newCollections: 1, skipped: 0 });
    expect(applyImport(payload)).toMatchObject({ newSubjects: 1, newCollections: 1, skipped: 0 });
    expect(applyImport(payload)).toMatchObject({ updatedCollections: 1, skipped: 0 });
    expect(one('SELECT subject_type, type, rate, private FROM collections WHERE subject_id=990005'))
      .toEqual({ subject_type: 6, type: 2, rate: 8, private: 1 });
  });

  it.each([{ infobox: {} }, { infobox: [null] }, { images: [] }, { rating_dist: [] },
    { collection_stats: { collect: 'bad' } }, { nsfw: 'false' }])('详情结构/布尔字段不能接受错误类型：%j', (invalid) => {
    const payload = { format: 'bangumi-analyzer-export', version: 1,
      subjects: [{ id: 990004, name: 'typed field fixture', ...invalid }], collections: [{ subject_id: 990004, type: 2 }] };
    expect(previewImport(payload)).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: 2 });
    expect(applyImport(payload)).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: 2 });
    expect(one('SELECT id FROM subjects WHERE id=990004')).toBeUndefined();
  });

  it('导入无法识别的格式时给出明确错误', () => {
    expect(() => previewImport({ hello: 'world' })).toThrowError(ApiError);
    try {
      previewImport({ hello: 'world' });
    } catch (error) {
      expect((error as ApiError).hint).toContain('Bangumi');
    }
  });

  it('导入时跳过无效条目并给出统计', async () => {
    const raw = [...libraryCollectionItems(), { subject_id: 'bad' }, null];
    const preview = previewImport(raw);
    expect(preview.skipped).toBe(2);
    applyImport(raw);
    expect(countCollections()).toBe(10);
  });

  it('可以创建数据库备份并读取备份文件', async () => {
    await seed();
    expect(applySeriesTitleOverride(listSeries({ includeSingletons: true })[0]!.key, { mode: 'custom', title: 'backup manual title' }).ok).toBe(true);
    const tables = ['subjects', 'collections', 'subject_staff', 'subject_relations', 'series_entities', 'series_entity_members', 'franchise_entities', 'franchise_series', 'entity_events', 'candidate_decisions', 'meta'];
    const expected = Object.fromEntries(tables.map((table) => [table, all(`SELECT * FROM ${table} ORDER BY rowid`)]));
    const backup = createBackup();
    expect(backup.fileName).toMatch(/^bangumi-.*\.db$/);
    expect(backup.sizeBytes).toBeGreaterThan(0);

    const backups = listBackups();
    expect(backups.some((item) => item.fileName === backup.fileName)).toBe(true);

    const path = resolveBackupPath(backup.fileName);
    expect(existsSync(path)).toBe(true);
    // 备份是完整的 SQLite 文件
    const header = readFileSync(path).subarray(0, 15).toString('utf8');
    expect(header).toBe('SQLite format 3');
    // 在独立临时目录恢复副本，验证真实 SQL 内容、人工治理和账号归属，而非只验证文件头。
    const restoredPath = join(paths.dataDir, 'restored-fixture.db');
    copyFileSync(path, restoredPath);
    run('UPDATE collections SET rate = 1');
    const restored = new DatabaseSync(restoredPath);
    try {
      expect(restored.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      for (const table of tables) expect(restored.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(expected[table]);
      restored.exec('BEGIN; UPDATE collections SET rate = 2; ROLLBACK');
      expect(restored.prepare('SELECT * FROM collections ORDER BY rowid').all()).toEqual(expected.collections);
    } finally { restored.close(); }
  });

  it('拒绝路径穿越的备份文件名', () => {
    expect(() => resolveBackupPath('../../../etc/passwd')).toThrowError(ApiError);
    expect(() => resolveBackupPath('..\\..\\windows\\system32\\config')).toThrowError(ApiError);
  });

  it('备份路径不能借目录或硬链接读取备份目录外的文件', () => {
    const outside = join(paths.dataDir, 'outside-backup-fixture.txt');
    writeFileSync(outside, 'not a backup, fixture only');
    mkdirSync(paths.backupDir, { recursive: true });
    linkSync(outside, join(paths.backupDir, 'linked.db'));
    mkdirSync(join(paths.backupDir, 'directory.db'));
    expect(() => resolveBackupPath('linked.db')).toThrowError(ApiError);
    expect(() => resolveBackupPath('directory.db')).toThrowError(ApiError);
    expect(listBackups().map((item) => item.fileName)).not.toContain('linked.db');
    expect(listBackups().map((item) => item.fileName)).not.toContain('directory.db');
  });
});
