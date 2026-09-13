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

  it('skips queued messages and unknown ids', () => {
    const rows = [
      { id: 'u1', kind: 'message', role: 'user', text: 'same prompt' },
      { id: 'q1', kind: 'message', role: 'user', text: 'same prompt', queued: true }
    ]

    expect(promptOccurrenceFromEnd(rows, 'u1')).toBe(1)
    expect(promptOccurrenceFromEnd(rows, 'missing')).toBe(1)
  })
})
