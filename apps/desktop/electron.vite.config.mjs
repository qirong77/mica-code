import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * 应用的运行时是 Web 页面（由 vite.server.config.mjs 构建的 out/server 托管），
 * 这里只构建 Electron 外壳 main 和 renderer 页面本身。
 *
 * dev 下页面走 Vite dev server（HMR），运行时另行启动，因此把 /api 代理到它，
 * 让页面在两种模式下都保持同源调用。端口与外壳一致（MICA_DESKTOP_PORT 可覆盖）。
 *
 * 这里没有 preload 段：页面只通过 HTTP + SSE 访问运行时，不需要 IPC 桥
 * （脚本里的 `--ignoreConfigWarning` 就是为它加的）。
 */
const runtimePort = Number.parseInt(process.env.MICA_DESKTOP_PORT || '', 10) || 8787

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@packages': resolve('../../packages')
      }
    },
    server: {
      proxy: {
        '/api': { target: `http://127.0.0.1:${runtimePort}`, changeOrigin: false }
      }
    }
  }
})
