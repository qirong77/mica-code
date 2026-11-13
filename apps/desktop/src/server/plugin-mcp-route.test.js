import { describe, expect, it } from 'bun:test'
import { createPluginMcpRoute } from './plugin-mcp-route.js'

function response() {
  return {
    status: null, body: null,
    writeHead(status) { this.status = status; return this },
    end(body) { this.body = body; return this }
  }
}

describe('application plugin MCP route', () => {
  it('dispatches the declared plugin without needing a page or session', async () => {
    const seen = []
    const route = createPluginMcpRoute({
      runtime: { has: (id) => id === 'demo' },
      verifyOrigin: () => ({ ok: true }),
      handle: async (id, req, res) => { seen.push({ id, method: req.method }); res.end('MCP') }
    })
    const res = response()
    expect(await route({ method: 'POST' }, res, '/plugin/demo/mcp')).toBe(true)
    expect(seen).toEqual([{ id: 'demo', method: 'POST' }])
    expect(res.body).toBe('MCP')
    expect(await route({}, response(), '/api/invoke')).toBe(false)
  })

  it('never lets disabled, unknown or malformed plugin paths fall back to the SPA', async () => {
    const route = createPluginMcpRoute({
      runtime: { has: () => false }, verifyOrigin: () => ({ ok: true }),
      handle: () => { throw new Error('must not be called') }
    })
    for (const path of ['/plugin', '/plugin/demo/mcp', '/plugin/toString/mcp', '/plugin/demo', '/plugin/demo/mcp/extra']) {
      const res = response()
      expect(await route({}, res, path)).toBe(true)
      expect(res.status).toBe(404)
    }
  })

  it('applies the same origin guard before resolving or loading any plugin', async () => {
    const route = createPluginMcpRoute({
      runtime: { has: () => { throw new Error('must not inspect plugins') } },
      verifyOrigin: () => ({ ok: false, status: 403, error: '来源未授权' }),
      handle: () => { throw new Error('must not be called') }
    })
    const res = response()
    expect(await route({}, res, '/plugin/demo/mcp')).toBe(true)
    expect(res.status).toBe(403)
  })
})
