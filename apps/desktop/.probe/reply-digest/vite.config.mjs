import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * 探针「长回复摘要」：把 reply-digest 插件的产物（一张 digest notice 卡）
 * 放进真实对话区样式里看版式，判定用插件自己的 digest.ts。
 * 运行方式见 ../README.md。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: [{ find: /^(apps|plugins)\//, replacement: `${root}/$1/` }] },
  server: { port: 5232, fs: { allow: [root] } }
})
