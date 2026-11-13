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
  server: { host: '127.0.0.1', port: 15973, strictPort: true, fs: { allow: [repo] } },
});
