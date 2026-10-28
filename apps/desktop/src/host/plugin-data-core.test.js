import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  decodePluginData,
  encodePluginData,
  pluginDataPath,
  PLUGIN_DATA_MAX_BYTES
} from './plugin-data-core'

const HOME = '/tmp/mica-home'

describe('pluginDataPath', () => {
  test('puts one data.json under plugin-data/<pluginId>', () => {
    expect(pluginDataPath(HOME, 'connections')).toBe(
      join(HOME, 'plugin-data', 'connections', 'data.json')
    )
  })

  test('rejects an id that could escape the plugin-data directory', () => {
    for (const id of ['', '   ', '../etc', 'a/../b', 'a/b', '..', null, undefined, 42]) {
      expect(pluginDataPath(HOME, id)).toBeNull()
    }
  })

  test('returns null without a home directory', () => {
    expect(pluginDataPath('', 'connections')).toBeNull()
  })
})

describe('encodePluginData', () => {
  test('serializes a value and reports the json text', () => {
    const encoded = encodePluginData({ version: 1, items: [{ id: 'a' }] })
    expect(encoded).toEqual({ ok: true, json: '{"version":1,"items":[{"id":"a"}]}' })
  })

  test('refuses data over the size limit instead of throwing', () => {
    const huge = 'x'.repeat(PLUGIN_DATA_MAX_BYTES + 1)
    const encoded = encodePluginData({ huge })
    expect(encoded.ok).toBe(false)
    expect(typeof encoded.error).toBe('string')
  })

  test('refuses values that cannot be serialized', () => {
    const circular = {}
    circular.self = circular
    for (const value of [{ big: 1n }, circular]) {
      const encoded = encodePluginData(value)
      expect(encoded.ok).toBe(false)
      expect(typeof encoded.error).toBe('string')
    }
  })

  test('refuses a value that has no json form at all', () => {
    expect(encodePluginData(undefined).ok).toBe(false)
  })
})

describe('decodePluginData', () => {
  test('round-trips what encodePluginData produced', () => {
    const value = { version: 2, items: [{ id: 'a', label: '本机' }] }
    const encoded = encodePluginData(value)
    expect(encoded.ok).toBe(true)
    expect(decodePluginData(encoded.json)).toEqual(value)
  })

  test('returns null for a broken file so the page keeps working', () => {
    for (const raw of ['', '   ', '{', 'not json', null, undefined, 42, {}]) {
      expect(decodePluginData(raw)).toBeNull()
    }
  })
})
