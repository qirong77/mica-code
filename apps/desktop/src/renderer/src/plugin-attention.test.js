import { describe, expect, it } from 'bun:test'
import { attentionFingerprint, pickPluginAttention } from './plugin-attention'

/**
 * 侧栏提示点只由插件自己上报的 `attention` 决定。
 *
 * 这里只测「挑哪一条」：宿主不认识任何插件，多一条规则就意味着下次要为某个插件改页面。
 */

const enabled = (id, attention) => ({ id, name: id, state: 'enabled', attention })

describe('pickPluginAttention', () => {
  it('returns null when nothing is reported', () => {
    expect(pickPluginAttention([enabled('a', null), { id: 'b', state: 'enabled' }])).toBeNull()
    expect(pickPluginAttention(null)).toBeNull()
  })

  it('ignores disabled plugins and empty text', () => {
    expect(
      pickPluginAttention([
        {
          id: 'off',
          name: 'off',
          state: 'disabled',
          attention: { text: '页面落后', tone: 'warn' }
        },
        enabled('blank', { text: '   ', tone: 'warn' })
      ])
    ).toBeNull()
  })

  it('carries the plugin id, text and tone through', () => {
    const picked = pickPluginAttention([
      enabled('mobile-relay', { text: ' 手机端页面落后 ', tone: 'error', action: 'sync-page' })
    ])
    expect(picked).toEqual({
      pluginId: 'mobile-relay',
      pluginName: 'mobile-relay',
      text: '手机端页面落后',
      tone: 'error'
    })
  })

  it('falls back to warn for an unknown tone and takes the first one reported', () => {
    const picked = pickPluginAttention([
      enabled('first', { text: '先看到的', tone: 'weird' }),
      enabled('second', { text: '后看到的', tone: 'warn' })
    ])
    expect(picked?.pluginId).toBe('first')
    expect(picked?.tone).toBe('warn')
  })

  // 同一对版本只点一次：点开过的那条（记在本地，按插件 + 文案去重）不再点亮侧栏。
  // 文案里带着版本号，所以本机重新构建 / 中转机换了一份时是另一条提示，会重新出现。
  it('skips the one the user already opened', () => {
    const plugins = [
      enabled('mobile-relay', { text: '手机端页面落后（本机 a，中转机 b）', tone: 'warn' }),
      enabled('other', { text: '另一件事', tone: 'warn' })
    ]
    const seen = [attentionFingerprint({ pluginId: 'mobile-relay', text: '手机端页面落后（本机 a，中转机 b）' })]

    expect(pickPluginAttention(plugins, seen)?.pluginId).toBe('other')
    expect(pickPluginAttention(plugins, ['mobile-relay:手机端页面落后（本机 a，中转机 c）'])?.pluginId).toBe(
      'mobile-relay'
    )
  })

  it('fingerprints only complete attentions', () => {
    expect(attentionFingerprint({ pluginId: 'p', text: 't' })).toBe('p:t')
    expect(attentionFingerprint({ pluginId: 'p' })).toBe('')
    expect(attentionFingerprint(null)).toBe('')
  })
})
