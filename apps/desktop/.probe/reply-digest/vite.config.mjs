import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * 探针「长回复摘要」：把 reply-digest 插件的产物（一张 digest notice 卡）
 * 放进真实对话区样式里看版式，判定用插件自己的 digest.ts。
 * 运行方式见 ../README.md。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^(apps|plugins)\//, replacement: `${root}/$1/` },
      { find: '@packages', replacement: resolve(root, 'packages') },
      { find: '@mica-config-ui/web', replacement: resolve(root, 'packages/mica-config-ui/web/index.tsx') }
    ]
  },
  server: { port: 5232, fs: { allow: [root] } }
})
