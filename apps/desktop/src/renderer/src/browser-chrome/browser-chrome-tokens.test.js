import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEMES } from '@packages/mica-web-shared/index.js'

/**
 * 顶栏颜色契约。
 *
 * `assets/app.css` 是渲染层唯一的颜色来源，但顶栏是独立入口（只为一个 38px 的工具条
 * 把整张 app.css 拖进来不值得），所以 `chrome.css` 里抄了一份用到的 token。这份拷贝
 * 必须逐主题和 app.css 一模一样：漏一个主题、或者改主题时只改了一边，这里就红。
 *
 * 只比 `chrome.css` 声明过的 token：它的职责是「用到的这几个跟应用一致」，不是把整个
 * 主题表复制一遍。
 */

const here = dirname(fileURLToPath(import.meta.url))
const APP_CSS = readFileSync(resolve(here, '../../assets/app.css'), 'utf8')
const CHROME_CSS = readFileSync(resolve(here, 'chrome.css'), 'utf8')

/** 从 `needle` 之后的第一个 `{` 起，取配对的块内容。 */
function blockAfter(source, needle) {
  const at = source.indexOf(needle)
  if (at < 0) return ''
  const open = source.indexOf('{', at)
  if (open < 0) return ''
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return ''
}

/** 块里声明的 `--color-*` → 值（保留原样，方便对比）。 */
function colorVars(block) {
  const vars = {}
  for (const match of block.matchAll(/(--color-[a-z-]+)\s*:\s*([^;]+);/g)) {
    vars[match[1]] = match[2].trim()
  }
  return vars
}

function chromeVarsFor(themeId) {
  // dark 是 @theme 的默认值，落在 :root 上；其余主题各有一块 html[data-theme='<id>']
  return themeId === 'dark'
    ? colorVars(blockAfter(CHROME_CSS, ':root'))
    : colorVars(blockAfter(CHROME_CSS, `html[data-theme='${themeId}']`))
}

function appVarsFor(themeId) {
  return themeId === 'dark'
    ? colorVars(blockAfter(APP_CSS, '@theme'))
    : colorVars(blockAfter(APP_CSS, `html[data-theme='${themeId}']`))
}

describe('browser chrome tokens', () => {
  const ids = THEMES.map((theme) => theme.id)
  const chromeDark = chromeVarsFor('dark')
  const declared = Object.keys(chromeDark)

  it('declares the shared Arco skin tokens the component library reads', () => {
    expect(declared).toEqual(
      expect.arrayContaining([
        '--color-canvas',
        '--color-panel',
        '--color-panel-hi',
        '--color-active',
        '--color-fg-strong',
        '--color-fg-soft',
        '--color-fg-faint',
        '--color-line',
        '--color-line-strong',
        '--color-accent',
        '--color-danger',
        '--color-warn'
      ])
    )
  })

  for (const id of ids) {
    it(`matches app.css for the ${id} theme`, () => {
      const chrome = chromeVarsFor(id)
      const app = appVarsFor(id)
      expect(Object.keys(chrome).length).toBeGreaterThan(0)
      for (const key of Object.keys(chrome)) {
        expect(app[key]).toBeDefined()
        expect(chrome[key]).toBe(app[key])
      }
    })
  }
})
