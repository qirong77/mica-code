import { afterEach, expect, it, vi } from 'vitest'
import { ensureMicaApi } from './transport.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  delete globalThis.window
  delete globalThis.document
  delete globalThis.EventSource
  globalThis.fetch = originalFetch
})

it('sends a subagent restart through the desktop invoke channel', async () => {
  globalThis.window = { location: { pathname: '/' }, addEventListener: vi.fn() }
  globalThis.document = { addEventListener: vi.fn(), hidden: false }
  globalThis.EventSource = class { addEventListener() {} }
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, result: { ok: true, taskId: 'new' } }) })
  globalThis.fetch = fetchMock
  const api = await ensureMicaApi()
  expect(await api.chat.restartSubagent('run', 'old')).toEqual({ ok: true, taskId: 'new' })
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    channel: 'chat:restart-subagent', payload: { id: 'run', taskId: 'old' }
  })
})
