import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { pluginMcpServerName } from '@packages/mica-plugin/PluginMcp.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * Generic MCP facade for bundled plugins.  The application owns HTTP/MCP
 * framing; a plugin only supplies tool definitions and an execute function.
 */
export function createPluginMcpHandler({ runtime }) {
  return async function handlePluginMcp(pluginId, req, res) {
    // This endpoint is stateless, so there is no server-sent event session for
    // GET/DELETE to resume.  Reject them before lazy-loading plugin code; GET
    // is a common browser probe and must not initialize a write-capable plugin.
    if (req.method !== 'POST') {
      res.writeHead(405, {
        allow: 'POST',
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      return res.end(JSON.stringify({ ok: false, error: 'MCP endpoint 只接受 POST' }))
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: errorMessage(error) } })
    }

    let handler
    let manifest
    let server
    try {
      handler = await runtime.load(pluginId)
      manifest = runtime.manifestOf(pluginId)
      server = createPluginMcpServer({ pluginId, version: manifest.version, handler })
    } catch (error) {
      return sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: `插件 MCP 初始化失败：${errorMessage(error)}` }
      })
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}

export function createPluginMcpServer({ pluginId, version = '1.0.0', handler }) {
  const server = new Server(
    { name: pluginMcpServerName(pluginId), version },
    { capabilities: { tools: {} }, ...(handler.instructions ? { instructions: handler.instructions } : {}) }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: handler.tools.map(({ execute: _execute, ...tool }) => tool)
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name
    const tool = handler.tools.find((candidate) => candidate.name === name)
    if (!tool) return errorResult(`未知 MCP 工具：${String(name || '')}`)

    const input = request.params?.arguments ?? {}
    const validationError = validateToolInput(input, tool.inputSchema)
    if (validationError) return errorResult(`${tool.name} 参数无效：${validationError}`)

    const signal = extra?.signal ?? new AbortController().signal
    try {
      if (signal.aborted) throw signal.reason ?? new Error('MCP request aborted')
      const value = await tool.execute(input, { signal })
      if (signal.aborted) throw signal.reason ?? new Error('MCP request aborted')
      return textResult(value)
    } catch (error) {
      return errorResult(errorMessage(error))
    }
  })

  return server
}

function textResult(value) {
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] }
  let text
  try {
    text = JSON.stringify(value === undefined ? null : value, null, 2)
  } catch (error) {
    return errorResult(`MCP 工具返回值无法序列化：${errorMessage(error)}`)
  }
  return { content: [{ type: 'text', text }] }
}

function errorResult(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true }
}

async function readJsonBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('MCP 请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return undefined
  return JSON.parse(text)
}

/** Minimal JSON-schema validation for the schema surface exposed by plugin tools. */
function validateToolInput(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return null
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return `${path} 必须是 ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(' / ')}`
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) return `${path} 类型无效`
  }
  if (value === null || value === undefined) return null
  if (isObjectSchema(value, schema)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) return `${path}.${required} 是必填项`
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) return `${path}.${key} 不是支持的参数`
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue
      const error = validateToolInput(value[key], childSchema, `${path}.${key}`)
      if (error) return error
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateToolInput(value[index], schema.items, `${path}[${index}]`)
      if (error) return error
    }
  }
  return null
}

function isObjectSchema(value, schema) {
  return (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) && isPlainObject(value)
}

function matchesType(value, type) {
  if (type === 'null') return value === null
  if (type === 'object') return isPlainObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return Number.isInteger(value)
  return true
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
