import { request, type FullConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { assertIsolatedServer, isolatedDataDir } from './test-isolation.js';

export default async function setup(config: FullConfig): Promise<void> {
  const projectRoot = resolve(import.meta.dirname, '..');
  const dataDirectory = isolatedDataDir(process.env.E2E_DATA_DIR, projectRoot);
  const client = await request.newContext({ baseURL: config.projects[0]?.use.baseURL });
  try {
    const response = await client.get('/api/health');
    if (!response.ok()) throw new Error('[e2e-isolation] 无法确认服务的实际隔离目标。');
    assertIsolatedServer(await response.json(), dataDirectory, projectRoot);
  } finally {
    await client.dispose();
  }
}
