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
    },
    build: {
      // electron-vite 的 renderer 默认 build.minify = false（它只对 main/preload
      // 有合理理由），不覆盖会让页面装载一份十几 MB 未压缩的 bundle。
      minify: true,
      reportCompressedSize: true,
      // 拆包后单个 chunk 会明显变大（monaco 独立成块），阈值跟着放宽，
      // 否则每次构建都刷一条误导性的告警。
      chunkSizeWarningLimit: 2048
    }
  }
})
