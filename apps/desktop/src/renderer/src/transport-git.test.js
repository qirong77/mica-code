import { afterEach, expect, it, vi } from 'vitest'
import { ensureMicaApi } from './transport.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  delete globalThis.window
  delete globalThis.document
  delete globalThis.EventSource
  globalThis.fetch = originalFetch
})

it('distinguishes automatic Git invalidation from a forced manual scan over HTTP', async () => {
  globalThis.window = { location: { pathname: '/' }, addEventListener: vi.fn() }
  globalThis.document = { addEventListener: vi.fn(), hidden: false }
  globalThis.EventSource = class {
    addEventListener() {}
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    .mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) })
  globalThis.fetch = fetchMock
  const api = await ensureMicaApi()

  await api.git.changeCounts('/work/repo', { invalidate: true })
  await api.git.summary('/work/repo', { invalidate: true })
  await api.git.summary('/work/repo', { refresh: true })

  expect(fetchMock.mock.calls.slice(1).map(([, options]) => JSON.parse(options.body))).toEqual([
    {
      channel: 'git:change-counts',
      payload: { cwd: '/work/repo', refresh: false, invalidate: true }
    },
    { channel: 'git:summary', payload: { cwd: '/work/repo', refresh: false, invalidate: true } },
    { channel: 'git:summary', payload: { cwd: '/work/repo', refresh: true, invalidate: false } }
  ])
})
