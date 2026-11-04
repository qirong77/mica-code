import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEMES } from '@packages/mica-web-shared/index.js'
import { chromeHtml, chromePalette, parseChromeMessage, CHROME_MESSAGE_PREFIX } from './browser-chrome.js'

/**
 * 顶栏是一条独立页面（data: URL，读不到 app.css），所以它的颜色是主进程按主题下发的
 * 一份拷贝。这里把那份拷贝和 app.css 逐档对一遍——漏改一个主题，界面就在那档下露回
 * Darcula 的灰绿（浅色主题下最明显）。
 */
const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../renderer/assets/app.css')
const css = readFileSync(CSS_PATH, 'utf8')

/** 调色板的键 → app.css 里的 token；顺序与 browser-chrome.js 的 PALETTES 无关，只列契约 */
const TOKENS = {
  panel: '--color-panel',
  canvas: '--color-canvas',
  active: '--color-active',
  line: '--color-line',
  fg: '--color-fg',
  fgSoft: '--color-fg-soft',
  fgDim: '--color-fg-dim',
  warn: '--color-warn-soft',
  overlay: '--color-overlay'
}

/** 取出某个选择器的声明块（花括号配对，块里没有嵌套规则） */
function blockBody(selector) {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return ''
  const from = start + selector.length + 2
  let depth = 1
  let index = from
  while (index < css.length && depth > 0) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') depth -= 1
    index += 1
  }
  return css.slice(from, index - 1)
}

function tokenValue(body, token) {
  const match = body.match(new RegExp(`${token}:\\s*([^;]+);`))
  return match ? match[1].trim() : null
}

describe('chromePalette', () => {
  it('matches app.css for every registered theme', () => {
    for (const theme of THEMES) {
      // 默认暗色（Darcula）就写在 @theme 里，没有自己的 html[data-theme] 块
      const body = blockBody(theme.id === 'dark' ? '@theme' : `html[data-theme='${theme.id}']`)
      expect(body, `${theme.id} 在 app.css 里缺主题块`).not.toBe('')
      const palette = chromePalette(theme.id)
      for (const [key, token] of Object.entries(TOKENS)) {
        expect(palette[key], `${theme.id} 的 ${key} 与 ${token} 不一致`).toBe(tokenValue(body, token))
      }
    }
  })

  it('falls back to the default dark palette for unknown themes', () => {
    expect(chromePalette('nope')).toEqual(chromePalette('dark'))
    expect(chromePalette(undefined)).toEqual(chromePalette('dark'))
  })
})

describe('chromeHtml', () => {
  it('keeps the address-bar hint short and the full sentence in the tooltip', () => {
    const html = chromeHtml()
    expect(html).toContain('title="地址由 Mica 控制，不可手动修改">请勿手动操作</span>')
    expect(html).not.toContain('>地址由 Mica 控制，不可手动修改<')
  })

  it('paints every themed surface through the injected variables', () => {
    const html = chromeHtml()
    // 顶栏底色、地址框、当前标签页都必须走变量，写死颜色就等于主题只对了一半
    expect(html).toContain('background: var(--c-panel)')
    expect(html).toContain('background: var(--c-canvas)')
    expect(html).toContain('background: var(--c-active)')
    expect(html).toContain("applyPalette(state.palette)")
  })
})

describe('parseChromeMessage', () => {
  it('reads control messages and ignores page logs', () => {
    expect(parseChromeMessage(`${CHROME_MESSAGE_PREFIX}{"action":"hide"}`)).toEqual({ action: 'hide' })
    expect(parseChromeMessage('some page log')).toBeNull()
    expect(parseChromeMessage(`${CHROME_MESSAGE_PREFIX}not-json`)).toBeNull()
  })
})
