import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { probeRuntime } from './runtime-probe-core'

// 地址规范化只在 `@packages/mica-web-shared` 里实现一份，这里只验探活本身怎么用它：
// 补默认端口、保显式端口、丢路径、非法输入，以及「不是 Mica 运行时」的判定。
describe('probeRuntime', () => {
  test('accepts a mica runtime and reports the normalized address', async () => {
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
      // 路径被丢掉：一个运行时就是一个 origin。
      const result = await probeRuntime(`http://127.0.0.1:${port}/api/health?a=1`)
      expect(result).toEqual({ ok: true, url: `http://127.0.0.1:${port}`, port: 8787 })
    } finally {
      server.close()
    }
  })

  test('fills in the default port for a bare host', async () => {
    // 本机可能真的跑着一台运行时（8787），所以不断言成功与否，只断言「地址被补齐成默认端口」：
    // 补上了才会真的去探，而不是在格式校验那一步被挡回来。
    const result = await probeRuntime('127.0.0.1', 200)
    if (result.ok) {
      expect(result.url).toBe('http://127.0.0.1:8787')
    } else {
      expect(result.error).not.toBe('地址格式不正确')
    }
  })

  test('keeps an explicit port instead of the default one', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'mica-code-app', port: 1234 }))
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port

    try {
      expect(await probeRuntime(`127.0.0.1:${port}`)).toMatchObject({
        ok: true,
        url: `http://127.0.0.1:${port}`,
        port: 1234
      })
    } finally {
      server.close()
    }
  })

  test('reports a readable reason for a dead address and a bad one', async () => {
    const dead = await probeRuntime('http://127.0.0.1:9')
    expect(dead.ok).toBe(false)
    expect(typeof dead.error).toBe('string')

    expect(await probeRuntime('not a host')).toEqual({ ok: false, error: '地址格式不正确' })
    expect(await probeRuntime('')).toEqual({ ok: false, error: '地址格式不正确' })
  })

  test('rejects an address that answers with a different app', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'something-else' }))
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port

    try {
      expect(await probeRuntime(`http://127.0.0.1:${port}`)).toMatchObject({
        ok: false,
        error: '目标地址不是 Mica Code 运行时'
      })
    } finally {
      server.close()
    }
  })

  test('reports a non-2xx answer as an HTTP status', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port

    try {
      expect(await probeRuntime(`http://127.0.0.1:${port}`)).toEqual({
        ok: false,
        error: '目标地址返回 HTTP 503'
      })
    } finally {
      server.close()
    }
  })
})
