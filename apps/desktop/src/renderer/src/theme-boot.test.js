import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEMES } from '@packages/mica-web-shared/index.js'

/**
 * 首帧启动脚本是 classic script，引不进模块，只能把 THEMES 抄一份。
 * 抄漏的直接后果是「首帧用了默认暗色、之后才跳到真主题」，也就是一闪。
 * 这里把两份副本逐项对齐：id、明暗档、画布色必须和注册表完全一致。
 */
const ROOT = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)))

const COPIES = [
  ['桌面渲染层', 'apps/desktop/src/renderer/public/theme-boot.js'],
  ['配置页宿主', 'apps/config-web/web/index.html']
]

/** 从副本源码里列出 `id: { appearance, canvas }` 表项。 */
function readCopy(relativePath) {
  const source = readFileSync(resolve(ROOT, relativePath), 'utf8')
  const table = new Map()
  const pattern = /'?([a-z-]+)'?:\s*\{\s*appearance:\s*'(\w+)',\s*canvas:\s*'(#[0-9a-f]{3,8})'\s*\}/g
  for (const match of source.matchAll(pattern)) {
    table.set(match[1], { appearance: match[2], canvas: match[3] })
  }
  return table
}

describe('首帧主题表与注册表一致', () => {
  for (const [label, path] of COPIES) {
    it(`${label} 的 ${path} 覆盖注册表里的每一个主题`, () => {
      const table = readCopy(path)
      expect(table.size, `${path} 里没解析到主题表（正则或格式变了）`).toBeGreaterThanOrEqual(
        THEMES.length
      )

      for (const theme of THEMES) {
        const entry = table.get(theme.id)
        expect(entry, `${path} 缺少主题 ${theme.id}`).toBeDefined()
        expect(entry.appearance, `${path} ${theme.id} 的明暗档`).toBe(theme.appearance)
        expect(entry.canvas, `${path} ${theme.id} 的画布色`).toBe(theme.canvas)
      }
    })
  }
})
