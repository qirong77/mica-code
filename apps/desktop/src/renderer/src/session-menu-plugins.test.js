import { describe, expect, test } from 'bun:test'
import {
  parseSessionMenuAction,
  runSessionMenuPluginAction,
  sessionMenuPluginItems
} from './session-menu-plugins'

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
      pluginAction: 'copy'
    })
    expect(parseSessionMenuAction('session-menu:session-copy:copy-plain')).toEqual({
      pluginId: 'session-copy',
      pluginAction: 'copy-plain'
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

describe('runSessionMenuPluginAction', () => {
  const item = { pluginId: 'session-copy', pluginAction: 'copy' }
  const target = { id: 'tab-1', sessionId: 's-1', cwd: '/tmp/repo' }

  test('forwards the action to the host and copies the returned text', async () => {
    const calls = []
    const copied = []
    const result = await runSessionMenuPluginAction({
      item,
      target,
      run: async (payload) => {
        calls.push(payload)
        return { ok: true, copyText: '# 标题', message: '已复制 2 条对话' }
      },
      copy: async (text) => {
        copied.push(text)
        return true
      }
    })
    expect(calls).toEqual([
      { id: 'tab-1', pluginId: 'session-copy', action: 'copy', sessionId: 's-1', cwd: '/tmp/repo' }
    ])
    expect(copied).toEqual(['# 标题'])
    expect(result).toEqual({ ok: true, message: '已复制 2 条对话' })
  })

  test('defaults the message when the plugin copied without one', async () => {
    const result = await runSessionMenuPluginAction({
      item,
      target,
      run: async () => ({ ok: true, copyText: 'x' }),
      copy: async () => true
    })
    expect(result).toEqual({ ok: true, message: '已复制到剪贴板' })
  })

  test('surfaces a clipboard failure as an error instead of a silent no-op', async () => {
    const result = await runSessionMenuPluginAction({
      item,
      target,
      run: async () => ({ ok: true, copyText: 'x' }),
      copy: async () => false
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('剪贴板')
  })

  test('does not show the plugin success message when the clipboard write fails', async () => {
    const result = await runSessionMenuPluginAction({
      item,
      target,
      run: async () => ({ ok: true, copyText: '# 会话', message: '已复制会话 Markdown' }),
      copy: async () => false
    })
    expect(result).toEqual({ ok: false, message: '复制失败：剪贴板不可用' })
  })

  test('reports host rejections and thrown transport errors', async () => {
    const rejected = await runSessionMenuPluginAction({
      item,
      target,
      run: async () => ({ ok: false, error: '会话正在运行' }),
      copy: async () => true
    })
    expect(rejected).toEqual({ ok: false, message: '会话正在运行' })

    const thrown = await runSessionMenuPluginAction({
      item,
      target,
      run: async () => {
        throw new Error('host 不在')
      },
      copy: async () => true
    })
    expect(thrown.ok).toBe(false)
    expect(thrown.message).toContain('host 不在')
  })

  test('rejects an item without a plugin action', async () => {
    const result = await runSessionMenuPluginAction({ item: { pluginId: 'x' }, target })
    expect(result).toEqual({ ok: false, message: '插件动作无效' })
  })
})
