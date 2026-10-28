import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

/**
 * 临时探针：把会话设置弹窗的真实组件单独跑起来看版式。
 * 用完即删，不进入交付。
 */
export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@mica-config-ui/web': resolve(import.meta.dirname, 'config-ui-shim.tsx'),
      '@packages': resolve(import.meta.dirname, '../../..', 'packages'),
    },
  },
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
})
