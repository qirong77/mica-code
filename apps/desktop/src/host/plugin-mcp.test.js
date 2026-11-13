import { afterEach, describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createPluginMcpHandler } from './plugin-mcp.js'

const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

function handler() {
  return {
    instructions: '只处理测试数据。',
    tools: [
      {
        name: 'echo',
        description: '回显一段文字',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        async execute(input) {
          return { echoed: input.text }
        }
      }
    ]
  }
}

async function start(handlerValue = handler(), runtimePatch = {}) {
  const handle = createPluginMcpHandler({
    runtime: {
      load: async () => handlerValue,
      manifestOf: () => ({ version: '1.0.0' }),
      ...runtimePatch
    }
  })
  const server = createServer((req, res) => {
    if (req.url === '/plugin/demo/mcp') return void handle('demo', req, res)
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const { port } = server.address()
  return `http://127.0.0.1:${port}/plugin/demo/mcp`
}

async function connect(url) {
  const client = new Client({ name: 'plugin-mcp-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

describe('generic plugin MCP handler', () => {
  it('serves instructions, tool definitions and tool calls over Streamable HTTP', async () => {
    const client = await connect(await start())
    try {
      expect((await client.getServerCapabilities()).tools).toBeDefined()
      const listed = await client.listTools()
      expect(listed.tools).toEqual([
        expect.objectContaining({ name: 'echo', description: '回显一段文字' })
      ])
      const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } })
      expect(result.isError).toBeUndefined()
      expect(JSON.parse(result.content[0].text)).toEqual({ echoed: 'hello' })
    } finally {
      await client.close()
    }
  })

  it('validates the declared input schema before executing a tool', async () => {
    let calls = 0
    const custom = handler()
    custom.tools[0].execute = async () => {
      calls += 1
      return 'should not run'
    }
    const client = await connect(await start(custom))
    try {
      const result = await client.callTool({ name: 'echo', arguments: { text: 123, extra: true } })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('参数无效')
      expect(calls).toBe(0)
    } finally {
      await client.close()
    }
  })

  it('rejects non-POST probes before loading plugin code', async () => {
    let loads = 0
    const url = await start(handler(), { load: async () => { loads += 1; return handler() } })
    const response = await fetch(url)
    expect(response.status).toBe(405)
    expect(await response.json()).toMatchObject({ error: 'MCP endpoint 只接受 POST' })
    expect(loads).toBe(0)
  })

  it('returns a structured initialization error when a plugin MCP module fails', async () => {
    const url = await start(handler(), {
      load: async () => { throw new Error('模块损坏') }
    })
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32603, message: '插件 MCP 初始化失败：模块损坏' }
    })
  })
})
