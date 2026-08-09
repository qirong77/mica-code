import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@packages': resolve(root, '../../../packages'),
    },
  },
  server: {
    host: '127.0.0.1',
  },
  build: {
    sourcemap: false,
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
  },
});
