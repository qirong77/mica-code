import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../../../..');

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  cacheDir: resolve(repo, 'temp/capabilities-vite-cache'),
  resolve: {
    alias: { '@packages': resolve(repo, 'packages') },
    dedupe: ['react', 'react-dom'],
  },
  // 端口可覆盖：桌面端自己的配置页也常占着附近的端口，撞上就 strictPort 直接起不来。
  server: {
    host: '127.0.0.1',
    port: Number(process.env.MICA_PROBE_PORT ?? 16073),
    strictPort: true,
    fs: { allow: [repo] },
  },
});
