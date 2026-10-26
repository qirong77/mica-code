import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expandMcpEnv } from '@packages/mica-mcp/config.js'
import { CONTROL_ORIGIN_ENV } from './control-mcp-config.js'

/**
 * 配置页 MCP 列表的连通性探测。
 *
 * 设置页要在圆点上反映「现在能不能用」，而连接本身发生在会话子进程（`mica app-server`）
 * 里，宿主进程不持有任何 MCP 连接。所以这里按需做一次最小握手：`initialize` + `tools/list`
 * 然后立刻关闭——既拿到真实状态，也顺带拿到工具数量（原本这一列恒为 0）。
 *
 * 只探测 http 类型的 server。stdio 得先把子进程起起来（缺省那个还是 `npx -y`，首次要下包），
 * 打开一次设置页就 spawn 一堆进程不划算，这类保持「已配置」并由页面说明原因。
 *
 * 结果按「名字 + 配置内容」缓存，短时间内反复切换页签不会重复握手；配置一改，key 就变。
 */

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_TTL_MS = 30_000
const MAX_TOOLS = 200

const cache = new Map()

/** 清空探测缓存（测试与强制刷新用）。 */
export function clearMcpProbeCache() {
  cache.clear()
}

/**
 * 只读缓存里的探测结果（不发起连接）。
 *
 * 输入框的 `/` 候选要在每次击键后立刻出列表，不能等 3s 握手；这里只在「刚才探过且配置没变」
 * 时返回，于是打开过设置页之后候选里就能带上真实工具名，没探过就只报名字。
 */
export function readCachedMcpResult(name, config, options = {}) {
  const { ttlMs = DEFAULT_TTL_MS, now = Date.now } = options
  const cached = cache.get(name)
  if (!cached || cached.key !== JSON.stringify(config) || now() - cached.at >= ttlMs) {
    return undefined
  }
  return cached.result
}

function isProbeable(config) {
  return Boolean(config && typeof config === 'object' && typeof config.url === 'string')
}

/**
 * 展开 `${VAR}` 用的环境变量。
 *
 * 桌面运行时的端口可能来自 `--port` 或回退，此时 `MICA_DESKTOP_PORT` 并不在环境里，
 * 直接把 `process.env` 交给展开会让 `${MICA_DESKTOP_PORT:-8787}` 落到默认端口上，
 * 探测打到另一个实例、把可用的服务报成红色。所以优先用运行时上报的真实 origin 补齐。
 */
function probeEnv() {
  const env = { ...process.env }
  if (env.MICA_DESKTOP_PORT) return env
  const origin = env[CONTROL_ORIGIN_ENV]
  if (!origin) return env
  try {
    const { port } = new URL(origin)
    if (port) env.MICA_DESKTOP_PORT = port
  } catch {
    // origin 不是合法 URL 时保持原样：展开会退回配置里写的默认值
  }
  return env
}

function normalizeTools(tools) {
  return (Array.isArray(tools) ? tools : []).slice(0, MAX_TOOLS).map((tool) => ({
    name: String(tool?.name ?? ''),
    description: String(tool?.description ?? '')
  }))
}

async function connectHttpTools(config, { timeoutMs, env }) {
  const url = expandMcpEnv(config.url, env)
  const headers = config.headers
    ? Object.fromEntries(
        Object.entries(config.headers).map(([key, value]) => [
          key,
          expandMcpEnv(String(value), env)
        ])
      )
    : undefined
  const signal = AbortSignal.timeout(timeoutMs)
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined
  })
  const client = new Client({ name: 'mica-config-probe', version: '0.1.0' }, { capabilities: {} })
  try {
    await client.connect(transport, { timeout: timeoutMs, signal })
    const { tools } = await client.listTools(undefined, { timeout: timeoutMs, signal })
    return tools
  } finally {
    // 探测是一次性的：不关连接会一直挂着 SSE/keep-alive
    await client.close().catch(() => undefined)
  }
}

async function probeOne(config, options) {
  try {
    const tools = normalizeTools(await options.connect(config, options))
    return { status: 'connected', toolCount: tools.length, tools }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'failed',
      toolCount: 0,
      tools: [],
      // 端口没开时的 ECONNREFUSED 原文会带一长串地址，截断后给页面当副标题用
      error: message.length > 160 ? `${message.slice(0, 160)}…` : message
    }
  }
}

/**
 * 探测一组 MCP server，返回 `name → { status, toolCount, tools, error? }`。
 *
 * 只包含探测过的 http server；stdio 与格式不对的条目不出现在结果里，调用方据此保留
 * 「已配置」。
 */
export async function probeMcpServers(servers, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ttlMs = DEFAULT_TTL_MS,
    now = Date.now,
    connect = connectHttpTools,
    env = probeEnv()
  } = options
  const results = new Map()
  const entries = Object.entries(servers || {}).filter(([, config]) => isProbeable(config))

  await Promise.all(
    entries.map(async ([name, config]) => {
      const key = JSON.stringify(config)
      const cached = cache.get(name)
      if (cached && cached.key === key && now() - cached.at < ttlMs) {
        results.set(name, cached.result)
        return
      }
      const result = await probeOne(config, { timeoutMs, connect, env })
      cache.set(name, { key, at: now(), result })
      results.set(name, result)
    })
  )

  // 配置被删掉的条目不该继续占着缓存
  for (const name of [...cache.keys()]) {
    if (!(name in (servers || {}))) cache.delete(name)
  }

  return results
}
