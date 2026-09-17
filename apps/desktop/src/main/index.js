import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

/**
 * Electron 外壳。
 *
 * 应用的主体是一个 Web 页面：由 `src/server` 的运行时（out/server/index.mjs）
 * 托管，同一个地址也能被局域网里的浏览器直接访问。这个进程只做三件事：
 * 拉起运行时、装载页面、补上只有容器才能提供的原生体验（dock 徽标等）。切换 Mica
 * 服务器在这里体现为「再开一个窗口」——一个窗口一台服务器，彼此互不影响。
 *
 * 因此这里不注册任何业务 IPC，也不注入 preload —— 页面里的 `window.mica`
 * 始终由 renderer 自己的 transport 适配层通过 HTTP + SSE 建立。
 */

const RUNTIME_ENTRY = join(__dirname, '../server/index.mjs')
const DEFAULT_PORT = 8787
const READY_PREFIX = '[mica-desktop] ready '
const HEADER_HEIGHT_PX = 34
const MAC_TRAFFIC_LIGHT_POSITION = { x: 12, y: 12 }

let runtime = null
let quitting = false
/** 「本机」页面地址（dev 下是 Vite dev server），⇧⌘M 与默认端口上的回环目标都回到它 */
let localPageUrl = ''
/**
 * 一个服务器一个窗口。启动时开的是本机窗口（`primary`，关闭时只隐藏），页面里请求
 * 切到另一台机器的运行时则当场再开一个。每个窗口自己持有它那台的状态：
 * - `server`/`local`：窗口当前显示的 origin，以及它是不是本机运行时（did-navigate 更新）
 * - `apiUrl`/`unread`/`stopBadgeWatcher`：未读徽标订阅跟着这个窗口的那台走
 * - `title`/`suffix`：标题拼成「<页面标题> — <服务器>」，让用户一眼知道连的是哪台
 */
const windows = new Set()
let primaryWindow = null
let lastFocusedWindow = null

/* ------------------------------------------------------------------ 运行时 */

function preferredPort() {
  const value = Number.parseInt(process.env.MICA_DESKTOP_PORT || '', 10)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT
}

/** 端口上已经是我们自己的运行时就直接复用（dev 下避免两个运行时抢端口/状态） */
async function probeRuntime(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000)
    })
    if (!response.ok) return null
    const body = await response.json()
    if (body?.app !== 'mica-code-app') return null
    return { url: `http://127.0.0.1:${port}`, port, owned: false }
  } catch {
    return null
  }
}

function spawnRuntime(port, { pageFromDevServer }) {
  const args = [RUNTIME_ENTRY, '--port', String(port)]
  // 页面由 Vite dev server 提供时，运行时只承载 API，不需要 renderer 产物
  if (pageFromDevServer) args.push('--allow-missing-renderer')

  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // 与打包版共享同一份本地状态（workspace / file-order / session-pins）
      MICA_DESKTOP_USER_DATA: app.getPath('userData'),
      MICA_DESKTOP_EXIT_ON_STDIN_CLOSE: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      if (settled) return
      buffer += chunk
      const index = buffer.indexOf(READY_PREFIX)
      if (index < 0) return
      const line = buffer.slice(index + READY_PREFIX.length).split('\n')[0]
      try {
        const info = JSON.parse(line)
        settled = true
        resolve({ url: `http://127.0.0.1:${info.port}`, port: info.port, owned: true, child })
      } catch {
        // 就绪行还没收全，等下一个 chunk
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))

    child.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })

    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true
        reject(new Error(`运行时进程退出（code=${code} signal=${signal}）`))
        return
      }
      if (!quitting) {
        console.error(`[mica-code-app] 运行时进程已退出（code=${code} signal=${signal}）`)
        runtime = null
        if (primaryWindow && !primaryWindow.win.isDestroyed()) {
          dialog.showErrorBox('Mica Code 运行时已退出', '请重新启动应用。')
        }
      }
    })

    // 运行时自己会处理 stdin 关闭，这里保持管道打开即可
    child.stdin.on('error', () => {})
  })
}

async function resolveRuntime({ pageFromDevServer }) {
  if (is.dev) {
    const existing = await probeRuntime(preferredPort())
    if (existing) return existing
  }
  return spawnRuntime(preferredPort(), { pageFromDevServer })
}

/* ------------------------------------------------------------ 切换 Mica 服务器 */

/**
 * 页面可以切到另一台机器上的 Mica 运行时 —— 页面侧就是一次 `location.assign`，外壳
 * 接管它并**弹出一个新窗口**（一窗口一台服务器，原来那台仍留在自己的窗口里）。外壳
 * 在这里做三件页面做不到的事：确认目标地址上确实是一台 Mica 运行时（页面跨源 fetch
 * 读不到结果）、把新窗口接上自己的状态（标题后缀、徽标订阅）、把不认识的跳转仍交回
 * 系统浏览器。
 */

function originOf(value) {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

/** 这个地址上是不是一台 Mica Code 运行时（/api/health 会自报 app 名） */
async function probeMicaRuntime(origin) {
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(1200)
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.app === 'mica-code-app'
  } catch {
    return false
  }
}

function applyWindowTitle(state) {
  if (state.win.isDestroyed()) return
  state.win.setTitle(`${state.title}${state.suffix ? ` — ${state.suffix}` : ''}`)
}

async function loadPage(state, url) {
  if (!state || state.win.isDestroyed()) return
  try {
    await state.win.loadURL(url)
  } catch (error) {
    console.error('[mica-code-app] 页面加载失败', error)
  }
}

function showWindow(state) {
  if (state.win.isDestroyed()) return
  if (state.win.isMinimized()) state.win.restore()
  state.win.show()
  state.win.focus()
}

/** 已经开着某台服务器时不再开第二个窗口，直接把它端到前面 —— 切回来才不用重新加载 */
function findServerWindow(origin) {
  if (!origin) return null
  const localOrigin = originOf(localPageUrl)
  return (
    [...windows].find(
      (item) =>
        !item.win.isDestroyed() &&
        (item.server === origin || (item.local && origin === localOrigin))
    ) || null
  )
}

/**
 * 页面请求切到另一个地址：已经开着的服务器把窗口端到前面，没开过的在**新窗口**里打开，
 * 其余交回系统浏览器。
 */
async function navigateToServer(state, target) {
  const origin = originOf(target)
  // 默认端口上的回环地址一律理解成「本机」，必须先于探活判定：本机运行时的 8787 被
  // 别的服务（或同一台机器上的另一个 mica 实例）占着时它会回退到随机端口，而页面只
  // 知道约定地址。先探活会连到恰好占着 8787 的那个实例上，那不是「本机」。（dev 下
  // 本机页面在 Vite dev server 上，这条分支把它换回本机页面地址。）
  if (origin && origin === `http://127.0.0.1:${DEFAULT_PORT}` && localPageUrl) {
    const existing = findServerWindow(originOf(localPageUrl))
    if (existing && existing !== state) {
      showWindow(existing)
      return
    }
    // 自己就是本机页面（启动失败页上的「返回本机」）时重新加载，别让这一下变成空点
    await loadPage(state, localPageUrl)
    return
  }
  if (!origin) {
    shell.openExternal(target)
    return
  }
  const existing = findServerWindow(origin)
  if (existing && existing !== state) {
    showWindow(existing)
    return
  }
  if (await probeMicaRuntime(origin)) {
    createWindow(origin)
    return
  }
  shell.openExternal(target)
}

/** 窗口落在哪台运行时上：标题后缀与未读徽标订阅都跟着它 */
function syncWindowServer(state, target) {
  const origin = originOf(target)
  const local = Boolean(localPageUrl) && origin === originOf(localPageUrl)
  state.server = origin
  state.local = local
  const apiUrl = local ? runtime?.url || origin : origin
  if (apiUrl && apiUrl !== state.apiUrl) {
    state.apiUrl = apiUrl
    watchUnread(state, apiUrl)
  }
  state.suffix = local ? '' : origin.replace(/^https?:\/\//i, '')
  applyWindowTitle(state)
  refreshBadge()
}

/**
 * 回到本机（⇧⌘M）：本机窗口还在就把它端到前面，否则把当前窗口带回本机页面。
 * 切过去的那台可能跑着更旧的 bundle（页面里根本没有切换入口），回程只能由壳提供。
 */
function backToLocalPage(state) {
  const local = [...windows].find((item) => item.local && !item.win.isDestroyed())
  if (local) {
    showWindow(local)
    return
  }
  if (!localPageUrl) return
  void loadPage(state, localPageUrl)
}

/* ---------------------------------------------------------------- 原生体验 */

/**
 * 页面的未读状态由它自己维护（页面聚焦/可见时标记已读），这里为每个窗口订阅它自己
 * 那台运行时的通知流，把「有多少条未读」映射成 dock 徽标 / 任务栏闪烁。
 */
function startUnreadWatcher(url, onCount) {
  const controller = new AbortController()

  const refresh = async () => {
    try {
      const response = await fetch(`${url}/api/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'notify:list' })
      })
      const body = await response.json()
      const states = Array.isArray(body?.result) ? body.result : []
      const count = states.reduce((sum, item) => sum + (item?.unread ? 1 : 0), 0)
      onCount(count)
    } catch {
      // 运行时正忙/已退出，保留上一次的徽标
    }
  }

  const stream = async () => {
    const response = await fetch(`${url}/api/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal
    })
    if (!response.ok || !response.body) throw new Error(`events HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const line = frame.split('\n').find((item) => item.startsWith('data: '))
        if (line) {
          try {
            if (JSON.parse(line.slice(6))?.channel === 'notify:changed') void refresh()
          } catch {
            // 非 JSON 帧
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  }

  const loop = async () => {
    while (!controller.signal.aborted) {
      try {
        await stream()
      } catch {
        // 断开后重连，运行时可能正在重启
      }
      if (controller.signal.aborted) return
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))
    }
  }

  void loop()
  void refresh()

  return () => controller.abort()
}

/** 窗口跟着自己那台走：换服务器就换订阅 */
function watchUnread(state, url) {
  stopUnreadWatcher(state)
  state.stopBadgeWatcher = startUnreadWatcher(url, (count) => {
    state.unread = count
    if (state.win.isDestroyed()) return
    // Windows 没有计数徽标，用任务栏闪烁表达「有未读且窗口不在前台」
    if (process.platform === 'win32') state.win.flashFrame(count > 0 && !state.win.isFocused())
    refreshBadge()
  })
}

function stopUnreadWatcher(state) {
  if (typeof state.stopBadgeWatcher === 'function') state.stopBadgeWatcher()
  state.stopBadgeWatcher = null
}

/** 徽标反映当前聚焦窗口那台服务器的未读；都不可用时回落到本机窗口 */
function refreshBadge() {
  const focused = [...windows].find((state) => !state.win.isDestroyed() && state.win.isFocused())
  const fallback = primaryWindow && !primaryWindow.win.isDestroyed() ? primaryWindow : null
  const state = focused || fallback || [...windows].find((item) => !item.win.isDestroyed()) || null
  applyBadge(state ? state.unread : 0)
}

function applyBadge(count) {
  app.setBadgeCount(count)

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '')
  }
}

/* ------------------------------------------------------------------ 窗口 */

/**
 * 开一个窗口装载 `url`。`primary` 是启动时那个本机窗口：关掉它只是隐藏（应用继续留在
 * dock 里），其余窗口（切过去的那几台）关掉就真的关掉，不会攒下一堆看不见的窗口。
 */
function createWindow(url, { primary = false } = {}) {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Mica Code',
    backgroundColor: '#0e0e0e',
    ...(isMac
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION
        }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const state = {
    win,
    primary,
    server: originOf(url),
    local: false,
    apiUrl: '',
    unread: 0,
    stopBadgeWatcher: null,
    title: 'Mica Code',
    suffix: ''
  }
  windows.add(state)
  if (primary) primaryWindow = state

  if (isMac) {
    win.setSheetOffset(HEADER_HEIGHT_PX)
  }

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('close', (event) => {
    if (!quitting && primary) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    stopUnreadWatcher(state)
    windows.delete(state)
    if (primaryWindow === state) primaryWindow = null
    if (lastFocusedWindow === state) lastFocusedWindow = null
    refreshBadge()
  })

  win.on('focus', () => {
    lastFocusedWindow = state
    refreshBadge()
    if (process.platform === 'win32') win.flashFrame(false)
  })

  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, target) => {
    // 窗口自己那台上的跳转（含本机页面内部）直接放行 —— 同一台服务器换个路径不是
    // 「切换服务器」，不该再开一个窗口。其余交给 navigateToServer 判断：另一台 mica
    // 开新窗口，普通链接仍给系统浏览器。
    const origin = originOf(target)
    if (origin && (origin === state.server || origin === originOf(localPageUrl))) return
    event.preventDefault()
    if (!/^https?:/i.test(target)) return
    void navigateToServer(state, target)
  })

  win.webContents.on('did-navigate', (_event, target) => {
    syncWindowServer(state, target)
  })

  // 页面自己的 title 会被壳子接管，这里补上当前服务器，切到别台时也看得出来
  win.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    state.title = title || 'Mica Code'
    applyWindowTitle(state)
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const modifier = process.platform === 'darwin' ? input.meta : input.control
    if (!modifier || !input.shift || input.key.toLowerCase() !== 'm') return
    event.preventDefault()
    backToLocalPage(state)
  })

  win.loadURL(url).catch((error) => {
    console.error('[mica-code-app] 页面加载失败', error)
    dialog.showErrorBox('页面加载失败', `${url}\n\n${error?.message || error}`)
  })

  return state
}

/* ---------------------------------------------------------------- 生命周期 */

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.mica.code')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // dev 下页面走 Vite dev server（HMR），它把 /api 代理到运行时
  const devPageUrl =
    is.dev && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null

  try {
    runtime = await resolveRuntime({ pageFromDevServer: Boolean(devPageUrl) })
  } catch (error) {
    dialog.showErrorBox('无法启动 Mica Code 运行时', String(error?.message || error))
    app.quit()
    return
  }

  localPageUrl = devPageUrl || runtime.url
  // 只开本机窗口：另一台机器上的服务器各占一个新窗口，由页面里「切换 Mica 服务器」当场开
  createWindow(localPageUrl, { primary: true })

  app.on('activate', () => {
    // 回到用户最后用的那个窗口（关掉的窗口还在 windows 里时就轮到本机窗口）
    const state =
      (lastFocusedWindow && !lastFocusedWindow.win.isDestroyed() && lastFocusedWindow) ||
      (primaryWindow && !primaryWindow.win.isDestroyed() && primaryWindow) ||
      [...windows].find((item) => !item.win.isDestroyed()) ||
      null
    if (state) {
      showWindow(state)
      return
    }
    if (localPageUrl) createWindow(localPageUrl, { primary: true })
  })
})

app.on('window-all-closed', (event) => {
  event.preventDefault()
})

app.on('before-quit', () => {
  quitting = true
  app.setBadgeCount(0)
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge('')
  for (const state of windows) stopUnreadWatcher(state)
  // 只结束自己拉起的运行时；复用的那个（dev 下已在跑）留给它的属主
  if (runtime?.owned && runtime.child) {
    try {
      runtime.child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
  runtime = null
})
