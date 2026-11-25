import { describe, expect, it } from 'bun:test'
import {
  browserButtonTitle,
  browserCountBadge,
  browserIconTitle,
  browserMenuRow,
  browserMenuRows,
  browserStatusLabel,
  isOwnedByNode,
  nodeBrowsers
} from './browser-control'

const node = { id: 'chat-1', sessionId: 'sess-abc' }

describe('nodeBrowsers', () => {
  it('keeps windows owned by the node session or by the node id', () => {
    const list = [
      { id: 'brw-1', owner: 'sess-abc' },
      { id: 'brw-2', owner: 'chat-1' },
      { id: 'brw-3', owner: 'sess-other' }
    ]
    expect(nodeBrowsers(list, node).map((item) => item.id)).toEqual(['brw-1', 'brw-2'])
  })

  it('drops windows without an owner: they belong to no session at all', () => {
    const list = [{ id: 'brw-1', owner: null }]
    expect(nodeBrowsers(list, node)).toEqual([])
  })

  it('tolerates a missing node and a malformed list', () => {
    expect(nodeBrowsers([{ id: 'brw-1', owner: 'x' }], null)).toEqual([])
    expect(nodeBrowsers(null, node)).toEqual([])
  })

  it('matches a draft node by its id when there is no session yet', () => {
    const draft = { id: 'chat-2', sessionId: null }
    expect(nodeBrowsers([{ id: 'brw-1', owner: 'chat-2' }], draft)).toHaveLength(1)
  })
})

describe('isOwnedByNode', () => {
  it('distinguishes owned from unowned windows', () => {
    expect(isOwnedByNode({ owner: 'sess-abc' }, node)).toBe(true)
    expect(isOwnedByNode({ owner: 'chat-1' }, node)).toBe(true)
    expect(isOwnedByNode({ owner: null }, node)).toBe(false)
    expect(isOwnedByNode({ owner: 'sess-other' }, node)).toBe(false)
  })

  it('also judges the activity events that only carry owner and id', () => {
    expect(isOwnedByNode({ id: 'brw-1', owner: 'sess-abc' }, node)).toBe(true)
    expect(isOwnedByNode({ id: 'brw-1', owner: 'sess-other' }, node)).toBe(false)
    expect(isOwnedByNode({ id: 'brw-1' }, node)).toBe(false)
  })
})

describe('browserStatusLabel', () => {
  it('prefers loading over visibility', () => {
    expect(browserStatusLabel({ loading: true, visible: true })).toBe('加载中')
    expect(browserStatusLabel({ loading: false, visible: true })).toBe('已显示')
    expect(browserStatusLabel({ loading: false, visible: false })).toBe('已隐藏')
    expect(browserStatusLabel(null)).toBe('')
  })
})

describe('browserIconTitle', () => {
  it('collects label, title, url, tabs and action', () => {
    const title = browserIconTitle({
      label: '订单页',
      title: '订单详情',
      url: 'https://example.com/order/1',
      visible: true,
      loading: false,
      owner: 'sess-abc',
      tabs: [{ id: 'tab-1' }, { id: 'tab-2' }]
    })
    expect(title).toBe(
      '订单页 · 订单详情 · https://example.com/order/1 · 2 个标签页 · 已显示 · 点击收起 · 右键关闭'
    )
  })

  it('hides about:blank and asks for a click to summon', () => {
    const title = browserIconTitle({
      label: '受控浏览器',
      title: '',
      url: 'about:blank',
      visible: false,
      tabs: [],
      owner: 'sess-abc'
    })
    expect(title).not.toContain('about:blank')
    expect(title).toContain('点击唤出')
  })

  it('skips a title that only repeats the label', () => {
    const title = browserIconTitle({
      label: '订单页',
      title: '订单页',
      url: '',
      visible: false,
      tabs: [],
      owner: 'sess-abc'
    })
    expect(title.startsWith('订单页 · 已隐藏 · 点击唤出 · 右键关闭')).toBe(true)
  })
})

describe('browserCountBadge', () => {
  it('writes the count only when more than one window is open', () => {
    expect(browserCountBadge([])).toBe('')
    expect(browserCountBadge([{ id: 'brw-1' }])).toBe('')
    expect(browserCountBadge([{ id: 'brw-1' }, { id: 'brw-2' }])).toBe('2')
    expect(browserCountBadge([{ id: 'brw-1' }, { id: 'brw-2' }, { id: 'brw-3' }])).toBe('3')
    // 没有 id 的条目点不中，不参与计数
    expect(browserCountBadge([{ id: 'brw-1' }, {}])).toBe('')
    expect(browserCountBadge(null)).toBe('')
  })
})

describe('browserButtonTitle', () => {
  it('says there is no window instead of leaving the always-on button silent', () => {
    expect(browserButtonTitle([])).toBe('浏览器\n当前会话还没有打开的窗口')
  })

  it('reuses the single-window wording so click and right-click stay explained', () => {
    const title = browserButtonTitle([
      { id: 'brw-1', label: '订单页', url: 'https://e.example/a', visible: false }
    ])
    expect(title).toContain('订单页')
    expect(title).toContain('点击唤出')
    expect(title).toContain('右键关闭')
  })

  it('explains the dropdown once there is more than one window', () => {
    const title = browserButtonTitle([
      { id: 'brw-1', visible: true },
      { id: 'brw-2', visible: false },
      { id: 'brw-3', visible: false }
    ])
    expect(title).toBe('浏览器 · 3 个窗口（1 个已显示）\n悬停或点击选择窗口 · 行上右键关闭')
    // 一个都没显示时不写括号，别在 tooltip 里出现「（0 个已显示）」
    expect(browserButtonTitle([{ id: 'brw-1' }, { id: 'brw-2' }])).toBe(
      '浏览器 · 2 个窗口\n悬停或点击选择窗口 · 行上右键关闭'
    )
  })
})

describe('browserMenuRows', () => {
  it('names the window by its label and shows the address without the protocol', () => {
    const [row] = browserMenuRows([
      {
        id: 'brw-1',
        label: '订单页',
        title: '订单详情',
        url: 'https://example.com/order/1?x=1',
        visible: true,
        loading: false
      }
    ])
    expect(row).toMatchObject({
      id: 'brw-1',
      name: '订单页',
      detail: 'example.com/order/1?x=1',
      status: '已显示',
      visible: true
    })
    expect(row.tooltip).toContain('订单详情')
  })

  it('falls back to the page title when the agent gave no label', () => {
    expect(browserMenuRow({ id: 'brw-2', title: '新标签页', visible: false })).toMatchObject({
      name: '新标签页',
      detail: '',
      status: '已隐藏'
    })
    expect(browserMenuRow({ id: 'brw-3' }).name).toBe('受控浏览器')
  })

  it('drops entries the list could not point at', () => {
    expect(browserMenuRows([{ id: 'brw-1' }, null, {}]).map((row) => row.id)).toEqual(['brw-1'])
    expect(browserMenuRows(null)).toEqual([])
  })
})
