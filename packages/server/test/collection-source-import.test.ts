import { beforeEach, expect, it } from 'vitest';
import { applyImport, previewImport } from '../src/data/import.js';
import { buildExportPayload } from '../src/data/export.js';
import { subjectFromExportRow } from '../src/data/mappers.js';
import { all, dataVersion, one, run } from '../src/db/index.js';
import { getSubjectDetail, listSubjects } from '../src/db/query.js';
import { resetDatabase } from './helpers.js';

const payload = (subjects: Record<string, unknown>[], collections: Record<string, unknown>[] = []) => ({
  format: 'bangumi-analyzer-export', version: 1, subjects, collections,
});
const source = (id: number, count: unknown, known: unknown = 1) => ({
  id, name: 'source fixture', collection_total: count, collection_total_known: known,
});
beforeEach(() => resetDatabase());

it('AUD-089：原始新行反例不能将空白已知人数制造为确定零，预览与执行一致', () => {
  const input = payload([source(901, ' \t ')], [{ subject_id: 901, type: 2 }]);
  const version = dataVersion();
  const preview = previewImport(input);
  expect(dataVersion()).toBe(version);
  const result = applyImport(input);
  expect(one('SELECT collection_total,collection_total_known FROM subjects WHERE id=901')).toBeUndefined();
  expect(getSubjectDetail(901)).toBeNull();
  expect(listSubjects({}).items.find((row) => row.id === 901)).toBeUndefined();
  expect(preview).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: 2 });
  expect(result).toMatchObject({ newSubjects: 0, newCollections: 0, skipped: preview.skipped });
  expect(buildExportPayload().subjects.some((row) => row.id === 901)).toBe(false);
});

it('AUD-089：原始更新反例不能覆盖可信400，JSON导出再导入仍保留来源', () => {
  applyImport(payload([source(902, 400)], [{ subject_id: 902, type: 2 }]));
  const before = one('SELECT * FROM subjects WHERE id=902');
  const input = payload([source(902, '\n\t')]);
  const preview = previewImport(input); const result = applyImport(input);
  expect(getSubjectDetail(902)?.collectionTotal).toBe(400);
  expect(one('SELECT * FROM subjects WHERE id=902')).toEqual(before);
  expect(listSubjects({}).items.find((row) => row.id === 902)?.collectionTotal).toBe(400);
  expect(preview).toMatchObject({ updatedSubjects: 0, skipped: 1 });
  expect(result).toMatchObject({ updatedSubjects: 0, skipped: 1 });
  const exported = JSON.parse(JSON.stringify(buildExportPayload()));
  resetDatabase(); applyImport(exported);
  expect(getSubjectDetail(902)?.collectionTotal).toBe(400);
  expect(one('SELECT collection_total,collection_total_known FROM subjects WHERE id=902'))
    .toEqual({ collection_total: 400, collection_total_known: 1 });
});

it('已知来源联合资格：缺失/所有空白/非法人数均拒绝，不能更新可信行', () => {
  applyImport(payload([source(902, 400)], [{ subject_id: 902, type: 2 }]));
  const before = one('SELECT * FROM subjects WHERE id=902');
  for (const value of [undefined, null, '', ' ', '\t', '\r\n', '\u00a0', '\u2003', [], {}, true, false,
    NaN, Infinity, -Infinity, 'NaN', 'Infinity', '1e999', -1, '-1', 0.5, '0.5', Number.MAX_SAFE_INTEGER + 1, '9007199254740992']) {
    const row = source(902, value);
    expect(subjectFromExportRow(row), `count=${String(value)}`).toBeNull();
    expect(previewImport(payload([row])).updatedSubjects).toBe(0);
    applyImport(payload([row]));
    expect(one('SELECT * FROM subjects WHERE id=902')).toEqual(before);
  }
});

it('合法零/非零/兼容数字字符串保留来源声明；明确零能合法覆盖400', () => {
  applyImport(payload([source(902, 400)], [{ subject_id: 902, type: 2 }]));
  for (const value of [0, '0', ' \t0\n ', 400, '400', ' 400 ', Number.MAX_SAFE_INTEGER]) {
    applyImport(payload([source(902, value)]));
    expect(getSubjectDetail(902)?.collectionTotal).toBe(Number(value));
    expect(one('SELECT collection_total_known FROM subjects WHERE id=902')).toEqual({ collection_total_known: 1 });
  }
});

it('known0与旧NULL/缺失保持各自兼容，缺失更新不能取消可信事实，非法枚举仍拒绝', () => {
  for (const [id, known, count, expected] of [[1, 0, ' \t ', null], [2, null, ' \t ', 0],
    [3, undefined, undefined, 0], [4, 0, 0, null], [5, null, '400', 400]] as const) {
    applyImport(payload([{ ...source(id, count), collection_total_known: known }], [{ subject_id: id, type: 2 }]));
    expect(getSubjectDetail(id)?.collectionTotal).toBe(expected);
  }
  const exported = JSON.parse(JSON.stringify(buildExportPayload())); resetDatabase(); applyImport(exported);
  expect(all('SELECT id,collection_total_known FROM subjects ORDER BY id')).toEqual([
    { id: 1, collection_total_known: 0 }, { id: 2, collection_total_known: null },
    { id: 3, collection_total_known: null }, { id: 4, collection_total_known: 0 }, { id: 5, collection_total_known: null },
  ]);
  applyImport(payload([source(902, 400)], [{ subject_id: 902, type: 2 }]));
  for (const known of [0, null, undefined]) {
    const row = { id: 902, collection_total_known: known, collection_total: ' \t ' };
    applyImport(payload([row])); expect(getSubjectDetail(902)?.collectionTotal).toBe(400);
  }
  for (const known of [-1, 2, true, '1', 0.5, {}]) expect(subjectFromExportRow(source(902, 400, known))).toBeNull();
});

it('合法来源更新在版本提交失败时全事务回滚，去除故障后可重试', () => {
  applyImport(payload([source(902, 400)], [{ subject_id: 902, type: 2 }]));
  const before = one('SELECT * FROM subjects WHERE id=902'); const version = dataVersion();
  run(`CREATE TRIGGER source_import_version_failure BEFORE INSERT ON meta WHEN NEW.key='data_version'
    BEGIN SELECT RAISE(ABORT,'source import version fault'); END`);
  try {
    expect(() => applyImport(payload([source(902, 0)]))).toThrow('source import version fault');
    expect(one('SELECT * FROM subjects WHERE id=902')).toEqual(before); expect(dataVersion()).toBe(version);
  } finally { run('DROP TRIGGER source_import_version_failure'); }
  applyImport(payload([source(902, 0)])); expect(getSubjectDetail(902)?.collectionTotal).toBe(0);
});

it('原始收藏数组不接受额外known1声明为可信来源，空白人数未知且不覆盖400', () => {
  const raw = (id: number) => ({ subject_id: id, subject_type: 2, type: 2,
    subject: { id, type: 2, name: 'slim source', collection_total: ' \t ', collection_total_known: 1 } });
  applyImport([raw(903)]);
  expect(getSubjectDetail(903)?.collectionTotal).toBeNull();
  expect(one('SELECT collection_total_known FROM subjects WHERE id=903')).toEqual({ collection_total_known: 0 });
  expect(JSON.parse(one<{ raw: string }>('SELECT raw FROM collections WHERE subject_id=903')!.raw)).toEqual(raw(903));
  applyImport(payload([source(902, 400)], [{ subject_id: 902, type: 2 }]));
  applyImport([raw(902)]);
  expect(getSubjectDetail(902)?.collectionTotal).toBe(400);
  expect(one('SELECT collection_total_known FROM subjects WHERE id=902')).toEqual({ collection_total_known: 1 });
});
