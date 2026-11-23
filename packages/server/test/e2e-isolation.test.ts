import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertIsolatedServer, isolatedDataDir } from '../../../e2e/test-isolation.js';

const directory = mkdtempSync(join(tmpdir(), 'bangumi-e2e-guard-'));
const root = join(directory, 'project');
const production = join(root, 'data');
const fixture = join(directory, 'fixture');
mkdirSync(production, { recursive: true });
mkdirSync(fixture);
writeFileSync(join(fixture, 'bangumi.db'), 'isolated fixture');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('E2E 隔离入口（仅临时目录，health 为模拟输入）', () => {
  it('缺失配置、真实 data、子目录/祖先、临时根均拒绝', () => {
    mkdirSync(join(production, 'child'));
    for (const path of [undefined, '', production, root, join(production, 'child'), tmpdir()]) {
      expect(() => isolatedDataDir(path, root)).toThrow('[e2e-isolation]');
    }
  });

  it('显式独立临时目录允许，服务实际目录/DB 必须一致', () => {
    const expected = isolatedDataDir(fixture, root);
    expect(() => assertIsolatedServer({ ok: true, dataDir: fixture, dbPath: join(fixture, 'bangumi.db'), syncRunning: false }, expected, root)).not.toThrow();
    for (const health of [
      { ok: true, dataDir: production, dbPath: join(production, 'bangumi.db') },
      { ok: true, dataDir: fixture, dbPath: join(fixture, 'other.db') },
      { ok: true, dataDir: fixture, dbPath: join(fixture, 'bangumi.db'), syncRunning: true },
      { ok: false },
    ]) {
      expect(() => assertIsolatedServer(health, expected, root)).toThrow();
    }
  });

  it('临时夹具中指向其他资产的 hardlink 在服务启动之前拒绝', () => {
    const linked = join(directory, 'linked');
    mkdirSync(linked);
    writeFileSync(join(production, 'bangumi.db'), 'protected fixture');
    linkSync(join(production, 'bangumi.db'), join(linked, 'bangumi.db'));
    expect(() => isolatedDataDir(linked, root)).toThrow(/hardlink/);
  });
});
