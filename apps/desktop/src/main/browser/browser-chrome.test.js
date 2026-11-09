import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { THEMES } from '@packages/mica-web-shared/index.js'
import {
  chromeHtml,
  chromePalette,
  parseChromeMessage,
  CHROME_MESSAGE_PREFIX
} from './browser-chrome.js'

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
        expect(palette[key], `${theme.id} 的 ${key} 与 ${token} 不一致`).toBe(
          tokenValue(body, token)
        )
      }
    }
  })

  it('falls back to the default dark palette for unknown themes', () => {
    expect(chromePalette('nope')).toEqual(chromePalette('dark'))
    expect(chromePalette(undefined)).toEqual(chromePalette('dark'))
  })
})

describe('chromeHtml', () => {
  it('removes visible ownership, copy guidance, hide and window-switch controls', () => {
    const html = chromeHtml()
    // 窗口彼此独立：顶栏不提供「切换到别的窗口」的入口，那只能做成原生菜单
    for (const id of ['owner', 'hint', 'hide', 'label', 'badge', 'windows'])
      expect(html).not.toContain('id="' + id + '"')
    expect(html).not.toContain('showWindows')
  })

  it('deduplicates matching titles without losing tab switching or address copying', () => {
    function element() {
      return {
        children: [],
        listeners: {},
        attributes: {},
        set textContent(value) {
          this.text = value
          this.children = []
        },
        get textContent() {
          return this.text || ''
        },
        appendChild(child) {
          this.children.push(child)
        },
        addEventListener(name, handler) {
          this.listeners[name] = handler
        },
        setAttribute(name, value) {
          this.attributes[name] = value
        }
      }
    }
    const elements = Object.fromEntries(
      ['tabs', 'url', 'loading'].map((id) => [id, element()])
    )
    const messages = []
    const document = {
      ...element(),
      documentElement: { style: { setProperty() {} } },
      getElementById: (id) => elements[id],
      createElement: element
    }
    const window = { getSelection: () => 'selected address' }
    runInNewContext(chromeHtml().match(/<script>([\s\S]*?)<\/script>/)[1], {
      window,
      document,
      console: { log: (message) => messages.push(parseChromeMessage(message)) }
    })
    const update = window.__micaChrome.update
    update({
      label: 'Entry',
      owner: 'session-123',
      url: 'https://example.com',
      loading: true,
      tabs: [
        { id: 'one', title: 'Qirong Entry', url: 'https://example.com/one' },
        { id: 'two', title: 'Qirong Entry', url: 'https://example.com/two', active: true }
      ]
    })
    expect(elements.loading.title).toBe('Entry\n用户会话 session-123')
    expect(elements.url.title).toContain('地址由 Mica 控制，不可编辑；可选中复制')
    expect(elements.loading.className).toBe('dot loading')
    const [heading, first, second] = elements.tabs.children
    expect(heading.textContent).toBe('Qirong Entry')
    expect(first.children[0].textContent).toBe('1')
    expect(second.children[0].textContent).toBe('2')
    expect(second.attributes['aria-pressed']).toBe('true')
    expect(second.title).toBe('Qirong Entry\nhttps://example.com/two')
    first.listeners.click()
    let prevented = false
    document.listeners.keydown({
      metaKey: true,
      key: 'c',
      preventDefault() {
        prevented = true
      }
    })
    document.listeners.contextmenu({ preventDefault() {} })
    expect(prevented).toBe(true)
    expect(messages).toEqual([
      { action: 'activateTab', tabId: 'one' },
      { action: 'copy', text: 'selected address' },
      { action: 'copy', text: 'selected address' }
    ])
    update({
      tabs: [
        { id: 'one', title: 'First' },
        { id: 'two', title: 'Second' }
      ]
    })
    expect(elements.tabs.children.map((node) => node.children[0].textContent)).toEqual([
      'First',
      'Second'
    ])
    update({ tabs: [{ id: 'one', title: 'Only tab' }] })
    expect(elements.tabs.children).toHaveLength(1)
    expect(elements.tabs.children[0].className).toBe('page-title')
    expect(elements.tabs.children[0].title).toBe('Only tab')
    update({})
    expect(elements.loading.className).toBe('dot')
    expect(elements.url.textContent).toBe('about:blank')
    expect(elements.tabs.children).toHaveLength(0)
  })

  it('makes the address selectable and copies it through the host', () => {
    const html = chromeHtml()
    // 地址在窗口拖动区里：不 no-drag + 放开选择，选中就失效
    expect(html).toContain(
      '-webkit-user-select: text; user-select: text; -webkit-app-region: no-drag;'
    )
    expect(html).toContain("send('copy', { text: text })")
    expect(html).toContain("addEventListener('contextmenu'")
    expect(html).toContain('range.selectNodeContents(url)')
  })

  it('paints every themed surface through the injected variables', () => {
    const html = chromeHtml()
    // 顶栏底色、地址框、当前标签页都必须走变量，写死颜色就等于主题只对了一半
    expect(html).toContain('background: var(--c-panel)')
    expect(html).toContain('background: var(--c-canvas)')
    expect(html).toContain('background: var(--c-active)')
    expect(html).toContain('applyPalette(state.palette)')
  })
})

describe('parseChromeMessage', () => {
  it('reads control messages and ignores page logs', () => {
    expect(parseChromeMessage(`${CHROME_MESSAGE_PREFIX}{"action":"hide"}`)).toEqual({
      action: 'hide'
    })
    expect(parseChromeMessage('some page log')).toBeNull()
    expect(parseChromeMessage(`${CHROME_MESSAGE_PREFIX}not-json`)).toBeNull()
  })
})
