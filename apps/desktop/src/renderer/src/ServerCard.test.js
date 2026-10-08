import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerCard } from './ServerCard'
import { LOCAL_SERVER_URL } from './servers'

/**
 * 卡片的行由页面本地清单驱动（`readRecentServers()` 自己读 localStorage），所以这里把
 * 存储替换掉再渲染——服务端渲染不跑 effect，正好只断言「静态长什么样」。
 */
function withStoredServers(entries, run) {
  const previous = globalThis.localStorage
  const data = new Map([['mica-servers', JSON.stringify(entries)]])
  globalThis.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value))
  }
  try {
    return run()
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
}

const render = (current) =>
  renderToStaticMarkup(
    createElement(ServerCard, { current, onSwitch: () => {}, onDismiss: () => {} })
  )

const pencilCount = (html) => html.split('aria-label="备注"').length - 1

describe('ServerCard notes', () => {
  test('shows the note under its address and offers a pencil on every remembered row', () => {
    const html = withStoredServers(
      [
        { url: 'http://a:8787', note: '办公室的 Mac' },
        { url: 'http://b:8787', note: '' }
      ],
      () => render(LOCAL_SERVER_URL)
    )

    expect(html).toContain('http://a:8787')
    expect(html).toContain('办公室的 Mac')
    expect(html).toContain('http://b:8787')
    expect(pencilCount(html)).toBe(2)
    // 没在编辑，行内编辑器（含它的输入框）不该出现
    expect(html).not.toContain('备注，如「办公室的 Mac」')
  })

  test('shows the note of the machine the page runs on when it is remembered', () => {
    const html = withStoredServers(
      [
        { url: 'http://a:8787', note: '公司的 Mac' },
        { url: 'http://b:8787', note: '家里的 Mac' }
      ],
      () => render('http://a:8787')
    )

    expect(html).toContain('公司的 Mac')
    expect(html).toContain('家里的 Mac')
    // 当前那台（单独一行）+ 清单里的另一台，各自都带铅笔
    expect(pencilCount(html)).toBe(2)
  })

  test('leaves the current machine without a pencil while it was never remembered', () => {
    const html = withStoredServers([{ url: 'http://b:8787', note: '家里的 Mac' }], () =>
      render('http://a:8787')
    )

    expect(html).toContain('家里的 Mac')
    expect(pencilCount(html)).toBe(1)
  })
})
