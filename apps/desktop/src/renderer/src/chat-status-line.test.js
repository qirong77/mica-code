import { describe, expect, it } from 'bun:test'
import { retryNoticeText, retryStatusLabel, statusLinePhase } from './ChatView'

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

// host 内部重试期间没有别的进度信号：这两段文案是「在等，不是卡死」的唯一证据。
describe('retry labels', () => {
  const retry = { attempt: 2, maxAttempts: 5, delayMs: 10000, error: 'provider 503' }

  it('shows the attempt out of the cap plus the wait in seconds', () => {
    expect(retryStatusLabel(retry)).toBe('retrying 2/5 · 10s')
    expect(retryStatusLabel({ ...retry, delayMs: 2500 })).toBe('retrying 2/5 · 3s')
    expect(retryStatusLabel(null)).toBe('')
  })

  it('keeps the notice text in the CLI wording and appends the error', () => {
    expect(retryNoticeText(retry)).toBe(
      '请求暂时失败，将在 10s 后自动重试（第 2/5 次）\n错误：provider 503'
    )
    expect(retryNoticeText({ ...retry, error: '' })).toBe(
      '请求暂时失败，将在 10s 后自动重试（第 2/5 次）'
    )
  })
})
