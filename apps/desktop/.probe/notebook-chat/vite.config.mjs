import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const configuredTarget = process.env.MICA_PROBE_RUNTIME_TARGET?.trim()
let runtimeTarget = ''
if (configuredTarget) {
  const url = new URL(configuredTarget)
  // This probe must never fall back to the user's running desktop / default port.
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    ['8787', '5240'].includes(url.port) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'MICA_PROBE_RUNTIME_TARGET must be an explicit isolated http://127.0.0.1:<port> (not 8787 or 5240)'
    )
  runtimeTarget = url.origin
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  define: { __NOTEBOOK_PROBE_RUNTIME_TARGET__: JSON.stringify(runtimeTarget) },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@mica-config-ui/web', replacement: `${root}/packages/mica-config-ui/web/index.tsx` },
      {
        find: '@mica-config-ui/plugin-icons',
        replacement: `${root}/packages/mica-config-ui/web/pluginIcons.tsx`
      },
      { find: '@packages', replacement: `${root}/packages` },
      { find: /^(apps|plugins)\//, replacement: `${root}/$1/` },
      { find: '@plugins', replacement: `${root}/plugins` },
      { find: '@renderer', replacement: `${root}/apps/desktop/src/renderer/src` }
    ]
  },
  server: {
    host: '127.0.0.1',
    port: 5240,
    strictPort: true,
    fs: { allow: [root] },
    // Keep transport.js unchanged: relative /api requests and SSE stay same-origin.
    ...(runtimeTarget
      ? {
          proxy: {
            '/api': { target: runtimeTarget, changeOrigin: true },
            '/editor': { target: runtimeTarget, changeOrigin: true }
          }
        }
      : {})
  }
})
