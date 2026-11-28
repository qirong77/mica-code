/**
 * 把受控能力与独立插件 MCP 注册成 server：生成每个会话自己的 `--mcp-config` 文件。
 *
 * 为什么必须按会话生成：MCP server 的 `x-mica-owner` 头决定窗口/终端归属到哪条会话
 * （终端写操作还靠它挡串台），而 owner 是进程级信息、`mcpServers` 配置里又没有变量展开。
 * 于是运行时按 owner 生成一份配置，聊天进程启动时用 `--mcp-config` 带上——
 * 不写用户自己的 `~/.mica/config.json`，会话之间也不会互相看到对方的归属。
 *
 * 纯 Node 实现（不 import electron），路径与内容都能直接测。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** MCP server 名：会出现在工具名 `mcp__<server>__<tool>` 里，别带空格与斜杠。 */
export const CONTROL_MCP_SERVERS = {
  browser: 'mica-browser',
  terminal: 'mica-terminal'
}

/** 运行时把自己端口上的地址写进这个变量：会话配置要拼 `/mcp/<kind>`。 */
export const CONTROL_ORIGIN_ENV = 'MICA_DESKTOP_ORIGIN'

/** 哪个 socket 变量存在，就说明主进程提供了对应能力。 */
export const CONTROL_SOCKET_ENVS = {
  browser: 'MICA_BROWSER_SOCKET',
  terminal: 'MICA_TERMINAL_SOCKET'
}

/** 当前运行时真正可用的能力（纯 Web 宿主两个都没有）。 */
export function availableControlKinds(env = process.env) {
  return Object.entries(CONTROL_SOCKET_ENVS)
    .filter(([, key]) => Boolean(env?.[key]))
    .map(([kind]) => kind)
}

/** 运行时在同一个端口上挂的两个 MCP 端点。 */
export function controlMcpUrl(origin, kind) {
  const base = String(origin || '')
    .trim()
    .replace(/\/+$/, '')
  if (!base || !kind) return ''
  return `${base}/mcp/${kind}`
}

/**
 * 生成 `mcpServers` 配置。
 *
 * `kinds` 只包含真正可用的能力：纯 Web 宿主（`npm run start:web`）两个 socket 都没有，
 * 调用方就不会走到这里；只有其中一个可用时也只注册一个 server。
 */
export function buildControlMcpServers({ origin, owner = '', kinds = [] }) {
  const headers = owner ? { 'x-mica-owner': String(owner) } : undefined
  const servers = {}
  for (const kind of kinds) {
    const url = controlMcpUrl(origin, kind)
    const name = CONTROL_MCP_SERVERS[kind]
    if (!url || !name) continue
    servers[name] = { type: 'http', url, ...(headers ? { headers } : {}) }
  }
  return servers
}

/** 一个 owner 一份文件；owner 可能带路径分隔符（页签 id），用哈希保证文件名安全。 */
export function controlMcpConfigPath(homeDir, owner, separator = '/') {
  const key = String(owner || '').trim()
  if (!homeDir || !key) return ''
  const digest = createHash('sha1').update(key).digest('hex').slice(0, 16)
  return [homeDir, 'desktop', 'mcp', `${digest}.json`].join(separator)
}

/**
 * 写配置并返回文件路径；没有可用能力或没有 owner 时返回 null（调用方就不加 `--mcp-config`）。
 *
 * 同步写：调用点在 spawn 之前，异步写会让子进程先读到旧文件（端口回退时尤其明显）。
 */
export function writeControlMcpConfig({
  homeDir,
  origin,
  owner = '',
  kinds = [],
  extraServers = {},
  separator = '/'
}) {
  const path = controlMcpConfigPath(homeDir, owner, separator)
  if (!path) return null
  const servers = { ...buildControlMcpServers({ origin, owner, kinds }), ...extraServers }
  if (Object.keys(servers).length === 0) return null
  try {
    mkdirSync(join(homeDir, 'desktop', 'mcp'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf8')
  } catch {
    return null
  }
  return path
}

