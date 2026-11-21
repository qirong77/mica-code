import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * 探针「剪贴板浮窗」：把 mica-maccy 的启动器单独跑起来，按清单里的 760×560 看版式。
 * 运行方式见 ../README.md。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@mica-config-ui/web', replacement: `${root}/packages/mica-config-ui/web/index.tsx` },
      { find: '@packages', replacement: `${root}/packages` },
      { find: /^(apps|plugins)\//, replacement: `${root}/$1/` }
    ]
  },
  server: { port: 5240, fs: { allow: [root] } }
})
