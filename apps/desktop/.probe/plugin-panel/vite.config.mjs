import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * 探针「插件面板弹窗」：用真实的 ModalShell / SplitView / PluginPanelSection 画
 * SSH 面板（清单 `desktop.panel.display: "modal"`），看分栏宽度、表格列与留白。
 * 运行方式见 ../README.md。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@mica-config-ui/web', replacement: `${root}/packages/mica-config-ui/web/index.tsx` },
      { find: '@mica-config-ui/plugin-icons', replacement: `${root}/packages/mica-config-ui/web/pluginIcons.tsx` },
      // 渲染层的模块会 `import.meta.glob('@plugins/*/desktop.jsx')` 找插件入口：
      // 少了这条别名，整块面板根本 import 不进来。
      { find: '@plugins', replacement: `${root}/plugins` },
      { find: '@renderer', replacement: `${root}/apps/desktop/src/renderer/src` },
      { find: '@packages', replacement: `${root}/packages` },
      { find: /^(apps|plugins)\//, replacement: `${root}/$1/` }
    ]
  },
  server: { port: 5239, fs: { allow: [root] } }
})
