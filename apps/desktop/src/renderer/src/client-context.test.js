import { describe, expect, test } from 'bun:test'
import { createClientContextApi } from './client-context.js'

function fixture() {
  const calls = []
  const bridge = Object.fromEntries(
    ['context', 'readData', 'writeData', 'probe', 'open', 'local'].map((operation) => [
      operation,
      async (...args) => {
        calls.push([operation, ...args])
        return {
          ok: true,
          result: operation === 'writeData' ? { ok: false, conflict: true } : null
        }
      }
    ])
  )
  return { calls, bridge, api: createClientContextApi('bookmarks', { bridge }) }
}

describe('native client context API', () => {
  test('browsers and other Electron containers without the native bridge have no client capability', () => {
    expect(createClientContextApi('bookmarks', { bridge: null })).toBeNull()
    expect(createClientContextApi('bookmarks', { bridge: {} })).toBeNull()
  })

  test('pins data access to the plugin and preserves version comparisons', async () => {
    const { api, calls } = fixture()
    await api.readData()
    expect(
      await api.writeData({ peers: [] }, { expectedVersion: null, pluginId: 'other' })
    ).toEqual({ ok: false, conflict: true })
    expect(calls).toEqual([
      ['readData', 'bookmarks'],
      ['writeData', 'bookmarks', { peers: [] }, { expectedVersion: null }]
    ])
  })

  test('Local uses the native bridge without fetching, and relay targets retain their token', async () => {
    const { api, calls } = fixture()
    await api.local()
    await api.open('https://relay.example/?t=machine-b&session=two')
    expect(calls).toEqual([['local'], ['open', 'https://relay.example/?t=machine-b&session=two']])
  })

  test('reports native errors to the card', async () => {
    const api = createClientContextApi('bookmarks', {
      bridge: {
        context: async () => ({ ok: true }),
        readData: async () => ({ ok: false, error: 'disk full' })
      }
    })
    await expect(api.readData()).rejects.toThrow('disk full')
  })
})
