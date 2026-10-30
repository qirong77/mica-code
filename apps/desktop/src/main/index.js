import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { resolveBrowserSocketPath, startBrowserHost } from './browser/browser-host.js'
import { applyBrowserRenderSwitch } from './browser/browser-core.js'
import { resolveTerminalSocketPath, startTerminalHost } from './terminal/terminal-host.js'
import { resolveSystemSocketPath, startSystemHost } from './system/system-host.js'
import { TERMINAL_PAGE_PATH } from '@mica-app-paths'
import { RUNTIME_PORT_ENV, loopbackRuntimeUrl, parseRuntimePort } from '@packages/mica-web-shared'
// 与运行时、插件同一份探活逻辑（含「中转机链接要带 ?t=」的判定），这里只是为了与
// 上面那个「端口上是不是我们自己的运行时」的 probeRuntime 区分而改名
import { probeRuntime as probeRemoteRuntime } from '../host/runtime-probe-core.js'
import { appPageKey, isAppPageTarget, relayEntryKey } from './app-page-target.js'

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

/**
 * 一份「外部进程读得到」的页面产物目录。
 *
 * 开发时就是 out/renderer；打包后页面在 app.asar 里，只有 Electron 自己能读，
 * 所以 build 把 out/renderer 解包到 app.asar.unpacked（插件要打包上传给中转机）。
 * 两者都没有时返回空串——插件会如实说「找不到页面产物」，而不是去抠 asar。
 */
function publishableRendererDir() {
  const candidates = [
    join(__dirname, '../renderer'),
    join(process.resourcesPath || '', 'app.asar.unpacked', 'out', 'renderer')
  ]
  return candidates.find((dir) => dir && existsSync(join(dir, 'index.html'))) || ''
}
const READY_PREFIX = '[mica-desktop] ready '
// 与渲染层的顶栏高度（App.jsx 的 h-8）保持一致：macOS 的系统窗口按钮浮在顶栏上，
// y 要让它在这一条里居中，setSheetOffset 决定原生提示框挂下来时贴在哪。
const HEADER_HEIGHT_PX = 32
const MAC_TRAFFIC_LIGHT_POSITION = { x: 12, y: 8 }

// 必须在 app ready 之前：受控浏览器的窗口默认是隐藏的，而 Chromium 把隐藏/被遮挡的窗口
// 当后台窗口 —— 页面里 requestAnimationFrame 完全不触发、visibilityState 停在 hidden，
// 于是截图只能拿到画面冻结前的那一帧。开关的取舍见 browser-core.js 的注释。
applyBrowserRenderSwitch(app.commandLine, process.env)

let runtime = null
let quitting = false
/**
 * 受控浏览器宿主（窗口 + Unix socket 上的 HTTP 服务）。它必须由外壳启动：只有主进程能
 * 创建 Chromium 窗口，而运行时是纯 Node（ELECTRON_RUN_AS_NODE）。它**不占端口**：
 * socket 路径经 `MICA_BROWSER_SOCKET` 交给运行时，由运行时代理成自己端口上的
 * `/remote/control/*`，再把那个地址注入每个会话进程给 agent 用。
 */
let browserHost = null
/**
 * 终端控制宿主（真实 PTY + 后台窗口 + Unix socket 服务）。和受控浏览器同一个理由住在
 * 主进程：只有这里开得了窗口，node-pty 也在这里加载。socket 路径经 `MICA_TERMINAL_SOCKET`
 * 交给运行时，运行时代理成自己端口上的 `/remote/terminal/*`。
 */
let terminalHost = null
/**
 * 系统检查宿主（辅助功能 / 屏幕录制 / 命令行工具）。同样只在主进程：
 * TCC 权限属于有 app 身份的那个进程，运行时（`ELECTRON_RUN_AS_NODE`）拿到的是空壳。
 * socket 路径经 `MICA_SYSTEM_SOCKET` 交给运行时，页面经运行时的 IPC 读它。
 */
let systemHost = null
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
  return parseRuntimePort(process.env[RUNTIME_PORT_ENV])
}

/** 端口上已经是我们自己的运行时就直接复用（dev 下避免两个运行时抢端口/状态） */
async function probeRuntime(port) {
  try {
    const response = await fetch(`${loopbackRuntimeUrl(port)}/api/health`, {
      signal: AbortSignal.timeout(1000)
    })
    if (!response.ok) return null
    const body = await response.json()
    if (body?.app !== 'mica-code-app') return null
    return { url: loopbackRuntimeUrl(port), port, owned: false }
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
      MICA_DESKTOP_EXIT_ON_STDIN_CLOSE: '1',
      // 受控浏览器的 socket：运行时据此在**自己已有的端口**上代理出 /remote/control，
      // 再把它注入给每个 agent 进程（MICA_BROWSER_URL），所以这里不再传端口或地址。
      MICA_BROWSER_SOCKET: browserHost?.socketPath || '',
      MICA_TERMINAL_SOCKET: terminalHost?.socketPath || '',
      MICA_SYSTEM_SOCKET: systemHost?.socketPath || '',
      // 页面产物目录：插件要把「手机上看到的这份界面」同步到中转机，
      // 而打包版默认只有 asar 里的一份（外部进程读不到）。
      MICA_DESKTOP_RENDERER: publishableRendererDir() || ''
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
        resolve({ url: loopbackRuntimeUrl(info.port), port: info.port, owned: true, child })
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

/**
 * 页面此刻是什么状态：
 * - `booted`：脚本跑过、`window.mica` 已装上（正常）
 * - `error-page`：页面自己渲染的可读失败提示（运行时没起来），别去打扰它
 * - `blank`：空白 —— 新建窗口首次加载偶发失败时就是这个样子：导航其实「成功」了，
 *   `did-finish-load` 照常触发、`document.readyState` 也是 complete，但页面停在
 *   空白状态，窗口只剩自己的底色（`#0e0e0e`），看上去就是一块黑屏
 *
 * 这种状态只有问渲染层才知道（`executeJavaScript` 走页面主世界，不需要 preload）。
 */
const PAGE_STATE_PROBE = `(() => {
  if (typeof window.mica === 'object') return 'booted'
  const root = document.getElementById('root')
  return root && root.children.length > 0 ? 'error-page' : 'blank'
})()`

async function pageState(state) {
  const contents = state.win.webContents
  if (state.win.isDestroyed() || contents.isDestroyed() || contents.isCrashed()) return 'blank'
  try {
    const value = await Promise.race([
      contents.executeJavaScript(PAGE_STATE_PROBE),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise('blank'), 1000))
    ])
    return typeof value === 'string' ? value : 'blank'
  } catch {
    return 'blank'
  }
}

/**
 * 探测节奏。6 秒对「页面正常启动」已经很宽裕（本机不到 1 秒，跨机器的 `/api/env`
 * 也只有几百毫秒），而失败的样子是「什么都没加载上」，超出即可判定，不必再等。
 */
const BOOT_PROBE_TIMEOUT_MS = 6000
const BOOT_PROBE_INTERVAL_MS = 500
/** 重载只做一次：慢启动不该被误判成失败，更不能无限重载 */
const MAX_BOOT_RELOADS = 1

/**
 * 每次加载结束后确认页面真的起来了，没起来就地重载 —— 实测重载是有效的恢复手段。
 * 不做的话用户只能自己想到按 ⌘R，而「点远程那行」只会把那块黑屏再端到前面一次。
 */
function watchPageBoot(state, url) {
  let reloads = 0
  let probing = false

  const reload = (reason) => {
    if (reloads >= MAX_BOOT_RELOADS) {
      console.warn(`[mica-code-app] 页面仍然无法启动（${reason}）`, url)
      // 重载也救不回来，只能如实告诉用户 —— 否则窗口就停在黑屏上，一句话都没有
      if (!state.win.isDestroyed()) dialog.showErrorBox('页面加载失败', `${url}\n\n${reason}`)
      return
    }
    reloads += 1
    console.warn(`[mica-code-app] 页面未能启动，重新加载（${reason}）`, url)
    void loadPage(state, url)
  }

  const probe = async () => {
    if (probing || state.win.isDestroyed()) return
    probing = true
    try {
      const deadline = Date.now() + BOOT_PROBE_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, BOOT_PROBE_INTERVAL_MS))
        // 已经开了新一轮加载（比如上面刚重载过），交给它自己那一次探测
        if (state.win.isDestroyed() || state.win.webContents.isLoading()) return
        if ((await pageState(state)) !== 'blank') return
      }
      reload('探测超时')
    } finally {
      probing = false
    }
  }

  state.win.webContents.on('did-finish-load', () => void probe())

  // 主框架真的加载失败（连不上 / DNS 出错）时走不到上面的探测，这里补一次
  state.win.webContents.on(
    'did-fail-load',
    (_event, code, description, validatedURL, isMainFrame) => {
      // -3 是 ERR_ABORTED：正常重定向/取消会带上它，不是失败
      if (!isMainFrame || code === -3) return
      console.warn(`[mica-code-app] 页面加载失败（${code} ${description}）`, validatedURL)
      reload(`${code} ${description}`)
    }
  )
}

/**
 * 把窗口端到前面。复用一台**已经开着**的服务器时不能只 `showWindow`：那个窗口可能停在
 * 空白状态（首次加载偶发失败留下的），端出来用户看到的还是那块黑屏。
 */
async function enterWindow(state) {
  if (!state || state.win.isDestroyed()) return
  showWindow(state)
  if (state.win.webContents.isLoading()) return
  if ((await pageState(state)) !== 'blank') return
  // 优先用页面自己的地址：中转机入口的 `?t=` 只在地址里，退回 state.server 会把入口丢掉
  const target = state.win.webContents.getURL() || state.server
  if (!target) return
  console.warn('[mica-code-app] 窗口里是空白页，重新加载', target)
  void loadPage(state, target)
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

/** 中转机入口对应的窗口（同一台中转机上的不同机器各算一个） */
function findEntryWindow(key) {
  if (!key) return null
  return [...windows].find((item) => !item.win.isDestroyed() && item.entryKey === key) || null
}

/**
 * 页面自己开窗口（`window.open`）：目标落在同一台运行时的应用页面上时，由外壳开一个
 * 应用窗口——顶栏的文件夹就是这么把 `/files` 开成独立文件窗口的（那一页只有文件树与
 * 编辑器，没有会话列表），主窗口因此能留在对话里。同名窗口已经开着就把那个窗口端到前面
 * 并换到新地址（比如换了个目录），重复点按钮不会攒出一堆窗口。返回 `false` 表示不是这种
 * 目标，调用方仍按外链处理。
 */
function openAppPageWindow(state, target, frameName = '') {
  if (!state || state.win.isDestroyed()) return false
  const origins = [state.server, originOf(localPageUrl)]
  if (!isAppPageTarget(target, { origins })) return false
  const name = String(frameName || '').trim()
  const key = appPageKey(target)
  const existing = [...windows].find((item) => {
    if (item.win.isDestroyed()) return false
    if (name) return item.frameName === name
    return appPageKey(item.win.webContents.getURL()) === key
  })
  if (!existing) {
    createWindow(target, { frameName: name })
    return true
  }
  showWindow(existing)
  if (appPageKey(existing.win.webContents.getURL()) !== key) void loadPage(existing, target)
  return true
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
  if (origin && origin === loopbackRuntimeUrl() && localPageUrl) {
    const existing = findServerWindow(originOf(localPageUrl))
    if (existing && existing !== state) {
      void enterWindow(existing)
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
  // 中转机链接要看完整入口：`?t=` 才是「连哪一台机器」，光有 origin 只会探到中转机本身
  const entryKey = relayEntryKey(target)
  const existing = entryKey ? findEntryWindow(entryKey) : findServerWindow(origin)
  if (existing && existing !== state) {
    void enterWindow(existing)
    return
  }
  // 探活与打开都用**完整入口**：带 `?t=` 的中转机链接丢了查询串就只是一台没人认识的域名，
  // 外壳于是把它当外链丢给系统浏览器（这也是「Connections 里点开会跳浏览器」的旧行为）。
  const probe = await probeRemoteRuntime(target)
  if (!probe.ok) {
    shell.openExternal(target)
    return
  }
  createWindow(probe.url)
}

/** 窗口落在哪台运行时上：标题后缀与未读徽标订阅都跟着它 */
function syncWindowServer(state, target) {
  const origin = originOf(target)
  const local = Boolean(localPageUrl) && origin === originOf(localPageUrl)
  state.server = origin
  state.local = local
  state.entryKey = relayEntryKey(target)
  // 中转机窗口不挂未读订阅：那要再让一条 SSE 穿过中转机，而页面自己已经挂着一条了，
  // 徽标留给本机与直连的另一台机器。
  const apiUrl = state.entryKey ? '' : local ? runtime?.url || origin : origin
  if (apiUrl !== state.apiUrl) {
    state.apiUrl = apiUrl
    if (apiUrl) watchUnread(state, apiUrl)
    else {
      stopUnreadWatcher(state)
      state.unread = 0
    }
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
    void enterWindow(local)
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
/**
 * 窗口底色：页面加载出第一帧之前、以及窗口缩放露出的边，看到的是这个颜色。
 * 深色沿用原来的 #0e0e0e；浅色用画布白。偏好存在渲染层界面状态（ui-state.json，
 * 与渲染层同一份），auto 跟系统主题——和页面自己的解析规则保持一致，避免
 * 浅色主题下先闪一块深色。读不到文件（首次启动）就按系统主题。
 */
function windowBackgroundColor() {
  const dark = '#0e0e0e'
  const light = '#ffffff'
  const systemLight = !nativeTheme.shouldUseDarkColors
  try {
    const stored = JSON.parse(readFileSync(join(app.getPath('userData'), 'ui-state.json'), 'utf8'))
    const preference = stored?.keys?.theme
    if (preference === 'light') return light
    if (preference === 'dark') return dark
    return systemLight ? light : dark
  } catch {
    return systemLight ? light : dark
  }
}

function createWindow(url, { primary = false, frameName = '' } = {}) {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Mica Code',
    backgroundColor: windowBackgroundColor(),
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
    // 页面自己开的窗口（`window.open(url, 'mica-files')`）记下它的名字：同名再开一次时
    // 复用同一个窗口，重复点按钮不会攒出一堆窗口。
    frameName,
    server: originOf(url),
    // 中转机入口的窗口身份（origin + t）；直连别的机器时为空
    entryKey: relayEntryKey(url),
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
    // 页面要的是一台运行时上的应用页面（顶栏文件夹的 `?view=files`）时就真开一个窗口，
    // 其余 http(s) 目标照旧交给系统浏览器。
    if (openAppPageWindow(state, details.url, details.frameName)) return { action: 'deny' }
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

  // 加载失败由 watchPageBoot 接住（重载一次 + 日志）：这里再弹一个模态框只会在自动
  // 恢复的同时糊用户一脸，而且那个框关掉之后页面该黑还是黑。
  watchPageBoot(state, url)
  win.loadURL(url).catch((error) => {
    console.error('[mica-code-app] 页面加载失败', error)
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

  // 受控浏览器先起：运行时启动时要拿到它的 socket（会话进程的 agent 靠它驱动窗口）
  try {
    browserHost = await startBrowserHost({
      socketPath: resolveBrowserSocketPath(app.getPath('userData')),
      cacheDir: join(app.getPath('userData'), 'browser-cookies'),
      isQuitting: () => quitting
    })
    console.log(`[mica-browser] 受控浏览器服务: unix:${browserHost.socketPath}`)
  } catch (error) {
    // 起不来只影响「AI 驱动的浏览器」，不该拦住整个应用
    console.error('[mica-code-app] 受控浏览器服务启动失败', error)
  }

  // 终端控制同样先起：窗口页面加载运行时地址，回调在运行时就绪后才真正用到
  try {
    terminalHost = await startTerminalHost({
      socketPath: resolveTerminalSocketPath(app.getPath('userData')),
      // dev 下页面由 Vite 提供（/terminal.html，改代码即时生效）；生产由运行时托管
      // /terminal-control。两者都通过同源 /remote/terminal 访问终端服务。
      getPageUrl: (sessionId) => {
        const base = String(devPageUrl || runtime?.url || '').replace(/\/+$/, '')
        if (!base) return ''
        const page = devPageUrl ? '/terminal.html' : TERMINAL_PAGE_PATH
        return `${base}${page}?session=${encodeURIComponent(sessionId)}`
      },
      isQuitting: () => quitting
    })
    console.log(`[mica-terminal] 终端控制服务: unix:${terminalHost.socketPath}`)
  } catch (error) {
    console.error('[mica-code-app] 终端控制服务启动失败', error)
  }

  // 系统检查（权限 / 命令行工具）同样先起：页面与插件页面读它，起不来只是全报「未知」
  try {
    systemHost = await startSystemHost({
      socketPath: resolveSystemSocketPath(app.getPath('userData'))
    })
    console.log(`[mica-system] 系统检查服务: unix:${systemHost.socketPath}`)
  } catch (error) {
    console.error('[mica-code-app] 系统检查服务启动失败', error)
  }

  try {
    runtime = await resolveRuntime({ pageFromDevServer: Boolean(devPageUrl) })
  } catch (error) {
    dialog.showErrorBox('无法启动 Mica Code 运行时', String(error?.message || error))
    app.quit()
    return
  }
  if (runtime.owned === false && browserHost) {
    // dev 下复用了已在跑的运行时：它的 MICA_BROWSER_URL 是上一次注入的，可能已经失效
    console.warn('[mica-code-app] 复用了已在运行的运行时，受控浏览器可能不可用（重启运行时即可）')
  }
  if (runtime.owned === false && terminalHost) {
    // 同理：复用的运行时没有这次的 MICA_TERMINAL_SOCKET
    console.warn('[mica-code-app] 复用了已在运行的运行时，终端控制可能不可用（重启运行时即可）')
  }
  if (runtime.owned === false && systemHost) {
    // 同理：复用的运行时不知道这次的 MICA_SYSTEM_SOCKET，系统检查会报「需要桌面应用」
    console.warn('[mica-code-app] 复用了已在运行的运行时，系统检查可能不可用（重启运行时即可）')
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
      void enterWindow(state)
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
})

// 服务（浏览器、终端、系统检查）只在确定退出时拆。放在 `before-quit` 里的话，一旦这次退出被取消
// （系统打断、别处 preventDefault），socket 已经被 unlink，进程却还活着——运行时之后
// 每条 `/remote/*` 都只能 503，只有重启应用能恢复。
app.on('will-quit', () => {
  // 受控浏览器窗口是「关闭即隐藏」的，退出时必须显式销毁，否则 app 退不掉
  if (browserHost) void browserHost.close().catch(() => {})
  browserHost = null
  if (terminalHost) void terminalHost.close().catch(() => {})
  terminalHost = null
  if (systemHost) void systemHost.close().catch(() => {})
  systemHost = null
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
