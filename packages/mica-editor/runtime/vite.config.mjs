import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cdnImports, cdnStyles } from './cdn.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const bare = (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !id.startsWith('data:') && !id.startsWith('vite/')

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  plugins: [{
    name: 'notebook:cdn-dependencies',
    enforce: 'pre',
    resolveId(id) {
      return id === 'virtual:mica-arco-theme.css' ? '\0mica-arco-theme.css' : null
    },
    load(id) {
      if (id !== '\0mica-arco-theme.css') return null
      // 主题与控件皮肤只有一份：第三方 CSS 已由 CDN提供，仅复用宿主适配层。
      const file = fileURLToPath(new URL('../../../packages/mica-config-ui/web/arco-settings.css', import.meta.url))
      this.addWatchFile(file)
      return readFileSync(file, 'utf8').replace(/^@import[^;]*;\s*$/gm, '')
    },
    transform(code, id) {
      if (id.endsWith('/mica-config-ui/web/arco-settings.css')) {
        // The isolated runtime already loads the pinned Arco stylesheet from
        // its import map page; shared controls keep only the host adaptation.
        return code.replace(/^@import[^;]*;\s*$/gm, '')
      }
      if (id.endsWith('/workspace/notebook.css')) {
        const file = fileURLToPath(new URL('../../../packages/mica-config-ui/web/arco-settings.css', import.meta.url))
        this.addWatchFile(file)
        return code.replace(/@import\s+['"]virtual:mica-arco-theme\.css['"];?/, readFileSync(file, 'utf8').replace(/^@import[^;]*;\s*$/gm, ''))
      }
      if (!/\.[jt]sx?$/.test(id)) return null
      // 外部 CSS 由 HTML 固定版本链接加载；不让 Vite 将字体和第三方控件混进插件产物。
      return code
        .replace(/^import\s*['"]([^'"]+\.css)['"];?\s*$/gm, (line, specifier) => bare(specifier) && !specifier.startsWith('virtual:') ? '' : line)
        // Shared controls use deep imports in the desktop bundle. Here they
        // must use the same CDN module as the existing editor controls.
        .replace(/import\s+(\w+)\s+from\s+['"]@arco-design\/web-react\/es\/(\w+)['"]/g,
          (_line, local, component) => `import {${component} as ${local}} from '@arco-design/web-react'`)
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const imports = JSON.stringify({ imports: cdnImports })
        return html.replace('<!-- CDN_IMPORTS -->', `<script type="importmap">${imports}</script>\n${cdnStyles.map((href) => `<link rel="stylesheet" href="${href}" crossorigin="anonymous">`).join('\n')}`)
      }
    }
  }],
  define: {
    'import.meta.env.DEV': 'false',
    'process.env.EXCALIDRAW_ASSET_PATH': JSON.stringify('https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/'),
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  esbuild: { jsx: 'automatic', jsxDev: false },
  mode: 'production',
  build: {
    modulePreload: { polyfill: false },
    target: 'es2022',
    reportCompressedSize: false,
    assetsInlineLimit: 0,
    rollupOptions: { external: (id) => bare(id) && !id.endsWith('.css') }
  }
})
