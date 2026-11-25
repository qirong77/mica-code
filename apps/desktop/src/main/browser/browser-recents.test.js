import { describe, expect, it } from 'bun:test'
import {
  RECENT_LIMIT,
  RECENT_MAX_ROWS,
  RECENT_PAD,
  RECENT_ROW_HEIGHT,
  pushRecent,
  recentBounds
} from './browser-recents.js'

const at = (n) => 1700000000000 + n

describe('pushRecent', () => {
  it('keeps the newest first and records the title', () => {
    let list = []
    list = pushRecent(list, { url: 'https://a.test/1', title: 'A1' }, { at: at(1) })
    list = pushRecent(list, { url: 'https://b.test/', title: 'B' }, { at: at(2) })
    expect(list.map((item) => item.url)).toEqual(['https://b.test/', 'https://a.test/1'])
    expect(list[0]).toEqual({ url: 'https://b.test/', title: 'B', at: at(2) })
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

describe('recentBounds', () => {
  const content = { x: 100, y: 100, width: 1000, height: 700 }
  const anchor = { left: 120, top: 5, width: 500, height: 28 }
  const workArea = { x: 0, y: 0, width: 1440, height: 900 }

  it('sits flush under the bar, at least as wide as the address field', () => {
    const bounds = recentBounds({ anchor, content, rows: 3, workArea })
    expect(bounds).toEqual({
      x: 220,
      // 顶栏高度是 38：列表贴着它的下沿，而不是浮在地址框下面留一条缝
      y: 100 + 38,
      width: 500,
      height: 3 * RECENT_ROW_HEIGHT + RECENT_PAD
    })
  })

  it('never gets narrower than the minimum or wider than the screen', () => {
    const narrow = recentBounds({
      anchor: { ...anchor, width: 120 },
      content,
      rows: 1,
      workArea
    })
    expect(narrow.width).toBe(320)
    const tinyScreen = recentBounds({
      anchor,
      content: { ...content, width: 300 },
      rows: 1,
      workArea: { x: 0, y: 0, width: 320, height: 800 }
    })
    expect(tinyScreen.width).toBeLessThanOrEqual(320 - 16)
  })

  it('keeps at most eight rows tall', () => {
    const bounds = recentBounds({ anchor, content, rows: 50, workArea })
    expect(bounds.height).toBe(RECENT_MAX_ROWS * RECENT_ROW_HEIGHT + RECENT_PAD)
  })

  it('flips above the bar when there is no room below', () => {
    const bounds = recentBounds({
      anchor,
      // 窗口贴着屏幕底部：下方只剩 40px
      content: { x: 100, y: 600, width: 1000, height: 260 },
      rows: 4,
      workArea: { x: 0, y: 0, width: 1440, height: 700 }
    })
    expect(bounds.y).toBe(600 - (4 * RECENT_ROW_HEIGHT + RECENT_PAD))
  })

  it('stays inside the work area when neither side fits', () => {
    const short = recentBounds({
      anchor,
      content: { x: 100, y: 300, width: 1000, height: 100 },
      rows: 8,
      workArea: { x: 0, y: 200, width: 1440, height: 400 }
    })
    expect(short.y).toBeGreaterThanOrEqual(200 + 8)
    expect(short.y + short.height).toBeLessThanOrEqual(600 - 8)
  })

  it('clamps the left edge into the work area for windows near the right edge', () => {
    const bounds = recentBounds({
      anchor: { ...anchor, left: 900, width: 400 },
      content: { x: 700, y: 100, width: 740, height: 700 },
      rows: 2,
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    })
    expect(bounds.x).toBe(1440 - 400 - 8)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440 - 8)
  })
})
