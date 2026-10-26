import { ipcMain } from 'electron'
import { openSocketRequest, requestJson } from './control-client.js'
import {
  TERMINAL_MCP_KIND,
  TERMINAL_OWNER_ENV,
  TERMINAL_SOCKET_ENV,
  TERMINAL_URL_ENV,
  emptyTerminalSnapshot,
  normalizeTerminalSummaries,
  parseTerminalSseData,
  sameTerminalSessions,
  terminalDetailsFrom
} from './terminal-control-core.js'
import { controlMcpUrl } from './control-mcp-config.js'

/**
 * 终端控制在运行时的门面：页面（顶栏图标、设置页）与 agent 各自从这一层进出。
 *
 * - **页面**通过 `terminal-control:*` IPC 读列表、显示/隐藏/关闭、新建；
 * - **agent** 不经过这里：它通过运行时同源端口上的 MCP 端点 `/mcp/terminal` 使用这个能力
 *   （见 control-mcp.js），配置由 control-mcp-config.js 按会话生成。
 *
 * 终端会话（真实 PTY）与窗口都活在 Electron 主进程里，运行时是纯 Node，两边只能靠本机
 * 通道通信：主进程把服务监听在一个 **Unix socket** 上（不占端口），运行时既把它代理成
 * 自己端口上的 `/remote/terminal/*`，也从这里直接读 socket——订阅它的 SSE，把变化广播成
 * `terminal:changed` 给页面。
 */

const REQUEST_TIMEOUT_MS = 4000
const RECONNECT_DELAY_MS = 2000
const CONTROL_LABEL = '终端控制服务'

let broadcaster = () => {}
let state = { ...emptyTerminalSnapshot(), docs: null }
let streamController = null
let started = false

export function setTerminalControlBroadcaster(fn) {
  broadcaster = typeof fn === 'function' ? fn : () => {}
}

function serviceUrl() {
  return String(process.env[TERMINAL_URL_ENV] || '')
    .trim()
    .replace(/\/+$/, '')
}

function socketPath() {
  return String(process.env[TERMINAL_SOCKET_ENV] || '').trim()
}

function hasService() {
  return Boolean(socketPath())
}

/** 运行时端口上的 MCP 端点：设置页展示它，agent 的 `--mcp-config` 也指向它。 */
function mcpUrl() {
  try {
    return controlMcpUrl(new URL(serviceUrl()).origin, TERMINAL_MCP_KIND)
  } catch {
    return ''
  }
}

function publish(reason = 'change') {
  const snapshot = getTerminalControlSnapshot()
  broadcaster('terminal:changed', { reason, ...snapshot })
  return snapshot
}

export function getTerminalControlSnapshot() {
  return {
    available: hasService() && !state.error,
    serviceUrl: serviceUrl() || null,
    mcpUrl: mcpUrl() || null,
    sessions: state.sessions || [],
    error: state.error || null
  }
}

async function request(path, { method = 'GET', body } = {}) {
  return requestJson(socketPath(), path, {
    method,
    body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    label: CONTROL_LABEL
  })
}

/** 刷新终端列表；失败只记录错误，不清空已知列表（服务重启时会自愈） */
async function refresh(reason = 'refresh') {
  if (!hasService()) {
    state = { ...emptyTerminalSnapshot(), docs: state.docs }
    return getTerminalControlSnapshot()
  }
  try {
    const payload = await request('/sessions')
    const sessions = normalizeTerminalSummaries(payload?.sessions)
    const changed = !sameTerminalSessions(state.sessions, sessions)
    state.sessions = sessions
    state.error = null
    if (changed) publish(reason)
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    publish('error')
  }
  return getTerminalControlSnapshot()
}

async function loadDocs() {
  if (state.docs) return state.docs
  try {
    const payload = await request('/docs')
    state.docs = {
      version: payload.version,
      endpoints: payload.endpoints,
      markdown: payload.markdown,
      guide: payload.guide
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
  }
  return state.docs
}

/* ------------------------------------------------------------------ SSE 订阅 */

function applyEvent(parsed) {
  if (parsed?.channel !== 'terminal:changed') return
  const reason = parsed.payload?.reason || 'change'
  const session = parsed.payload?.session
  if (!session?.id) return
  let next = state.sessions || []
  if (reason === 'closed') {
    next = next.filter((item) => item.id !== session.id)
  } else {
    const [normalized] = normalizeTerminalSummaries([session])
    if (!normalized) return
    const index = next.findIndex((item) => item.id === normalized.id)
    next =
      index >= 0
        ? next.map((item) => (item.id === normalized.id ? normalized : item))
        : [...next, normalized]
  }
  if (sameTerminalSessions(state.sessions, next)) return
  state.sessions = next
  publish(reason)
}

async function runStream(controller) {
  if (!hasService()) return
  const response = await openSocketRequest(socketPath(), '/events', {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
    label: CONTROL_LABEL
  })
  if (response.statusCode >= 400) throw new Error(`terminal events HTTP ${response.statusCode}`)
  const decoder = new TextDecoder()
  let buffer = ''
  // 建连后再对账一次：订阅建立之前发生的变化不会有事件补发
  void refresh('stream-open')
  for await (const chunk of response) {
    if (controller.signal.aborted) return
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const line = frame.split('\n').find((item) => item.startsWith('data:'))
      const parsed = line ? parseTerminalSseData(line) : null
      if (parsed) applyEvent(parsed)
      boundary = buffer.indexOf('\n\n')
    }
  }
}

async function streamLoop(controller) {
  while (!controller.signal.aborted) {
    try {
      await runStream(controller)
    } catch {
      // 断开就退避重连：服务可能正在随应用重启
    }
    if (controller.signal.aborted) return
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, RECONNECT_DELAY_MS)
      timer.unref?.()
    })
  }
}

/**
 * 由 server 在启动时调用一次：先取一次列表与文档，再挂上 SSE。
 * 没有 socket（纯 `npm run start:web`）时什么都不做。
 */
export async function startTerminalControl() {
  if (started) return getTerminalControlSnapshot()
  started = true
  if (!hasService()) return getTerminalControlSnapshot()
  await refresh('startup')
  await loadDocs()
  streamController = new AbortController()
  void streamLoop(streamController)
  return getTerminalControlSnapshot()
}

export function stopTerminalControl() {
  started = false
  streamController?.abort()
  streamController = null
}

/* --------------------------------------------------------------------- IPC */

/** 上一次 IPC 操作后立刻刷新：SSE 也会推，但页面不必等那一圈 */
async function mutate(path, body, { method = 'POST' } = {}) {
  const payload = await request(path, { method, body })
  await refresh('mutate')
  return { ...payload, ...getTerminalControlSnapshot() }
}

export function registerTerminalControlIpc() {
  ipcMain.handle('terminal-control:list', () => getTerminalControlSnapshot())

  ipcMain.handle('terminal-control:create', async (_event, input = {}) => {
    if (!hasService()) return getTerminalControlSnapshot()
    await request('/sessions', {
      method: 'POST',
      body: {
        cwd: typeof input.cwd === 'string' ? input.cwd : '',
        label: typeof input.label === 'string' ? input.label : '',
        owner: typeof input.owner === 'string' && input.owner ? input.owner : undefined,
        show: input.show !== false
      }
    })
    await refresh('created')
    return getTerminalControlSnapshot()
  })

  ipcMain.handle('terminal-control:show', async (_event, input = {}) =>
    showTerminalControlWindow(input)
  )

  ipcMain.handle('terminal-control:hide', async (_event, input = {}) =>
    hideTerminalControlWindow(input)
  )

  ipcMain.handle('terminal-control:close', async (_event, input = {}) =>
    closeTerminalControlWindow(input)
  )

  ipcMain.handle('terminal-control:details', () => readTerminalControlDetails())
}

/**
 * 窗口的三个命令（显示 / 隐藏 / 销毁）：顶栏图标入口与设置页都走这里。
 * 没有服务时返回 `available: false` 的快照而不是抛错，调用方不必自己判空。
 */
export async function showTerminalControlWindow({ id } = {}) {
  if (!hasService() || !id) return getTerminalControlSnapshot()
  await mutate(`/sessions/${encodeURIComponent(id)}/show`)
  return getTerminalControlSnapshot()
}

export async function hideTerminalControlWindow({ id } = {}) {
  if (!hasService() || !id) return getTerminalControlSnapshot()
  await mutate(`/sessions/${encodeURIComponent(id)}/hide`)
  return getTerminalControlSnapshot()
}

export async function closeTerminalControlWindow({ id } = {}) {
  if (!hasService() || !id) return getTerminalControlSnapshot()
  await mutate(`/sessions/${encodeURIComponent(id)}/close`)
  return getTerminalControlSnapshot()
}

/** 设置页用：文档 + 当前终端 + MCP 端点 + 最近一次错误 */
export async function readTerminalControlDetails() {
  if (!hasService()) {
    return terminalDetailsFrom({ docs: null, sessions: [], serviceUrl: '', mcpUrl: '' })
  }
  await refresh('details')
  const docs = await loadDocs()
  return terminalDetailsFrom({
    docs,
    sessions: state.sessions,
    serviceUrl: serviceUrl(),
    mcpUrl: mcpUrl(),
    error: state.error || null
  })
}

/* --------------------------------------------------------- 供会话进程使用的环境 */

/** 注入给会话进程（app-server / PTY 终端）的归属变量 */
export function terminalOwnerEnv(owner) {
  return owner ? { [TERMINAL_OWNER_ENV]: String(owner) } : {}
}
