/**
 * 受控能力（浏览器 / 终端）的 MCP 门面。
 *
 * 这两个能力以前以 skill 形式出现：往 `$MICA_HOME/skills/<name>/SKILL.md` 写一行地址，
 * agent 再自己用 curl 打运行时的 HTTP 接口。skill 只说「服务在哪」，接口清单、参数和
 * owner 头全靠 agent 现读文档，工具层面完全不可见 —— agent 既不会主动去读，也拿不到
 * 「归属到当前会话」这类只有服务端才知道的上下文。
 *
 * 现在改成 MCP server，对 agent 只暴露**一个 tool**：
 *
 * - 不带 `action`：返回这台机器上可用的操作清单（doc 列表），模型按需读；
 * - 带 `action` + `params`：按端点目录（browser-docs.js / terminal-docs.js，唯一事实来源）
 *   把参数映射到 path/query/body，转发给主进程的 Unix socket 服务。
 *
 * 单 tool 是刻意的：端点有 20+ 条，逐条注册会占满工具位，也让模型在「该用哪个」上分心；
 * 文档按需返回，模型只在真正要操作时才看细节。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { suggestActionIds } from '../main/browser/browser-docs.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { openSocketRequest } from './control-client.js'

export const OWNER_HEADER = 'x-mica-owner'
export const CONTROL_TOOL_NAME = 'control'

/** 运行时把两个能力的 MCP 地址挂在同源路径下，agent 只看到一个普通 URL。 */
export const CONTROL_MCP_PREFIX = '/mcp'

/** SSE 与元信息端点不进入 action 列表：MCP 调用是一次性请求，接不了流。 */
const NON_ACTION_IDS = new Set(['health', 'capabilities', 'docs', 'events'])

const REQUEST_TIMEOUT_MS = 30_000

function isActionEndpoint(endpoint) {
  return Boolean(endpoint?.id) && !NON_ACTION_IDS.has(endpoint.id) && endpoint.method !== 'SSE'
}

/**
 * 把端点目录压成 action 文档：只保留 agent 需要知道的字段。
 *
 * `in: 'header'` 的参数（owner）不列：它由服务端按当前会话注入，agent 传了也会被覆盖。
 */
export function buildControlDocs({ server, title, guide = '', endpoints = [], usage = '' }) {
  return {
    server,
    title,
    usage,
    guide,
    actions: endpoints.filter(isActionEndpoint).map((endpoint) => ({
      action: endpoint.id,
      method: endpoint.method,
      summary: endpoint.summary,
      params: describeParams(endpoint),
      returns: endpoint.returns || ''
    }))
  }
}

/**
 * 一个 action 对 agent 可见的参数列表。
 *
 * 路径占位符（`/browser/tabs/:id/click` 里的 `id`）必须列进来：以前它只存在于 path 里，
 * 调用时缺了又会直接报错，agent 只能靠猜——真实轨迹里 98 次「缺少必填参数 id」都是这么来的。
 */
function describeParams(endpoint) {
  const fromPath = pathParams(endpoint)
  return [
    ...fromPath.map((name) => ({
      name,
      in: 'path',
      required: true,
      description: name === 'id' ? '目标 id（标签页或浏览器，看这个操作的路径）' : undefined
    })),
    // 已经由路径声明过的名字不重复列（老目录里偶尔会重复声明一次）。
    ...(endpoint.params || [])
      .filter((param) => param.in !== 'header' && !fromPath.includes(param.name))
      .map((param) => ({
        name: param.name,
        in: param.in,
        required: param.required === true,
        description: param.description
      }))
  ]
}

/** `/browser/tabs/:id/click` → ['id']：路径里出现几次就要求几次。 */
export function pathParams(endpoint) {
  const names = []
  for (const match of String(endpoint?.path || '').matchAll(/:([A-Za-z0-9_]+)/g)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

/**
 * 判断调用方传的参数是否都能被该 action 解释。
 *
 * 拼错的参数名（`selector` 写成 `selecter`）静默丢掉会得到一个「什么都没发生」的成功响应，
 * 比直接报错更难排查；这里明确回绝并列出可用参数。
 */
export function unknownParams(endpoint, params = {}) {
  if (!params || typeof params !== 'object') return []
  const known = new Set([
    ...(endpoint.params || []).map((param) => param.name),
    ...pathParams(endpoint)
  ])
  // `id` 的别名在下面会被折进去，不该再报「不认识这个参数」。
  const aliases = new Set(Object.keys(PATH_ID_ALIASES))
  return Object.keys(params).filter((key) => !known.has(key) && !aliases.has(key))
}

/**
 * agent 对「标签页 id」的自然写法。
 *
 * 文档里的路径参数叫 `id`，但模型更常写 `tabId` / `browserId` / `tab`——真实轨迹里
 * 这类不匹配有 60+ 次。别名是稳定的同义关系，不该让模型为命名差异多花一次往返。
 */
const PATH_ID_ALIASES = {
  tabId: 'id',
  tab: 'id',
  tabid: 'id',
  browserId: 'id',
  browser: 'id',
  targetId: 'id'
}

/** 把 `id` 的别名折回路径参数名；显式给了 `id` 就优先用它。 */
function withPathId(endpoint, params) {
  if (!params || typeof params !== 'object' || params.id !== undefined) return params
  if (!pathParams(endpoint).includes('id')) return params
  // 端点自己声明了同名参数（`createTab` 的 `browserId` 是 body 里的目标窗口）时不能折叠，
  // 否则会把一个真实参数改写成路径 id。
  const declared = new Set((endpoint.params || []).map((param) => param.name))
  for (const [alias, target] of Object.entries(PATH_ID_ALIASES)) {
    if (declared.has(alias)) continue
    if (params[alias] === undefined || params[alias] === null || params[alias] === '') continue
    const folded = { ...params, [target]: params[alias] }
    delete folded[alias]
    return folded
  }
  return params
}

/**
 * 按端点文档把 `params` 摊到 path / query / body / header。
 *
 * 路径参数没给就报错（`/browser/tabs/:id/click` 少了 id 会打到字面量 `:id` 上），
 * 其余参数缺省即不带 —— 服务端本来就有默认值。
 */
export function buildActionRequest(endpoint, params = {}, { owner = '' } = {}) {
  if (!endpoint) throw new Error('未知操作')
  const folded = withPathId(endpoint, params)
  const unknown = unknownParams(endpoint, folded)
  if (unknown.length > 0) {
    const known = [...pathParams(endpoint), ...(endpoint.params || []).map((param) => param.name)]
    throw new Error(
      `操作 ${endpoint.id} 不认识这些参数：${unknown.join('、')}；可用参数：${known.join('、') || '（无）'}`
    )
  }

  let path = String(endpoint.path || '')
  const query = new URLSearchParams()
  const body = {}
  const headers = {}
  let hasBody = false

  for (const param of endpoint.params || []) {
    const value = folded[param.name]
    if (value === undefined || value === null || value === '') continue
    if (param.in === 'path') {
      path = path.split(`:${param.name}`).join(encodeURIComponent(String(value)))
    } else if (param.in === 'query') {
      query.set(param.name, String(value))
    } else if (param.in === 'body') {
      body[param.name] = value
      hasBody = true
    } else if (param.in === 'header' && param.name !== OWNER_HEADER) {
      headers[param.name] = String(value)
    }
  }

  // 路径占位符都在 path 里，不在 params 里：按 path 本身判断，顺带给出它还需要哪些参数，
  // 这样一次往返就能改对。
  for (const name of pathParams(endpoint)) {
    const value = folded[name]
    if (value === undefined || value === null || value === '') {
      const known = (endpoint.params || []).map((param) => param.name)
      throw new Error(
        `操作 ${endpoint.id} 缺路径参数 ${name}（例如 {"${name}":"tab-1"${known.length ? `,"${known[0]}":…` : ''}}）；这个操作其余可用参数：${known.join('、') || '（无）'}`
      )
    }
    path = path.split(`:${name}`).join(encodeURIComponent(String(value)))
  }

  if (owner) headers[OWNER_HEADER] = String(owner)
  const queryString = query.toString()
  return {
    method: endpoint.method === 'SSE' ? 'GET' : endpoint.method || 'GET',
    path: queryString ? `${path}?${queryString}` : path,
    body: hasBody ? body : undefined,
    headers
  }
}

function decodeBody(buffer, contentType) {
  const text = buffer.toString('utf8')
  if (!contentType.includes('application/json')) return { kind: 'text', value: text }
  try {
    return { kind: 'json', value: text ? JSON.parse(text) : null }
  } catch {
    return { kind: 'text', value: text }
  }
}

/**
 * 调一次主进程服务，并保留响应形态：JSON 原样转文本，图片（截图 raw）转成 MCP 的
 * image content —— 否则 agent 只能拿到一串 base64，既看不懂也浪费上下文。
 */
export async function callControlService(
  socketPath,
  request,
  { label = '受控服务', timeoutMs = REQUEST_TIMEOUT_MS } = {}
) {
  const response = await openSocketRequest(socketPath, request.path, {
    method: request.method,
    body: request.body,
    headers: request.headers,
    timeoutMs,
    label
  })
  const chunks = []
  for await (const chunk of response) chunks.push(chunk)
  const buffer = Buffer.concat(chunks)
  const contentType = String(response.headers['content-type'] || '')

  if (response.statusCode >= 400) {
    const decoded = decodeBody(buffer, contentType)
    const message =
      (decoded.value && typeof decoded.value === 'object' && decoded.value.error) ||
      `${label}返回 HTTP ${response.statusCode}`
    return Promise.reject(new Error(String(message)))
  }
  if (contentType.startsWith('image/')) {
    return { kind: 'image', mimeType: contentType.split(';')[0], data: buffer.toString('base64') }
  }
  return decodeBody(buffer, contentType)
}

function toolResult(value) {
  if (value.kind === 'image')
    return { content: [{ type: 'image', data: value.data, mimeType: value.mimeType }] }
  const text = typeof value.value === 'string' ? value.value : JSON.stringify(value.value, null, 2)
  return { content: [{ type: 'text', text }] }
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function ownerFromRequest(extra) {
  const headers = extra?.requestInfo?.headers
  if (!headers) return ''
  const value = headers[OWNER_HEADER]
  return typeof value === 'string' ? value.trim() : ''
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 构造一个只暴露单 tool 的 MCP server。
 *
 * 用底层的 `Server` 而不是 `McpServer`：这里只需要 tools/list 与 tools/call 两个处理器，
 * 也避免为此引入 zod 作为 desktop 的直接依赖。
 */
export function createControlMcpServer({
  serverInfo,
  instructions,
  toolDescription,
  getCatalog,
  callAction
}) {
  const server = new Server(
    { name: serverInfo.name, version: serverInfo.version || '1.0.0' },
    { capabilities: { tools: {} }, instructions }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: CONTROL_TOOL_NAME,
        title: `${serverInfo.title} 控制`,
        description: toolDescription,
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description:
                '要执行的操作 id（取自返回的 actions[].action）。省略时返回全部操作的文档列表。'
            },
            params: {
              type: 'object',
              description: '该操作的参数，键名与文档里的 params[].name 一致。',
              additionalProperties: true
            }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, openWorldHint: false }
      }
    ]
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params?.arguments || {}
    const action = typeof args.action === 'string' ? args.action.trim() : ''
    const owner = ownerFromRequest(extra)
    try {
      const catalog = await getCatalog()
      if (!action) return toolResult({ kind: 'json', value: catalog.docs })
      return toolResult(await callAction(action, args.params || {}, { owner, catalog }))
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  })

  return server
}

/**
 * 运行时的 `/mcp/<kind>` 处理器：每次请求独立建 server + stateless transport。
 *
 * 这两个能力没有需要跨请求保持的 MCP 状态（窗口/终端状态都在主进程服务里），
 * stateless 因此省掉会话表、断线清理与并发复用的一整套复杂度。
 *
 * `loadCatalog` 只在第一次工具调用时执行：`tools/list` 是会话启动链路的一部分，
 * 不该因为受控服务一时没起来就让整个 MCP 连接超时。
 */
export function createControlMcpHandler({
  kind,
  title,
  usage,
  socketPath,
  loadCatalog,
  label = '受控服务',
  guide = ''
}) {
  let catalogPromise = null

  const getCatalog = () => {
    if (!catalogPromise) {
      catalogPromise = Promise.resolve()
        .then(() => loadCatalog())
        .then((payload) => {
          const endpoints = Array.isArray(payload?.endpoints) ? payload.endpoints : []
          if (endpoints.length === 0) throw new Error(`${label}没有返回端点目录`)
          const byId = new Map(endpoints.filter(isActionEndpoint).map((item) => [item.id, item]))
          return {
            byId,
            docs: buildControlDocs({
              server: kind,
              title,
              guide: payload?.guide || guide,
              endpoints,
              usage
            })
          }
        })
        .catch((error) => {
          catalogPromise = null
          throw error
        })
    }
    return catalogPromise
  }

  const instructions = [
    `这是 Mica 桌面应用内置的「${title}」。`,
    usage,
    '只有一个工具 control：不带 action 调用会返回全部操作的文档；带上 action 与 params 执行。',
    '不要自己去 curl 运行时的 HTTP 接口，统一走这个工具。'
  ].join('\n')

  const toolDescription =
    `${title}：${usage} ` +
    '不带 action 调用返回可用操作清单与每个操作的参数说明；' +
    '带 action + params 执行对应操作并返回服务端结果。'

  return async function handleControlMcp(req, res, parsedBody) {
    const body = parsedBody === undefined ? await readJsonBody(req) : parsedBody
    const server = createControlMcpServer({
      serverInfo: { name: kind, title, version: '1.0.0' },
      instructions,
      toolDescription,
      getCatalog,
      callAction: async (action, params, options) => {
        const endpoint = options.catalog.byId.get(action)
        if (!endpoint) {
          const ids = [...options.catalog.byId.keys()]
          const closest = suggestActionIds(action, ids)
          throw new Error(
            `未知操作 ${action}；` +
              (closest.length > 0 ? `最接近的合法操作：${closest.join('、')}。` : '') +
              `可用操作：${ids.join('、')}。不带 action 调用可看完整文档。`
          )
        }
        if (kind === 'mica-browser' && !options.owner) {
          throw new Error('缺少会话归属，无法调用浏览器操作')
        }
        const actionParams =
          kind === 'mica-browser' && action === 'screenshot'
            ? { ...params, raw: params.raw ?? true }
            : params
        const request = buildActionRequest(endpoint, actionParams, options)
        return callControlService(socketPath, request, { label })
      }
    })

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
