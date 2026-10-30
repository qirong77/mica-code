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
      // access 透传给调用方：'off' 时对方还没开远程访问，开窗只会得到 404
      expect(result).toEqual({
        ok: true,
        kind: 'runtime',
        url: `http://127.0.0.1:${port}`,
        port: 8787,
        access: null
      })
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

  // 对方的远程访问开关状态直接决定「连过去能不能用」：没开时开窗只会看到 404，
  // 所以探活要把这个事实带回来，让卡片先给提示。
  test('reports whether the peer requires a password', async () => {
    for (const access of ['off', 'password', undefined]) {
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, app: 'mica-code-app', access }))
      })
      await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
      const port = server.address().port

      try {
        // 老版本不报这个字段：当成「不知道」，不去猜对方开没开
        const expected = access === 'off' ? 'off' : access === 'password' ? 'password' : null
        expect((await probeRuntime(`127.0.0.1:${port}`)).access).toBe(expected)
      } finally {
        server.close()
      }
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

// 中转机链接（mobile-relay 借出去的入口）连的不是「那个 origin 上的运行时」：
// 它是「中转机转给某台机器的界面」，判定要看 /api/health?t= 回的 label。
describe('probeRuntime with a relay link', () => {
  const link = (origin, extra = '') => `${origin}/?t=the-token${extra}`

  test('accepts a relay link and keeps the whole entry url', async () => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          url.searchParams.get('t') === 'the-token'
            ? { ok: true, label: 'Office Mac', agentOnline: true, pageVersion: 'abc' }
            : { ok: true, agents: 1 }
        )
      )
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port

    try {
      const result = await probeRuntime(link(`http://127.0.0.1:${port}`, '&session=s1'))
      expect(result).toMatchObject({
        ok: true,
        kind: 'relay',
        label: 'Office Mac',
        online: true
      })
      // session 必须留在入口里：打开它才是那条会话
      expect(result.url).toBe(`http://127.0.0.1:${port}/?t=the-token&session=s1`)
    } finally {
      server.close()
    }
  })

  test('reports an unknown token instead of pretending it is not a runtime', async () => {
    // 中转机对不认识的 t 只回 { ok, agents }，状态码同样是 200
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, agents: 1 }))
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port

    try {
      const result = await probeRuntime(link(`http://127.0.0.1:${port}`))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('访问口令')
    } finally {
      server.close()
    }
  })

  test('surfaces a relay whose bridge is offline without failing the probe', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, label: 'Office Mac', agentOnline: false }))
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port

    try {
      // 「能打开、但此刻没内容」和「连不上」是两件事：前者要打开并说明原因
      expect(await probeRuntime(link(`http://127.0.0.1:${port}`))).toMatchObject({
        ok: true,
        kind: 'relay',
        online: false
      })
    } finally {
      server.close()
    }
  })

  // 粘裸域名是很自然的下一步，所以「连不上」要说清是缺了 ?t=，而不是网络问题。
  test('explains a bare relay origin instead of blaming the network', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, agents: 1 }))
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = server.address().port

    try {
      const result = await probeRuntime(`http://127.0.0.1:${port}`)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('中转机')
      expect(result.error).toContain('?t=')
    } finally {
      server.close()
    }
  })
})
