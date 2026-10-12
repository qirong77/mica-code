import { describe, expect, it } from 'bun:test'
import { statusLinePhase } from './ChatView'

// 状态行的阶段与它的耗时是同一份判定：阶段文本由 statusLinePhase 决定，计时锚点也按它取
// （working 取最早 running 工具的 startedAt，其余阶段取阶段起点）。这条规则得能挡住
// 「工具结果回来后 phase 仍是 working」那种回归——那时既会显示成 calling_tool，又会因为
// 没有 running 工具而把整段时间隐藏掉。
describe('statusLinePhase', () => {
  it('settles back to waiting_model once no tool is in flight', () => {
    expect(statusLinePhase('working', [])).toBe('connecting')
  })

  it('keeps the working phase while a tool is running', () => {
    expect(statusLinePhase('working', ['run_shell'])).toBe('working')
    expect(statusLinePhase('working', ['read_file', 'grep_search'])).toBe('working')
  })

  it('leaves the other phases untouched', () => {
    for (const phase of ['idle', 'connecting', 'thinking', 'streaming', 'stopping', 'error']) {
      expect(statusLinePhase(phase, [])).toBe(phase)
      expect(statusLinePhase(phase, ['run_shell'])).toBe(phase)
    }
  })

  it('does not treat a missing tool list as "no tools"', () => {
    expect(statusLinePhase('working', undefined)).toBe('connecting')
  })
})
