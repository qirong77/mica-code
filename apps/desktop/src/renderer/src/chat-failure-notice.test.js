import { describe, expect, it } from 'bun:test'
import { turnFailureExplained } from './ChatView'

// 一条失败只能有一行：host 写完「请求失败（已重试 10/10 次）：原因」之后，
// turn/completed 透传的同一句错误不能又贴一条。
describe('turnFailureExplained', () => {
  const hostNotice = {
    id: 'notice-1',
    kind: 'notice',
    role: 'notice',
    variant: 'error',
    text: '请求失败（已重试 10/10 次）\n错误：The socket connection was closed unexpectedly（HTTP 502）'
  }

  it('treats the error already described by the last notice as explained', () => {
    expect(
      turnFailureExplained([{ id: 'a', kind: 'message' }, hostNotice], 'The socket connection was closed unexpectedly')
    ).toBe(true)
  })

  it('still shows a failure the host never wrote', () => {
    expect(turnFailureExplained([{ id: 'a', kind: 'message' }], 'the host crashed')).toBe(false)
  })

  it('does not let an older failure swallow a new, unrelated one', () => {
    expect(turnFailureExplained([hostNotice], 'Unknown model: foo')).toBe(false)
  })

  it('only dedupes against an error notice, not a successful retry', () => {
    const success = { ...hostNotice, variant: 'success' }
    expect(turnFailureExplained([success], 'The socket connection was closed unexpectedly')).toBe(false)
  })
})
