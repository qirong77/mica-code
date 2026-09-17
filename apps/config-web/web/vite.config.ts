import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    // 页面组件与数据层来自 packages/mica-config-ui，桌面端用同一份源码（见 apps/desktop）
    alias: { '@packages': resolve(root, '../../../packages') },
  },
  server: {
    host: '127.0.0.1',
  },
  build: {
    sourcemap: false,
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      external: ['@monaco-editor/react', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    },
  },
});
