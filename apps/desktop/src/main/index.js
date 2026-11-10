import { app, BrowserWindow, dialog, globalShortcut, nativeTheme, protocol, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { resolveBrowserSocketPath, startBrowserHost } from './browser/browser-host.js'
import { applyBrowserRenderSwitch } from './browser/browser-core.js'
import { resolveTerminalSocketPath, startTerminalHost } from './terminal/terminal-host.js'
import { resolveSystemSocketPath, startSystemHost } from './system/system-host.js'
import { TERMINAL_PAGE_PATH } from '@mica-app-paths'
import {
  DEFAULT_THEME_PREFERENCE,
  RUNTIME_PORT_ENV,
  loopbackRuntimeUrl,
  normalizeThemePreference,
  parseRuntimePort,
  relayTokenOf,
  resolveThemeName,
  themeCanvasColor
} from '@packages/mica-web-shared'
// 与运行时、插件同一份探活逻辑（含「中转机链接要带 ?t=」的判定），这里只是为了与
// 上面那个「端口上是不是我们自己的运行时」的 probeRuntime 区分而改名
import { probeRuntime as probeRemoteRuntime } from '../host/runtime-probe-core.js'
import { flushLogs, logger, startMemorySampler } from '@packages/mica-diagnostics/index.js'
import { resolveLogDir } from '@packages/mica-config/brand.js'
import { officialPluginManifests } from '@packages/mica-official-plugins/manifests.js'
import { readDisabledPluginIds, resolvePluginStatePath } from '@packages/mica-plugin/PluginState.js'
import { createPluginLaunchers } from './plugin-launchers.js'
import { isDevToolsShortcut } from './devtools-shortcut.js'
import { CLIENT_SCHEME, createClientContextHandler, isClientOriginAllowed } from './client-context.js'
import { resolveMicaHome } from '@packages/mica-config/index.js'
import { readPluginData, writePluginData } from '../host/plugin-data-store.js'
import { retainHiddenWindow } from './window-retention.js'

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

// 客户端能力只注册在应用窗口的默认 session；受控浏览器的独立 partition 没有这条通道。
// 仍受页面 CSP 与 CORS 约束，不向远程页面暴露通用 IPC 或文件系统。
protocol.registerSchemesAsPrivileged([{
  scheme: CLIENT_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}])

/**
 * 一份「外部进程读得到」的页面产物目录。
 *
 * 开发时就是 out/renderer；打包后页面在 app.asar 里，只有 Electron 自己能读，
 * 所以 build 把 out/renderer 解包到 app.asar.unpacked（插件要打包上传给中转机）。
 * 两者都没有时返回空串——插件会如实说「找不到页面产物」，而不是去抠 asar。
 */
function publishableRendererDir() {
  const candidates = [
    // 打包后优先取解包出来的真实目录：它既是外部进程唯一读得到的一份，也不经过 asar
    // 索引——索引在进程启动时就固定了，之后重新构建产物，旧进程只看得到旧文件名，
    // 页面引用的新 chunk 于是全变成 404（分享链接在浏览器里打不开就是这么来的）。
    join(process.resourcesPath || '', 'app.asar.unpacked', 'out', 'renderer'),
    join(__dirname, '../renderer')
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
let pluginLaunchers = null

/** Deliver native intents to the local editor, including when its window was hidden. */
async function deliverDesktopIntent(intent) {
  const state =
    (lastFocusedWindow?.local && !lastFocusedWindow.win.isDestroyed() && lastFocusedWindow) ||
    [...windows].find((item) => item.local && !item.win.isDestroyed()) ||
    (primaryWindow && !primaryWindow.win.isDestroyed() && primaryWindow.server === originOf(localPageUrl) && primaryWindow) ||
    createWindow(localPageUrl, { primary: true })
  showWindow(state)
  const script = `(() => typeof window.__micaDesktopAction === 'function' ? window.__micaDesktopAction(${JSON.stringify(intent)}) : false)()`
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && !state.win.isDestroyed()) {
    let timer
    const accepted = await Promise.race([
      state.win.webContents.executeJavaScript(script).catch(() => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())) })
    ])
    clearTimeout(timer)
    if (accepted) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('主窗口尚未就绪，请稍后重试')
}

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
  // 仅外壳主动加载的入口授予客户端能力；页面自己的重定向不能扩大授权来源。
  state.clientOrigin = originOf(url)
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
  // `pageState` 最多等 1 秒：这段时间里用户可能已经把窗口关掉了，之后碰 webContents
  // 会抛 "Object has been destroyed"——调用方是 `void enterWindow(...)`，那就是一条
  // 没人捕获的 rejection。
  if (state.win.isDestroyed() || state.win.webContents.isDestroyed()) return
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
 * 中转机入口的窗口身份：`origin + t`。
 *
 * 一台中转机后面可以接多台机器（每台一个访问口令），只比 origin 会让「点 B 的链接却端出
 * A 的窗口」。同一台机器的不同 `?session=` 仍算同一个窗口，所以只取 `t`。
 * 不是中转机入口（没有 `t`）时返回空串，调用方回落到「按服务器认窗口」。
 */
function relayEntryKey(value) {
  const token = relayTokenOf(value)
  if (!token) return ''
  try {
    return `${new URL(String(value)).origin}?t=${token}`
  } catch {
    return ''
  }
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
    if (state) await loadPage(state, localPageUrl)
    else createWindow(localPageUrl, { primary: true })
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
  if (state) void loadPage(state, localPageUrl)
  else createWindow(localPageUrl, { primary: true })
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
 * 当前主题偏好：存在渲染层界面状态（ui-state.json，与渲染层同一份）。按 mtime 缓存，
 * 文件没变就不重复解析——浏览器顶栏每次推状态都会问一次。
 */
let themePreferenceCache = { mtimeMs: null, preference: DEFAULT_THEME_PREFERENCE }
function currentThemePreference() {
  const file = join(app.getPath('userData'), 'ui-state.json')
  try {
    const { mtimeMs } = statSync(file)
    if (mtimeMs === themePreferenceCache.mtimeMs) return themePreferenceCache.preference
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    const preference = normalizeThemePreference(stored?.keys?.theme)
    themePreferenceCache = { mtimeMs, preference }
    return preference
  } catch {
    // 读不到（首次启动、还没写过界面状态）就按默认偏好，与渲染层一致
    return DEFAULT_THEME_PREFERENCE
  }
}

/**
 * 当前生效的主题 id：`auto` 跟系统主题，其余显式选定——与渲染层 theme.js 的解析规则
 * 同一份实现。浏览器窗口的顶栏、窗口底色、主窗口底色都用它。
 */
function currentThemeId() {
  return resolveThemeName(currentThemePreference(), !nativeTheme.shouldUseDarkColors)
}

/**
 * 窗口底色：页面加载出第一帧之前、以及窗口缩放露出的边，看到的是这个颜色。
 * 取当前主题的 --color-canvas，界面重载时从旧页面到新页面第一帧之间不会先闪一块别的
 * 底色。读不到界面状态（首次启动）就按系统主题。
 */
function windowBackgroundColor() {
  return themeCanvasColor(currentThemeId())
}

/**
 * 主题一变就把已经打开的浏览器窗口顶栏重画一遍。偏好由运行时的宿主进程写盘，主进程
 * 只能从文件上看到变化，所以盯 ui-state.json 一个文件（同一批多次写只算一次）。
 */
function watchThemeChanges(onChange) {
  let timer = null
  try {
    const watcher = watch(app.getPath('userData'), (_event, filename) => {
      if (filename && String(filename) !== 'ui-state.json') return
      clearTimeout(timer)
      timer = setTimeout(onChange, 150)
    })
    watcher.on('error', () => {})
    app.on('will-quit', () => watcher.close())
  } catch {
    // 盯不上就退回「窗口下次显示/状态变化时跟随」，不影响功能
  }
}

/**
 * 开发者工具开在独立窗口里（⌥⌘I，判定见 devtools-shortcut.js）。
 *
 * 不用内嵌在右侧/底部：主窗口装的就是整套界面，嵌进去会挤压布局，排查问题时看到的
 * 已经不是用户那一屏了。再按一次关掉。
 */
function toggleDevTools(contents) {
  if (contents.isDestroyed()) return
  if (contents.isDevToolsOpened()) {
    contents.closeDevTools()
    return
  }
  contents.openDevTools({ mode: 'detach', activate: true })
}

/**
 * 开一个窗口装载 `url`。`primary` 是启动时那个本机窗口：关掉它只是隐藏（应用继续留在
 * dock 里），其余运行时窗口隐藏后保活两小时；再次显示取消回收，下次隐藏重新计时。
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
    server: originOf(url),
    clientOrigin: originOf(url),
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
  else retainHiddenWindow(win)

  if (isMac) {
    win.setSheetOffset(HEADER_HEIGHT_PX)
  }

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
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
    // 页面里 `window.open` 出来的 http(s) / mailto 一律交给系统（浏览器 / 邮件客户端）：
    // 应用内的视图（编辑器、评审）都不再另开窗口。`mailto:` 是面板表格 `link` 与
    // `openExternal` 都放行的 scheme，这里不认就等于点了没反应。
    if (/^(https?:|mailto:)/i.test(details.url)) shell.openExternal(details.url)
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
    if (isDevToolsShortcut(input)) {
      event.preventDefault()
      toggleDevTools(win.webContents)
      return
    }
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

/**
 * 给一个窗口拍 V8 堆快照，写到日志目录。
 *
 * 渲染层的内存只能从外面看（`app.getAppMetrics()` 给 RSS），要回答「这 40MB/h 是
 * 什么东西涨起来的」必须有一份堆快照。快照文件是 Chromium 的 `.heapsnapshot`，用
 * Chrome DevTools 的 Memory 面板（或在 DevTools 里 Load）打开就能按构造函数看保留大小。
 *
 * 由用户从 Performance 页触发：快照期间目标页面会停住几秒，文件可能上百 MB，
 * 不适合自动跑。
 */
async function takeWindowHeapSnapshot({ windowId } = {}) {
  const id = Number(windowId)
  const win =
    (Number.isFinite(id) && BrowserWindow.fromId(id)) ||
    BrowserWindow.getFocusedWindow() ||
    BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
  if (!win || win.isDestroyed()) throw new Error('没有可用的窗口')

  const contents = win.webContents
  if (contents.isDestroyed() || contents.isCrashed()) throw new Error('目标页面已崩溃或已关闭')

  const dir = resolveLogDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `heap-${contents.id}-${stamp}.heapsnapshot`)
  mkdirSync(dir, { recursive: true })

  const startedAt = Date.now()
  await contents.takeHeapSnapshot(path)
  let bytes = 0
  try {
    bytes = statSync(path).size
  } catch {
    // 拍完拿不到大小不影响结果，路径本身就是给用户用的
  }
  const result = { path, bytes, windowId: win.id, title: win.getTitle().slice(0, 120) }
  logger('main').info('heap-snapshot', { ...result, ms: Date.now() - startedAt })
  flushLogs()
  return result
}

/**
 * 主进程的诊断：内存分布 + 崩溃现场。
 *
 * 页面白屏 / 卡死（renderer OOM、GPU 崩、utility 崩）此前只会在控制台打一行，
 * 关掉窗口就没了。这里把它们写进与运行时同一套 JSONL（`~/Library/Logs/mica`）：
 * 一条 60s 的进程内存分布（按 Electron 的进程类型），加上三类崩溃事件。
 */
function startMainDiagnostics() {
  const log = logger('main')
  log.info('boot', {
    pid: process.pid,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.version
  })

  startMemorySampler({
    host: 'main',
    intervalMs: 60_000,
    describe: () => {
      // app-server 不在这份表里（它是我们自己的子进程，各自上报 mem），
      // 所以这里是「外壳 + 页面 + GPU + utility」的分布。
      const byType = {}
      try {
        for (const metric of app.getAppMetrics()) {
          const mb = Math.round((metric.memory?.workingSetSize || 0) / 1024)
          byType[metric.type] = (byType[metric.type] || 0) + mb
        }
      } catch {
        // 指标读不到就只留主进程自己的 memoryUsage
      }
      return { windows: BrowserWindow.getAllWindows().length, byType }
    }
  })

  // 页面 URL 里带着 `?session=` 与 cwd，而下面的 `slice(0, 200)` 正好可能把会话参数
  // 切掉。单独解一次，崩溃现场才归得到会话。
  const sessionOf = (raw) => {
    try {
      return new URL(raw).searchParams.get('session') || undefined
    } catch {
      return undefined
    }
  }
  app.on('render-process-gone', (_event, contents, details) => {
    const raw = contents && contents.getURL ? contents.getURL() : ''
    log.error('render-process-gone', {
      url: raw.slice(0, 200),
      session: sessionOf(raw),
      webContentsId: contents && contents.id,
      reason: details && details.reason,
      exitCode: details && details.exitCode
    })
    flushLogs()
  })
  app.on('child-process-gone', (_event, details) => {
    log.error('child-process-gone', {
      type: details && details.type,
      // utility 崩了要能分清是 network 还是 audio，光看 type 分不出来。
      serviceName: details && details.serviceName,
      name: details && details.name,
      reason: details && details.reason,
      exitCode: details && details.exitCode
    })
    flushLogs()
  })
  // 必须在开窗之前注册，否则第一个窗口的 webContents 漏掉。
  app.on('web-contents-created', (_event, contents) => {
    const url = () => (contents.getURL ? contents.getURL() : '').slice(0, 200)
    contents.on('unresponsive', () => {
      log.warn('unresponsive', { url: url() })
      flushLogs()
    })
    contents.on('responsive', () => log.info('responsive', { url: url() }))
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.mica.code')
  startMainDiagnostics()

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
      isQuitting: () => quitting,
      theme: currentThemeId
    })
    console.log(`[mica-browser] 受控浏览器服务: unix:${browserHost.socketPath}`)
    watchThemeChanges(() => browserHost?.manager.refreshTheme())
    // 偏好是 auto 时换系统亮暗不写盘，只能靠这个事件
    nativeTheme.on('updated', () => browserHost?.manager.refreshTheme())
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
      socketPath: resolveSystemSocketPath(app.getPath('userData')),
      snapshotHeap: takeWindowHeapSnapshot,
      launcherControl: (payload) => {
        if (!pluginLaunchers) throw new Error('桌面启动器尚未就绪')
        return pluginLaunchers.control(payload)
      }
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
  const clientHome = process.env.MICA_HOME || resolveMicaHome()
  protocol.handle(CLIENT_SCHEME, createClientContextHandler({
    isAllowedOrigin: (origin) => isClientOriginAllowed(windows, origin),
    manifests: officialPluginManifests,
    readDisabled: () => readDisabledPluginIds(),
    readData: (pluginId) => readPluginData(clientHome, pluginId),
    writeData: (pluginId, value, options) => writePluginData(clientHome, pluginId, value, options),
    probe: probeRemoteRuntime,
    open: (url) => navigateToServer(null, url),
    local: () => backToLocalPage(null),
    localHost: () => localPageUrl
  }))
  // 只开本机窗口：另一台机器上的服务器各占一个新窗口，由页面里「切换 Mica 服务器」当场开
  createWindow(localPageUrl, { primary: true })
  pluginLaunchers = createPluginLaunchers({
    manifests: officialPluginManifests,
    readDisabled: readDisabledPluginIds,
    statePath: resolvePluginStatePath(),
    BrowserWindow, globalShortcut, screen,
    pageUrl: localPageUrl,
    backgroundColor: windowBackgroundColor,
    deliver: deliverDesktopIntent,
    onError: (message) => logger('main').warn('plugin-launcher', { message })
  })

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
  logger('main').info('quit')
  flushLogs()
})

// 服务（浏览器、终端、系统检查）只在确定退出时拆。放在 `before-quit` 里的话，一旦这次退出被取消
// （系统打断、别处 preventDefault），socket 已经被 unlink，进程却还活着——运行时之后
// 每条 `/remote/*` 都只能 503，只有重启应用能恢复。
app.on('will-quit', () => {
  pluginLaunchers?.close()
  pluginLaunchers = null
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
