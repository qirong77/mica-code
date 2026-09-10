import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces, release as osRelease } from 'node:os'
import { setBroadcast, invokeChannel, ipcMain } from './electron-shim.js'
import { createNotifyServer } from '../host/notifyServer.js'
import { disposeAllTerminals, registerTerminalIpc, setNotifyServer } from '../host/terminals.js'
import { disposeAllChatRuns, registerChatIpc, setChatNotifyServer } from '../host/chat.js'
import { registerWorkspaceIpc } from '../host/workspace.js'
import { registerFilesIpc } from '../host/files.js'
import { registerGitIpc } from '../host/git.js'
import { registerStatsIpc } from '../host/stats.js'
import { disposeSettings, registerSettingsIpc } from '../host/settings.js'
import { initializeDesktopProcessPath, stripContainerEnv } from '../host/desktop-process-env.js'
import { warmShellEnv } from '../host/shell-env.js'
import { saveImageDataUrl } from '../host/chat-images.js'

/**
 * Mica Code 桌面端的运行时本体：`src/host` 下的能力（PTY 终端、mica app-server
 * 会话、文件/Git/统计/配置）以 `POST /api/invoke` + SSE 推送的形式暴露给页面，
 * 同一个 renderer 产物直接由它托管。Electron 只是它的一个容器（见 src/main/index.js）。
 *
 * 用法：node out/server/index.mjs [--host 0.0.0.0] [--port 8787] [--renderer <dir>]
 */

const MODULE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)))
const PACKAGE_ROOT = resolve(MODULE_DIR, '..', '..')
const DEFAULT_PORT = 8787
const MAX_BODY_BYTES = 64 * 1024 * 1024
const HEARTBEAT_MS = 15000

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

function parseArgs(argv) {
  const options = {
    host: process.env.MICA_DESKTOP_HOST || '0.0.0.0',
    port: Number.parseInt(process.env.MICA_DESKTOP_PORT || '', 10) || DEFAULT_PORT,
    renderer: process.env.MICA_DESKTOP_RENDERER || join(PACKAGE_ROOT, 'out', 'renderer'),
    // dev 模式下页面由 Vite dev server 提供，服务端只承载 API
    requireRenderer: process.env.MICA_DESKTOP_ALLOW_MISSING_RENDERER !== '1'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--host' && argv[index + 1]) options.host = argv[(index += 1)]
    else if (arg === '--port' && argv[index + 1])
      options.port = Number.parseInt(argv[(index += 1)], 10)
    else if (arg === '--renderer' && argv[index + 1]) options.renderer = resolve(argv[(index += 1)])
    else if (arg === '--allow-missing-renderer') options.requireRenderer = false
  }
  return options
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  // ipcRenderer.invoke 的 rejection 会带 "Error invoking remote method 'x':" 前缀，
  // renderer 只需可读文案，这里保持干净的 message。
  return message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ 推送层 */

const sseClients = new Set()

function broadcast(channel, payload) {
  if (sseClients.size === 0) return
  const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`
  for (const res of sseClients) {
    try {
      res.write(frame)
    } catch {
      sseClients.delete(res)
    }
  }
}

/* ------------------------------------------------------------------ 静态资源 */

async function serveStatic(res, rendererRoot, urlPath) {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, '')
  const candidate = resolve(rendererRoot, normalize(relative || 'index.html'))
  const insideRoot = candidate === rendererRoot || candidate.startsWith(rendererRoot + sep)
  let file = insideRoot && existsSync(candidate) ? candidate : null
  if (file && statSync(file).isDirectory()) file = join(file, 'index.html')

  if (!file || !existsSync(file)) {
    // SPA 回退：未知路径交回前端路由
    if (extname(relative)) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }
    file = join(rendererRoot, 'index.html')
  }

  const extension = extname(file).toLowerCase()
  if (extension === '.html') {
    // Electron 版用 file:// 加载，只允许 frame 到本机 config-web；服务端模式下
    // 配置页与主页面同源（经 host 重写），这里放宽 frame-src 以允许任意来源。
    const html = (await readFile(file, 'utf8')).replace(
      'frame-src http://127.0.0.1:*',
      'frame-src http: https:'
    )
    res.writeHead(200, {
      'content-type': MIME_TYPES['.html'],
      'cache-control': 'no-store'
    })
    res.end(html)
    return
  }

  res.writeHead(200, {
    'content-type': MIME_TYPES[extension] || 'application/octet-stream',
    'cache-control': 'public, max-age=3600'
  })
  pipeFile(res, file)
}

function pipeFile(res, file) {
  const stream = createReadStream(file)
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 500, { error: '读取文件失败' })
    else res.end()
  })
  stream.pipe(res)
}

/* -------------------------------------------------------------------- 路由 */

async function handleInvoke(req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    return
  }
  const channel = body?.channel
  if (typeof channel !== 'string' || !channel) {
    sendJson(res, 400, { ok: false, error: '缺少 channel' })
    return
  }
  try {
    sendJson(res, 200, { ok: true, result: await invokeChannel(channel, body.payload) })
  } catch (error) {
    sendJson(res, 200, { ok: false, error: errorMessage(error) })
  }
}

async function handlePasteImage(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}')
    const dataUrl = typeof body?.dataUrl === 'string' ? body.dataUrl : ''
    sendJson(res, 200, saveImageDataUrl(dataUrl))
  } catch (error) {
    sendJson(res, 200, { ok: false, error: errorMessage(error) })
  }
}

async function handleImage(res, url) {
  const file = url.searchParams.get('path')
  if (!file) {
    sendJson(res, 400, { error: '缺少 path' })
    return
  }
  const absolute = resolve(file)
  let info
  try {
    info = statSync(absolute)
  } catch {
    sendJson(res, 404, { error: '文件不存在' })
    return
  }
  if (!info.isFile() || info.size > 32 * 1024 * 1024) {
    sendJson(res, 403, { error: '无法读取该文件' })
    return
  }
  const extension = extname(absolute).toLowerCase()
  const type = MIME_TYPES[extension]
  if (!type || !type.startsWith('image/')) {
    sendJson(res, 403, { error: '不是图片文件' })
    return
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  pipeFile(res, absolute)
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write(': connected\n\n')
  sseClients.add(res)

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      // 连接已断开，由 close 事件清理
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const cleanup = () => {
    clearInterval(heartbeat)
    sseClients.delete(res)
  }
  req.on('close', cleanup)
  res.on('error', cleanup)
}

/* -------------------------------------------------------------------- 启动 */

/** 端口被占用时回退到随机端口：Electron 容器据此拿到实际地址，不必预选空闲端口 */
async function listenWithFallback(server, host, port) {
  const bind = (value) =>
    new Promise((resolvePromise, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolvePromise()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(value, host)
    })

  try {
    await bind(port)
    return port
  } catch (error) {
    if (error?.code !== 'EADDRINUSE' || !port) throw error
    console.warn(`[mica-desktop] 端口 ${port} 已被占用，改用随机端口`)
    await bind(0)
    return server.address().port
  }
}

export async function startDesktopServer(options = {}) {
  const rendererRoot = resolve(options.renderer || join(PACKAGE_ROOT, 'out', 'renderer'))
  if (options.requireRenderer !== false && !existsSync(join(rendererRoot, 'index.html'))) {
    throw new Error(`未找到 renderer 产物：${rendererRoot}（先执行 npm run build）`)
  }

  // 先摘掉容器标记再采样 shell env / 派生 PTY 与子进程，否则用户会在自己的
  // 终端里继承 ELECTRON_RUN_AS_NODE（见 desktop-process-env.js 的说明）
  stripContainerEnv()
  initializeDesktopProcessPath()
  warmShellEnv()
  // 配置页（config web）由主进程按需拉起；局域网访问时它也要能被别的设备内嵌加载，
  // 否则 iframe 里的 127.0.0.1 指向的是客户端自己（见 main/settings.js 的 spawn env）
  if (!process.env.MICA_CONFIG_WEB_HOST) process.env.MICA_CONFIG_WEB_HOST = '0.0.0.0'

  const notifyServer = await createNotifyServer()
  setNotifyServer(notifyServer)
  setChatNotifyServer(notifyServer)
  setBroadcast(broadcast)
  // 与 Electron 版 index.js 的 notify 桥一致：PTY 里的插件上报状态后推给所有页面
  const stopNotifyBridge = notifyServer.onChange((payload) => broadcast('notify:changed', payload))

  registerTerminalIpc()
  registerChatIpc()
  registerWorkspaceIpc()
  registerFilesIpc()
  registerGitIpc()
  registerStatsIpc()
  registerSettingsIpc()

  // renderer 会用「窗口是否聚焦/可见」决定是否把通知标记为已读；网页端没有窗口，
  // 统一返回可见（真实的可读性由浏览器 tab 的 document.visibilityState 参与判断）
  ipcMain.handle('app:get-window-state', () => ({ focused: true, visible: true }))

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      try {
        if (req.method === 'POST' && url.pathname === '/api/invoke')
          return await handleInvoke(req, res)
        if (req.method === 'POST' && url.pathname === '/api/paste-image') {
          return await handlePasteImage(req, res)
        }
        if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res)
        if (req.method === 'GET' && url.pathname === '/api/health') {
          // Electron 容器 / 探活脚本用它判断「这个端口上跑的是不是 Mica Code 运行时」
          return sendJson(res, 200, {
            ok: true,
            app: 'mica-code-app',
            port: server.address()?.port
          })
        }
        if (req.method === 'GET' && url.pathname === '/api/image')
          return await handleImage(res, url)
        if (req.method === 'GET' && url.pathname === '/api/env') {
          return sendJson(res, 200, {
            platform: process.platform,
            homeDir: process.env.HOME || '',
            windowsBuildNumber:
              process.platform === 'win32'
                ? Number.parseInt(osRelease().split('.')[2], 10) || null
                : null,
            runShellLogConfig: {
              verboseThresholdMs:
                Number.parseInt(process.env.MICA_RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS, 10) || 10000,
              maxLines: Number.parseInt(process.env.MICA_RUN_SHELL_LOG_MAX_LINES, 10) || 10
            }
          })
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'Method not allowed' })
        }
        return await serveStatic(res, rendererRoot, url.pathname)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) })
        else res.end()
      }
    })()
  })

  const host = options.host || '0.0.0.0'
  const port = await listenWithFallback(server, host, options.port || DEFAULT_PORT)

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    for (const res of sseClients) {
      try {
        res.end()
      } catch {
        // ignore
      }
    }
    sseClients.clear()
    disposeAllTerminals()
    disposeAllChatRuns()
    disposeSettings()
    stopNotifyBridge()
    await notifyServer.close()
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
  }

  return { server, port, host, url: `http://127.0.0.1:${port}`, rendererRoot, close }
}

function lanAddresses(port) {
  const addresses = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal)
        addresses.push(`http://${entry.address}:${port}`)
    }
  }
  return addresses
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const running = await startDesktopServer(options)
  // 机器可读的就绪行：Electron 容器（src/main/index.js）据此拿到实际端口
  console.log(
    `[mica-desktop] ready ${JSON.stringify({ url: running.url, port: running.port, host: running.host })}`
  )
  console.log(`[mica-desktop] 本机访问: http://127.0.0.1:${running.port}`)
  for (const address of lanAddresses(running.port)) {
    console.log(`[mica-desktop] 局域网访问: ${address}`)
  }
  console.log(`[mica-desktop] renderer 目录: ${running.rendererRoot}`)

  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    console.log(`\n[mica-desktop] 收到 ${signal}，正在关闭…`)
    await running.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // 被 Electron 容器以 `stdio: ['pipe', ...]` 拉起时，父进程消失会关闭 stdin 管道，
  // 这里跟着退出，避免留下孤儿运行时（占着端口与 PTY）。
  if (process.env.MICA_DESKTOP_EXIT_ON_STDIN_CLOSE === '1') {
    process.stdin.on('end', () => void shutdown('容器已退出'))
    process.stdin.on('close', () => void shutdown('容器已退出'))
    process.stdin.resume()
  }
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirectRun) {
  main().catch((error) => {
    console.error('[mica-desktop] 启动失败:', error)
    process.exit(1)
  })
}
