import { describe, expect, test } from 'bun:test'
import { applyPanelResult, pluginPanelTabs, selectPluginPanels } from './plugin-panels'

const plugin = (overrides = {}) => ({
  id: 'user.demand-dev',
  name: '需求开发',
  icon: 'messages-square',
  state: 'enabled',
  desktopPanel: { label: '需求开发', roles: ['需求开发'], shortcuts: [] },
  ...overrides
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
        shortcuts: []
      }
    ])
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

  test('treats a panel without shortcuts as having none', () => {
    const panels = selectPluginPanels([plugin({ desktopPanel: { label: '巡检' } })], '需求开发')
    expect(panels[0].shortcuts).toEqual([])
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
})
