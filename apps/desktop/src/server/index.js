import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces, release as osRelease } from 'node:os'
import { createGzip } from 'node:zlib'
import { setBroadcast, invokeChannel, ipcMain } from './electron-shim.js'
import { registerAccessIpc, setRuntimeAddress, verifyRequestOrigin } from '../host/access.js'
import { createNotifyServer } from '../host/notifyServer.js'
import { disposeAllTerminals, registerTerminalIpc, setNotifyServer } from '../host/terminals.js'
import {
  disposeAllChatRuns,
  registerChatIpc,
  runLoopTurn,
  setChatNotifyServer
} from '../host/chat.js'
import { disposeLoops, registerLoopIpc, setLoopBroadcaster, setLoopRunner } from '../host/loops.js'
import {
  registerBrowserControlIpc,
  setBrowserControlBroadcaster,
  startBrowserControl,
  stopBrowserControl
} from '../host/browser-control.js'
import {
  BROWSER_CONTROL_PREFIX,
  BROWSER_SOCKET_ENV,
  BROWSER_URL_ENV
} from '../host/browser-control-core.js'
import { createBrowserControlProxy, isBrowserControlPath } from '../host/browser-control-proxy.js'
import { SHARE_BASE_PATH, isSharePath, toAssetPath } from '@packages/mica-web-shared'
import { registerFilesIpc } from '../host/files.js'
import { registerGitIpc } from '../host/git.js'
import { registerStatsIpc } from '../host/stats.js'
import { registerSkillsIpc } from '../host/skills.js'
import { registerClipboardIpc } from '../host/clipboard.js'
import { registerServersIpc } from '../host/servers.js'
import { registerConfigWebIpc } from '../host/configWeb.js'
import { flushUiState, registerUiStateIpc, setUiStateSender } from '../host/ui-state.js'
import { registerSharedSessionIpc } from '../host/shared-sessions.js'
import { initializeDesktopProcessPath, stripContainerEnv } from '../host/desktop-process-env.js'
import { warmShellEnv } from '../host/shell-env.js'
import { saveImageDataUrl } from '../host/chat-images.js'

/**
 * Mica Code 桌面端的运行时本体：`src/host` 下的能力（PTY 终端、mica app-server
 * 会话、文件/Git/统计/配置）以 `POST /api/invoke` + SSE 推送的形式暴露给页面，
 * 同一个 renderer 产物直接由它托管。Electron 只是它的一个容器（见 src/main/index.js）。
 *
 * 它只监听**一个端口**（默认 8787），所有能力靠路径区分，谁也不额外占端口（地址约定见
 * `@packages/mica-web-shared` 的 app-paths）：
 *
 * - `/`、`/mica-web`：完整的应用（左侧会话列表、文件、终端、设置都在）
 * - `/share`：分享出去的界面——`/share?session=<id>` 打开某一条会话，`/share` 本身是
 *   分享链接列表。见 renderer 的 shareView 分支
 * - `/remote/control`：受控浏览器（窗口服务在 Electron 主进程里、只监听 Unix socket，
 *   由这里转发，见 ../host/browser-control-proxy.js）
 * - `/api/*`：运行时能力
 *
 * 所有这些是同一台运行时、同一份状态（无账号体系，能连上就等于能操作）。分享视图上
 * 少画一个侧栏只是**呈现**，不是权限边界——别把它当访问控制用。
 *
 * 用法：node out/server/index.mjs [--host 0.0.0.0] [--port 8787] [--no-share]
 *                                [--renderer <dir>]
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

/**
 * 分享视图开关。历史上有过独立的分享端口（`--share-port 8890`、`0`/`off` 关掉），现在
 * 它只是自己端口上的 `/share`，所以这里只认「开/关」：`0`/`off`/`false` 关掉 `/share`
 * 路由，其余值（含历史上传过的端口号）一律表示开启，端口号本身不再有意义。
 */
function parseSharing(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
  if (text === '0' || text === 'off' || text === 'false' || text === 'no') return false
  return true
}

function parseArgs(argv) {
  const options = {
    host: process.env.MICA_DESKTOP_HOST || '0.0.0.0',
    port: Number.parseInt(process.env.MICA_DESKTOP_PORT || '', 10) || DEFAULT_PORT,
    sharing: parseSharing(process.env.MICA_DESKTOP_SHARE_PORT ?? process.env.MICA_DESKTOP_SHARING),
    renderer: process.env.MICA_DESKTOP_RENDERER || join(PACKAGE_ROOT, 'out', 'renderer'),
    // dev 模式下页面由 Vite dev server 提供，服务端只承载 API
    requireRenderer: process.env.MICA_DESKTOP_ALLOW_MISSING_RENDERER !== '1'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--host' && argv[index + 1]) options.host = argv[(index += 1)]
    else if (arg === '--port' && argv[index + 1])
      options.port = Number.parseInt(argv[(index += 1)], 10)
    // 兼容历史上的 `--share-port 8890`（只认开关，端口号已无意义）与新的 `--no-share`
    else if (arg === '--share-port' && argv[index + 1])
      options.sharing = parseSharing(argv[(index += 1)])
    else if (arg === '--no-share') options.sharing = false
    else if (arg === '--share') options.sharing = true
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
  for (const client of sseClients) client.writeFrame(channel, payload)
}

/* ------------------------------------------------------------------ 静态资源 */

/** 能显著压小的文本类资源；图片/字体/worker 不列进来（压缩比低或本身已压缩）。 */
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|manifest\+json))/
const GZIP_MIN_BYTES = 1024
/** Vite 产物名带 8 位内容 hash（如 `index-DBO-oDRP.js`），内容变则名变。 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/

async function serveStatic(req, res, rendererRoot, urlPath) {
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
    res.writeHead(200, {
      'content-type': MIME_TYPES['.html'],
      'cache-control': 'no-store'
    })
    res.end(await readFile(file))
    return
  }

  const contentType = MIME_TYPES[extension] || 'application/octet-stream'
  const headers = {
    'content-type': contentType,
    // 带 hash 的产物可以永久缓存：改内容必然改名，不改名就不必重新下载。
    // 固定名的（favicon、manifest 之类）仍走短缓存。
    'cache-control': HASHED_ASSET.test(file)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600'
  }

  // 运行时的重资源是 monaco/xterm 那几个 chunk，走局域网时压缩能把它们压到约 1/4。
  // 只压文本类且够大的文件，小文件压了反而多一层开销。
  const compressible = COMPRESSIBLE.test(contentType)
  if (compressible) headers.vary = 'accept-encoding'
  const size = statSync(file).size
  if (
    compressible &&
    size >= GZIP_MIN_BYTES &&
    /\bgzip\b/.test(req.headers['accept-encoding'] || '')
  ) {
    headers['content-encoding'] = 'gzip'
    res.writeHead(200, headers)
    pipeFile(res, file, createGzip({ level: 6 }))
    return
  }

  headers['content-length'] = String(size)
  res.writeHead(200, headers)
  pipeFile(res, file)
}

function pipeFile(res, file, transform) {
  const source = createReadStream(file)
  const fail = () => {
    if (!res.headersSent) sendJson(res, 500, { error: '读取文件失败' })
    else res.end()
  }
  // 两个流都要接 error：pipe() 只转发数据不转发错误，只挂在末端的话
  // 读文件失败会在 source 上冒出未捕获异常。
  source.on('error', fail)
  if (!transform) {
    source.pipe(res)
    return
  }
  transform.on('error', fail)
  source.pipe(transform).pipe(res)
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
  const writeFrame = (channel, payload) => {
    try {
      res.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)
    } catch {
      // 连接已断开，由 close 事件清理
    }
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write(': connected\n\n')
  // 所有客户端看到同一份推送：运行时状态只有一份，页面只是它的不同视口
  const client = { res, writeFrame }
  sseClients.add(client)

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
    sseClients.delete(client)
  }
  req.on('close', cleanup)
  res.on('error', cleanup)
}

/* -------------------------------------------------------------------- 启动 */

/**
 * 端口被占用时回退随机端口。
 *
 * 这里只监听一个端口，默认 8787，但**不能**把它钉死：8787 上可能已经跑着另一台运行时
 * （打包版 + dev 一起开着，或上一个实例没退干净），Electron 容器本来就会先探活再复用，
 * 探不到时才让新实例起来，所以随机回退是「起得来」的兜底——外壳与页面都从 `ready` 行拿
 * 实际端口，不需要复现。分享链接因此必须**现取现用**（`access:info` 用实际绑定端口拼）。
 */
async function listenWithFallback(server, host, port, { label = '端口' } = {}) {
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
  }

  console.warn(`[mica-desktop] ${label} ${port} 已被占用，改用随机端口`)
  await bind(0)
  return server.address().port
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

  const notifyServer = await createNotifyServer()
  setNotifyServer(notifyServer)
  setChatNotifyServer(notifyServer)
  setBroadcast(broadcast)
  // 页面 UI 状态（草稿/工作区/面板布局）由 host 持有并广播，第二个窗口看到的是同一份
  setUiStateSender(broadcast)
  // 定时循环跑在运行时里（页签关掉也继续），发送走 chat host 的同一条链路
  setLoopBroadcaster(broadcast)
  setLoopRunner(runLoopTurn)
  // 受控浏览器窗口活在 Electron 主进程里（只有主进程能开窗口），运行时经 HTTP 访问它；
  // 浏览器状态变化要实时推给所有页面，图标才知道该不该亮
  setBrowserControlBroadcaster(broadcast)
  // 与 Electron 版 index.js 的 notify 桥一致：PTY 里的插件上报状态后推给所有页面
  const stopNotifyBridge = notifyServer.onChange((payload) => broadcast('notify:changed', payload))

  registerTerminalIpc()
  registerChatIpc()
  registerLoopIpc()
  registerBrowserControlIpc()
  registerUiStateIpc()
  registerFilesIpc()
  registerGitIpc()
  registerStatsIpc()
  registerSkillsIpc()
  registerClipboardIpc()
  registerServersIpc()
  registerConfigWebIpc()
  registerAccessIpc()
  registerSharedSessionIpc()

  // renderer 会用「窗口是否聚焦/可见」决定是否把通知标记为已读；网页端没有窗口，
  // 统一返回可见（真实的可读性由浏览器 tab 的 document.visibilityState 参与判断）
  ipcMain.handle('app:get-window-state', () => ({ focused: true, visible: true }))

  // 受控浏览器的窗口服务只监听 Unix socket（Electron 外壳给的 `MICA_BROWSER_SOCKET`），
  // 这里把它代理成自己端口上的 /remote/control——agent 因此只需要一个已有的端口。
  const browserProxy = createBrowserControlProxy({ socketPath: process.env[BROWSER_SOCKET_ENV] })

  const sharing = options.sharing !== false
  const server = createServer(createRequestHandler({ rendererRoot, sharing, browserProxy }))
  const host = options.host || '0.0.0.0'
  const port = await listenWithFallback(server, host, options.port || DEFAULT_PORT, {
    label: '端口'
  })

  // 分享链接要拼出「别人能连到」的地址（自己这个端口 + /share），所以必须在端口确定
  // （可能已回退）之后告知
  setRuntimeAddress({ port, host, sharing })

  // agent 用的浏览器地址：**运行时自己的端口** + /remote/control（端口可能已从默认值回退，
  // 所以必须等到这里才定）。会话进程靠继承这个变量拿到它，技能文档里也写它。
  if (process.env[BROWSER_SOCKET_ENV]) {
    process.env[BROWSER_URL_ENV] = `http://127.0.0.1:${port}${BROWSER_CONTROL_PREFIX}`
  }
  // 挂上浏览器服务：取一次窗口列表 + 文档（顺带把技能文件写给 agent），再订阅它的 SSE。
  // 纯浏览器宿主（`npm run start:web`）没有 socket，什么都不做。
  void startBrowserControl()

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
    disposeLoops()
    stopBrowserControl()
    stopNotifyBridge()
    // 攒在防抖里的界面状态是用户最后那次输入/拖动，必须在退出前落盘
    flushUiState()
    await notifyServer.close()
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
  }

  return {
    server,
    port,
    host,
    url: `http://127.0.0.1:${port}`,
    sharing,
    shareUrl: sharing ? `http://127.0.0.1:${port}${SHARE_BASE_PATH}` : null,
    rendererRoot,
    close
  }
}

/**
 * 一个端口上的请求处理：先按路径分派服务（/api/*、/remote/control/*、/share、页面产物），
 * 再交给静态服务。`/share` 与 `/mica-web` 都是页面产物的别名，页面自己按 location.pathname
 * 判断「是不是分享视图」——判断只有一份，在 @packages/mica-web-shared 的 app-paths 里。
 */
function createRequestHandler({ rendererRoot, sharing = true, browserProxy = null }) {
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      try {
        // 分享视图（/share 与其子路径）：关掉分享时直接 404，免得以为还能分享。
        if (isSharePath(url.pathname) && !sharing) {
          return sendJson(res, 404, { ok: false, error: '分享视图已关闭' })
        }

        // 受控浏览器：窗口服务住在 Electron 主进程里（只有它开得了窗口），只监听 Unix
        // socket，这里原样转发，agent 于是只用到运行时这一个端口。校验与 /api 同款
        // （curl 没有 Origin、Host 是本机，正常放行；网页发来的跨站请求被挡住）。
        if (browserProxy && isBrowserControlPath(url.pathname)) {
          const origin = verifyRequestOrigin(req)
          if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error })
          if (browserProxy(req, res, url)) return
        }

        // 探活接口：另一台运行时（Node）靠它判断「这个端口上是不是一台 Mica Code」，
        // 所以只回一个不含任何数据的指纹。
        if (req.method === 'GET' && url.pathname === '/api/health') {
          return sendJson(res, 200, {
            ok: true,
            app: 'mica-code-app'
          })
        }

        if (url.pathname.startsWith('/api/')) {
          // 运行时没有账号体系：这里只挡「不是本页发来的浏览器请求」（DNS rebinding /
          // 任意网页替访客静默请求本机），过了这一关的客户端一律是对等的完整客户端。
          const origin = verifyRequestOrigin(req)
          if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error })
          if (req.method === 'POST' && url.pathname === '/api/invoke')
            return await handleInvoke(req, res)
          if (req.method === 'POST' && url.pathname === '/api/paste-image')
            return await handlePasteImage(req, res)
          if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res)
          if (req.method === 'GET' && url.pathname === '/api/image')
            return await handleImage(res, url)
          if (req.method === 'GET' && url.pathname === '/api/env') {
            return sendJson(res, 200, {
              platform: process.platform,
              homeDir: process.env.HOME || '',
              // 当前绑定端口与分享视图的地址：页面用它拼分享链接（`shareBaseUrl` 在
              // access:info 里另有一份「别人能连到」的地址）。
              sharePath: SHARE_BASE_PATH,
              shareEnabled: sharing,
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
        }
        // 受控浏览器：主进程的窗口服务只监听 Unix socket，这里把它代理成运行时端口上的
        // /remote/control/*。校验与 /api 同款（curl 没有 Origin、Host 是本机，正常放行；
        // 网页发来的跨站请求被挡住）。
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'Method not allowed' })
        }
        // 页面产物：`/share` 与 `/mica-web` 都是别名，剥掉服务前缀后走同一份静态资源。
        // 产物里的资源引用是相对的（`./assets/x.js`），从 `/mica-web/`、`/share/` 下取时会
        // 解析成 `/mica-web/assets/x.js` 这种形态，所以这里剥前缀是必需的，不是顺手为之。
        return await serveStatic(req, res, rendererRoot, toAssetPath(url.pathname))
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) })
        else res.end()
      }
    })()
  }
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
  // 运行时无账号体系：能连上端口就等于拿到这台机器（终端是 shell、files 是任意读写、
  // 配置页里有 API key）。这些地址是给别人连的，打印出来是为了让人知道它开在哪张网上。
  for (const address of lanAddresses(running.port)) {
    console.log(`[mica-desktop] 局域网访问: ${address}`)
  }
  // 分享页面与主页面在同一个端口上，只差一个路径：`/share?session=<id>` 打开一条会话
  // （不画左侧会话列表），`/share` 是分享链接列表。同一台运行时、同一份状态，只是少画
  // 一个侧栏——不是权限边界。
  if (running.sharing) {
    console.log(`[mica-desktop] 分享页面: http://127.0.0.1:${running.port}${SHARE_BASE_PATH}`)
    for (const address of lanAddresses(running.port)) {
      console.log(`[mica-desktop] 分享链接: ${address}${SHARE_BASE_PATH}`)
    }
  } else {
    console.log('[mica-desktop] 分享视图已关闭，分享链接不可用')
  }
  if (process.env.MICA_DESKTOP_PUBLIC_URL)
    console.log(`[mica-desktop] 公网地址: ${process.env.MICA_DESKTOP_PUBLIC_URL}`)
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
