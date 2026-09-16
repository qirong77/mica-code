import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_SERVER_PORT,
  MAX_SERVER_NOTE,
  mergeServerUrl,
  normalizeServerUrl,
  normalizeServerNote,
  probeServer,
  readServerStore,
  removeServerUrl,
  sanitizeServerStore,
  setServerNote,
  serverStorePath,
  writeServerStore
} from './servers-core'

const temporaryDirectories = []

function makeUserDataDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mica-servers-'))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('normalizeServerUrl', () => {
  test('fills in the default port and the http scheme', () => {
    expect(normalizeServerUrl('192.168.1.5')).toBe(`http://192.168.1.5:${DEFAULT_SERVER_PORT}`)
    expect(normalizeServerUrl('192.168.1.5:9000')).toBe('http://192.168.1.5:9000')
    expect(normalizeServerUrl('  http://192.168.1.5:9000  ')).toBe('http://192.168.1.5:9000')
  })

  test('drops the path, query and hash so a server is an origin', () => {
    expect(normalizeServerUrl('http://box:8787/api/health?a=1#x')).toBe('http://box:8787')
  })

  test('keeps non-default ports the WHATWG parser would elide', () => {
    expect(normalizeServerUrl('http://box:80')).toBe('http://box:80')
    expect(normalizeServerUrl('https://box:443')).toBe('https://box:443')
  })

  test('keeps the brackets of an IPv6 host', () => {
    expect(normalizeServerUrl('[::1]:8787')).toBe('http://[::1]:8787')
  })

  test('rejects input that is not an http server address', () => {
    for (const input of ['', '   ', 'ftp://box:21', 'http://', 'a b', 'http://box:99999']) {
      expect(normalizeServerUrl(input)).toBeNull()
    }
  })
})

describe('server list', () => {
  test('sanitizes a stored list: drops invalid and duplicate entries', () => {
    const store = sanitizeServerStore({
      version: 99,
      servers: [
        { url: '192.168.1.5', lastUsedAt: '2026-01-01T00:00:00.000Z' },
        { url: 'http://192.168.1.5:8787', lastUsedAt: '2026-02-01T00:00:00.000Z' },
        { url: 'nonsense address' },
        { url: 'http://box:9000' }
      ]
    })

    expect(store.version).toBe(1)
    expect(store.servers).toEqual([
      { url: 'http://192.168.1.5:8787', note: '', lastUsedAt: '2026-01-01T00:00:00.000Z' },
      { url: 'http://box:9000', note: '', lastUsedAt: new Date(0).toISOString() }
    ])
  })

  test('moves a reused address to the front and forgets on request', () => {
    let servers = mergeServerUrl([], 'http://a:8787', '2026-01-01T00:00:00.000Z')
    servers = mergeServerUrl(servers, 'http://b:8787', '2026-01-02T00:00:00.000Z')
    expect(servers.map((entry) => entry.url)).toEqual(['http://b:8787', 'http://a:8787'])

    servers = mergeServerUrl(servers, 'http://a:8787', '2026-01-03T00:00:00.000Z')
    expect(servers).toEqual([
      { url: 'http://a:8787', note: '', lastUsedAt: '2026-01-03T00:00:00.000Z' },
      { url: 'http://b:8787', note: '', lastUsedAt: '2026-01-02T00:00:00.000Z' }
    ])

    expect(removeServerUrl(servers, 'http://a:8787').map((entry) => entry.url)).toEqual([
      'http://b:8787'
    ])
  })

  test('keeps the note of an address that is re-used', () => {
    let servers = mergeServerUrl([], 'http://a:8787', '2026-01-01T00:00:00.000Z')
    servers = setServerNote(servers, 'http://a:8787', ' 公司的构建机 ')
    expect(servers).toEqual([
      { url: 'http://a:8787', note: '公司的构建机', lastUsedAt: '2026-01-01T00:00:00.000Z' }
    ])

    servers = mergeServerUrl(servers, 'http://a:8787', '2026-01-02T00:00:00.000Z')
    expect(servers[0]).toMatchObject({ note: '公司的构建机' })
  })
})

describe('server notes', () => {
  test('normalizes a note into a single truncated line', () => {
    expect(normalizeServerNote(undefined)).toBe('')
    expect(normalizeServerNote(42)).toBe('')
    expect(normalizeServerNote('  开发机\n\t二号  ')).toBe('开发机 二号')
    expect(normalizeServerNote('x'.repeat(MAX_SERVER_NOTE + 10))).toHaveLength(MAX_SERVER_NOTE)
  })

  test('only writes a note for an address already in the list', () => {
    const servers = [{ url: 'http://a:8787', note: 'a', lastUsedAt: '2026-01-01T00:00:00.000Z' }]
    expect(setServerNote(servers, 'http://b:8787', 'b').map((entry) => entry.url)).toEqual([
      'http://a:8787'
    ])
    expect(setServerNote(servers, 'http://a:8787', '').map((entry) => entry.note)).toEqual([''])
  })

  test('drops a note that is not a string when reading the store', () => {
    const store = sanitizeServerStore({
      servers: [
        { url: 'http://a:8787', note: { evil: true } },
        { url: 'http://b:8787', note: ' b ' }
      ]
    })
    expect(store.servers.map((entry) => entry.note)).toEqual(['', 'b'])
  })
})

describe('server store files', () => {
  test('reads an unreadable or missing store as empty', () => {
    const dir = makeUserDataDir()
    expect(readServerStore(dir).servers).toEqual([])

    writeFileSync(serverStorePath(dir), '{ not json', 'utf8')
    expect(readServerStore(dir).servers).toEqual([])
  })

  test('round-trips through disk', () => {
    const dir = makeUserDataDir()
    const servers = setServerNote(
      mergeServerUrl([], 'http://box:8787'),
      'http://box:8787',
      '构建机'
    )
    writeServerStore(dir, { version: 1, servers })
    expect(readServerStore(dir).servers.map((entry) => entry.url)).toEqual(['http://box:8787'])
    expect(readServerStore(dir).servers[0].note).toBe('构建机')
  })
})

describe('probeServer', () => {
  test('accepts a mica runtime and rejects other services', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          req.url === '/api/health' ? { ok: true, app: 'mica-code-app', port: 8787 } : {}
        )
      )
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port

    try {
      const result = await probeServer(`http://127.0.0.1:${port}`)
      expect(result).toEqual({ ok: true, url: `http://127.0.0.1:${port}`, port: 8787 })
    } finally {
      server.close()
    }
  })

  test('reports a readable reason for a dead address and a bad one', async () => {
    const dead = await probeServer('http://127.0.0.1:9')
    expect(dead.ok).toBe(false)
    expect(typeof dead.error).toBe('string')

    expect(await probeServer('not a host')).toEqual({ ok: false, error: '地址格式不正确' })
  })

  test('rejects an address that answers with a different app', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'something-else' }))
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port

    try {
      expect(await probeServer(`http://127.0.0.1:${port}`)).toMatchObject({
        ok: false,
        error: '目标地址不是 Mica Code 运行时'
      })
    } finally {
      server.close()
    }
  })
})
