import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CONTROL_TOOL_NAME } from './control-mcp.js'
import {
  CONTROL_MCP_SERVERS,
  CONTROL_ORIGIN_ENV,
  availableControlKinds,
  controlMcpUrl
} from './control-mcp-config.js'
import { readCachedMcpResult } from './mcp-probe.js'

/**
 * 输入框 `/` 浮层里的 MCP server 候选（纯扫描，IPC 装配层在 mcp-candidates.js）。
 *
 * 只读 `$MICA_HOME/config.json`，不发起连接：候选要跟着击键即时出，等一次 MCP 握手
 * （http 3s 超时、stdio 还要起进程）就来不及了。工具名只在「刚刚探测过同一个配置」时
 * 交给 `mcp-probe` 的缓存带出来，没探过就只报名字。
 *
 * 除了用户配置的那些，运行时自己还会挂两个 MCP server（受控浏览器 / 终端）：它们是
 * 按会话生成 `--mcp-config` 的，从不写进 `config.json`，所以这里直接按当前进程的
 * socket 能力算出来——内置能力不该要求用户抄一遍配置。
 *
 * 与 `skills-core.listSkills` 相对：两者共同组成 `/` 的候选列表，都只负责「列出来」，
 * 选中后插什么文本由渲染层决定（见 chat-completions.js）。
 *
 * 每条候选带 `source`：内置（运行时挂的）与配置里的分开标，用户才知道要改去哪里。
 */

const MAX_TOOLS = 50

export function micaHome() {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(homedir(), '.mica')
}

export function mcpConfigPath() {
  return join(micaHome(), 'config.json')
}

/**
 * 运行时自带、不需要任何配置的 MCP server。
 *
 * 判据只有一条：宿主真的提供了对应能力（主进程注入了浏览器 / 终端的 socket 变量）。
 * 纯 Web 宿主两个都没有，于是这里什么都不返回——列一个连不上的 server 比不列更糟。
 */
export function builtinMcpCandidates(env = process.env) {
  const origin = env?.[CONTROL_ORIGIN_ENV] ?? ''
  return availableControlKinds(env)
    .map((kind) => {
      const name = CONTROL_MCP_SERVERS[kind]
      if (!name) return null
      const url = controlMcpUrl(origin, kind)
      return {
        name,
        type: 'http',
        // 这两个 server 只有一个 tool，名字是契约的一部分（见 control-mcp.js），不必探测。
        tools: [CONTROL_TOOL_NAME],
        source: { kind: 'builtin', label: '内置' },
        ...(url ? { url } : {})
      }
    })
    .filter(Boolean)
}

/** 按名字排序的候选；配置文件缺失或损坏时返回空数组，不让输入框报错。 */
export function listMcpCandidates() {
  const builtin = builtinMcpCandidates()
  const builtinNames = new Set(builtin.map((server) => server.name))
  const path = mcpConfigPath()
  if (!existsSync(path)) return builtin.sort(byName)
  let configured
  try {
    configured = JSON.parse(readFileSync(path, 'utf-8')).mcpServers ?? {}
  } catch {
    return builtin.sort(byName)
  }
  if (!configured || typeof configured !== 'object') return builtin.sort(byName)

  // 同名时内置的赢：运行时挂在会话上的那份带 owner 头，用户手抄一份也不会更准。
  const configuredCandidates = Object.entries(configured)
    .filter(([name]) => !builtinNames.has(name))
    .map(([name, config]) => {
      const cached = readCachedMcpResult(name, config)
      const tools = (cached?.tools ?? [])
        .slice(0, MAX_TOOLS)
        .map((tool) => String(tool?.name ?? ''))
        .filter(Boolean)
      return {
        name,
        type: config && typeof config.url === 'string' ? 'http' : 'stdio',
        tools,
        // 配置文件的绝对路径放进 `detail`：悬停就知道该改哪个文件。
        source: { kind: 'config', label: 'config.json', detail: path }
      }
    })

  return [...builtin, ...configuredCandidates].sort(byName)
}

function byName(left, right) {
  return left.name.localeCompare(right.name)
}
