import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readCachedMcpResult } from './mcp-probe.js'

/**
 * 输入框 `/` 浮层里的 MCP server 候选（纯扫描，IPC 装配层在 mcp-candidates.js）。
 *
 * 只读 `$MICA_HOME/config.json`，不发起连接：候选要跟着击键即时出，等一次 MCP 握手
 * （http 3s 超时、stdio 还要起进程）就来不及了。工具名只在「刚刚探测过同一个配置」时
 * 交给 `mcp-probe` 的缓存带出来，没探过就只报名字。
 *
 * 与 `skills-core.listSkills` 相对：两者共同组成 `/` 的候选列表，都只负责「列出来」，
 * 选中后插什么文本由渲染层决定（见 chat-completions.js）。
 */

const MAX_TOOLS = 50

export function micaHome() {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(homedir(), '.mica')
}

export function mcpConfigPath() {
  return join(micaHome(), 'config.json')
}

/** 按名字排序的候选；配置文件缺失或损坏时返回空数组，不让输入框报错。 */
export function listMcpCandidates() {
  const path = mcpConfigPath()
  if (!existsSync(path)) return []
  let configured
  try {
    configured = JSON.parse(readFileSync(path, 'utf-8')).mcpServers ?? {}
  } catch {
    return []
  }
  if (!configured || typeof configured !== 'object') return []

  return Object.entries(configured)
    .map(([name, config]) => {
      const cached = readCachedMcpResult(name, config)
      const tools = (cached?.tools ?? [])
        .slice(0, MAX_TOOLS)
        .map((tool) => String(tool?.name ?? ''))
        .filter(Boolean)
      return {
        name,
        type: config && typeof config.url === 'string' ? 'http' : 'stdio',
        tools
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}
