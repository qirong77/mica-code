import { expect, it } from 'bun:test'
import { rollbackAttemptReasoning, rollbackAttemptText } from './text-rollback'
import { appendBufferedEvent } from '../../../host/chat-events'

it('only removes the replayed portion of the failed attempt', () => {
  const messages = [
    { id: 'old', turnId: 't', kind: 'message', role: 'assistant', attemptId: 'a', text: 'previous' },
    { id: 'new', turnId: 't', kind: 'message', role: 'assistant', attemptId: 'b', text: 'tail' }
  ]
  expect(rollbackAttemptText(messages, 't', 'b', 100)).toEqual([messages[0]])
  expect(rollbackAttemptText(messages, 't', undefined, 100)).toEqual(messages)
  expect(rollbackAttemptText(messages, 't', 'b', 2)[1].text).toBe('ta')
})

it('removes only reasoning belonging to the failed attempt, even with no text', () => {
  const messages = [
    { id: 'old', turnId: 't', kind: 'reasoning', attemptId: 'a', text: 'complete' },
    { id: 'legacy', turnId: 't', kind: 'reasoning', text: 'legacy' },
    { id: 'other', turnId: 'other', kind: 'reasoning', attemptId: 'b', text: 'other turn' },
    { id: 'partial', turnId: 't', kind: 'reasoning', attemptId: 'b', text: 'partial', done: true },
    { id: 'partial2', turnId: 't', kind: 'reasoning', attemptId: 'b', text: 'more' }
  ]
  expect(rollbackAttemptText(messages, 't', 'b', 100)).toEqual(messages)
  expect(rollbackAttemptReasoning(messages, 't', 'b', 100)).toEqual(messages.slice(0, 3))
  expect(rollbackAttemptReasoning(messages, 't', 'b', 0)).toEqual(messages)
  expect(rollbackAttemptReasoning(messages, 't', undefined, 100)).toEqual(messages)
  expect(rollbackAttemptReasoning(messages, 't', 'b', 6)).toEqual([
    ...messages.slice(0, 3), { ...messages[3], text: 'parti' }
  ])
})

it('replays a thinking rollback after an evicted prefix without touching previous thinking or text', () => {
  const buffer = []
  const push = (sequence, event) => appendBufferedEvent(buffer, { sequence, event }, 3)
  push(1, { type: 'reasoning', attemptId: 'b', part: { text: 'lost' } })
  push(2, { type: 'text', attemptId: 'b', part: { text: 'answer' } })
  push(3, { type: 'reasoning', attemptId: 'b', part: { text: 'tail' } })
  push(4, { type: 'reasoning_rollback', attemptId: 'b', length: 8 })
  let messages = [{ turnId: 't', kind: 'reasoning', attemptId: 'a', text: 'previous' }]
  for (const { event } of buffer) {
    if (event.type === 'text') messages.push({ turnId: 't', kind: 'message', role: 'assistant', attemptId: event.attemptId, text: event.part.text })
    if (event.type === 'reasoning') messages.push({ turnId: 't', kind: 'reasoning', attemptId: event.attemptId, text: event.part.text })
    if (event.type === 'reasoning_rollback') messages = rollbackAttemptReasoning(messages, 't', event.attemptId, event.length)
  }
  expect(messages.map((message) => message.text)).toEqual(['previous', 'answer'])
})

it('safely rolls back a replay whose beginning was evicted', () => {
  const buffer = []
  const push = (sequence, event) => appendBufferedEvent(buffer, { sequence, event }, 3)
  push(1, { type: 'text', attemptId: 'b', part: { text: 'lost' } })
  push(2, { type: 'reasoning', part: { text: 'thinking' } })
  push(3, { type: 'text', attemptId: 'b', part: { text: 'tail' } })
  push(4, { type: 'text_rollback', attemptId: 'b', length: 8 })
  expect(buffer.map((r) => r.sequence)).toEqual([2, 3, 4])
  let messages = [{ id: 'old', turnId: 't', kind: 'message', role: 'assistant', attemptId: 'a', text: 'previous' }]
  for (const { event } of buffer) {
    if (event.type === 'text') messages.push({ id: 'tail', turnId: 't', kind: 'message', role: 'assistant', attemptId: event.attemptId, text: event.part.text })
    if (event.type === 'text_rollback') messages = rollbackAttemptText(messages, 't', event.attemptId, event.length)
  }
  expect(messages.map((m) => m.text)).toEqual(['previous'])
})
