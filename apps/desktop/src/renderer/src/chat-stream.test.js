import { expect, test } from 'bun:test'
import { transcriptMessagesForDisplay, updateStreamMessage } from './chat-stream.js'

test('stream deltas and completion target their row when notices or queued prompts follow it', () => {
  const history = Array.from({ length: 10_000 }, (_, index) => ({
    id: `history-${index}`,
    text: 'old'
  }))
  const active = { id: 'active', text: 'Hello', done: false }
  const queued = { id: 'queued', text: 'next question', queued: true }
  const messages = [...history, active, queued]
  const delta = updateStreamMessage(messages, 'active', (message) => ({
    ...message,
    text: message.text + ' world'
  }))
  const done = updateStreamMessage(delta, 'active', (message) => ({ ...message, done: true }))
  expect(done.at(-2)).toEqual({ id: 'active', text: 'Hello world', done: true })
  expect(done.at(-1)).toBe(queued)
  expect(done[0]).toBe(history[0])
  expect(messages.at(-2)).toBe(active)
  expect(active.text).toBe('Hello')
})

test('a late delta for a removed row leaves the current transcript intact', () => {
  const messages = [{ id: 'replaced-history', text: 'current' }]
  expect(
    updateStreamMessage(messages, 'removed', () => {
      throw new Error('must not update')
    })
  ).toBe(messages)
})

test('reasoning, tool and queued updates preserve the conversation render list', () => {
  const prompt = { id: 'prompt', kind: 'message', role: 'user', text: 'question' }
  const thought = { id: 'thought', kind: 'reasoning', text: 'thinking' }
  const answer = { id: 'answer', kind: 'message', text: 'answer' }
  const first = transcriptMessagesForDisplay([prompt, thought, answer])
  const next = transcriptMessagesForDisplay(
    [
      prompt,
      { ...thought, text: 'more thinking' },
      { id: 'tool', kind: 'tool' },
      answer,
      { id: 'queued', kind: 'message', role: 'user', queued: true, text: 'later' }
    ],
    first
  )
  expect(next).toBe(first)
  expect(next).toEqual([prompt, answer])
  const changed = { ...answer, text: 'answer continued' }
  const streamed = transcriptMessagesForDisplay([prompt, thought, changed], first)
  expect(streamed).not.toBe(first)
  expect(streamed).toEqual([prompt, changed])
  expect(transcriptMessagesForDisplay([prompt], streamed)).toEqual([prompt])
  expect(transcriptMessagesForDisplay([], streamed)).toEqual([])
})
