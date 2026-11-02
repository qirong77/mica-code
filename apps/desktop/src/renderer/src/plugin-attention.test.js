import { describe, expect, it } from 'bun:test'
import { pickPluginAttention } from './plugin-attention'

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
})
