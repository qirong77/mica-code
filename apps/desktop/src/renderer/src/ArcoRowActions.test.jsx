import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Arco 的 .arco-btn 对齐规则没有放进 layer，Tailwind 的 justify-* 落在 utilities 层、
// 压不住它（见 packages/mica-config-ui/web/arco-settings.css）。整行按钮漏掉 mica-arco-row
// 的后果是图标 + 文字被居中到一行中间，侧栏 / 菜单里整列都跟着歪，所以这里静态挡住。

const root = new URL('../../../../../', import.meta.url).pathname
const scanDirs = [new URL('.', import.meta.url).pathname, join(root, 'plugins')]

function jsxFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsx'))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
}

function arcoActions(source) {
  return Array.from(source.matchAll(/<ArcoAction\b[\s\S]*?>/g), ([tag]) => tag)
}

describe('Arco 整行按钮', () => {
  test('w-full + text-left 的动作带 mica-arco-row', () => {
    const offenders = []
    for (const file of scanDirs.flatMap(jsxFiles)) {
      for (const action of arcoActions(readFileSync(file, 'utf8'))) {
        if (!/w-full/.test(action) || !/text-left/.test(action)) continue
        if (/mica-arco-row/.test(action)) continue
        offenders.push(`${file}: ${action.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('样式用更高特异性覆盖 Arco 的居中与图标左边距', () => {
    const css = readFileSync(
      join(root, 'packages/mica-config-ui/web/arco-settings.css'),
      'utf8',
    )
    expect(css).toContain('.arco-btn.mica-arco-row {')
    expect(css).toMatch(/\.arco-btn\.mica-arco-row \{\s*justify-content: flex-start;/)
    expect(css).toMatch(/\.arco-btn\.mica-arco-row > svg \+ span \{\s*margin-left: 0;/)
  })
})
