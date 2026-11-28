import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from '../../../../../node_modules/react/index.js'
import { renderToStaticMarkup } from '../../../../../node_modules/react-dom/server.node.js'
import { BrowserWindowsButton } from './BrowserWindowsButton'

// 窗口列表挂在 Popover 的 content 里，点开之前不渲染，静态标记看不到它；
// 「点击只展开列表」这条只能守着源码。
const source = readFileSync(new URL('./BrowserWindowsButton.jsx', import.meta.url), 'utf8')

const render = (props) => renderToStaticMarkup(createElement(BrowserWindowsButton, props))

describe('BrowserWindowsButton', () => {
  test('clicking opens the window list instead of creating or showing a window', () => {
    expect(source).toContain('trigger="click"')
    expect(source).not.toContain('trigger="hover"')
    // 按钮和图标自己不再接新建 / 开第一扇：这两个动作都在列表的行上
    expect(source).not.toMatch(/onClick=\{\(\) => \{\s*onCreate/)
  })

  test('the list always offers "新建浏览器窗口" and one row per window', () => {
    expect(source).toContain('新建浏览器窗口')
    expect(source).toContain('browserMenuRows')
    expect(source).toContain('browser-window-url')
  })

  test('a single window still writes the count in the corner', () => {
    const html = render({
      browsers: [{ id: 'brw-1', label: '订单页', url: 'https://e.example/a', visible: true }]
    })
    expect(html).toContain('text-[8px]')
    expect(html).toContain('>1</span>')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('点击展开窗口列表')
    // 点击不再直接唤出 / 收起某一扇，tooltip 也不再这么许诺
    expect(html).not.toContain('点击收起')
  })

  test('stays clickable with no window, and promises nothing it will not do', () => {
    const html = render({ browsers: [] })
    expect(html).toContain('arco-btn')
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('text-[8px]')
    expect(html).toContain('点击展开窗口列表')
  })

  test('several windows collapse into one button with the count in its corner', () => {
    const html = render({
      browsers: [
        { id: 'brw-1', label: '订单页', visible: true },
        { id: 'brw-2', label: '登录页', visible: false },
        { id: 'brw-3', label: '结算页', visible: false }
      ]
    })
    expect(html).toContain('浏览器 · 3 个窗口（1 个已显示）')
    expect(html).toContain('text-[8px]')
    expect(html).toContain('>3</span>')
    expect(html).toContain('aria-expanded="false"')
  })
})
