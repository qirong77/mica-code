import { describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CONTROL_TOOL_NAME,
  buildActionRequest,
  buildControlDocs,
  createControlMcpHandler,
  unknownParams
} from './control-mcp.js'

const BROWSER_ENDPOINTS = [
  {
    id: 'health',
    method: 'GET',
    path: '/browser/health',
    summary: '服务探活',
    params: [],
    returns: '{ ok }'
  },
  {
    id: 'listBrowsers',
    method: 'GET',
    path: '/browser/browsers',
    summary: '列出窗口',
    params: [],
    returns: '{ browsers }'
  },
  {
    id: 'navigate',
    method: 'POST',
    path: '/browser/tabs/:id/navigate',
    summary: '导航',
    params: [
      { name: 'id', in: 'path', required: true, description: '标签页' },
      { name: 'url', in: 'body', required: false, description: '目标地址' },
      { name: 'action', in: 'body', required: false, description: 'back / forward' },
      { name: 'x-mica-owner', in: 'header', required: false, description: '归属' }
    ],
    returns: '{ tab }'
  },
  {
    id: 'waitFor',
    method: 'POST',
    path: '/browser/tabs/:id/wait',
    summary: '等待条件',
    params: [
      { name: 'id', in: 'path', required: true, description: '标签页' },
      { name: 'timeoutMs', in: 'query', required: false, description: '超时' }
    ],
    returns: '{ tab }'
  },
  {
    id: 'events',
    method: 'SSE',
    path: '/browser/events',
    summary: '推送',
    params: [],
    returns: 'text/event-stream'
  }
]

describe('buildControlDocs', () => {
  const docs = buildControlDocs({
    server: 'mica-browser',
    title: '受控浏览器',
    usage: '驱动浏览器',
    guide: '先 listBrowsers',
    endpoints: BROWSER_ENDPOINTS
  })

  it('leaves out meta endpoints and streams', () => {
    expect(docs.actions.map((item) => item.action)).toEqual(['listBrowsers', 'navigate', 'waitFor'])
  })

  it('keeps the params an agent has to fill in but drops the owner header', () => {
    const navigate = docs.actions.find((item) => item.action === 'navigate')
    expect(navigate.params.map((param) => param.name)).toEqual(['id', 'url', 'action'])
    expect(navigate.params[0]).toMatchObject({ name: 'id', in: 'path', required: true })
  })

  it('carries the guide and usage so a no-action call is self-contained', () => {
    expect(docs.server).toBe('mica-browser')
    expect(docs.usage).toBe('驱动浏览器')
    expect(docs.guide).toBe('先 listBrowsers')
  })
})

describe('buildActionRequest', () => {
  const navigate = BROWSER_ENDPOINTS.find((item) => item.id === 'navigate')
  const waitFor = BROWSER_ENDPOINTS.find((item) => item.id === 'waitFor')

  it('splits params into path, query and body and injects the owner header', () => {
    const request = buildActionRequest(
      navigate,
      { id: 'tab-1', url: 'https://example.com' },
      { owner: 'sess-1' }
    )
    expect(request).toEqual({
      method: 'POST',
      path: '/browser/tabs/tab-1/navigate',
      body: { url: 'https://example.com' },
      headers: { 'x-mica-owner': 'sess-1' }
    })
  })

  it('puts query params on the url and keeps only the declared body keys', () => {
    const request = buildActionRequest(waitFor, { id: 'tab-1', timeoutMs: 5000 }, { owner: '' })
    expect(request.path).toBe('/browser/tabs/tab-1/wait?timeoutMs=5000')
    expect(request.body).toBeUndefined()
    expect(request.headers).toEqual({})
  })

  // 拼错的参数名静默丢掉会得到「什么都没发生」的成功响应，比报错更难排查
  it('rejects unknown params and names the ones it knows', () => {
    expect(unknownParams(navigate, { id: 'tab-1', selecter: 'a' })).toEqual(['selecter'])
    expect(() => buildActionRequest(navigate, { id: 'tab-1', selecter: 'a' })).toThrow(
      /不认识这些参数：selecter/
    )
  })

  it('refuses a missing required path param instead of hitting the literal :id', () => {
    expect(() => buildActionRequest(navigate, { url: 'https://example.com' })).toThrow(
      /缺少必填参数 id/
    )
  })

  it('encodes path params', () => {
    const request = buildActionRequest(navigate, { id: 'a/b c' })
    expect(request.path).toBe('/browser/tabs/a%2Fb%20c/navigate')
  })
})

describe('createControlMcpHandler over streamable http', () => {
  async function startRuntime({
    endpoints = BROWSER_ENDPOINTS,
    socketPath = '/nonexistent.sock'
  } = {}) {
    const handler = createControlMcpHandler({
      kind: 'mica-browser',
      title: '受控浏览器',
      usage: '驱动浏览器',
      socketPath,
      label: '受控浏览器服务',
      loadCatalog: async () => ({ endpoints, guide: '先 listBrowsers' })
    })
    const server = createServer((req, res) => {
      if (req.url === '/mcp/browser') return void handler(req, res)
      res.writeHead(404).end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    return { url: `http://127.0.0.1:${port}/mcp/browser`, close: () => server.close() }
  }

  async function connect(url, headers = {}) {
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers }
    })
    await client.connect(transport)
    return client
  }

  it('exposes exactly one tool with a description that explains the two modes', async () => {
    const runtime = await startRuntime()
    const client = await connect(runtime.url)
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe(CONTROL_TOOL_NAME)
      expect(tools[0].description).toContain('不带 action')
      expect(tools[0].inputSchema.properties.action).toBeDefined()
    } finally {
      await client.close()
      runtime.close()
    }
  })

  it('returns the doc list when called without an action', async () => {
    const runtime = await startRuntime()
    const client = await connect(runtime.url)
    try {
      const result = await client.callTool({ name: CONTROL_TOOL_NAME, arguments: {} })
      const payload = JSON.parse(result.content[0].text)
      expect(payload.server).toBe('mica-browser')
      expect(payload.guide).toBe('先 listBrowsers')
      expect(payload.actions.map((item) => item.action)).toContain('listBrowsers')
    } finally {
      await client.close()
      runtime.close()
    }
  })

  it('reports an unknown action instead of silently doing nothing', async () => {
    const runtime = await startRuntime()
    const client = await connect(runtime.url)
    try {
      const result = await client.callTool({
        name: CONTROL_TOOL_NAME,
        arguments: { action: 'nope' }
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('未知操作 nope')
    } finally {
      await client.close()
      runtime.close()
    }
  })

  // owner 决定窗口/终端挂到哪条会话上，MCP 这一层必须把它原样带到主进程服务
  it('forwards the caller owner header to the control service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-mcp-'))
    const socketPath = join(dir, 'svc.sock')
    const seen = []
    const service = createServer((req, res) => {
      seen.push({ url: req.url, owner: req.headers['x-mica-owner'] || '' })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, browsers: [] }))
    })
    await new Promise((resolve) => service.listen(socketPath, resolve))

    const runtime = await startRuntime({ socketPath })
    const client = await connect(runtime.url, { 'x-mica-owner': 'sess-1' })
    try {
      const result = await client.callTool({
        name: CONTROL_TOOL_NAME,
        arguments: { action: 'navigate', params: { id: 'tab-1', url: 'https://example.com' } }
      })
      expect(result.isError).toBeUndefined()
      expect(seen).toHaveLength(1)
      expect(seen[0]).toEqual({
        url: '/browser/tabs/tab-1/navigate',
        owner: 'sess-1'
      })
    } finally {
      await client.close()
      runtime.close()
      service.close()
    }
  })
})
