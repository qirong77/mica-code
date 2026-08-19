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

export default defineConfig({
  plugins: [micaTestRuntimePlugin()],
  resolve: {
    alias: {
      '@packages': fileURLToPath(new URL('./packages', import.meta.url)),
      '@apps': fileURLToPath(new URL('./apps', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    fileParallelism: false,
    setupFiles: ['./test/setup.ts'],
    include: [
      'packages/mica-builtin-commands/**/*.test.ts',
      'apps/**/*.test.{ts,tsx}',
      'packages/mica-*/**/*.test.ts',
      'packages/@anthropic/ink/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'temp/**'],
  },
});
