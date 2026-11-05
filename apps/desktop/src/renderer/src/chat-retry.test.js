import { describe, expect, it } from 'bun:test'
import { retryPrompt } from './ChatView'

describe('retryPrompt', () => {
  it('selects the latest sent user message, not queued or assistant messages', () => {
    expect(retryPrompt([
      { role: 'user', text: 'first' },
      { role: 'user', text: ' latest ' },
      { role: 'assistant', text: 'answer' },
      { role: 'user', text: 'queued', queued: true }
    ])).toBe('latest')
  })

  it('preserves image paths and refuses unrecoverable image placeholders', () => {
    expect(retryPrompt([{ role: 'user', text: '[Image](/tmp/a.png)[图片] look' }]))
      .toBe('[Image](/tmp/a.png) look')
    expect(retryPrompt([{ role: 'user', text: 'look [图片]' }])).toBe('')
  })

  it('does not fall back to an older message when the latest cannot be resent', () => {
    expect(retryPrompt([{ role: 'user', text: 'old' }, { role: 'user', text: '' }])).toBe('')
    expect(retryPrompt([])).toBe('')
  })
})
