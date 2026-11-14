import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * 探针「停靠区行高」：回合日志的标题 / 思考 / 工具行，以及它下面 todo、subagent、
 * 后台那几块的行，量出来必须一样高（`--chat-log-row-height`）。
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
      {
        find: '@mica-config-ui/web',
        replacement: resolve(root, 'packages/mica-config-ui/web/index.tsx')
      }
    ]
  },
  server: { port: 5237, fs: { allow: [root] } }
})
