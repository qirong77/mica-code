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
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        // 共享包与页面同一套别名：主进程也要读地址约定（app-paths.ts），不能各写一份
        '@packages': resolve('../../packages'),
        // 终端窗口要加载的页面路径与运行时路由同源：直接用共享包里的常量，
        // 不再在主进程里抄一份 '/terminal-control'
        '@mica-app-paths': resolve('../../packages/mica-web-shared/app-paths.ts')
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@packages': resolve('../../packages'),
        // 配置页组件来自 packages/mica-config-ui：显式指向 .tsx 入口，页面代码是 .jsx，
        // 写 `.../index.js` 不会回退到 TypeScript 源码
        '@mica-config-ui/web': resolve('../../packages/mica-config-ui/web/index.tsx')
      }
    },
    server: {
      proxy: {
        '/api': { target: `http://127.0.0.1:${runtimePort}`, changeOrigin: false },
        // dev 下的终端窗口页面（/terminal.html）也从 Vite 加载，它访问的
        // /remote/terminal/* 必须落到运行时，再由运行时代理到主进程
        '/remote': { target: `http://127.0.0.1:${runtimePort}`, changeOrigin: false }
      }
    },
    build: {
      // 三个页面入口：主应用、独立文件窗口（顶栏文件夹开出来的，运行时按 /files 提供）
      // 与终端控制窗口（由 Electron 主进程加载，运行时按 /terminal-control 提供）。
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          files: resolve('src/renderer/files.html'),
          terminal: resolve('src/renderer/terminal.html')
        }
      },
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
