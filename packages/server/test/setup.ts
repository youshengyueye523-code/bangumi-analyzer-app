import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * 每个测试文件使用独立的临时数据目录，避免污染真实的 data 目录，
 * 同时保证文件之间互不影响（vitest 默认按文件隔离模块状态）。
 */
const testDataDir = mkdtempSync(join(tmpdir(), 'bangumi-analyzer-test-'));
process.env.BANGUMI_DATA_DIR = testDataDir;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

afterAll(async () => {
  const { closeDatabase } = await import('../src/db/index.js');
  closeDatabase();
  rmSync(testDataDir, { recursive: true, force: true });
});
