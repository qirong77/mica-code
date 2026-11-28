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
  it('writes the count as soon as one window is open', () => {
    expect(browserCountBadge([])).toBe('')
    // 一扇也要写：数量是「这条会话有窗口」的唯一线索
    expect(browserCountBadge([{ id: 'brw-1' }])).toBe('1')
    expect(browserCountBadge([{ id: 'brw-1' }, { id: 'brw-2' }])).toBe('2')
    expect(browserCountBadge([{ id: 'brw-1' }, { id: 'brw-2' }, { id: 'brw-3' }])).toBe('3')
    // 没有 id 的条目点不中，不参与计数
    expect(browserCountBadge([{ id: 'brw-1' }, {}])).toBe('1')
    expect(browserCountBadge([{}])).toBe('')
    expect(browserCountBadge(null)).toBe('')
  })
})

describe('browserButtonTitle', () => {
  it('says the click only opens the list when the session has no window', () => {
    const title = browserButtonTitle([])
    expect(title.startsWith('浏览器\n点击展开窗口列表')).toBe(true)
    expect(title).toContain('新建')
  })

  it('does not claim a click opens a particular window', () => {
    const title = browserButtonTitle([
      { id: 'brw-1', label: '订单页', url: 'https://e.example/a', visible: false }
    ])
    expect(title).toBe(
      '浏览器 · 1 个窗口\n点击展开窗口列表：点哪一行就显示 / 收起哪一扇，行上右键关闭'
    )
    expect(title).not.toContain('点击唤出')
    expect(title).not.toContain('悬停')
  })

  it('counts windows and how many are on screen', () => {
    const title = browserButtonTitle([
      { id: 'brw-1', visible: true },
      { id: 'brw-2', visible: false },
      { id: 'brw-3', visible: false }
    ])
    expect(title.startsWith('浏览器 · 3 个窗口（1 个已显示）')).toBe(true)
    // 一个都没显示时不写括号，别在 tooltip 里出现「（0 个已显示）」
    expect(browserButtonTitle([{ id: 'brw-1' }, { id: 'brw-2' }])).not.toContain('个已显示')
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
      visible: true
    })
    expect(row.tooltip).toContain('订单详情')
    expect(row.tooltip).toContain('已显示')
  })

  it('falls back to the page title when the agent gave no label', () => {
    expect(browserMenuRow({ id: 'brw-2', title: '新标签页', visible: false })).toMatchObject({
      name: '新标签页',
      detail: ''
    })
    expect(browserMenuRow({ id: 'brw-3' }).name).toBe('受控浏览器')
  })

  it('treats the default label as "no name": the page title tells windows apart', () => {
    // 用户自己点出来的窗口都叫这个名字，拿它当名字几扇窗口就长得一模一样
    expect(browserMenuRow({ id: 'brw-4', label: '受控浏览器', title: '订单详情' }).name).toBe(
      '订单详情'
    )
    expect(browserMenuRow({ id: 'brw-5', label: '受控浏览器' }).name).toBe('受控浏览器')
  })

  it('drops entries the list could not point at', () => {
    expect(browserMenuRows([{ id: 'brw-1' }, null, {}]).map((row) => row.id)).toEqual(['brw-1'])
    expect(browserMenuRows(null)).toEqual([])
  })

  it('keeps the fixed server order when usage timestamps change', () => {
    const rows = browserMenuRows([
      { id: 'brw-old', label: '旧窗口', lastUsedAt: 1000 },
      { id: 'brw-new', label: '新窗口', lastUsedAt: 9000 },
      { id: 'brw-mid', label: '中间', lastUsedAt: 5000 }
    ])
    expect(rows.map((row) => row.id)).toEqual(['brw-old', 'brw-new', 'brw-mid'])
    // 旧快照没有这个字段也保持服务端给的顺序，不把列表打乱
    expect(browserMenuRows([{ id: 'brw-1' }, { id: 'brw-2' }]).map((row) => row.id)).toEqual([
      'brw-1',
      'brw-2'
    ])
  })
})
