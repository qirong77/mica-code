import { ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveMicaHome } from '@packages/mica-config/index.js'
import { openSocketRequest, readAllText } from './control-client.js'
import {
  BROWSER_OWNER_ENV,
  BROWSER_SOCKET_ENV,
  BROWSER_URL_ENV,
  detailsFrom,
  emptyBrowserSnapshot,
  normalizeBrowserSummaries,
  parseSseData,
  resolveSkillTemplate,
  sameBrowsers,
  skillFilePath,
  skillNeedsWrite
} from './browser-control-core.js'

/**
 * 受控浏览器在运行时的门面：页面（顶栏图标、设置页）与 agent 各自从这一层进出。
 *
 * - **页面**通过 `browser-control:*` IPC 读列表、显示/隐藏/关闭、新建窗口；
 * - **agent** 不经过这里，它直接打 `MICA_BROWSER_URL`（运行时端口 + `/remote/control`，
 *   由运行时在端口确定后自己写好），再随 `MICA_BROWSER_OWNER` 传给每个会话进程，
 *   技能文档见 browser-control-core.js 的说明。
 *
 * 浏览器窗口活在 Electron 主进程里，运行时是纯 Node，两边只能靠本机通道通信：主进程把
 * 服务监听在一个 **Unix socket** 上（不占端口），运行时既把它代理成自己端口上的
 * `/remote/control/*`（见 browser-control-proxy.js），也从这里直接读 socket——订阅它的
 * SSE，把变化广播成 `browser:changed` 给所有页面。
 */

const REQUEST_TIMEOUT_MS = 4000
const CONTROL_LABEL = '受控浏览器服务'
const RECONNECT_DELAY_MS = 2000

let broadcaster = () => {}
let state = { ...emptyBrowserSnapshot(), docs: null }
let streamController = null
let started = false
let failedSkillWrite = false

export function setBrowserControlBroadcaster(fn) {
  broadcaster = typeof fn === 'function' ? fn : () => {}
}

function serviceUrl() {
  return String(process.env[BROWSER_URL_ENV] || '')
    .trim()
    .replace(/\/+$/, '')
}

function socketPath() {
  return String(process.env[BROWSER_SOCKET_ENV] || '').trim()
}

function hasService() {
  return Boolean(socketPath())
}

function publish(reason = 'change') {
  const snapshot = getBrowserControlSnapshot()
  broadcaster('browser:changed', { reason, ...snapshot })
  return snapshot
}

export function getBrowserControlSnapshot() {
  return {
    available: hasService() && !state.error,
    serviceUrl: state.serviceUrl || null,
    browsers: state.browsers || [],
    skillPath: state.skillPath || null,
    error: state.error || null
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await openSocketRequest(socketPath(), path, {
    method,
    body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    label: CONTROL_LABEL
  })
  const text = await readAllText(response)
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${CONTROL_LABEL}返回了非 JSON 响应（HTTP ${response.statusCode}）`)
  }
  if (response.statusCode >= 400 || payload?.ok === false) {
    throw new Error(payload?.error || `${CONTROL_LABEL}返回 HTTP ${response.statusCode}`)
  }
  return payload
}

/** 刷新窗口列表；失败只记录错误，不清空已知列表（服务重启时会自愈） */
async function refresh(reason = 'refresh') {
  if (!hasService()) {
    state = { ...emptyBrowserSnapshot(), docs: state.docs }
    return getBrowserControlSnapshot()
  }
  state.serviceUrl = serviceUrl() || null
  try {
    const payload = await request('/browser/browsers')
    const browsers = normalizeBrowserSummaries(payload?.browsers)
    const changed = !sameBrowsers(state.browsers, browsers)
    state.browsers = browsers
    state.error = null
    if (changed) publish(reason)
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    publish('error')
  }
  return getBrowserControlSnapshot()
}

async function loadDocs() {
  if (state.docs) return state.docs
  try {
    const payload = await request('/browser/docs')
    state.docs = {
      version: payload.version,
      endpoints: payload.endpoints,
      markdown: payload.markdown,
      skillMarkdown: resolveSkillTemplate(payload.skillMarkdown, { serviceUrl: serviceUrl() })
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
  }
  return state.docs
}

/**
 * 把技能写进 `$MICA_HOME/skills/mica-browser/SKILL.md`：agent 靠它知道这台机器上有一套
 * 能真正打开的浏览器、以及怎么把窗口挂到当前会话上。内容变了才写，失败只在文档里标出来
 * ——不因为写不了文件就让整个能力不可用。
 */
async function ensureSkillFile(docs) {
  const markdown = docs?.skillMarkdown
  if (typeof markdown !== 'string' || !markdown.trim()) return
  const path = skillFilePath(resolveMicaHome(), process.platform === 'win32' ? '\\' : '/')
  try {
    let existing = null
    try {
      existing = await readFile(path, 'utf8')
    } catch {
      existing = null
    }
    if (!skillNeedsWrite(existing, markdown)) {
      state.skillPath = path
      return
    }
    await mkdir(join(resolveMicaHome(), 'skills', 'mica-browser'), { recursive: true })
    await writeFile(path, markdown, 'utf8')
    state.skillPath = path
  } catch (error) {
    failedSkillWrite = true
    console.error('[mica-desktop] 写入浏览器技能文档失败:', error)
  }
}

/* ------------------------------------------------------------------ SSE 订阅 */

async function runStream(controller) {
  if (!hasService()) return
  const response = await openSocketRequest(socketPath(), '/browser/events', {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
    label: CONTROL_LABEL
  })
  if (response.statusCode >= 400) throw new Error(`events HTTP ${response.statusCode}`)
  const decoder = new TextDecoder()
  let buffer = ''
  // 建连后再对账一次：订阅建立之前发生的窗口变化不会有事件补发，只靠前缀会漏掉。
  void refresh('stream-open')
  for await (const chunk of response) {
    if (controller.signal.aborted) return
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const line = frame.split('\n').find((item) => item.startsWith('data:'))
      const parsed = line ? parseSseData(line) : null
      if (parsed?.channel === 'browser:changed') {
        const browsers = normalizeBrowserSummaries(parsed.payload?.browsers)
        if (!sameBrowsers(state.browsers, browsers)) {
          state.browsers = browsers
          state.error = null
          publish('stream')
        }
      }
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
 * 由 server 在启动时调用一次：先取一次列表与文档（顺带写技能），再挂上 SSE。
 * 没有服务地址（浏览器宿主、纯 `npm run start:web`）时什么都不做。
 */
export async function startBrowserControl() {
  if (started) return getBrowserControlSnapshot()
  started = true
  state.serviceUrl = serviceUrl() || null
  if (!hasService()) return getBrowserControlSnapshot()
  await refresh('startup')
  const docs = await loadDocs()
  await ensureSkillFile(docs)
  streamController = new AbortController()
  void streamLoop(streamController)
  return getBrowserControlSnapshot()
}

export function stopBrowserControl() {
  started = false
  streamController?.abort()
  streamController = null
}

/* --------------------------------------------------------------------- IPC */

/** 上一次 IPC 操作后立刻广播：SSE 也会推，但页面不必等那一圈 */
async function mutate(path, body, { method = 'POST' } = {}) {
  const payload = await request(path, { method, body })
  await refresh('mutate')
  return { ...payload, ...getBrowserControlSnapshot() }
}

export function registerBrowserControlIpc() {
  ipcMain.handle('browser-control:list', () => getBrowserControlSnapshot())

  ipcMain.handle('browser-control:show', async (_event, input = {}) =>
    showBrowserControlWindow(input)
  )

  ipcMain.handle('browser-control:hide', async (_event, input = {}) =>
    hideBrowserControlWindow(input)
  )

  ipcMain.handle('browser-control:close', async (_event, input = {}) =>
    closeBrowserControlWindow(input)
  )

  ipcMain.handle('browser-control:create', async (_event, input = {}) =>
    createBrowserControlWindow(input)
  )

  ipcMain.handle('browser-control:details', () => readBrowserControlDetails())

  ipcMain.handle('browser-control:open-skill', () => state.skillPath || null)
}

/**
 * 窗口的四个命令（新建 / 显示 / 隐藏 / 销毁）：顶栏图标入口与设置页都走这里。
 *
 * 没有服务时返回 `available: false` 的快照而不是抛错——设置页据此显示「不可用」，
 * 顶栏图标则根本不会出现，两边都不需要自己判空。
 */
export async function createBrowserControlWindow(input = {}) {
  if (!hasService()) return getBrowserControlSnapshot()
  await request('/browser/browsers', {
    method: 'POST',
    body: {
      url: typeof input.url === 'string' ? input.url : '',
      label: typeof input.label === 'string' ? input.label : '',
      owner: typeof input.owner === 'string' && input.owner ? input.owner : undefined,
      show: input.show === true
    }
  })
  await refresh('created')
  return getBrowserControlSnapshot()
}

export async function closeBrowserControlWindow({ id } = {}) {
  if (!hasService()) return getBrowserControlSnapshot()
  await mutate(`/browser/browsers/${encodeURIComponent(id)}/close`)
  return getBrowserControlSnapshot()
}

export async function showBrowserControlWindow({ id, focus = true } = {}) {
  if (!hasService()) return getBrowserControlSnapshot()
  await mutate(`/browser/browsers/${encodeURIComponent(id)}/show${focus ? '?focus=1' : ''}`)
  return getBrowserControlSnapshot()
}

export async function hideBrowserControlWindow({ id } = {}) {
  if (!hasService()) return getBrowserControlSnapshot()
  await mutate(`/browser/browsers/${encodeURIComponent(id)}/hide`)
  return getBrowserControlSnapshot()
}

/** 设置页用：文档 + 当前窗口 + 技能文件位置 + 最近一次错误 */
export async function readBrowserControlDetails() {
  const service = serviceUrl()
  state.serviceUrl = service || null
  if (!hasService()) {
    return detailsFrom({ docs: null, browsers: [], serviceUrl: '', skillPath: null })
  }
  await refresh('details')
  const docs = await loadDocs()
  await ensureSkillFile(docs)
  return detailsFrom({
    docs,
    browsers: state.browsers,
    serviceUrl: service,
    skillPath: state.skillPath,
    error: state.error || (failedSkillWrite ? '技能文件写入失败（权限或磁盘问题）' : null)
  })
}

/* --------------------------------------------------------- 供会话进程使用的环境 */

/**
 * 注入给会话进程（app-server / PTY 终端）的归属变量。地址由运行时自己继承
 * `MICA_BROWSER_URL`，这里只补「这个进程是谁」——agent 把它原样写进 x-mica-owner 头。
 */
export function browserOwnerEnv(owner) {
  return owner ? { [BROWSER_OWNER_ENV]: String(owner) } : {}
}
