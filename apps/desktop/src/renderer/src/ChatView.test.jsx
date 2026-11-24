import { expect, it, mock } from 'bun:test'
import { mergeReplayEvents, readChatRestore } from './ChatView'

const payload = { id: 'node', sessionId: 'session', from: 'cursor' }
const page = { rows: [], startCursor: 'cursor' }
const state = { sessionId: 'session', running: false, events: [] }
const options = { resync: true, isCurrent: () => true, getSessionId: () => payload.sessionId }

it.each(['page', 'state'])('rejects a %s error during resync but keeps partial initial restore', async (field) => {
  const result = { page, state, meta: null, [field]: null, errors: { [field]: `${field} failed` } }
  const chat = { restore: mock(async () => result), isRunning: mock() }
  const api = { chat }

  await expect(readChatRestore(api, payload, options)).rejects.toThrow(`${field} failed`)
  await expect(readChatRestore(api, payload, { ...options, resync: false })).resolves.toEqual({
    page: result.page, state: result.state, meta: null
  })
  expect(chat.restore.mock.calls).toEqual([[payload], [payload]])
  expect(chat.isRunning).not.toHaveBeenCalled()
})

it.each(['page', 'state'])('rejects a missing %s during strict combined resync', async (field) => {
  const chat = { restore: async () => ({ page, state, [field]: null }) }
  await expect(readChatRestore({ chat }, payload, options)).rejects.toThrow(/unavailable during resync/)
})

it('keeps sequenced SSE replay usable when only metadata fails', async () => {
  const received = { type: 'text', text: 'answer' }
  const finish = { type: 'step_finish' }
  const running = { ...state, running: true, events: [{ sequence: 10, event: received }] }
  const chat = { restore: async () => ({ page, state: running, errors: { meta: 'unavailable' } }) }
  const restored = await readChatRestore({ chat }, payload, options)

  expect(restored).toEqual({ page, state: running, meta: null })
  expect(mergeReplayEvents(restored.state.events, [
    { sequence: 10, event: received }, { sequence: 11, event: finish }
  ])).toEqual([received, finish])
})

it('uses the legacy share readers and waits for history before sampling state', async () => {
  const history = Promise.withResolvers()
  const chat = {
    restore: mock(),
    historyPage: mock(() => history.promise),
    meta: mock(async () => { throw new Error('metadata failed') }),
    isRunning: mock(async () => state)
  }
  const pending = readChatRestore({ shareView: true, chat }, payload, options)
  expect(chat.historyPage.mock.calls).toEqual([['session', { id: 'node', from: 'cursor' }]])
  expect(chat.meta.mock.calls).toEqual([['session']])
  expect(chat.isRunning).not.toHaveBeenCalled()
  history.resolve(page)
  await expect(pending).resolves.toEqual({ page, meta: null, state })
  expect(chat.isRunning.mock.calls).toEqual([['node', 'session']])
  expect(chat.restore).not.toHaveBeenCalled()
})

it('does not sample share state after the view switches nodes', async () => {
  const history = Promise.withResolvers()
  let current = true
  const chat = { historyPage: () => history.promise, meta: async () => null, isRunning: mock() }
  const pending = readChatRestore({ shareView: true, chat }, payload, { ...options, isCurrent: () => current })
  current = false
  history.resolve(page)
  await expect(pending).resolves.toBeNull()
  expect(chat.isRunning).not.toHaveBeenCalled()
})

it('still rejects a failed history read during share resync before asking for state', async () => {
  const chat = {
    historyPage: async () => { throw new Error('history failed') },
    meta: async () => null,
    isRunning: mock()
  }
  await expect(readChatRestore({ shareView: true, chat }, payload, options)).rejects.toThrow('history failed')
  expect(chat.isRunning).not.toHaveBeenCalled()
})

it('rechecks a draft binding learned during the combined read without rereading history', async () => {
  const draft = { id: 'node', sessionId: null }
  const chat = {
    restore: mock(async () => ({ page: null, state: { ...state, sessionId: null } })),
    isRunning: mock(async () => state)
  }
  await expect(readChatRestore({ chat }, draft, options)).resolves.toEqual({ page: null, meta: null, state })
  expect(chat.restore.mock.calls).toEqual([[draft]])
  expect(chat.isRunning.mock.calls).toEqual([['node', 'session']])
})
