import { describe, expect, it } from 'bun:test'
import { activateQueuedMessage } from './ChatView'

describe('queued chat message ordering', () => {
  it('moves an activated queued message after the completed previous turn', () => {
    const messages = [
      { id: 'prompt-1', kind: 'message', role: 'user', text: 'first prompt' },
      { id: 'answer-1a', kind: 'message', role: 'assistant', text: 'working' },
      { id: 'prompt-2', kind: 'message', role: 'user', text: 'queued prompt', queued: true },
      { id: 'answer-1b', kind: 'message', role: 'assistant', text: 'validation passed' }
    ]

    expect(activateQueuedMessage(messages, 'prompt-2')).toEqual([
      messages[0],
      messages[1],
      messages[3],
      { ...messages[2], queued: false }
    ])
    expect(messages[2].queued).toBe(true)
  })

  it('leaves the transcript untouched when the queued message is unavailable', () => {
    const messages = [{ id: 'prompt-1', kind: 'message', role: 'user', text: 'first prompt' }]

    expect(activateQueuedMessage(messages, 'missing')).toBe(messages)
    expect(activateQueuedMessage(messages, null)).toBe(messages)
  })
})
