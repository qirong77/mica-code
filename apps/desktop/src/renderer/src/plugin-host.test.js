import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPluginHostApi } from './plugin-host.js'

const originalWindow = globalThis.window
let calls
let snapshot
let result

beforeEach(() => {
  calls = []
  snapshot = { value: { text: '正文' }, version: 'current-version' }
  result = { ok: true }
  globalThis.window = {
    mica: {
      pluginHost: {
        readData: async (...args) => {
          calls.push(['read', ...args])
          return snapshot
        },
        writeData: async (...args) => {
          calls.push(['write', ...args])
          return result
        }
      }
    }
  }
})

afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
})

describe('plugin host local data API', () => {
  test('preserves config reads and writes without a document key', async () => {
    const api = createPluginHostApi('sample')
    const value = { tree: [] }
    const options = { expectedVersion: 'config-version' }
    expect(await api.readData()).toBe(snapshot)
    expect(await api.writeData(value, options)).toBe(result)
    expect(await api.writeData(value)).toBe(result)
    expect(calls).toEqual([
      ['read', 'sample'],
      ['write', 'sample', value, options],
      ['write', 'sample', value, undefined]
    ])
  })

  test('routes document reads and writes through existing host channels with an explicit key', async () => {
    const api = createPluginHostApi('sample')
    const key = '92de9c14-5a20-4a55-9c4f-3910d941057a'
    const value = { text: 'new body' }
    const options = { expectedVersion: null }
    expect(await api.documents.read(key)).toBe(snapshot)
    expect(await api.documents.write(key, value, options)).toBe(result)
    expect(options).toEqual({ expectedVersion: null })
    expect(await api.documents.write(key, value)).toBe(result)
    expect(calls).toEqual([
      ['read', 'sample', { key }],
      ['write', 'sample', value, { expectedVersion: null, key }],
      ['write', 'sample', value, { key }]
    ])
  })

  test('binds document requests to this plugin and keeps the explicit key over options', async () => {
    const api = createPluginHostApi('sample')
    await api.documents.write('page', 'body', {
      key: 'other',
      pluginId: 'other-plugin',
      value: 'other-body',
      expectedVersion: 'version'
    })
    expect(calls).toEqual([
      ['write', 'sample', 'body', { key: 'page', expectedVersion: 'version' }]
    ])
  })

  test('rejects keys that JSON would omit rather than targeting the config file', async () => {
    const api = createPluginHostApi('sample')
    for (const key of ['', undefined, null, 42, () => {}]) {
      await expect(api.documents.read(key)).rejects.toThrow('key')
      await expect(api.documents.write(key, 'body')).rejects.toThrow('key')
    }
    expect(calls).toEqual([])
  })

  test('passes CAS conflicts through and propagates document read failures', async () => {
    const api = createPluginHostApi('sample')
    result = { ok: false, conflict: true, error: '插件数据已更新' }
    expect(await api.documents.write('page', 'body', { expectedVersion: 'stale' })).toBe(result)
    window.mica.pluginHost.readData = async () => {
      throw new Error('插件文档 JSON 损坏')
    }
    await expect(api.documents.read('page')).rejects.toThrow('JSON 损坏')
  })
})
