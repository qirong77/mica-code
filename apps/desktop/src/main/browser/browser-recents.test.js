import { describe, expect, it } from 'bun:test'
import {
  RECENT_LIMIT,
  RECENT_MAX_ROWS,
  RECENT_MIN_WIDTH,
  RECENT_PAD,
  RECENT_ROW_HEIGHT,
  pickFaviconSource,
  pushRecent,
  recentBounds,
  recentWindowOptions
} from './browser-recents.js'

const at = (n) => 1700000000000 + n

describe('pushRecent', () => {
  it('keeps the newest first and records the title', () => {
    let list = []
    list = pushRecent(list, { url: 'https://a.test/1', title: 'A1' }, { at: at(1) })
    list = pushRecent(list, { url: 'https://b.test/', title: 'B' }, { at: at(2) })
    expect(list.map((item) => item.url)).toEqual(['https://b.test/', 'https://a.test/1'])
    expect(list[0]).toEqual({ url: 'https://b.test/', title: 'B', favicon: '', at: at(2) })
  })

  it('keeps an inline icon and survives the icon arriving after the visit', () => {
    const icon = 'data:image/png;base64,AAAA'
    // 先记地址、图标还没取到：条目照样成立，只是没有图标
    let list = pushRecent([], { url: 'https://a.test/', title: 'A' })
    expect(list[0].favicon).toBe('')
    // 图标晚到：同一个地址被替换成带图标的那条，位置不变
    list = pushRecent(list, { url: 'https://b.test/', title: 'B' })
    list = pushRecent(list, { url: 'https://a.test/', title: 'A', favicon: icon })
    expect(list.map((item) => item.url)).toEqual(['https://a.test/', 'https://b.test/'])
    expect(list[0].favicon).toBe(icon)
    // 下一次访问没带图标（比如页面没再报）：沿用已有的，不清空
    list = pushRecent(list, { url: 'https://a.test/', title: 'A2' })
    expect(list[0].favicon).toBe(icon)
    expect(list[0].title).toBe('A2')
  })

  it('rejects anything but an inline image as an icon', () => {
    for (const favicon of ['https://a.test/favicon.ico', 'javascript:alert(1)', 'data:text/html,hi', 42]) {
      const list = pushRecent([], { url: 'https://a.test/', title: 'A', favicon })
      expect(list[0].favicon).toBe('')
    }
  })

  it('moves a revisit to the front instead of duplicating it', () => {
    let list = []
    for (const [index, url] of ['https://a.test/', 'https://b.test/', 'https://c.test/'].entries()) {
      list = pushRecent(list, { url, title: url }, { at: at(index) })
    }
    list = pushRecent(list, { url: 'https://a.test/', title: 'A again' }, { at: at(9) })
    expect(list.map((item) => item.url)).toEqual([
      'https://a.test/',
      'https://c.test/',
      'https://b.test/'
    ])
    expect(list[0].title).toBe('A again')
  })

  it('only records http(s) addresses', () => {
    for (const url of ['', 'about:blank', 'data:text/html,hi', 'chrome://settings', 'not a url']) {
      expect(pushRecent([], { url, title: '' })).toEqual([])
    }
    expect(pushRecent([], { url: 'HTTP://A.TEST/', title: '' })).toHaveLength(1)
  })

  it('caps the list and truncates long titles', () => {
    let list = []
    for (let index = 0; index < RECENT_LIMIT + 5; index++) {
      list = pushRecent(list, { url: `https://a.test/${index}`, title: 'x'.repeat(400) }, { at: index })
    }
    expect(list).toHaveLength(RECENT_LIMIT)
    expect(list[0].url).toBe(`https://a.test/${RECENT_LIMIT + 4}`)
    expect(list[0].title.length).toBe(120)
  })

  it('tolerates junk instead of throwing', () => {
    expect(pushRecent(null, { url: 'https://a.test/' })).toHaveLength(1)
    expect(pushRecent(undefined, { url: 'https://a.test/' })).toHaveLength(1)
  })
})

describe('pickFaviconSource', () => {
  it('prefers an inline icon and otherwise takes the first http(s) one', () => {
    expect(pickFaviconSource(['https://a.test/favicon.ico', 'data:image/svg+xml,<svg/>'])).toBe(
      'data:image/svg+xml,<svg/>'
    )
    expect(pickFaviconSource(['https://a.test/icon-32.png', 'https://a.test/icon-16.png'])).toBe(
      'https://a.test/icon-32.png'
    )
  })

  it('ignores entries it cannot use', () => {
    expect(pickFaviconSource([])).toBe('')
    expect(pickFaviconSource(null)).toBe('')
    expect(pickFaviconSource(['', 'data:text/html,x', 'file:///tmp/a.png'])).toBe('')
  })

  it('resolves the relative icons pages actually declare', () => {
    // 维基百科这种页面写的是 `/static/favicon/wikipedia.ico`
    expect(pickFaviconSource(['/static/favicon/wikipedia.ico'], 'https://www.wikipedia.org/')).toBe(
      'https://www.wikipedia.org/static/favicon/wikipedia.ico'
    )
    expect(pickFaviconSource(['//cdn.test/i.ico'], 'https://a.test/x')).toBe('https://cdn.test/i.ico')
    // 没有 base 就补不出来，别硬拼一个坏地址
    expect(pickFaviconSource(['/static/favicon.ico'])).toBe('')
  })
})

describe('recentWindowOptions', () => {
  it('keeps the panel flush with the bar but drops a shadow', () => {
    const mac = recentWindowOptions({ platform: 'darwin' })
    expect(mac.roundedCorners).toBe(false)
    // 菜单要有投影才看得出来浮在网页之上；窗口与菜单同尺寸，影子就是菜单自己的
    expect(mac.hasShadow).toBe(true)
    expect(mac.frame).toBe(false)
    expect(mac.transparent).toBe(true)
    // 不抢焦点：用户还要继续在地址栏里打字
    expect(mac.focusable).toBe(false)
    expect(mac.type).toBe('panel')
    const other = recentWindowOptions({ platform: 'win32' })
    expect(other.type).toBeUndefined()
    expect(other.roundedCorners).toBe(false)
  })
})

describe('recentBounds', () => {
  const content = { x: 100, y: 100, width: 1000, height: 700 }
  const anchor = { left: 120, top: 5, width: 500, height: 28 }

  it('sits flush under the bar, as wide as the address field', () => {
    const bounds = recentBounds({ anchor, content, rows: 3 })
    expect(bounds).toEqual({
      x: 220,
      // 顶栏高度是 38：列表贴着它的下沿，而不是浮在地址框下面留一条缝
      y: 100 + 38,
      width: 500,
      height: 3 * RECENT_ROW_HEIGHT + RECENT_PAD
    })
  })

  it('is exactly as wide as the address field', () => {
    const narrow = recentBounds({ anchor: { ...anchor, width: 120 }, content, rows: 1 })
    // 用户要的是从地址栏底下长出来的一条：地址框窄，列表也窄，不另给最小宽度
    expect(narrow.width).toBe(120)
    const wide = recentBounds({ anchor: { ...anchor, width: 866.4 }, content, rows: 1 })
    expect(wide.width).toBe(866)
    // 比屏幕还宽也不收：地址框就在用户眼前，收窄只会让列表和它错开
    const huge = recentBounds({ anchor: { ...anchor, width: 3000 }, content, rows: 1 })
    expect(huge.width).toBe(3000)
    // 地址框宽度拿不到时才退回兜底宽度
    expect(recentBounds({ anchor: null, content, rows: 1 }).width).toBe(RECENT_MIN_WIDTH)
  })

  it('scales with the page zoom, so it still matches the address field', () => {
    // Chromium 按 host 记住 zoomLevel（1.2^0.5 = 1.0954）：页面里的 CSS px 比窗口坐标小，
    // 不换算的话列表会窄一圈、并整体向左偏——「下拉跟地址栏对不上」就是这么来的
    const zoom = 1.2 ** 0.5
    const bounds = recentBounds({
      anchor: { left: 102, top: 5, width: 1150.89, height: 28 },
      content: { x: 166, y: 109, width: 1326, height: 788 },
      rows: 3,
      zoom
    })
    expect(bounds.x).toBe(Math.round(166 + 102 * zoom))
    expect(bounds.width).toBe(1261)
    expect(bounds.y).toBe(Math.round(109 + 38 * zoom))
    // 行高也跟着放大，否则窗口会比内容矮，最后一行被截掉
    expect(bounds.height).toBe(Math.ceil((3 * RECENT_ROW_HEIGHT + RECENT_PAD) * zoom))
    // 没给 zoom（老调用、测试）时按 1 算
    expect(recentBounds({ anchor, content, rows: 3 }).width).toBe(500)
  })

  it('keeps at most eight rows tall', () => {
    const bounds = recentBounds({ anchor, content, rows: 50 })
    expect(bounds.height).toBe(RECENT_MAX_ROWS * RECENT_ROW_HEIGHT + RECENT_PAD)
  })
})
