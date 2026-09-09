import { describe, expect, it } from 'bun:test'
import { lastUserPromptText } from './ChatView'

describe('last user prompt bar', () => {
  it('uses the newest sent user message', () => {
    const messages = [
      { id: 'p1', kind: 'message', role: 'user', text: 'first prompt' },
      { id: 'a1', kind: 'message', role: 'assistant', text: 'working' },
      { id: 'p2', kind: 'message', role: 'user', text: 'second prompt' },
      { id: 'a2', kind: 'message', role: 'assistant', text: 'done' }
    ]

    expect(lastUserPromptText(messages)).toBe('second prompt')
  })

  it('skips queued messages so the bar keeps showing the sent prompt', () => {
    const messages = [
      { id: 'p1', kind: 'message', role: 'user', text: 'sent prompt' },
      { id: 'p2', kind: 'message', role: 'user', text: 'queued prompt', queued: true }
    ]

    expect(lastUserPromptText(messages)).toBe('sent prompt')
  })

  it('skips blank user messages and returns an empty string when nothing matches', () => {
    expect(lastUserPromptText([{ id: 'p1', role: 'user', text: '   ' }])).toBe('')
    expect(lastUserPromptText([{ id: 'a1', role: 'assistant', text: 'hi' }])).toBe('')
    expect(lastUserPromptText([])).toBe('')
  })
})
