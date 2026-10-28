import { describe, expect, it } from 'bun:test'
import { resolveDisplayedEffort } from './ChatView'

// 状态行显示的档位必须等于这一轮真正会发出去的档位：
// host 每轮用 normalizeModelEffort 收敛，界面不能显示一个不会发送的值。
describe('status line effort display', () => {
  it('keeps the current level when the model declares it', () => {
    expect(resolveDisplayedEffort('high', ['none', 'low', 'high', 'max'], 'high')).toBe('high')
    expect(resolveDisplayedEffort('max', ['none', 'low', 'high', 'max'], 'high')).toBe('max')
  })

  it('shows the model default when the current level is not one of its levels', () => {
    // kimi-k2.6：开关型，只有 none/on；会话留下的 high 会被 host 收敛成 on。
    expect(resolveDisplayedEffort('high', ['none', 'on'], 'on')).toBe('on')
  })

  it('shows a dash when the model has no effort selection at all', () => {
    expect(resolveDisplayedEffort('medium', [], null)).toBe('—')
  })

  it('does not invent a level when the catalog is missing or has no default', () => {
    expect(resolveDisplayedEffort('medium', undefined, 'high')).toBe('medium')
    expect(resolveDisplayedEffort('medium', ['none', 'low'], null)).toBe('—')
  })
})
