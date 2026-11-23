import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * 仓库根目录的 Vitest 入口（v1.7.0 RC 测试隔离加固）。
 *
 * 背景：过去从仓库根目录直接执行 `vitest run packages/server/test/...` 时，
 * 不会加载 packages/server/vitest.config.ts，setup 不会运行，测试会落到真实
 * data 目录（曾导致一次真实数据库被清空的事故）。
 *
 * 这里把三个包声明为独立 project：无论从哪里执行 vitest，都会加载各自的配置与
 * setup —— server 的 setup 会把 BANGUMI_DATA_DIR 指向本次运行专属的临时目录，
 * web 仍然使用 jsdom，因此错误命令也不会再触碰真实 Local 数据。
 */
export default defineConfig({
  test: {
    projects: ['packages/shared', 'packages/server', 'packages/web'].map((directory) =>
      resolve(import.meta.dirname, directory),
    ),
  },
});
