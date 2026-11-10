import { describe, expect, test } from 'bun:test'
import {
  parseSessionMenuAction,
  retainPendingMenuNotices,
  runSessionMenuPluginAction,
  runSessionMenuPluginActionWithNotice,
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
        pluginAction: 'copy',
        icon: 'file-text'
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

  // 摆位随清单一路带到菜单构建处：宿主不认识「谁该在最上面」，只看这个字段
  test('carries the declared position through', () => {
    const items = sessionMenuPluginItems([
      plugin({
        desktopSessionMenu: [
          { label: '快速压缩', action: 'quick', position: 'top' },
          { label: '复制', action: 'copy' }
        ]
      })
    ])
    expect(items.map((item) => item.position)).toEqual(['top', undefined])
  })

  // 同一个插件的好几项共用插件图标就分不出哪一行是哪件事，所以按行声明优先
  test('prefers the per-item icon and falls back to the plugin icon', () => {
    const items = sessionMenuPluginItems([
      plugin({
        desktopSessionMenu: [
          { label: '快速压缩', action: 'quick', icon: 'eraser' },
          { label: '复制', action: 'copy' }
        ]
      })
    ])
    expect(items.map((item) => item.icon)).toEqual(['eraser', 'file-text'])
  })

  test('leaves the icon out when neither the item nor the plugin declares one', () => {
    const items = sessionMenuPluginItems([
      plugin({ icon: '', desktopSessionMenu: [{ label: '复制', action: 'copy' }] })
    ])
    expect(items[0]).not.toHaveProperty('icon')
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

  // 两处右键共用一份清单：只对某一处生效的项必须在取项时就被过滤掉，否则侧栏会话行
  // 也会出现「快速压缩」这类只在正看着对话时讲得通的项。
  test('keeps items that do not name a surface in both menus', () => {
    const items = [plugin()]
    expect(sessionMenuPluginItems(items, 'sidebar').map((item) => item.pluginAction)).toEqual(['copy'])
    expect(sessionMenuPluginItems(items, 'chat').map((item) => item.pluginAction)).toEqual(['copy'])
  })

  test('drops items declared for the other surface', () => {
    const items = [
      plugin({
        desktopSessionMenu: [
          { label: '快速压缩', action: 'quick', surface: 'chat' },
          { label: '复制', action: 'copy' }
        ]
      })
    ]
    expect(sessionMenuPluginItems(items, 'sidebar').map((item) => item.pluginAction)).toEqual(['copy'])
    expect(sessionMenuPluginItems(items, 'chat').map((item) => item.pluginAction)).toEqual(['quick', 'copy'])
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

describe('runSessionMenuPluginActionWithNotice', () => {
  test('shows progress before a slow model action resolves, then updates the same notice', async () => {
    const notices = []
    const pending = new Set()
    let finish
    const run = () => new Promise((resolve) => { finish = resolve })
    const action = runSessionMenuPluginActionWithNotice({
      item: { pluginId: 'session-compact', pluginAction: 'model', label: '模型压缩' },
      target: { sessionId: 's-1' },
      run,
      appendNotice: (text, variant) => {
        notices.push({ text, variant })
        return 'notice-1'
      },
      updateNotice: (id, text, variant) => notices.push({ id, text, variant }),
      onPendingChange: (id, active) => active ? pending.add(id) : pending.delete(id)
    })
    expect(notices).toEqual([{ text: '正在模型压缩…', variant: 'info' }])
    expect(pending.has('notice-1')).toBe(true)
    finish({ ok: true, message: '模型压缩完成' })
    expect(await action).toEqual({ ok: true, message: '模型压缩完成' })
    expect(notices[1]).toEqual({ id: 'notice-1', text: '模型压缩完成', variant: 'info' })
    expect(pending.size).toBe(0)
  })

  test('updates progress to an error and clears the pending marker when the host rejects', async () => {
    const notices = []
    const pending = new Set()
    const result = await runSessionMenuPluginActionWithNotice({
      item: { pluginId: 'session-compact', pluginAction: 'model', label: '模型压缩' },
      run: async () => { throw new Error('请求超时') },
      appendNotice: (text, variant) => {
        notices.push({ text, variant })
        return 'notice-2'
      },
      updateNotice: (id, text, variant) => notices.push({ id, text, variant }),
      onPendingChange: (id, active) => active ? pending.add(id) : pending.delete(id)
    })
    expect(result.ok).toBe(false)
    expect(notices[1]).toEqual({ id: 'notice-2', text: '插件动作失败：请求超时', variant: 'error' })
    expect(pending.size).toBe(0)
  })
})

test('history replacement keeps queued prompts and pending menu progress, not old notices', () => {
  const queued = { id: 'queued', queued: true }
  const pending = { id: 'progress', kind: 'notice', text: '正在模型压缩…' }
  const old = { id: 'old', kind: 'notice' }
  expect(retainPendingMenuNotices([old, queued, pending], new Set(['progress']))).toEqual([
    queued, pending
  ])
})
