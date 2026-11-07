import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * 探针「全局搜索」：把 global-search 插件的启动器单独跑起来看输入框与结果列表。
 * 运行方式见 ../README.md。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: [{ find: /^(apps|plugins)\//, replacement: `${root}/$1/` }] },
  server: { port: 5231, fs: { allow: [root] } }
})
