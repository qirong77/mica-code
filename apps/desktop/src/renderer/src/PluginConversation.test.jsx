import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as rootReact from '../../../../../node_modules/react/index.js'
mock.module(import.meta.dir + '/../../../node_modules/react/index.js', () => rootReact)
import { createElement } from '../../../../../node_modules/react/index.js'
import { renderToStaticMarkup } from '../../../../../node_modules/react-dom/server.node.js'
const { PluginConversation, createPluginConversation } = await import('./PluginConversation')

describe('PluginConversation', () => {
  test('the plugin component is bound to the host API and scopes are separate React instances', () => {
    const api = { pluginId: 'sample', sessions: {} }
    const callbacks = { createSession: () => 'node' }
    const Conversation = createPluginConversation(api, callbacks)
    const element = Conversation({ scope: 'note:one', visible: false })
    expect(element.props.api).toBe(api)
    expect(element.props.hostCallbacks).toBe(callbacks)
    expect(element.key).toBe('note:one')
  })
  test('has a useful SSR empty state without a chat host or browser globals', () => {
    const html = renderToStaticMarkup(
      createElement(PluginConversation, {
        api: { pluginId: 'sample', sessions: null },
        scope: 'stable-scope',
        visible: true
      })
    )
    expect(html).toContain('新建对话')
    expect(html).toContain('这个范围还没有 Mica 对话')
    expect(html).not.toContain('正在加载 Mica 对话')
  })

  test('exposes the reference label and keeps the full ChatView lazy', () => {
    const text = readFileSync(new URL('./PluginConversation.jsx', import.meta.url), 'utf8')
    expect(text).toContain("lazyView(() => import('./ChatView'), 'ChatView')")
    expect(text).toContain('appendConversationDraft')
    expect(text).toContain("reference.label || '引用当前范围'")
  })
})
