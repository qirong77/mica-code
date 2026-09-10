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
 * 拉起运行时、用窗口装载页面、补上只有容器才能提供的原生体验（dock 徽标等）。
 *
 * 因此这里不注册任何业务 IPC，也不注入 preload —— 页面里的 `window.mica`
 * 始终由 renderer 自己的 transport 适配层通过 HTTP + SSE 建立。
 */

const RUNTIME_ENTRY = join(__dirname, '../server/index.mjs')
const DEFAULT_PORT = 8787
const READY_PREFIX = '[mica-desktop] ready '
const HEADER_HEIGHT_PX = 34
const MAC_TRAFFIC_LIGHT_POSITION = { x: 12, y: 12 }

let mainWindow = null
let runtime = null
let stopBadgeWatcher = null
let quitting = false

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
        if (mainWindow && !mainWindow.isDestroyed()) {
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

/* ---------------------------------------------------------------- 原生体验 */

/**
 * 页面的未读状态由它自己维护（页面聚焦/可见时标记已读），这里只订阅运行时的
 * 通知流，把「有多少条未读」映射成 dock 徽标 / 任务栏闪烁。
 */
function startBadgeWatcher(url) {
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
      applyBadge(count)
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

function applyBadge(count) {
  app.setBadgeCount(count)

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '')
  }

  // Windows 没有计数徽标，用任务栏闪烁表达「有未读且窗口不在前台」
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(count > 0 && !mainWindow.isFocused())
  }
}

/* ------------------------------------------------------------------ 窗口 */

function createWindow(url) {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
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

  if (isMac) {
    mainWindow.setSheetOffset(HEADER_HEIGHT_PX)
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('focus', () => {
    if (process.platform === 'win32') mainWindow.flashFrame(false)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, target) => {
    // 页面是唯一的导航目标，其余跳转交给系统浏览器
    if (target.startsWith(url)) return
    event.preventDefault()
    if (/^https?:/i.test(target)) shell.openExternal(target)
  })

  mainWindow.loadURL(url).catch((error) => {
    console.error('[mica-code-app] 页面加载失败', error)
    dialog.showErrorBox('页面加载失败', `${url}\n\n${error?.message || error}`)
  })
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

  stopBadgeWatcher = startBadgeWatcher(runtime.url)

  const pageUrl = devPageUrl || runtime.url
  createWindow(pageUrl)

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      return
    }
    if (BrowserWindow.getAllWindows().length === 0) createWindow(pageUrl)
  })
})

app.on('window-all-closed', (event) => {
  event.preventDefault()
})

app.on('before-quit', () => {
  quitting = true
  app.setBadgeCount(0)
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge('')
  if (typeof stopBadgeWatcher === 'function') {
    stopBadgeWatcher()
    stopBadgeWatcher = null
  }
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
