import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * 探针「停靠区」：几组写死的数据，用真组件（`ChatView.jsx` 导出的那几块停靠区）
 * 摆出运行中 / 展开 / 中断 / 完成四种场面，同时量出每行高度与收起箭头的轨道位置。
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
      // `ChatView.jsx` 会经由 `plugin-entries.js` 收录随包插件的桌面入口：那个 glob
      // 写的是 `@plugins/*/desktop.jsx`，别名缺了就解析不成绝对路径，整页 import 失败。
      { find: '@plugins', replacement: resolve(root, 'plugins') },
      {
        find: '@mica-config-ui/web',
        replacement: resolve(root, 'packages/mica-config-ui/web/index.tsx')
      }
    ]
  },
  server: { port: 5237, fs: { allow: [root] } }
})
