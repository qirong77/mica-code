import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import { RUNTIME_PORT_ENV, parseRuntimePort } from '../../packages/mica-web-shared/runtime-port.js'
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
// dev 代理要落到运行时那个端口上：端口常量的唯一来源是 mica-web-shared 的 runtime-port，
// 这里不再抄一份 8787
const runtimePort = parseRuntimePort(process.env[RUNTIME_PORT_ENV])

/**
 * 把 `import { IconX, IconY } from '@tabler/icons-react'` 改写成逐个深路径导入。
 *
 * 上游包的 barrel（dist/esm/tabler-icons-react.mjs）除了 re-export 全部 6197 个图标模块，
 * 还会 `import * as index from './icons/index.mjs'`。tree-shaking 后产物里只剩实际用到的
 * 几十个图标，体积没差别，但构建期仍要解析这 6000 多个模块：实测 renderer 段 10870 →
 * 4749 个模块、快 1.5~2s。用 transform 改写而不是维护一份图标清单，源码写法保持不变，
 * 新增图标时也不需要同步任何东西。
 *
 * 只对 build 生效：dev 下改写会让每个图标各成一个 optimizeDeps 预构建产物（实测 100 个
 * deps 文件），冷启动反而更慢；dev 交给 Vite 把整个 barrel 预构建成一份即可。
 */
function tablerIconDeepImports() {
  const specifier = '@tabler/icons-react'
  const deep = `${specifier}/dist/esm/icons`
  return {
    name: 'mica:tabler-icon-deep-imports',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('/node_modules/') || !code.includes(specifier)) return null
      const namedImport = /import\s*\{([^}]*)\}\s*from\s*(['"])@tabler\/icons-react\2\s*;?/g
      if (!namedImport.test(code)) return null
      return code.replace(namedImport, (_match, names) => {
        const lines = names
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            // 图标模块 default 导出组件，所以 `IconX as Alias` 直接变成 `import Alias from ...`
            const [exported, local] = entry.split(/\s+as\s+/).map((value) => value.trim())
            return `import ${local || exported} from '${deep}/${exported}.mjs'`
          })
        // 正则里的 `\s*` 会把结尾换行一起吃掉，补回来避免和下一条语句粘连
        return `${lines.join('\n')}\n`
      })
    }
  }
}

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
    plugins: [tablerIconDeepImports(), react(), tailwindcss()],
    resolve: {
      // packages/mica-config-ui 的源码从仓库根 node_modules 解析 react，页面脚本则从
      // apps/desktop/node_modules 解析，两份物理路径不同的 react 会被当成两个实例打进包：
      // 配置页里调用 hooks 时拿到的命名空间是 null（Cannot read properties of null
      // (reading 'useState')）。dedupe 强制收敛到同一份。
      dedupe: ['react', 'react-dom'],
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@packages': resolve('../../packages'),
        // 插件自己的桌面入口（`plugins/<id>/desktop.jsx`）：页面按 id 去插件目录找模块，
        // 宿主因此不需要登记任何具体插件。指向仓库根，glob 才能收录这些文件。
        '@plugins': resolve('../../plugins'),
        // 配置页组件来自 packages/mica-config-ui：显式指向 .tsx 入口，页面代码是 .jsx，
        // 写 `.../index.js` 不会回退到 TypeScript 源码
        '@mica-config-ui/web': resolve('../../packages/mica-config-ui/web/index.tsx'),
        // 插件入口行的图标要在侧栏首屏就画出来，而整个配置页是懒加载的独立 chunk：
        // 深路径直接指向图标表，别为了一个图标把配置页拖进主包
        '@mica-config-ui/plugin-icons': resolve('../../packages/mica-config-ui/web/pluginIcons.tsx'),
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
      // 三个页面入口：主应用、独立文件窗口（顶栏编辑器按钮开出来的，运行时按 /files 提供）
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
      // 每次构建都要为每个 chunk 跑一遍 gzip 才算体积，monaco 单块 3.6MB，
      // 这部分纯统计开销在本地反复构建时很显眼，体积告警由 chunkSizeWarningLimit 兜底。
      reportCompressedSize: false,
      // 拆包后单个 chunk 会明显变大（monaco 独立成块），阈值跟着放宽，
      // 否则每次构建都刷一条误导性的告警。
      chunkSizeWarningLimit: 2048
    }
  }
})
