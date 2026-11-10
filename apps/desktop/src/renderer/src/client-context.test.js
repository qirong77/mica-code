import { describe, expect, test } from 'bun:test'
import { createClientContextApi } from './client-context.js'

const userAgent = 'Mica Electron/39.2.6'

describe('native client context API', () => {
  test('ordinary browsers have no native client data capability', () => {
    expect(createClientContextApi('bookmarks', { userAgent: 'Chrome/131' })).toBeNull()
  })

  test('pins data access to the plugin and preserves version comparisons', async () => {
    const requests = []
    const api = createClientContextApi('bookmarks', {
      userAgent,
      fetch: async (url, init) => {
        requests.push([url, JSON.parse(init.body)])
        return Response.json({ ok: true, result: { ok: false, conflict: true } })
      }
    })
    await api.readData()
    expect(await api.writeData({ peers: [] }, { expectedVersion: null })).toEqual({
      ok: false,
      conflict: true
    })
    expect(requests).toEqual([
      ['mica-client://host/read-data', { pluginId: 'bookmarks' }],
      [
        'mica-client://host/write-data',
        { pluginId: 'bookmarks', value: { peers: [] }, expectedVersion: null }
      ]
    ])
  })

  test('Local is a shell operation and relay targets retain their token', async () => {
    const requests = []
    const api = createClientContextApi('bookmarks', {
      userAgent,
      fetch: async (url, init) => {
        requests.push([url, JSON.parse(init.body)])
        return Response.json({ ok: true, result: null })
      }
    })
    await api.local()
    await api.open('https://relay.example/?t=machine-b&session=two')
    expect(requests).toEqual([
      ['mica-client://host/local', {}],
      ['mica-client://host/open', { url: 'https://relay.example/?t=machine-b&session=two' }]
    ])
  })

  test('reports shell failures to the card', async () => {
    const api = createClientContextApi('bookmarks', {
      userAgent,
      fetch: async () => Response.json({ ok: false, error: 'disk full' }, { status: 500 })
    })
    await expect(api.readData()).rejects.toThrow('disk full')
  })
})
