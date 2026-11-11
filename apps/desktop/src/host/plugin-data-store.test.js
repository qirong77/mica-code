import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireProcessLock } from '@packages/mica-common/processLock.js'
import { pluginDataPath, PLUGIN_DATA_MAX_BYTES, PLUGIN_DOCUMENT_MAX_BYTES } from './plugin-data-core.js'
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

  test('returns the exact committed version so callers can save again without a verification read', () => {
    const options = { key: 'note-a', expectedVersion: null }
    const first = writePluginData(home, 'sample', { text: 'local draft' }, options)
    expect(first).toEqual({ ok: true, version: readPluginData(home, 'sample', options).version })
    expect(first.version).toBeTypeOf('string')
    const second = writePluginData(home, 'sample', { text: 'other window' }, { ...options, expectedVersion: first.version })
    expect(second).toEqual({ ok: true, version: readPluginData(home, 'sample', options).version })
    expect(first.version).not.toBe(second.version)
    expect(writePluginData(home, 'sample', { text: 'stale local edit' }, { ...options, expectedVersion: first.version }))
      .toMatchObject({ ok: false, conflict: true })
    expect(readPluginData(home, 'sample', options).value).toEqual({ text: 'other window' })
  })

  test('keeps unversioned writes compatible and refuses oversized replacements', () => {
    expect(writePluginData(home, 'sample', { value: 'original' })).toMatchObject({ ok: true })
    expect(() =>
      writePluginData(home, 'sample', { value: 'x'.repeat(PLUGIN_DATA_MAX_BYTES) })
    ).toThrow('上限')
    expect(readPluginData(home, 'sample').value).toEqual({ value: 'original' })
    expect(writePluginData(home, 'sample', { value: 'updated' })).toMatchObject({ ok: true })
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

  test('keeps the legacy broken config behavior unchanged', () => {
    writePluginData(home, 'sample', { original: true })
    writeFileSync(pluginDataPath(home, 'sample'), '{')
    const broken = readPluginData(home, 'sample')
    expect(broken.value).toBeNull()
    expect(typeof broken.version).toBe('string')
    expect(
      writePluginData(home, 'sample', { restored: true }, { expectedVersion: broken.version })
    ).toMatchObject({ ok: true })
  })
})

describe('plugin documents versioned persistence', () => {
  const pluginId = 'sample'
  const key = 'c461ba5a-1c23-4e11-aab4-e276ff350e74'

  test('keeps each document and config independent, with per-document CAS versions', () => {
    expect(readPluginData(home, pluginId, { key })).toEqual({ value: null, version: null })
    expect(writePluginData(home, pluginId, { tree: [key] }, { expectedVersion: null })).toMatchObject({
      ok: true
    })
    expect(
      writePluginData(home, pluginId, { text: 'first' }, { key, expectedVersion: null })
    ).toMatchObject({ ok: true })
    const original = readPluginData(home, pluginId, { key })
    expect(typeof original.version).toBe('string')
    expect(original.value).toEqual({ text: 'first' })
    expect(
      writePluginData(home, pluginId, { text: 'second' }, { key: 'other', expectedVersion: null })
    ).toMatchObject({ ok: true })
    expect(
      writePluginData(home, pluginId, { text: 'updated' }, { key, expectedVersion: original.version })
    ).toMatchObject({ ok: true })
    expect(
      writePluginData(home, pluginId, { text: 'stale' }, { key, expectedVersion: original.version })
    ).toMatchObject({ ok: false, conflict: true })
    expect(
      writePluginData(home, pluginId, { text: 'not new' }, { key, expectedVersion: null })
    ).toMatchObject({ ok: false, conflict: true })
    expect(readPluginData(home, pluginId, { key }).value).toEqual({ text: 'updated' })
    expect(readPluginData(home, pluginId, { key: 'other' }).value).toEqual({ text: 'second' })
    expect(readPluginData(home, pluginId).value).toEqual({ tree: [key] })
    const directory = join(home, 'plugin-data', pluginId, 'documents')
    expect(readdirSync(directory).sort()).toEqual(
      [`${key}.json`, `${key}.json.lock.owners`, 'other.json', 'other.json.lock.owners'].sort()
    )
    expect(readdirSync(`${pluginDataPath(home, pluginId, { key })}.lock.owners`)).toEqual([])
  })

  test('persists a large document privately while config stays limited to 256 KiB', () => {
    const value = { text: 'x'.repeat(PLUGIN_DATA_MAX_BYTES + 1) }
    expect(writePluginData(home, pluginId, value, { key, expectedVersion: null })).toMatchObject({
      ok: true
    })
    expect(readPluginData(home, pluginId, { key }).value).toEqual(value)
    const file = pluginDataPath(home, pluginId, { key })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(() => writePluginData(home, pluginId, value)).toThrow('256 KiB')
    expect(readPluginData(home, pluginId)).toEqual({ value: null, version: null })

    const fullSize = 'x'.repeat(PLUGIN_DOCUMENT_MAX_BYTES - 2)
    expect(writePluginData(home, pluginId, fullSize, { key })).toMatchObject({ ok: true })
    expect(statSync(file).size).toBe(PLUGIN_DOCUMENT_MAX_BYTES + 1)
    const version = readPluginData(home, pluginId, { key }).version
    expect(() => writePluginData(home, pluginId, `${fullSize}x`, { key })).toThrow('上限')
    expect(readPluginData(home, pluginId, { key }).version).toBe(version)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('uses the same process lock for a document without blocking other documents or config', () => {
    const release = acquireProcessLock(`${pluginDataPath(home, pluginId, { key })}.lock`)
    try {
      expect(
        writePluginData(home, pluginId, { text: 'blocked' }, { key, expectedVersion: null })
      ).toMatchObject({ ok: false, conflict: true })
      expect(readPluginData(home, pluginId, { key })).toEqual({ value: null, version: null })
      expect(writePluginData(home, pluginId, { tree: [] })).toMatchObject({ ok: true })
      expect(writePluginData(home, pluginId, { text: 'other' }, { key: 'other' })).toMatchObject({
        ok: true
      })
    } finally {
      release()
    }
    expect(
      writePluginData(home, pluginId, { text: 'saved' }, { key, expectedVersion: null })
    ).toMatchObject({ ok: true })
  })

  test('rejects invalid keys for reads and writes before creating any files', () => {
    for (const invalid of [
      '', '../escape', '..', 'a..b', 'a/b', 'a\\b', '/absolute', 'a%2fb', 'a\u0000b', 'a\n',
      'a'.repeat(129), null, undefined, 42
    ]) {
      expect(() => readPluginData(home, pluginId, { key: invalid })).toThrow('key 非法')
      expect(() => writePluginData(home, pluginId, {}, { key: invalid })).toThrow('key 非法')
    }
    expect(() => readPluginData(home, '../escape', { key })).toThrow('id 非法')
    expect(() => writePluginData(home, '../escape', {}, { key })).toThrow('id 非法')
    expect(readdirSync(home)).toEqual([])
  })

  test('reports corrupt documents and refuses to overwrite them, including without CAS', () => {
    writePluginData(home, pluginId, { text: 'original' }, { key })
    const file = pluginDataPath(home, pluginId, { key })
    for (const raw of ['', '{', '{"text":"truncated"']) {
      writeFileSync(file, raw)
      expect(() => readPluginData(home, pluginId, { key })).toThrow('JSON 损坏')
      for (const options of [{ key }, { key, expectedVersion: null }]) {
        expect(() => writePluginData(home, pluginId, { text: 'replacement' }, options)).toThrow(
          'JSON 损坏'
        )
        expect(readFileSync(file, 'utf8')).toBe(raw)
      }
      expect(readdirSync(`${file}.lock.owners`)).toEqual([])
      expect(
        readdirSync(join(home, 'plugin-data', pluginId, 'documents')).some((name) =>
          name.endsWith('.tmp')
        )
      ).toBe(false)
    }
    writeFileSync(file, 'null\n')
    const empty = readPluginData(home, pluginId, { key })
    expect(empty.value).toBeNull()
    expect(typeof empty.version).toBe('string')
    expect(
      writePluginData(home, pluginId, { text: 'restored' }, { key, expectedVersion: empty.version })
    ).toMatchObject({ ok: true })
  })

  test('rejects symlinks in the plugin root, document directory, document file and lock', () => {
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    const source = join(elsewhere, 'original.json')
    writeFileSync(source, '{"text":"untouched"}')
    const plugin = join(home, 'plugin-data', pluginId)
    const documents = join(plugin, 'documents')
    const file = pluginDataPath(home, pluginId, { key })
    for (const path of [join(home, 'plugin-data'), plugin, documents, file, `${file}.lock.owners`]) {
      const directory = path === file ? source : elsewhere
      mkdirSync(join(path, '..'), { recursive: true })
      symlinkSync(directory, path)
      try {
        expect(() => readPluginData(home, pluginId, { key })).toThrow('符号链接')
        expect(() => writePluginData(home, pluginId, 'replacement', { key })).toThrow('符号链接')
        expect(readdirSync(elsewhere)).toEqual(['original.json'])
        expect(readFileSync(source, 'utf8')).toBe('{"text":"untouched"}')
      } finally {
        rmSync(path)
      }
    }
  })

  test('surfaces document IO failures instead of returning a missing document', () => {
    mkdirSync(pluginDataPath(home, pluginId, { key }), { recursive: true })
    expect(() => readPluginData(home, pluginId, { key })).toThrow('读取插件数据失败')
  })
})
