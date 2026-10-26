/**
 * 终端控制在运行时的纯逻辑：环境变量约定、会话摘要归一化、设置页详情装配、SSE 解析。
 *
 * 不 import electron、不发请求 —— 请求与 IPC 在 terminal-control.js，这里只放能直接测的部分。
 */

import { TERMINAL_CONTROL_PREFIX } from '@packages/mica-web-shared/index.js'

/**
 * 地址、归属与 socket 三个变量名：一起写进设置页，别在两处各写一份。
 *
 * 终端宿主活在 Electron 主进程里（真实 PTY + 窗口），它**不占 TCP 端口**，只监听一个
 * Unix socket；运行时在**自己已有的端口**上把 `/remote/terminal/*` 代理过去，所以 agent
 * 只需要一个普通 HTTP 地址（`MICA_TERMINAL_URL`）。
 */
export const TERMINAL_URL_ENV = 'MICA_TERMINAL_URL'
export const TERMINAL_OWNER_ENV = 'MICA_TERMINAL_OWNER'
export const TERMINAL_SOCKET_ENV = 'MICA_TERMINAL_SOCKET'
/**
 * 运行时把主进程的终端服务挂在哪个路径下（`MICA_TERMINAL_URL` 的路径部分）。
 * 唯一事实来源在 `mica-web-shared/app-paths.ts`：页面、运行时、代理共用同一份。
 */
export { TERMINAL_CONTROL_PREFIX }

/** 运行时暴露给 agent 的 MCP 端点（`/mcp/terminal`）。 */
export const TERMINAL_MCP_KIND = 'terminal'

export function emptyTerminalSnapshot(error = null) {
  return { available: false, serviceUrl: null, mcpUrl: null, sessions: [], error }
}

/** 归一化服务端返回的终端列表：界面只用这些字段，缺的给默认值 */
export function normalizeTerminalSummaries(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      return {
        id: String(item.id || ''),
        owner: item.owner ? String(item.owner) : null,
        label: String(item.label || ''),
        cwd: String(item.cwd || ''),
        shell: String(item.shell || ''),
        cols: Number(item.cols) || 0,
        rows: Number(item.rows) || 0,
        createdAt: item.createdAt ? String(item.createdAt) : null,
        updatedAt: item.updatedAt ? String(item.updatedAt) : null,
        running: item.running !== false,
        exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
        signal: item.signal ? String(item.signal) : null,
        windowVisible: Boolean(item.windowVisible),
        outputSeq: Number(item.outputSeq) || 0,
        truncated: Boolean(item.truncated)
      }
    })
    .filter((item) => item && item.id)
}

export function terminalDetailsFrom({ docs, sessions, serviceUrl, mcpUrl = '', error = null }) {
  return {
    available: Boolean(serviceUrl),
    serviceUrl: serviceUrl || null,
    mcpUrl: mcpUrl || null,
    toolName: 'control',
    version: Number(docs?.version) || 0,
    error,
    sessions: normalizeTerminalSummaries(sessions),
    endpoints: Array.isArray(docs?.endpoints) ? docs.endpoints : [],
    markdown: typeof docs?.markdown === 'string' ? docs.markdown : '',
    envVars: { url: TERMINAL_URL_ENV, owner: TERMINAL_OWNER_ENV }
  }
}

/** 与受控浏览器同一帧格式：`{ channel, payload }` */
export function parseTerminalSseData(line) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('data:')) return null
  try {
    const parsed = JSON.parse(raw.slice(5).trim())
    if (!parsed || typeof parsed.channel !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** 快照是否等价：等价就不广播，避免每秒一次的无效重渲染 */
export function sameTerminalSessions(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || [])
}

/**
 * 注入给会话进程（app-server / 内置终端）的归属变量。地址由运行时自己继承
 * `MICA_TERMINAL_URL`，这里只补「这个进程是谁」——agent 把它写进 x-mica-owner 头。
 */
export function terminalOwnerEnv(owner) {
  return owner ? { [TERMINAL_OWNER_ENV]: String(owner) } : {}
}
