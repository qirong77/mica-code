import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  decodePluginData,
  encodePluginData,
  isValidPluginDocumentKey,
  pluginDataPath,
  PLUGIN_DATA_MAX_BYTES,
  PLUGIN_DOCUMENT_MAX_BYTES
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

  test('keeps config at data.json and puts safe document keys in their own directory', () => {
    expect(pluginDataPath(HOME, 'sample', { expectedVersion: null })).toBe(
      join(HOME, 'plugin-data', 'sample', 'data.json')
    )
    for (const key of ['37ee394c-c674-4d8a-a848-9b91ff0b6a42', 'Page_12.v1-2', 'data', 'a']) {
      expect(isValidPluginDocumentKey(key)).toBe(true)
      expect(pluginDataPath(HOME, 'sample', { key })).toBe(
        join(HOME, 'plugin-data', 'sample', 'documents', `${key}.json`)
      )
    }
    expect(isValidPluginDocumentKey('a'.repeat(128))).toBe(true)
  })

  test('rejects traversal, unsafe, missing and overlong document keys without using data.json', () => {
    for (const key of [
      '', ' ', '../escape', 'a/b', 'a\\b', '..', 'a..b', '.', '.hidden', '/absolute',
      'a%2Fb', 'a\u0000b', 'with space', '中文', ' a', 'a ', 'a\n', 'a\r\n',
      'a'.repeat(129), null, undefined, 42
    ]) {
      expect(isValidPluginDocumentKey(key)).toBe(false)
      expect(pluginDataPath(HOME, 'sample', { key })).toBeNull()
    }
    expect(pluginDataPath(HOME, '../escape', { key: 'safe' })).toBeNull()
    expect(pluginDataPath('', 'sample', { key: 'safe' })).toBeNull()
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

  test('allows a document larger than config without increasing the config limit', () => {
    const value = { text: 'x'.repeat(PLUGIN_DATA_MAX_BYTES + 1) }
    expect(encodePluginData(value).ok).toBe(false)
    expect(encodePluginData(value, { key: 'page' }).ok).toBe(true)
  })

  test('enforces the serialized UTF-8 byte boundary for config and documents', () => {
    for (const [options, maxBytes] of [
      [{}, PLUGIN_DATA_MAX_BYTES],
      [{ key: 'page' }, PLUGIN_DOCUMENT_MAX_BYTES]
    ]) {
      const fitting = 'x'.repeat(maxBytes - 2)
      expect(encodePluginData(fitting, options).ok).toBe(true)
      expect(encodePluginData(`${fitting}x`, options).ok).toBe(false)
      const wide = '界'.repeat(Math.floor((maxBytes - 2) / 3) + 1)
      expect(wide.length).toBeLessThan(maxBytes)
      expect(encodePluginData(wide, options).ok).toBe(false)
    }
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

  test('strict document decoding rejects broken JSON but accepts every valid JSON value', () => {
    for (const raw of ['', '   ', '{', 'not json', null, undefined, 42, {}]) {
      expect(() => decodePluginData(raw, { strict: true })).toThrow('JSON 损坏')
    }
    for (const value of [null, false, 0, '', { text: '正文' }, ['a']]) {
      expect(decodePluginData(JSON.stringify(value), { strict: true })).toEqual(value)
    }
  })
})
