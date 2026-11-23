import { defineConfig, devices } from '@playwright/test';
import { isolatedDataDir } from './e2e/test-isolation.js';

const PORT = Number(process.env.E2E_PORT ?? 18787);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
// 不允许测试启动/复用真实 Local；夹具由调用方创建，保留与清理由调用方负责。
const DATA_DIR = isolatedDataDir(process.env.E2E_DATA_DIR, import.meta.dirname);

/**
 * 端到端测试：直接跑生产模式（Fastify 托管已构建的前端），
 * 这样验证的就是用户真实使用的访问路径。
 *
 * 前置条件：pnpm build（前端已构建）+ 数据目录中已有同步后的数据。
 */
export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      testIgnore: /responsive\.spec\.ts/,
    },
    {
      name: 'narrow',
      use: { ...devices['Desktop Chrome'], viewport: { width: 900, height: 900 } },
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm start`,
        url: `${BASE_URL}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          BANGUMI_DATA_DIR: DATA_DIR,
          PORT: String(PORT),
          HOST: '127.0.0.1',
          LOG_LEVEL: 'warn',
        },
      },
});
