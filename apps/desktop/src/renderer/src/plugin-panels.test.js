import { describe, expect, test } from 'bun:test'
import { applyPanelResult, selectPluginPanels } from './plugin-panels'

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
      { id: 'user.demand-dev', label: '巡检', icon: 'messages-square', shortcuts: [] }
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

  test('ignores blank or malformed payloads', () => {
    const { seen, handlers } = effects()
    applyPanelResult({ ok: true, compose: '   ', newSession: { prompt: 42 } }, handlers)
    applyPanelResult(null, handlers)
    expect(seen).toEqual({ composed: '', launched: null, dialog: null })
  })
})
