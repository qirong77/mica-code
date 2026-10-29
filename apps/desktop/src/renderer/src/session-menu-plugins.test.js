import { describe, expect, test } from 'bun:test'
import { parseSessionMenuAction, sessionMenuPluginItems } from './session-menu-plugins'

const plugin = (overrides = {}) => ({
  id: 'session-copy',
  name: 'Copy Session',
  icon: 'file-text',
  state: 'enabled',
  desktopSessionMenu: [{ label: '复制会话 Markdown', action: 'copy' }],
  ...overrides
})

describe('sessionMenuPluginItems', () => {
  test('lists enabled plugins that declare menu items', () => {
    const items = sessionMenuPluginItems([
      plugin(),
      plugin({ id: 'disabled', state: 'disabled' }),
      plugin({ id: 'no-menu', desktopSessionMenu: [] })
    ])
    expect(items).toEqual([
      {
        action: 'session-menu:session-copy:copy',
        label: '复制会话 Markdown',
        pluginId: 'session-copy',
        pluginAction: 'copy'
      }
    ])
  })

  test('keeps the label and action from every declared item', () => {
    const items = sessionMenuPluginItems([
      plugin({
        desktopSessionMenu: [
          { label: '复制 Markdown', action: 'copy' },
          { label: '复制纯文本', action: 'copy-plain' }
        ]
      })
    ])
    expect(items.map((item) => item.action)).toEqual([
      'session-menu:session-copy:copy',
      'session-menu:session-copy:copy-plain'
    ])
  })

  test('skips malformed entries instead of rendering a dead menu row', () => {
    const items = sessionMenuPluginItems([
      plugin({ desktopSessionMenu: [{ label: '复制' }, { action: 'copy' }, null] })
    ])
    expect(items).toEqual([])
  })

  test('tolerates missing data', () => {
    expect(sessionMenuPluginItems(undefined)).toEqual([])
    expect(sessionMenuPluginItems([plugin({ desktopSessionMenu: undefined })])).toEqual([])
  })
})

describe('parseSessionMenuAction', () => {
  test('splits plugin id from action', () => {
    expect(parseSessionMenuAction('session-menu:user.demand-dev:copy')).toEqual({
      pluginId: 'user.demand-dev',
      action: 'copy'
    })
    expect(parseSessionMenuAction('session-menu:session-copy:copy-plain')).toEqual({
      pluginId: 'session-copy',
      action: 'copy-plain'
    })
  })

  test('returns null for actions that belong to something else', () => {
    expect(parseSessionMenuAction('annotation:session-tags:red')).toBeNull()
    expect(parseSessionMenuAction('pin')).toBeNull()
    expect(parseSessionMenuAction('session-menu:')).toBeNull()
    expect(parseSessionMenuAction('session-menu:only-plugin')).toBeNull()
    expect(parseSessionMenuAction('session-menu:plugin:')).toBeNull()
    expect(parseSessionMenuAction(undefined)).toBeNull()
  })
})
