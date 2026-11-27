import { describe, expect, test } from 'bun:test'
import { createElement } from '../../../../../node_modules/react/index.js'
import { renderToStaticMarkup } from '../../../../../node_modules/react-dom/server.node.js'
import { BrowserWindowsButton } from './BrowserWindowsButton'

const render = (props) => renderToStaticMarkup(createElement(BrowserWindowsButton, props))

describe('BrowserWindowsButton', () => {
  test('stays in the header and clickable with no window: one click creates one', () => {
    const html = render({ browsers: [] })
    expect(html).toContain('arco-btn')
    expect(html).not.toContain('disabled')
    expect(html).toContain('点击新建一个窗口')
  })

  test('a single window keeps the old click-to-show/hide button, without a count', () => {
    const html = render({
      browsers: [{ id: 'brw-1', label: '订单页', url: 'https://e.example/a', visible: true }]
    })
    expect(html).toContain('点击收起')
    expect(html).toContain('aria-pressed="true"')
    // 一个窗口时右下角不写数字：数量角标只在多开时出现。
    expect(html).not.toContain('text-[8px]')
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
    expect(html).toContain('点击显示 / 收起固定顺序里的窗口')
    expect(html).toContain('悬停选择窗口')
    expect(html).toContain('text-[8px]')
    expect(html).toContain('>3</span>')
    expect(html).toContain('aria-expanded="false"')
  })
})
