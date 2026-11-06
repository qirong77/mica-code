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
import { openSocketRequest, readAllText } from './control-client.js'

export const SYSTEM_SOCKET_ENV = 'MICA_SYSTEM_SOCKET'

const REQUEST_TIMEOUT_MS = 4000
const SERVICE_LABEL = '系统检查服务'
const NO_DESKTOP_DETAIL = '需要桌面应用'

const STATUSES = new Set(['granted', 'denied', 'unknown'])

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
