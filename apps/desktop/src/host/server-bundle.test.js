import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

/**
 * `out/server/index.mjs` 这个运行时产物按设计是**自包含**的：打包版把它放进 app.asar，
 * 而 app.asar 里没有 node_modules，所以任何被外部化的依赖都会变成用户启动时的
 * `Cannot find package …`。
 *
 * Vite 的 SSR 构建默认恰好会把 package.json 的 dependencies 全部外部化，于是这件事只能靠
 * `vite.server.config.mjs` 的 `ssr.noExternal` 兜住 —— 而且它一旦漏了，本地全绿、dev 正常
 * （dev 能从仓库根 node_modules 解析），只有发布产物会崩。历史上 `nanostores` 就是这样
 * 让唯一的运行时报废的。这里把「零依赖」从文档口号变成可执行断言：漏了就在构建验证阶段
 * 失败，而不是等用户装完才崩。
 */
const BUNDLE = join(import.meta.dirname, '../../out/server/index.mjs')

/** 只允许这两种保持 external：node 内置模块，以及必须运行时加载的原生模块。 */
const ALLOWED_EXTERNAL = new Set(['node-pty'])

const BUILTINS = new Set(builtinModules)

/**
 * 取产物里真正的模块说明符（module specifier）。
 * 只在行首的 import/export 语句上匹配，免得注释或字符串里的包名造成误报。
 */
function bareSpecifiers(source) {
  const found = new Set()
  for (const line of source.split('\n')) {
    const trimmed = line.trimStart()
    const isModuleStatement =
      trimmed.startsWith('import ') ||
      trimmed.startsWith('import(') ||
      trimmed.startsWith('export ')
    if (!isModuleStatement) continue

    const match = /["']([^"']+)["']/.exec(line)
    if (!match) continue

    const specifier = match[1]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    if (specifier.startsWith('data:') || specifier.startsWith('http')) continue
    found.add(specifier)
  }
  return found
}

const built = existsSync(BUNDLE)
// 这个检查属于构建产物，不该让纯逻辑测试也强制先跑一次 build：没构建就跳过。
const check = built ? it : it.skip

describe('desktop server runtime bundle', () => {
  check('is self-contained (只留 node 内置模块与原生模块为 external)', () => {
    const unexpected = [...bareSpecifiers(readFileSync(BUNDLE, 'utf8'))].filter(
      (specifier) => !ALLOWED_EXTERNAL.has(specifier) && !BUILTINS.has(specifier)
    )

    expect(unexpected).toEqual([])
  })

  // 反向对照：正则本身要真的能认出来。别让上面的断言因为「什么都没匹配到」而永远通过。
  it('检测逻辑能识别裸包名（自检）', () => {
    const sample = ['import { atom } from "nanostores";', 'import { x } from "node:fs";'].join('\n')

    expect([...bareSpecifiers(sample)]).toEqual(['nanostores'])
  })
})
