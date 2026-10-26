import { afterEach, describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { createControlMcpHandler } from './control-mcp.js'
import { clearMcpProbeCache, probeMcpServers } from './mcp-probe.js'

const ENDPOINTS = [
  {
    id: 'health',
    method: 'GET',
    path: '/browser/health',
    summary: '探活',
    params: [],
    returns: '{}'
  }
]

async function startControlMcp() {
  const handler = createControlMcpHandler({
    kind: 'mica-browser',
    title: '受控浏览器',
    usage: '驱动浏览器',
    socketPath: '/nonexistent.sock',
    label: '受控浏览器服务',
    loadCatalog: async () => ({ endpoints: ENDPOINTS, guide: '' })
  })
  const server = createServer((req, res) => {
    if (req.url === '/mcp/browser') return void handler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp/browser`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

afterEach(() => clearMcpProbeCache())

describe('probeMcpServers', () => {
  it('handshakes a live http server and reports the real tool count', async () => {
    const runtime = await startControlMcp()
    try {
      const results = await probeMcpServers({ 'mica-browser': { type: 'http', url: runtime.url } })

      const result = results.get('mica-browser')
      expect(result.status).toBe('connected')
      expect(result.toolCount).toBe(1)
      expect(result.tools[0].name).toBe('control')
      expect(result.error).toBeUndefined()
    } finally {
      await runtime.close()
    }
  })

  it('reports a closed port as failed instead of throwing', async () => {
    const runtime = await startControlMcp()
    const url = runtime.url
    await runtime.close()

    const results = await probeMcpServers({ 'mica-browser': { type: 'http', url } })

    const result = results.get('mica-browser')
    expect(result.status).toBe('failed')
    expect(result.toolCount).toBe(0)
    expect(result.error).toBeTruthy()
    expect(result.error.length).toBeLessThanOrEqual(161)
  })

  it('leaves stdio servers alone so opening the page does not spawn processes', async () => {
    const results = await probeMcpServers({
      'sequential-thinking': { command: 'npx', args: ['-y', 'server'] }
    })

    expect(results.size).toBe(0)
  })

  it('expands ${VAR} in the url with the given env', async () => {
    const runtime = await startControlMcp()
    try {
      const results = await probeMcpServers(
        { 'mica-browser': { url: 'http://127.0.0.1:${PORT}/mcp/browser' } },
        { env: { PORT: String(runtime.port) } }
      )

      expect(results.get('mica-browser').status).toBe('connected')
    } finally {
      await runtime.close()
    }
  })

  it('caches by name and config so repeated page loads do not re-handshake', async () => {
    let calls = 0
    const connect = async () => {
      calls += 1
      return [{ name: 'control', description: '' }]
    }
    const config = { url: 'http://127.0.0.1:1/mcp/browser' }

    await probeMcpServers({ mica: config }, { connect, ttlMs: 10_000 })
    const second = await probeMcpServers({ mica: config }, { connect, ttlMs: 10_000 })

    expect(calls).toBe(1)
    expect(second.get('mica').toolCount).toBe(1)
  })

  it('re-probes when the config changed', async () => {
    let calls = 0
    const connect = async () => {
      calls += 1
      return []
    }

    await probeMcpServers({ mica: { url: 'http://127.0.0.1:1/a' } }, { connect })
    await probeMcpServers({ mica: { url: 'http://127.0.0.1:1/b' } }, { connect })

    expect(calls).toBe(2)
  })

  it('re-probes once the ttl expired', async () => {
    let calls = 0
    let clock = 0
    const connect = async () => {
      calls += 1
      return []
    }
    const options = { connect, ttlMs: 1000, now: () => clock }

    await probeMcpServers({ mica: { url: 'http://127.0.0.1:1/a' } }, options)
    clock = 1001
    await probeMcpServers({ mica: { url: 'http://127.0.0.1:1/a' } }, options)

    expect(calls).toBe(2)
  })

  it('drops cache entries for servers that were removed', async () => {
    const connect = async () => []
    await probeMcpServers({ mica: { url: 'http://127.0.0.1:1/a' } }, { connect })

    // 删掉之后重新加回来必须再探一次，不能吃旧结果
    await probeMcpServers({}, { connect })
    let calls = 0
    await probeMcpServers(
      { mica: { url: 'http://127.0.0.1:1/a' } },
      {
        connect: async () => {
          calls += 1
          return []
        }
      }
    )

    expect(calls).toBe(1)
  })
})
