/**
 * 系统检查在运行时的门面：配置页的插件详情通过它读运行条件、跳系统设置。
 *
 * 探测与「打开系统设置」都只有 Electron 主进程做得了（TCC 权限属于有 app 身份的那个
 * 进程，`x-apple.systempreferences:` 也被页面的 http(s) 过滤挡着），所以这里只把请求发到
 * 主进程那条 Unix socket 上（`MICA_SYSTEM_SOCKET`）——**不经过运行时的 HTTP 代理**：
 * 这条通道只有运行时自己用，页面的入口是配置页的动作（见 configWebData.js）。
 *
 * 纯 Web 运行时（没有 Electron 外壳）没有这条 socket，此时不报错：所有检查项报「未知」，
 * 页面上如实说明需要桌面应用。
 */

import { DESKTOP_CHECKS } from '@packages/mica-plugin/index.js'
import { openSocketRequest, readAllText, requestJson } from './control-client.js'

export const SYSTEM_SOCKET_ENV = 'MICA_SYSTEM_SOCKET'

const REQUEST_TIMEOUT_MS = 4000
/** 文件夹选择器等的是人在面板里点选，默认 4 秒不够：面板还开着请求就先断了。 */
const PICKER_TIMEOUT_MS = 10 * 60 * 1000
const SERVICE_LABEL = '系统检查服务'
const NO_DESKTOP_DETAIL = '需要桌面应用'

const STATUSES = new Set(['granted', 'denied', 'unknown'])

/** Native launcher actions stay on the private system socket, never a remote control proxy. */
export async function controlPluginLauncher(payload) {
  const path = socketPath()
  if (!path) throw new Error(NO_DESKTOP_DETAIL)
  const response = await openSocketRequest(path, '/plugin-launcher', {
    method: 'POST', body: payload, timeoutMs: 10_000, label: '桌面启动器'
  })
  const text = await readAllText(response)
  const result = text ? JSON.parse(text) : null
  if (response.statusCode >= 400 || result?.ok !== true) throw new Error(result?.error || '桌面启动器请求失败')
  return result
}

function socketPath() {
  return String(process.env[SYSTEM_SOCKET_ENV] || '').trim()
}

function normalizeStatus(value) {
  return STATUSES.has(value) ? value : 'unknown'
}

/** 没有主进程时的回答：每一项都「未知」，detail 说明为什么。 */
function emptyChecks() {
  return {
    platform: process.platform,
    app: { path: '', packaged: false },
    checks: DESKTOP_CHECKS.map((check) => ({
      id: check.id,
      label: check.label,
      description: check.description,
      pane: check.pane || '',
      status: 'unknown',
      detail: NO_DESKTOP_DETAIL
    }))
  }
}

/**
 * 用清单补齐主进程的回答：顺序、文案、pane 都归 `DESKTOP_CHECKS` 说了算，主进程只提供
 * 状态与 detail。清单加了新检查而主进程还没实现时，它照样出现在页面上（报未知）。
 */
function mergeChecks(checks) {
  const byId = new Map((Array.isArray(checks) ? checks : []).map((check) => [check?.id, check]))
  return DESKTOP_CHECKS.map((check) => {
    const found = byId.get(check.id) || {}
    return {
      id: check.id,
      label: found.label || check.label,
      description: found.description || check.description,
      pane: found.pane || check.pane || '',
      status: normalizeStatus(found.status),
      detail: typeof found.detail === 'string' ? found.detail : ''
    }
  })
}

export async function readSystemChecks() {
  const path = socketPath()
  if (!path) return emptyChecks()

  try {
    const response = await openSocketRequest(path, '/checks', {
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: SERVICE_LABEL
    })
    const text = await readAllText(response)
    const payload = text ? JSON.parse(text) : null
    if (response.statusCode >= 400 || payload?.ok === false) return emptyChecks()
    return {
      platform: payload?.platform || process.platform,
      app: {
        path: typeof payload?.app?.path === 'string' ? payload.app.path : '',
        packaged: payload?.app?.packaged === true
      },
      checks: mergeChecks(payload?.checks)
    }
  } catch {
    // socket 不存在 / 主进程刚退出：页面要能继续用，只是这一段显示「未知」
    return emptyChecks()
  }
}

export async function openSystemSettings(pane) {
  const target = typeof pane === 'string' ? pane.trim() : ''
  if (!target) return { ok: false, error: '缺少要打开的系统设置面板' }
  const path = socketPath()
  if (!path) return { ok: false, error: NO_DESKTOP_DETAIL }

  try {
    const response = await openSocketRequest(path, '/open-settings', {
      method: 'POST',
      body: { pane: target },
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: SERVICE_LABEL
    })
    const text = await readAllText(response)
    const payload = text ? JSON.parse(text) : null
    if (response.statusCode >= 400 || payload?.ok === false) {
      return {
        ok: false,
        error: payload?.error || `${SERVICE_LABEL}返回 HTTP ${response.statusCode}`
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 打开系统的文件夹选择器。面板只有主进程开得了（app 身份在那里），所以这条路和系统
 * 检查共用一条私有 socket；`canceled: true` 表示用户点了取消，照原样回给页面。
 *
 * 超时按「用户要看一会儿文件夹」给：默认那 4 秒会在面板还开着的时候就断掉。
 */
export async function pickDirectoryNative({ title, defaultPath } = {}) {
  const path = socketPath()
  if (!path) return { canceled: true, error: NO_DESKTOP_DETAIL }

  try {
    const payload = await requestJson(path, '/pick-directory', {
      method: 'POST',
      body: {
        ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}),
        ...(typeof defaultPath === 'string' && defaultPath.trim() ? { defaultPath: defaultPath.trim() } : {})
      },
      timeoutMs: PICKER_TIMEOUT_MS,
      label: '文件夹选择器'
    })
    if (payload?.canceled === true) return { canceled: true }
    if (typeof payload?.path !== 'string' || !payload.path) return { canceled: true }
    return { canceled: false, path: payload.path }
  } catch (error) {
    return { canceled: true, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 让系统登记**这次运行的构建**（辅助功能），而不是只把用户送去面板。
 *
 * 权限条目按「路径 + 代码签名」记：重新打包之后，系统设置里那一行是上一次构建的，
 * 勾了也不会作用到正在运行的这一份。这个动作会让 macOS 就地把当前进程加进列表并弹窗。
 */
export async function requestSystemAccess(id) {
  const target = typeof id === 'string' ? id.trim() : ''
  if (!target) return { ok: false, error: '缺少要请求授权的检查项' }
  const path = socketPath()
  if (!path) return { ok: false, error: NO_DESKTOP_DETAIL }

  try {
    const response = await openSocketRequest(path, '/request-access', {
      method: 'POST',
      body: { id: target },
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: SERVICE_LABEL
    })
    const text = await readAllText(response)
    const payload = text ? JSON.parse(text) : null
    if (response.statusCode >= 400 || payload?.ok === false) {
      return {
        ok: false,
        error: payload?.error || `${SERVICE_LABEL}返回 HTTP ${response.statusCode}`
      }
    }
    return { ok: true, granted: payload?.granted === true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 让主进程给一个页面拍堆快照。
 *
 * 只有主进程拿得到 `webContents`（运行时是另一个进程），所以同样走这条 socket。
 * 超时单独放宽：快照本身就要几秒，拍一个大页面时 4 秒会直接判超时——那会把「正在拍」
 * 误报成失败，而文件其实已经写出来了。
 */
const HEAP_SNAPSHOT_TIMEOUT_MS = 120_000

export async function takeHeapSnapshot({ windowId } = {}) {
  const path = socketPath()
  if (!path) return { ok: false, error: NO_DESKTOP_DETAIL }
  try {
    const response = await openSocketRequest(path, '/heap-snapshot', {
      method: 'POST',
      body: Number.isFinite(Number(windowId)) ? { windowId: Number(windowId) } : {},
      timeoutMs: HEAP_SNAPSHOT_TIMEOUT_MS,
      label: SERVICE_LABEL
    })
    const text = await readAllText(response)
    const payload = text ? JSON.parse(text) : null
    if (response.statusCode >= 400 || payload?.ok === false) {
      return {
        ok: false,
        error: payload?.error || `${SERVICE_LABEL}返回 HTTP ${response.statusCode}`
      }
    }
    return {
      ok: true,
      path: typeof payload?.path === 'string' ? payload.path : '',
      bytes: Number(payload?.bytes) || 0,
      windowId: payload?.windowId,
      title: typeof payload?.title === 'string' ? payload.title : ''
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
