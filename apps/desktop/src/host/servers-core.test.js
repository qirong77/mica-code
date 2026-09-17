import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { DEFAULT_SERVER_PORT, normalizeServerUrl, probeServer } from './servers-core'

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
