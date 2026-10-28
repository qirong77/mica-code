import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

function micaTestRuntimePlugin(): Plugin {
  const bunBundleId = '\0mica-bun-bundle';

  return {
    name: 'mica-test-runtime',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'bun:bundle') return bunBundleId;
      return null;
    },
    load(id) {
      if (id === bunBundleId) {
        return 'export function feature() { return false; }\n';
      }

      const filePath = id.split('?')[0]!;
      if (filePath.endsWith('.md')) {
        return `export default ${JSON.stringify(readFileSync(filePath, 'utf-8'))};\n`;
      }

      return null;
    },
  };
}

/** Every test file the suite owns. Both projects below narrow this by `exclude`. */
const ALL_TESTS = [
  'packages/mica-builtin-commands/**/*.test.ts',
  'packages/mica-official-plugins/**/*.test.ts',
  'plugins/**/*.test.{ts,tsx}',
  'apps/**/*.test.{ts,tsx}',
  'packages/mica-*/**/*.test.ts',
  'packages/@anthropic/ink/**/*.test.ts',
];

/**
 * Tests that spawn real child processes (`mica app-server`, `mica exec`, PTY
 * helpers). They are the slow part of the suite — several hundred real process
 * boots — and they fight each other for CPU, so they get their own serial
 * project instead of sharing a pool with the in-process unit tests.
 *
 * Inside those files the individual tests are already `it.concurrent`
 * (`maxConcurrency` caps how many real children run at once), so the wall clock
 * of a flow file is a handful of boots rather than one boot per test.
 */
const PROCESS_TESTS = [
  'apps/**/*.flows.test.ts',
  'packages/mica-pty/**/*.test.ts',
  'packages/mica-builtin-commands/**/*.pty.test.ts',
  // 插件自己的 E2E 同样要真起 `dist/mica`，不能进并行的 unit 池。
  'plugins/**/*.pty.test.ts',
];

export default defineConfig({
  plugins: [micaTestRuntimePlugin()],
  resolve: {
    alias: {
      '@packages': fileURLToPath(new URL('./packages', import.meta.url)),
      '@apps': fileURLToPath(new URL('./apps', import.meta.url)),
      '@plugins': fileURLToPath(new URL('./plugins', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'temp/**'],
    // Vitest 默认 5s 是给纯内存单测留的预算，这套测试不是：unit 里有真实 git 仓库和
    // 文件 I/O，process 里的 PTY 用例自身就按 20s 等待。机器一忙（多个 worker + 开发者
    // 自己的进程）5s 就会随机打挂与代码无关的用例，所以显式给出预算而不是沿用默认值。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ALL_TESTS,
          exclude: ['**/node_modules/**', '**/dist/**', 'temp/**', ...PROCESS_TESTS],
          fileParallelism: true,
          // 8 核上 7 个 worker 会把「首个用例加载整个模块图」和 git 子进程压到 5s
          // 默认超时之外（实测 6 个 worker 有 7 个用例超时）。4 个 worker 是这台机器的
          // 拐点：再多人也不会更快，只是把时间换成偶发失败。
          maxWorkers: 4,
        },
      },
      {
        extends: true,
        test: {
          name: 'process',
          include: PROCESS_TESTS,
          exclude: ['**/node_modules/**', '**/dist/**', 'temp/**'],
          fileParallelism: false,
          // 4 个并发的真实 TUI 会把 /btw 的 mock 请求饿到 90s 预算之外（实测约 1/3 概率），
          // 3 个是这台机器上的稳定上限：再快的那 20s 会换成偶发失败。
          maxConcurrency: 3,
          // PTY 用例内部的 wait 预算就是 LONG_TIMEOUT = 20s，外层不能比它更小。
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
