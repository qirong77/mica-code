import { describe, expect, it } from 'bun:test'
import { canSubmitMessageEdit, promptOccurrenceFromEnd } from './ChatView'

describe('user message edit submit', () => {
  it('allows confirming while mica is idle and the edit has content', () => {
    expect(canSubmitMessageEdit({ running: false, text: 'hello' })).toBe(true)
    expect(canSubmitMessageEdit({ running: false, text: '  hello  ' })).toBe(true)
  })

  it('blocks confirming while a turn is running', () => {
    expect(canSubmitMessageEdit({ running: true, text: 'hello' })).toBe(false)
  })

  it('blocks confirming an empty edit', () => {
    expect(canSubmitMessageEdit({ running: false, text: '   \n ' })).toBe(false)
    expect(canSubmitMessageEdit({ running: false, text: '' })).toBe(false)
    expect(canSubmitMessageEdit({ running: false })).toBe(false)
  })
})

describe('edit resend target', () => {
  const messages = [
    { id: 'u1', kind: 'message', role: 'user', text: 'same prompt' },
    { id: 'a1', kind: 'message', role: 'assistant', text: 'answer' },
    { id: 'u2', kind: 'message', role: 'user', text: 'same\n  prompt' },
    { id: 'u3', kind: 'message', role: 'user', text: 'other prompt' },
    { id: 'u4', kind: 'message', role: 'user', text: 'same prompt' }
  ]

  it('counts matching user messages from the end, folding whitespace', () => {
    expect(promptOccurrenceFromEnd(messages, 'u4')).toBe(1)
    expect(promptOccurrenceFromEnd(messages, 'u2')).toBe(2)
    expect(promptOccurrenceFromEnd(messages, 'u1')).toBe(3)
    expect(promptOccurrenceFromEnd(messages, 'u3')).toBe(1)
  })

  it('normalizes the image placeholder the way the CLI does', () => {
    const rows = [
      { id: 'u1', kind: 'message', role: 'user', text: 'look [图片]' },
      { id: 'u2', kind: 'message', role: 'user', text: 'look [Image]' }
    ]

    expect(promptOccurrenceFromEnd(rows, 'u1')).toBe(2)
  })

  it('counts an unsent image reference the same as the persisted placeholder', () => {
    // 刚发出的乐观行是输入原文（[Image](路径)），历史行是投影（[图片]）；
    // 不剥掉占位符就数不成同一个 key，编辑会落到另一条消息上或直接找不到。
    const rows = [
      { id: 'u1', kind: 'message', role: 'user', text: '看这个[Image](~/.mica/images/a.png)' },
      { id: 'a1', kind: 'message', role: 'assistant', text: '好' },
      { id: 'u2', kind: 'message', role: 'user', text: '看这个[图片]' }
    ]

    // u2 是最新的一条；u1 是更早的同 key 消息，从末尾数是第 2 条。
    expect(promptOccurrenceFromEnd(rows, 'u2')).toBe(1)
    expect(promptOccurrenceFromEnd(rows, 'u1')).toBe(2)
  })

  it('skips queued messages and unknown ids', () => {
    const rows = [
      { id: 'u1', kind: 'message', role: 'user', text: 'same prompt' },
      { id: 'q1', kind: 'message', role: 'user', text: 'same prompt', queued: true }
    ]

    expect(promptOccurrenceFromEnd(rows, 'u1')).toBe(1)
    expect(promptOccurrenceFromEnd(rows, 'missing')).toBe(1)
  })
})
