import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireProcessLock } from '@packages/mica-common/processLock.js'
import { pluginDataPath, PLUGIN_DATA_MAX_BYTES } from './plugin-data-core.js'
import { readPluginData, writePluginData } from './plugin-data-store.js'

let home
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mica-plugin-cas-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('plugin data versioned persistence', () => {
  test('allows the first write and rejects stale edits without overwriting a newer value', () => {
    expect(readPluginData(home, 'connections')).toEqual({ value: null, version: null })
    expect(
      writePluginData(home, 'connections', { peers: ['a'] }, { expectedVersion: null }).ok
    ).toBe(true)
    const initial = readPluginData(home, 'connections')
    expect(typeof initial.version).toBe('string')
    expect(
      writePluginData(
        home,
        'connections',
        { peers: ['a', 'b'] },
        { expectedVersion: initial.version }
      ).ok
    ).toBe(true)
    expect(
      writePluginData(
        home,
        'connections',
        { peers: ['a', 'c'] },
        { expectedVersion: initial.version }
      )
    ).toMatchObject({ ok: false, conflict: true })
    expect(readPluginData(home, 'connections').value).toEqual({ peers: ['a', 'b'] })
  })

  test('keeps unversioned writes compatible and refuses oversized replacements', () => {
    expect(writePluginData(home, 'sample', { value: 'original' })).toEqual({ ok: true })
    expect(() =>
      writePluginData(home, 'sample', { value: 'x'.repeat(PLUGIN_DATA_MAX_BYTES) })
    ).toThrow('上限')
    expect(readPluginData(home, 'sample').value).toEqual({ value: 'original' })
    expect(writePluginData(home, 'sample', { value: 'updated' })).toEqual({ ok: true })
  })

  test('returns a conflict while another process holds the write guard', () => {
    const release = acquireProcessLock(`${pluginDataPath(home, 'connections')}.lock`)
    try {
      expect(
        writePluginData(home, 'connections', { peers: ['a'] }, { expectedVersion: null })
      ).toMatchObject({ ok: false, conflict: true })
      expect(readPluginData(home, 'connections').value).toBeNull()
    } finally {
      release()
    }
    expect(
      writePluginData(home, 'connections', { peers: ['a'] }, { expectedVersion: null }).ok
    ).toBe(true)
  })

  test('rejects unsafe ids before creating data or lock files', () => {
    expect(() => writePluginData(home, '../escape', {})).toThrow('非法')
    expect(readPluginData(home, '../escape')).toEqual({ value: null, version: null })
    expect(readdirSync(home)).toEqual([])
  })

  test('surfaces read failures instead of treating them as an empty store', () => {
    mkdirSync(pluginDataPath(home, 'sample'), { recursive: true })
    expect(() => readPluginData(home, 'sample')).toThrow('读取插件数据失败')
  })
})
