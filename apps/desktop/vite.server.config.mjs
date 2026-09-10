import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * HTTP 服务端构建：把 src/server 入口连同 src/main 下的业务模块打成一个 Node ESM 包，
 * 并把 `electron` 别名到纯 Node 替身（src/server/electron-shim.js），
 * 这样同一批主进程模块既能跑在 Electron 里，也能跑在 `node out/server/index.mjs` 里。
 *
 * node-pty 是原生模块，必须保持 external。
 */
const external = [...builtinModules, ...builtinModules.map((name) => `node:${name}`), 'node-pty']

export default defineConfig({
  resolve: {
    alias: [{ find: /^electron$/, replacement: resolve('src/server/electron-shim.js') }]
  },
  build: {
    ssr: resolve('src/server/index.js'),
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external,
      output: { entryFileNames: 'index.mjs', format: 'es' }
    }
  }
})
