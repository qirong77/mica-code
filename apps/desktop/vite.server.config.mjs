import { builtinModules } from 'node:module'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const REPOSITORY_ROOT = resolve('../..')

function readBuildCommit() {
  const explicit = process.env.MICA_BUILD_COMMIT || process.env.GITHUB_SHA
  if (explicit) return explicit
  try {
    return execFileSync('git', ['-C', REPOSITORY_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function readBuildTime() {
  return process.env.MICA_BUILD_TIME || new Date().toISOString()
}

/**
 * HTTP 服务端构建：把 src/server 入口连同 src/main 下的业务模块打成一个 Node ESM 包，
 * 并把 `electron` 别名到纯 Node 替身（src/server/electron-shim.js），
 * 这样同一批主进程模块既能跑在 Electron 里，也能跑在 `node out/server/index.mjs` 里。
 *
 * node-pty 是原生模块，必须保持 external。
 */
const external = [...builtinModules, ...builtinModules.map((name) => `node:${name}`), 'node-pty']

export default defineConfig({
  define: {
    __MICA_BUILD_COMMIT__: JSON.stringify(readBuildCommit()),
    __MICA_BUILD_TIME__: JSON.stringify(readBuildTime())
  },
  plugins: [
    {
      name: 'text-import',
      // `packages/mica-agent` 用 `import X from './system.md' with { type: 'text' }` 内嵌
      // 提示词（单二进制靠 bun 的这个能力）。配置页的「测试连接」要在运行时里发一次
      // 真实请求，于是这个包也进了服务端产物——rolldown 默认把 .md 当 JS 解析会直接报错，
      // 这里按文本处理，语义与 bun 的 `type: 'text'` 一致。
      transform(code, id) {
        if (!id.endsWith('.md')) return null
        return { code: `export default ${JSON.stringify(code)}`, map: null }
      }
    }
  ],
  // SSR 构建默认把 package.json 的 dependencies 全部外部化，产物因此仍会 `import` 裸包名，
  // 而打包版 app.asar 里并没有它们（`nanostores` 就是被它引用、又不在依赖树里的一个，
  // 打包版启动即 `Cannot find package 'nanostores'`；dev 模式从仓库根 node_modules 解析，
  // 所以只在发布产物上炸）。这个运行时按设计是零依赖的，这里把纯 JS 依赖全部内联，
  // 只留 rollupOptions.external 里的 node 内置模块与 node-pty —— 将来多一个依赖没能内联，
  // 也是构建期报错而不是留到用户启动时才崩。
  ssr: { noExternal: true },
  resolve: {
    alias: [
      { find: /^electron$/, replacement: resolve('src/server/electron-shim.js') },
      { find: '@packages', replacement: resolve('../../packages') }
    ]
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
