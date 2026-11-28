import { afterEach, expect, it } from 'bun:test'
import { ensureMicaApi } from './transport.js'
import { createPluginHostApi } from './plugin-host.js'

const originals = Object.fromEntries(
  ['window', 'document', 'EventSource', 'fetch'].map((key) => [key, globalThis[key]])
)
afterEach(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key]
    else globalThis[key] = value
  }
})

it('routes a document-sized update check through the version-only invoke channel', async () => {
  globalThis.window = { location: { pathname: '/', href: 'http://test/' }, addEventListener() {} }
  globalThis.document = { addEventListener() {}, hidden: false }
  globalThis.EventSource = class {
    addEventListener() {}
  }
  const calls = []
  globalThis.fetch = async (url, options) => {
    if (url === '/api/env') return { ok: true, json: async () => ({ platform: 'test' }) }
    expect(url).toBe('/api/invoke')
    calls.push(JSON.parse(options.body))
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { version: 'a'.repeat(64) } })
    }
  }
  await ensureMicaApi()
  const result = await createPluginHostApi('sample-notes').documents.version('note-1')
  expect(result).toEqual({ version: 'a'.repeat(64) })
  expect(calls).toEqual([
    { channel: 'plugin-host:data-version', payload: { pluginId: 'sample-notes', key: 'note-1' } }
  ])
  expect(JSON.stringify(result)).toHaveLength(78)
})
