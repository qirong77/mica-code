import { describe, expect, it } from 'bun:test'
import {
  browserIconBadge,
  browserIconTitle,
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
      '订单页 · 订单详情 · https://example.com/order/1 · 2 个标签页 · 已显示 · 点击隐藏 · 右键关闭'
    )
  })

  it('hides about:blank and asks for a click to show', () => {
    const title = browserIconTitle({
      label: '受控浏览器',
      title: '',
      url: 'about:blank',
      visible: false,
      tabs: [],
      owner: 'sess-abc'
    })
    expect(title).not.toContain('about:blank')
    expect(title).toContain('点击显示')
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
    expect(title.startsWith('订单页 · 已隐藏 · 点击显示 · 右键关闭')).toBe(true)
  })
})

describe('browserIconBadge', () => {
  it('numbers the second window onwards', () => {
    const list = [{ id: 'brw-1' }, { id: 'brw-2' }]
    expect(browserIconBadge(list, list[0])).toBe('1')
    expect(browserIconBadge(list, list[1])).toBe('2')
    expect(browserIconBadge([{ id: 'brw-1' }], { id: 'brw-1' })).toBe('')
    expect(browserIconBadge(list, { id: 'brw-9' })).toBe('')
  })
})
