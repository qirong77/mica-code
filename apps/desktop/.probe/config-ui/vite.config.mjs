import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

/**
 * 探针「会话设置弹窗」：把真实组件单独跑起来看版式。运行方式见 ../README.md。
 */
export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@mica-config-ui/web': resolve(import.meta.dirname, 'config-ui-shim.tsx'),
      '@packages': resolve(import.meta.dirname, '../../../..', 'packages'),
    },
  },
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
})
