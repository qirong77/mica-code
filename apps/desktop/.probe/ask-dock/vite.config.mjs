import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * 探针「提问卡片」：`ask` 插件抛出的那张卡是**高优先级**的东西——它卡着这一轮，
 * 要在一屏里最先被看见。这里用正式 `AskDock` 摆出几种形态与几套主题对照。
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
      },
      {
        find: '@mica-config-ui/plugin-icons',
        replacement: resolve(root, 'packages/mica-config-ui/web/pluginIcons.tsx')
      },
      // `AskDock` 住在 `ChatView.jsx` 里，而它（间接）会 import 插件的桌面入口：
      // `@plugins` 与 `@renderer` 两个别名不给全，vite 的 import-glob 会直接 500。
      { find: '@plugins', replacement: resolve(root, 'plugins') },
      { find: '@renderer', replacement: resolve(root, 'apps/desktop/src/renderer/src') }
    ]
  },
  server: { port: 5238, fs: { allow: [root] } }
})
