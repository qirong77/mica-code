import { describe, expect, test } from 'bun:test'
import {
  applyPanelResult,
  clearMenuCache,
  createPanelActionQueue,
  createPluginPanelsStore,
  isCompletedToolEvent,
  isOpenableLink,
  loadPluginPanels,
  menuCacheKey,
  observePanelCardImpression,
  panelCardImpressionKey,
  panelNeedsQuickbarView,
  panelDrafts,
  panelViewContext,
  pluginPanelCards,
  pluginPanelTabs,
  pluginQuickbarItems,
  quickbarButtonLook,
  quickbarMenuItems,
  quickbarMenuTable,
  readMenuCache,
  readPanelView,
  reconcilePanelActionDrafts,
  reconcilePanelDrafts,
  sectionDrafts,
  writePanelView,
  writeMenuCache,
  selectPluginPanels
} from './plugin-panels'

test('action refresh updates untouched fields in other sections while preserving real edits', () => {
  const baseline = { '0:search': '', '1:host': 'old', '1:user': 'root' }
  const submitted = { ...baseline, '0:search': 'submitted' }
  const drafts = { ...submitted, '0:search': 'typed during request', '1:user': 'custom' }
  const next = { '0:search': '', '1:host': 'target-host', '1:user': 'target-user' }
  expect(reconcilePanelActionDrafts(drafts, baseline, next, submitted, 0)).toEqual({
    '0:search': 'typed during request', '1:host': 'target-host', '1:user': 'custom'
  })
  expect(reconcilePanelActionDrafts(submitted, baseline, next, submitted, 0)).toEqual(next)
})

test('only declared dynamic/status/shortcut panels participate in quickbar polling', () => {
  expect(panelNeedsQuickbarView({ shortcuts: [] })).toBe(false)
  expect(panelNeedsQuickbarView({ shortcuts: [{ label: '打开', action: 'open' }] })).toBe(false)
  expect(panelNeedsQuickbarView({ dynamicShortcuts: true, shortcuts: [] })).toBe(true)
  expect(panelNeedsQuickbarView({ status: true })).toBe(true)
  expect(panelNeedsQuickbarView({ shortcuts: [{ menu: 'services' }] })).toBe(true)
})

const plugin = (overrides = {}) => ({
  id: 'user.demand-dev',
  name: '需求开发',
  icon: 'messages-square',
  state: 'enabled',
  desktopPanel: { label: '需求开发', roles: ['需求开发'], shortcuts: [] },
  ...overrides
})

describe('compact panel cards', () => {
  const card = (overrides = {}) => ({ id: 'summary', title: 'Summary', revision: 'v1', ...overrides })

  test('merges only current plugins, with separate identities per plugin and revision', () => {
    const panels = [{ id: 'one' }, { id: 'two' }]
    const views = { one: [card(), card({ id: 'second' })], two: [card()], disabled: [card()] }
    const entries = pluginPanelCards(panels, views)
    expect(entries.map((entry) => entry.panel.id)).toEqual(['one', 'one', 'two'])
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(3)
    const newer = pluginPanelCards(panels, { ...views, one: [card({ revision: 'v2' })] })
    expect(newer[0].key).not.toBe(entries[0].key)
    expect(newer[1].key).toBe(entries[2].key)
    expect(pluginPanelCards([], views)).toEqual([])
  })

  test('caps each plugin independently and drops duplicate or malformed cards', () => {
    const panels = [{ id: 'one' }, { id: 'two' }]
    const many = Array.from({ length: 6 }, (_, index) => card({ id: `c${index}` }))
    expect(pluginPanelCards(panels, { one: many, two: many })).toHaveLength(6)
    expect(pluginPanelCards(panels, { one: [card(), card(), null], two: {} })).toHaveLength(1)
  })

  test('impression identity varies with session, plugin, card and revision only', () => {
    const identity = panelCardImpressionKey('node', 'session', 'one', card())
    expect(panelCardImpressionKey('node', 'session', 'one', card({ title: 'polled again' }))).toBe(identity)
    for (const next of [
      panelCardImpressionKey('other-node', 'session', 'one', card()),
      panelCardImpressionKey('node', 'other-session', 'one', card()),
      panelCardImpressionKey('node', 'session', 'two', card()),
      panelCardImpressionKey('node', 'session', 'one', card({ id: 'other' })),
      panelCardImpressionKey('node', 'session', 'one', card({ revision: 'v2' }))
    ]) expect(next).not.toBe(identity)
  })

  const visibilityHarness = () => {
    const element = {}
    const listeners = new Set()
    const doc = {
      hidden: false,
      addEventListener: (_, callback) => listeners.add(callback),
      removeEventListener: (_, callback) => listeners.delete(callback)
    }
    let deliver
    let observed = 0
    let observerOptions
    class Observer {
      constructor(callback, options) { deliver = callback; observerOptions = options }
      observe() { observed += 1 }
      disconnect() {}
    }
    let impressions = 0
    const stop = observePanelCardImpression(element, () => { impressions += 1 }, {
      document: doc, Observer, supportsVisibility: true
    })
    return { doc, stop, listeners,
      get observed() { return observed },
      get impressions() { return impressions },
      get observerOptions() { return observerOptions },
      deliver: (overrides = {}) => deliver([{
        target: element, isIntersecting: true, intersectionRatio: 1, isVisible: true, ...overrides
      }])
    }
  }

  test('mount does not count; intersection, foreground and unoccluded visibility are required', () => {
    const view = visibilityHarness()
    expect(view.impressions).toBe(0)
    expect(view.observerOptions).toEqual({ threshold: 0.5, trackVisibility: true, delay: 100 })
    view.deliver({ isIntersecting: false })
    view.deliver({ intersectionRatio: 0.1 })
    view.deliver({ isVisible: false })
    view.deliver({ isVisible: undefined })
    view.doc.hidden = true
    view.deliver()
    expect(view.impressions).toBe(0)
    view.doc.hidden = false
    view.deliver()
    view.deliver()
    expect(view.impressions).toBe(1)
    expect(view.listeners.size).toBe(0)
    view.stop()
  })

  test('foregrounding re-observes and unmount prevents queued visibility callbacks', () => {
    const view = visibilityHarness()
    view.doc.hidden = true
    for (const listener of view.listeners) listener()
    expect(view.observed).toBe(1)
    view.doc.hidden = false
    for (const listener of view.listeners) listener()
    expect(view.observed).toBe(2)
    view.stop()
    view.deliver()
    expect(view.impressions).toBe(0)
    expect(view.listeners.size).toBe(0)
  })

  test('omits impressions when actual visibility cannot be determined', () => {
    let constructed = false
    const stop = observePanelCardImpression({}, () => { throw new Error('must not emit') }, {
      document: {}, supportsVisibility: false,
      Observer: class { constructor() { constructed = true } }
    })
    expect(constructed).toBe(false)
    stop()
    expect(() => observePanelCardImpression({}, () => {}, {
      document: {}, supportsVisibility: true,
      Observer: class { constructor() { throw new Error('visibility tracking unavailable') } }
    })()).not.toThrow()
  })
})

test('只在本会话的工具完成时刷新插件视图', () => {
  const payload = {
    id: 'one',
    event: { type: 'tool_use', part: { state: { status: 'completed' } } }
  }
  expect(isCompletedToolEvent(payload, 'one')).toBe(true)
  expect(isCompletedToolEvent(payload, 'two')).toBe(false)
  expect(
    isCompletedToolEvent(
      { ...payload, event: { ...payload.event, part: { state: { status: 'pending' } } } },
      'one'
    )
  ).toBe(false)
})

describe('selectPluginPanels', () => {
  test('keeps only enabled plugins that declare a panel', () => {
    const panels = selectPluginPanels(
      [
        plugin(),
        plugin({ id: 'disabled', state: 'disabled' }),
        plugin({ id: 'no-panel', desktopPanel: null })
      ],
      '需求开发'
    )
    expect(panels.map((panel) => panel.id)).toEqual(['user.demand-dev'])
  })

  test('passes the display form through, defaulting to the drawer', () => {
    const panels = selectPluginPanels(
      [
        plugin({
          id: 'a',
          desktopPanel: { label: 'A', roles: [], display: 'modal', shortcuts: [] }
        }),
        plugin({ id: 'b' })
      ],
      '需求开发'
    )
    expect(panels.map((panel) => panel.display)).toEqual(['modal', 'drawer'])
  })

  test('carries the entry action of a panel that is opened by running it', () => {
    const panels = selectPluginPanels(
      [
        plugin({ desktopPanel: { label: '手机访问', roles: [], open: 'show', shortcuts: [] } }),
        plugin({ id: 'plain' })
      ],
      'default'
    )
    expect(panels.map((panel) => panel.openAction)).toEqual(['show', undefined])
  })

  test('filters by the session role', () => {
    expect(selectPluginPanels([plugin()], '需求开发')).toHaveLength(1)
    expect(selectPluginPanels([plugin()], 'default')).toHaveLength(0)
    expect(selectPluginPanels([plugin()], '')).toHaveLength(0)
  })

  test('an empty role list shows the panel for every role', () => {
    const panels = selectPluginPanels(
      [plugin({ desktopPanel: { label: '巡检', roles: [] } })],
      'default'
    )
    expect(panels).toEqual([
      {
        id: 'user.demand-dev',
        label: '巡检',
        icon: 'messages-square',
        display: 'drawer',
        status: false,
        dynamicShortcuts: false,
        shortcuts: []
      }
    ])
  })

  test('carries dynamicShortcuts through so the bar knows it has to ask the view', () => {
    const panels = selectPluginPanels(
      [plugin({ desktopPanel: { label: '快捷按钮', roles: [], dynamicShortcuts: true } })],
      'default'
    )
    expect(panels[0].dynamicShortcuts).toBe(true)
    expect(panels[0].shortcuts).toEqual([])
  })

  test('carries the declared quick-bar shortcuts through', () => {
    const shortcuts = [
      { label: '立刻检查', action: 'check.now' },
      { label: '频道设置', section: '频道设置' }
    ]
    const panels = selectPluginPanels(
      [plugin({ desktopPanel: { label: '需求开发', roles: [], shortcuts } })],
      '需求开发'
    )
    expect(panels[0].shortcuts).toEqual(shortcuts)
  })

  test('keeps preview data on declared shortcuts', () => {
    const preview = {
      title: '报告已生成',
      markdown: '- 3 个文件\n- 测试通过',
      actions: [{ id: 'open-report', label: '在 Mica 中打开' }]
    }
    const shortcut = { label: '生成报告', action: 'report', preview }
    const panels = selectPluginPanels(
      [plugin({ desktopPanel: { label: '报告', roles: [], shortcuts: [shortcut] } })],
      'default'
    )
    expect(panels[0].shortcuts).toEqual([shortcut])
    expect(panels[0].shortcuts[0].preview).toEqual(preview)
  })

  test('treats a panel without shortcuts as having none', () => {
    const panels = selectPluginPanels([plugin({ desktopPanel: { label: '巡检' } })], '需求开发')
    expect(panels[0].shortcuts).toEqual([])
  })

  test('keeps the original shortcut shape when preview is absent', () => {
    const shortcut = { label: '检查', action: 'check' }
    const panels = selectPluginPanels(
      [plugin({ desktopPanel: { label: '巡检', roles: [], shortcuts: [shortcut] } })],
      'default'
    )
    expect(panels[0].shortcuts).toEqual([shortcut])
  })

  test('falls back to the plugin name, then the id, for the label', () => {
    expect(selectPluginPanels([plugin({ desktopPanel: { label: '' } })], '需求开发')[0].label).toBe(
      '需求开发'
    )
    expect(selectPluginPanels([plugin({ name: '', desktopPanel: {} })], '需求开发')[0].label).toBe(
      'user.demand-dev'
    )
  })

  test('survives a missing list', () => {
    expect(selectPluginPanels(null, '需求开发')).toEqual([])
    expect(selectPluginPanels([null, undefined, plugin()], '需求开发')).toHaveLength(1)
  })
})

describe('applyPanelResult', () => {
  const effects = () => {
    const seen = { composed: '', launched: null, dialog: null }
    return {
      seen,
      handlers: {
        onCompose: (text) => {
          seen.composed = text
        },
        onLaunchSession: (task) => {
          seen.launched = task
        },
        onDialog: (dialog) => {
          seen.dialog = dialog
        },
        onOpenPath: (path, line, options) => {
          seen.opened = { path, line, options }
        }
      }
    }
  }

  test('hands a composed prompt to the composer', () => {
    const { seen, handlers } = effects()
    applyPanelResult({ ok: true, compose: '看一眼群' }, handlers)
    expect(seen.composed).toBe('看一眼群')
    expect(seen.launched).toBeNull()
  })

  test('hands a new-session task to the host page', () => {
    const { seen, handlers } = effects()
    applyPanelResult({ ok: true, newSession: { prompt: '复盘', role: '需求开发' } }, handlers)
    expect(seen.launched).toEqual({ prompt: '复盘', role: '需求开发' })
    expect(seen.composed).toBe('')
  })

  test('hands a table dialog to the host page', () => {
    const { seen, handlers } = effects()
    const dialog = { title: '需求环境', columns: ['类型', '链接'], rows: [] }
    applyPanelResult({ ok: true, dialog }, handlers)
    expect(seen.dialog).toEqual(dialog)
    expect(seen.composed).toBe('')
    expect(seen.launched).toBeNull()
  })

  test('ignores a dialog without rows', () => {
    const { seen, handlers } = effects()
    applyPanelResult({ ok: true, dialog: { title: '空的' } }, handlers)
    expect(seen.dialog).toBeNull()
  })

  test('does nothing for a failed action', () => {
    const { seen, handlers } = effects()
    applyPanelResult(
      { ok: false, compose: 'x', newSession: { prompt: 'y' }, dialog: { rows: [] } },
      handlers
    )
    expect(seen).toEqual({ composed: '', launched: null, dialog: null })
  })

  test('opens a plugin file in the editor with its line', () => {
    const { seen, handlers } = effects()
    applyPanelResult(
      {
        ok: true,
        openPath: { path: '/Users/me/.mica/plugins/demand-dev/skills/a/SKILL.md', line: 12 }
      },
      handlers
    )
    expect(seen.opened).toEqual({
      path: '/Users/me/.mica/plugins/demand-dev/skills/a/SKILL.md',
      line: 12,
      options: { focus: false }
    })
  })

  test('passes the focus flag through so the host can hide the explorer', () => {
    const { seen, handlers } = effects()
    applyPanelResult(
      {
        ok: true,
        openPath: { path: '/Users/me/.mica/plugins/demand-dev/skills/a/SKILL.md', focus: true }
      },
      handlers
    )
    expect(seen.opened?.options).toEqual({ focus: true })
  })

  test('ignores an openPath without a path', () => {
    const { seen, handlers } = effects()
    applyPanelResult({ ok: true, openPath: { line: 3 } }, handlers)
    expect(seen.opened).toBeUndefined()
  })

  test('ignores blank or malformed payloads', () => {
    const { seen, handlers } = effects()
    applyPanelResult({ ok: true, compose: '   ', newSession: { prompt: 42 } }, handlers)
    applyPanelResult(null, handlers)
    expect(seen).toEqual({ composed: '', launched: null, dialog: null })
  })
})

describe('pluginPanelTabs', () => {
  test('一块分区一个页签，标题就是页签名', () => {
    const { tabs, activeIndex } = pluginPanelTabs(
      [{ title: '频道设置' }, { title: '需求描述' }, { title: '技能文件' }],
      undefined
    )
    expect(tabs.map((tab) => tab.label)).toEqual(['频道设置', '需求描述', '技能文件'])
    expect(activeIndex).toBe(0)
  })

  test('没有标题的分区按位置命名，不能出现点不到的页签', () => {
    const { tabs } = pluginPanelTabs([{}, { title: '' }], '')
    expect(tabs.map((tab) => tab.label)).toEqual(['第 1 项', '第 2 项'])
    expect(tabs.map((tab) => tab.key)).toEqual(['section-0', 'section-1'])
  })

  test('快捷按钮点名的那一块直接选中；名字失效时落回第一块', () => {
    const view = [{ title: '频道设置' }, { title: '技能文件' }]
    expect(pluginPanelTabs(view, '技能文件').activeIndex).toBe(1)
    expect(pluginPanelTabs(view, '已经删掉的分区').activeIndex).toBe(0)
    expect(pluginPanelTabs([], '技能文件').activeIndex).toBe(0)
  })

  // 两块分区可以同名（「设置」「环境」各一份很常见），页签必须各点得到。
  test('同名分区各有自己的 key，不会只打开第一块', () => {
    const view = [{ title: '设置' }, { title: '设置' }, { title: '环境' }]
    const { tabs, activeIndex } = pluginPanelTabs(view, '设置')
    expect(new Set(tabs.map((tab) => tab.key)).size).toBe(3)
    expect(tabs.map((tab) => tab.label)).toEqual(['设置', '设置', '环境'])
    expect(activeIndex).toBe(0)
  })
})

describe('isOpenableLink', () => {
  test('只认能交给系统浏览器的地址', () => {
    expect(isOpenableLink('https://prd.example/42')).toBe(true)
    expect(isOpenableLink('http://127.0.0.1:8080/x?a=1')).toBe(true)
    expect(isOpenableLink('mailto:a@b.com')).toBe(true)
    // 这些既不点、也不该被页面拿去导航
    expect(isOpenableLink('javascript:alert(1)')).toBe(false)
    expect(isOpenableLink('file:///etc/passwd')).toBe(false)
    expect(isOpenableLink('zhusu/pay')).toBe(false)
    expect(isOpenableLink('')).toBe(false)
    expect(isOpenableLink(undefined)).toBe(false)
  })
})

describe('quickbarMenuItems', () => {
  test('静态分组直接用清单里的子项', () => {
    const items = quickbarMenuItems(
      {
        label: '频道',
        items: [
          { label: '同步频道', action: 'check.now' },
          { label: '频道设置', section: '频道设置' }
        ]
      },
      null
    )
    expect(items.map((item) => item.label)).toEqual(['同步频道', '频道设置'])
  })

  test('清单里没有子项时就是空列表：动态菜单是表格，不走这一条', () => {
    expect(quickbarMenuItems({ label: 'PR', menu: 'reviews' })).toEqual([])
    expect(quickbarMenuItems({ label: '频道', items: 'nope' })).toEqual([])
  })
})

describe('quickbarMenuTable', () => {
  const table = {
    columns: [
      { key: 'project', label: '项目' },
      { key: 'branch', label: '分支', grow: true }
    ],
    rows: [
      { key: 'sass', action: 'review.open', cells: { project: { text: 'sass' } } },
      { cells: { project: { text: '缺动作' } } }
    ]
  }

  test('取视图里同名的那张表，缺 action 的行丢掉', () => {
    expect(quickbarMenuTable({ menus: { reviews: table } }, 'reviews')).toEqual({
      columns: table.columns,
      rows: [table.rows[0]]
    })
  })

  test('视图还没回来、菜单名不存在、形状不对都退化成空表', () => {
    const empty = { columns: [], rows: [] }
    expect(quickbarMenuTable(undefined, 'reviews')).toEqual(empty)
    expect(quickbarMenuTable({ menus: { other: table } }, 'reviews')).toEqual(empty)
    expect(
      quickbarMenuTable({ menus: { reviews: { columns: [], rows: table.rows } } }, 'reviews')
    ).toEqual(empty)
    expect(
      quickbarMenuTable({ menus: { reviews: { columns: table.columns, rows: [] } } }, 'reviews')
    ).toEqual(empty)
  })

  test('取视图里同名的那张表，缺 action 的行丢掉', () => {
    expect(quickbarMenuTable({ menus: { environment: table } }, 'environment')).toEqual({
      columns: table.columns,
      rows: [table.rows[0]]
    })
  })
})

describe('菜单缓存', () => {
  const key = menuCacheKey('node-1', 'user.demand-dev', 'reviews')

  test('TTL 内是新鲜的，过期只标 stale 不清空', () => {
    clearMenuCache()
    expect(readMenuCache(key)).toBeNull()
    writeMenuCache(key, { items: [{ label: 'mis · a' }], ready: true }, 1000)
    expect(readMenuCache(key, 2000)).toEqual({
      entry: { items: [{ label: 'mis · a' }], ready: true },
      stale: false
    })
    // 过期也照样给：先画出来再后台刷新，比让用户对着空菜单等一次请求好。
    expect(readMenuCache(key, 1000 + 60_000)).toEqual({
      entry: { items: [{ label: 'mis · a' }], ready: true },
      stale: true
    })
  })

  test('按会话隔离：换会话不拿上一个会话的分支', () => {
    clearMenuCache()
    const other = menuCacheKey('node-2', 'user.demand-dev', 'reviews')
    writeMenuCache(key, { items: [{ label: 'mis · a' }], ready: true })
    writeMenuCache(other, { items: [{ label: 'sass · b' }], ready: true })
    expect(readMenuCache(key)?.entry.items[0].label).toBe('mis · a')
    expect(readMenuCache(other)?.entry.items[0].label).toBe('sass · b')
  })
})

describe('面板视图缓存', () => {
  test('view identity includes node, session, cwd and role', () => {
    const context = panelViewContext('node', 'session', '/repo', 'role')
    writePanelView(context, 'plugin', { title: 'Current' })
    expect(readPanelView(context, 'plugin')?.view.title).toBe('Current')
    for (const identity of [
      panelViewContext('other', 'session', '/repo', 'role'),
      panelViewContext('node', 'other', '/repo', 'role'),
      panelViewContext('node', 'session', '/other', 'role'),
      panelViewContext('node', 'session', '/repo', 'other')
    ]) expect(readPanelView(identity, 'plugin')).toBeNull()
    expect(panelViewContext('node', 'session', '/repo', '')).toBe(
      panelViewContext('node', 'session', '/repo', 'default'))
  })

  test('fresh data replaces seeded values but preserves typing, including cleared fields', () => {
    const baseline = { '0:name': 'seed', '0:password': '', '1:host': 'old' }
    const fresh = { '0:name': 'fresh', '0:password': '', '1:host': 'new', '1:port': '22' }
    expect(reconcilePanelDrafts(baseline, baseline, fresh)).toEqual(fresh)
    expect(reconcilePanelDrafts({ ...baseline, '0:name': '', '0:password': 'typed' }, baseline, fresh))
      .toEqual({ ...fresh, '0:name': '', '0:password': 'typed' })
    expect(reconcilePanelDrafts({ '0:name': 'typed before first read' }, {}, fresh)['0:name'])
      .toBe('typed before first read')
  })

  test('抽屉打开时先画缓存的那一份，过期的也照画', () => {
    const context = panelViewContext('node-9', 'session-9', '/repo', 'default')
    expect(readPanelView(context, 'user.demand-dev')).toBeNull()
    writePanelView(context, 'user.demand-dev', { title: '需求开发', sections: [] }, 1000)
    expect(readPanelView(context, 'user.demand-dev', 2000)).toEqual({
      view: { title: '需求开发', sections: [] },
      stale: false
    })
    expect(readPanelView(context, 'user.demand-dev', 1000 + 60_000)?.stale).toBe(true)
  })

  test('草稿取每个输入框的初值，按分区隔离，缺省为空串', () => {
    const drafts = panelDrafts({
      sections: [
        { fields: [{ key: 'url', value: 'http://x' }, { key: 'target' }] },
        { rows: [{ label: 'a', value: 'b' }] }
      ]
    })
    expect(drafts).toEqual({ '0:url': 'http://x', '0:target': '' })
    expect(panelDrafts(null)).toEqual({})
  })

  test('两块分区都叫「地址」时各存各的，动作只带自己那块的字段', () => {
    const drafts = panelDrafts({
      sections: [
        { fields: [{ key: 'host', value: 'prod' }] },
        { fields: [{ key: 'host', value: 'test' }] }
      ]
    })
    expect(drafts).toEqual({ '0:host': 'prod', '1:host': 'test' })
    expect(sectionDrafts(drafts, 0)).toEqual({ host: 'prod' })
    expect(sectionDrafts({ ...drafts, '1:host': 'edited' }, 1)).toEqual({ host: 'edited' })
    // 没有作用域时不把带序号的内部键交给插件。
    expect(sectionDrafts(drafts, 2)).toEqual({})
  })
})

describe('panel auto-commit queue', () => {
  const harness = () => {
    const timers = new Map()
    const calls = []
    const releases = []
    let next = 0
    const queue = createPanelActionQueue((task) => {
      calls.push(task)
      return new Promise((resolve) => releases.push(resolve))
    }, {
      schedule: (callback) => { timers.set(++next, callback); return next },
      cancel: (timer) => timers.delete(timer)
    })
    return {
      queue, calls, releases,
      tick() {
        const callbacks = [...timers.values()]
        timers.clear()
        for (const callback of callbacks) callback()
      },
      async complete(result = { ok: true }) {
        releases.shift()(result)
        await Promise.resolve()
        await Promise.resolve()
      }
    }
  }

  test('serializes requests and commits only the latest pending value after a busy save', async () => {
    const h = harness()
    h.queue.commit(0, 'first')
    h.tick()
    h.queue.commit(0, 'second')
    h.tick()
    h.queue.commit(0, 'latest')
    h.tick()
    expect(h.calls).toEqual(['first'])
    await h.complete()
    expect(h.calls).toEqual(['first', 'latest'])
    await h.complete()
  })

  test('flush on section switch or close submits debounced tail and keeps other sections', async () => {
    const h = harness()
    h.queue.commit(0, 'section zero')
    h.queue.commit(1, 'section one')
    h.queue.flush(0)
    expect(h.calls).toEqual(['section zero'])
    h.queue.flush()
    await h.complete()
    expect(h.calls).toEqual(['section zero', 'section one'])
    await h.complete()
    h.tick()
    expect(h.calls).toHaveLength(2)
  })

  test('connect or cancel discards that section pending draft rather than replaying it afterwards', async () => {
    const h = harness()
    h.queue.commit(0, 'in-flight draft')
    h.tick()
    h.queue.commit(0, 'obsolete pending draft')
    h.tick()
    const action = h.queue.action(0, 'connect')
    h.queue.flush()
    await h.complete()
    expect(h.calls).toEqual(['in-flight draft', 'connect'])
    await h.complete()
    expect(await action).toEqual({ ok: true })
    h.tick()
    expect(h.calls).toHaveLength(2)
  })

  test('a failed save does not swallow newer edits or block later explicit actions', async () => {
    const h = harness()
    h.queue.commit(0, 'first')
    h.tick()
    h.queue.commit(0, 'new input')
    h.tick()
    await h.complete({ ok: false })
    expect(h.calls).toEqual(['first', 'new input'])
    await h.complete()
    const action = h.queue.action(0, 'cancel')
    await h.complete()
    expect(await action).toEqual({ ok: true })
  })
})

describe('applyPanelResult openReview', () => {
  test('把副本与基线交给页面，不认识的形状直接忽略', () => {
    const seen = []
    const handlers = { onOpenReview: (review) => seen.push(review) }
    applyPanelResult(
      { ok: true, openReview: { cwd: '/tmp/wt', base: 'master', label: 'mica · demand-a' } },
      handlers
    )
    applyPanelResult({ ok: true, openReview: { base: 'master' } }, handlers)
    applyPanelResult({ ok: false, openReview: { cwd: '/tmp/x' } }, handlers)
    // 插件没点名基线时不补 `master`：交给 Git 侧按仓库的远端默认分支解析。
    applyPanelResult({ ok: true, openReview: { cwd: '/tmp/wt2' } }, handlers)
    expect(seen).toEqual([
      { cwd: '/tmp/wt', base: 'master', label: 'mica · demand-a' },
      { cwd: '/tmp/wt2' }
    ])
  })
})

describe('loadPluginPanels', () => {
  const sleep = async () => {}

  test('第一次读到空清单时退避重试，拿到面板就停', async () => {
    const reads = [[], [plugin()]]
    const slept = []
    const panels = await loadPluginPanels('需求开发', {
      read: async () => reads.shift() ?? [],
      delays: [1500, 4000],
      sleep: async (ms) => {
        slept.push(ms)
      }
    })
    expect(panels.map((panel) => panel.id)).toEqual(['user.demand-dev'])
    expect(slept).toEqual([1500])
  })

  test('一直读不到就按规定次数放弃，不无限重试', async () => {
    let calls = 0
    const panels = await loadPluginPanels('需求开发', {
      read: async () => {
        calls += 1
        return []
      },
      delays: [1500, 4000],
      sleep
    })
    expect(panels).toEqual([])
    expect(calls).toBe(3)
  })

  test('角色不命中时重试几次后返回空，清单命中缓存因此不多打请求', async () => {
    let calls = 0
    const panels = await loadPluginPanels('default', {
      read: async () => {
        calls += 1
        return [plugin()]
      },
      delays: [1500, 4000],
      sleep
    })
    expect(panels).toEqual([])
    expect(calls).toBe(3)
  })

  test('组件卸载后不再继续重试', async () => {
    let alive = true
    let calls = 0
    const panels = await loadPluginPanels('需求开发', {
      read: async () => {
        calls += 1
        alive = false
        return []
      },
      delays: [1500, 4000],
      sleep,
      isAlive: () => alive
    })
    expect(panels).toEqual([])
    expect(calls).toBe(1)
  })
})

/**
 * 快捷条、状态行、抽屉入口是同一棵树里的三个消费方：底层那份清单只该读一次、
 * 退避重试只该跑一条，最后一个挂载点走了才收尾。store 不碰 DOM，所以直接驱动它。
 */
describe('插件面板清单在挂载点之间共享', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  test('两个消费方共用一次读取，最后一份卸载才停', async () => {
    let reads = 0
    let fire = null
    const sources = new Set()
    const store = createPluginPanelsStore({
      // 每读一次换一个标题：内容变了才该发通知，也才看得出第二次读取真的落到了还挂着的人。
      read: async () => {
        reads += 1
        return [plugin({ desktopPanel: { label: `需求开发 ${reads}`, roles: ['需求开发'] } })]
      },
      delays: [],
      subscribeSource: (listener) => {
        sources.add(listener)
        fire = listener
        return () => {
          sources.delete(listener)
          if (fire === listener) fire = null
        }
      },
      // 空清单的 15 秒续读不参与这个用例。
      schedule: () => 0,
      cancel: () => {}
    })

    let firstViewed = 0
    let secondViewed = 0
    const leaveFirst = store.subscribe('需求开发', () => {
      firstViewed += 1
    })
    const leaveSecond = store.subscribe('需求开发', () => {
      secondViewed += 1
    })

    await flush()
    expect(reads).toBe(1)
    expect(sources.size).toBe(1)
    expect(store.get('需求开发').map((panel) => panel.id)).toEqual(['user.demand-dev'])
    expect(firstViewed).toBe(1)
    expect(secondViewed).toBe(1)

    // 一份卸载：另一份照样收得到更新，清单订阅也不必重订。
    leaveFirst()
    expect(sources.size).toBe(1)
    fire()
    await flush()
    expect(reads).toBe(2)
    expect(firstViewed).toBe(1)
    expect(secondViewed).toBe(2)
    expect(store.get('需求开发')[0].label).toBe('需求开发 2')

    // 最后一份走了：清单订阅收掉，不再有人读。
    leaveSecond()
    expect(sources.size).toBe(0)
    expect(fire).toBeNull()
    await flush()
    expect(reads).toBe(2)
  })

  test('按角色分开缓存：换角色不会串面板', async () => {
    let reads = 0
    const store = createPluginPanelsStore({
      read: async () => {
        reads += 1
        return [plugin()]
      },
      delays: [],
      subscribeSource: () => () => {},
      schedule: () => 0,
      cancel: () => {}
    })
    store.subscribe('default', () => {})
    store.subscribe('需求开发', () => {})
    await flush()
    expect(reads).toBe(2)
    expect(store.get('default')).toEqual([])
    expect(store.get('需求开发').map((panel) => panel.id)).toEqual(['user.demand-dev'])
  })
})

describe('pluginQuickbarItems', () => {
  const panel = (overrides = {}) => ({
    id: 'quick-buttons',
    label: '快捷按钮',
    shortcuts: [],
    ...overrides
  })

  test('清单里的按钮在前，视图给的按钮在后', () => {
    const items = pluginQuickbarItems(
      [panel({ shortcuts: [{ label: '管理', section: '按钮' }] })],
      { 'quick-buttons': [{ id: 'open-doc', label: '打开需求单', action: 'run' }] }
    )
    expect(items.map((item) => item.shortcut.label)).toEqual(['管理', '打开需求单'])
    // 每个面板的第一颗带分隔标记，换到另一个插件的按钮时才画竖线
    expect(items.map((item) => item.first)).toEqual([true, false])
  })

  test('运行期的按钮 key 带 view: 前缀，不会和清单里同 id 的按钮撞成同一个 key', () => {
    const items = pluginQuickbarItems(
      [panel({ shortcuts: [{ id: 'open-doc', label: '清单', action: 'run' }] })],
      { 'quick-buttons': [{ id: 'open-doc', label: '视图', action: 'run' }] }
    )
    expect(items.map((item) => item.key)).toEqual([
      'quick-buttons:open-doc',
      'quick-buttons:view:open-doc'
    ])
  })

  test('没有视图按钮时原样返回清单里的那些', () => {
    expect(pluginQuickbarItems([panel({ shortcuts: [{ label: '检查', action: 'check' }] })], {})).toHaveLength(1)
    expect(pluginQuickbarItems([], null)).toEqual([])
  })
})

describe('quickbarButtonLook', () => {
  test('没有外观规格时就是原来那颗描边胶囊', () => {
    const look = quickbarButtonLook({ label: '检查', action: 'check' }, { panelLabel: 'SSH' })
    expect(look.className).toBe('chat-plugin-quickbar-button is-primary')
    expect(look.icon).toBe('')
    expect(look.iconOnly).toBe(false)
    expect(look.title).toBe('SSH · 检查')
    expect(look.ariaLabel).toBeUndefined()
  })

  test('颜色与形状翻成主题类名（色值由 CSS 变量决定，暗色亮色各一套）', () => {
    const look = quickbarButtonLook(
      { label: '打开', action: 'run', style: { color: 'accent', shape: 'soft' } },
      { panelLabel: '快捷按钮' }
    )
    expect(look.className).toContain('color-accent')
    expect(look.className).toContain('shape-soft')
    // 默认形状 pill 不另加类：默认样式就是描边胶囊
    expect(
      quickbarButtonLook({ label: 'x', action: 'run', style: { shape: 'pill' } }).className
    ).not.toContain('shape-')
  })

  test('纯图标时把文字退回无障碍名，没有图标就退回带文字', () => {
    const iconOnly = quickbarButtonLook({
      label: '打开',
      action: 'run',
      style: { icon: 'globe', iconOnly: true }
    })
    expect(iconOnly.iconOnly).toBe(true)
    expect(iconOnly.className).toContain('is-icon-only')
    expect(iconOnly.ariaLabel).toBe('打开')

    const noIcon = quickbarButtonLook({ label: '打开', action: 'run', style: { iconOnly: true } })
    expect(noIcon.iconOnly).toBe(false)
    expect(noIcon.className).not.toContain('is-icon-only')
  })

  test('状态类跟着运行态走，分区按钮的提示写「打开 / 收起」', () => {
    const busy = quickbarButtonLook({ label: '检查', action: 'check' }, { busy: true })
    expect(busy.className).toContain('is-busy')
    const section = quickbarButtonLook({ label: '设置', section: '按钮' }, { active: true })
    expect(section.className).toContain('is-active')
    expect(section.title).toBe('收起「设置」')
  })
})
