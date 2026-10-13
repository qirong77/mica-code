import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces, release as osRelease } from 'node:os'
import { createGzip } from 'node:zlib'
import { setBroadcast, invokeChannel, ipcMain } from './electron-shim.js'
import {
  ACCESS_COOKIE,
  SHARE_TTL_MS,
  buildSetCookie,
  scopeAllowsChannel,
  sanitizeScopedPayload,
  filterSessionsForShare,
  scopeAllowsSessionEvent
} from '../host/access-core.js'
import {
  authorizeRequest,
  getAccessToken,
  registerAccessIpc,
  remoteAccessRequiresCredential,
  resolveGrant,
  setRuntimeAddress,
  shareAllowsImagePath,
  verifyRequestOrigin
} from '../host/access.js'
import { createNotifyServer } from '../host/notifyServer.js'
import { disposeAllTerminals, registerTerminalIpc, setNotifyServer } from '../host/terminals.js'
import {
  disposeAllChatRuns,
  resolveNodeSessionId,
  registerChatIpc,
  runLoopTurn,
  setChatNotifyServer
} from '../host/chat.js'
import { disposeLoops, registerLoopIpc, setLoopBroadcaster, setLoopRunner } from '../host/loops.js'
import { registerFilesIpc } from '../host/files.js'
import { registerGitIpc } from '../host/git.js'
import { registerStatsIpc } from '../host/stats.js'
import { registerSkillsIpc } from '../host/skills.js'
import { registerServersIpc } from '../host/servers.js'
import { registerConfigWebIpc } from '../host/configWeb.js'
import { flushUiState, registerUiStateIpc, setUiStateSender } from '../host/ui-state.js'
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
  // 每个订阅者自带访问范围，逐条过滤后写（过滤规则见 handleEvents）
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

async function handleInvoke(req, res, scope) {
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
  // 授权在服务端。分享范围只有它被分享的那一个会话：即使把 URL 里的参数删掉、
  // 或直接照抄一份 channel，也只够得到这一条会话（别的会话与宿主能力一律拒绝）。
  // 只带 nodeId 的运行态操作由 host 侧解析节点归属，不听客户端自称。
  if (!scopeAllowsChannel(scope, channel, body?.payload, resolveNodeSessionId)) {
    sendJson(res, 200, { ok: false, error: '无权访问该资源' })
    return
  }
  try {
    // 授权之后再收敛入参：分享范围不能改属于分享者的会话配置（role 会写进快照）。
    const result = await invokeChannel(channel, sanitizeScopedPayload(scope, channel, body.payload))
    // 分享范围读会话清单只能看到被分享的那一行，别把别的会话标题/目录一起给出去。
    sendJson(res, 200, {
      ok: true,
      result:
        scope.kind === 'share' && channel === 'stats:list-sessions'
          ? filterSessionsForShare(result, scope.sessionId)
          : result
    })
  } catch (error) {
    sendJson(res, 200, { ok: false, error: errorMessage(error) })
  }
}

/**
 * 用链接片段里的令牌换一枚 HttpOnly cookie。
 *
 * 令牌放在片段里、由页面 POST 过来：片段本身不会被发到服务端，所以它不会出现在访问日志、
 * Referer 或链接预览里；而 cookie 是 HttpOnly 的，页面脚本（以及任何注入的脚本）读不到它。
 */
async function handleExchange(req, res) {
  const origin = verifyRequestOrigin(req)
  if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error })
  let body
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
  }
  const grant = resolveGrant(typeof body?.token === 'string' ? body.token : '')
  if (!grant) return sendJson(res, 401, { ok: false, error: '令牌无效或已失效' })
  res.setHeader(
    'set-cookie',
    buildSetCookie(ACCESS_COOKIE, body.token, { maxAgeSeconds: SHARE_TTL_MS / 1000 })
  )
  sendJson(res, 200, {
    ok: true,
    result:
      grant.kind === 'full' ? { scope: 'full' } : { scope: 'share', sessionId: grant.sessionId }
  })
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

function handleEvents(req, res, scope) {
  const writeFrame = (channel, payload) => {
    // 分享范围只收它那一个会话的事件：其余会话的流式内容、工具输出、终端输出
    // 一律不推。默认拒绝，避免新增 channel 时悄悄泄露。
    if (!scopeAllowsSessionEvent(scope, payload?.sessionId)) return
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
  // 每个客户端带自己的范围，广播时逐个过滤；不能共用一份全局连接集合
  const client = { res, scope, writeFrame }
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

  const notifyServer = await createNotifyServer()
  setNotifyServer(notifyServer)
  setChatNotifyServer(notifyServer)
  setBroadcast(broadcast)
  // 页面 UI 状态（草稿/工作区/面板布局）由 host 持有并广播，第二个窗口看到的是同一份
  setUiStateSender(broadcast)
  // 定时循环跑在运行时里（页签关掉也继续），发送走 chat host 的同一条链路
  setLoopBroadcaster(broadcast)
  setLoopRunner(runLoopTurn)
  // 与 Electron 版 index.js 的 notify 桥一致：PTY 里的插件上报状态后推给所有页面
  const stopNotifyBridge = notifyServer.onChange((payload) => broadcast('notify:changed', payload))

  registerTerminalIpc()
  registerChatIpc()
  registerLoopIpc()
  registerUiStateIpc()
  registerFilesIpc()
  registerGitIpc()
  registerStatsIpc()
  registerSkillsIpc()
  registerServersIpc()
  registerConfigWebIpc()
  registerAccessIpc()

  // renderer 会用「窗口是否聚焦/可见」决定是否把通知标记为已读；网页端没有窗口，
  // 统一返回可见（真实的可读性由浏览器 tab 的 document.visibilityState 参与判断）
  ipcMain.handle('app:get-window-state', () => ({ focused: true, visible: true }))

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      try {
        // 探活接口必须保持免凭据：另一台运行时（Node）就是靠它判断「这个端口上是不是
        // 一台 Mica Code」，而它拿不到本机的令牌。所以这里只回一个不含任何数据的指纹。
        if (req.method === 'GET' && url.pathname === '/api/health') {
          return sendJson(res, 200, {
            ok: true,
            app: 'mica-code-app',
            requiresCredential: remoteAccessRequiresCredential()
          })
        }
        // 换 cookie 时还没有 cookie，只用 Host/Origin 两道校验 + 请求体里的令牌
        if (req.method === 'POST' && url.pathname === '/api/access/exchange')
          return await handleExchange(req, res)

        if (url.pathname.startsWith('/api/')) {
          // 静态页面本身不设防（它只是一份前端产物，且页面要靠它才能把令牌换成 cookie），
          // 真正的边界在这条线上：所有 /api 调用都要先拿到范围。
          const auth = authorizeRequest(req)
          if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error })
          if (req.method === 'POST' && url.pathname === '/api/invoke')
            return await handleInvoke(req, res, auth.scope)
          // 粘贴图片会写进宿主机的 ~/.mica/images，属写操作：分享范围只能看，不能落盘
          if (req.method === 'POST' && url.pathname === '/api/paste-image') {
            // 分享范围也允许贴图：往里发消息本来就是这个会话的操作，图片只会落到
            // `$MICA_HOME/images/`（固定目录 + 生成的文件名），不是任意路径写入。
            return await handlePasteImage(req, res)
          }
          if (req.method === 'GET' && url.pathname === '/api/events')
            return handleEvents(req, res, auth.scope)
          if (req.method === 'GET' && url.pathname === '/api/image') {
            // 分享范围只能取这条会话里出现过的图片，否则这个接口就成了宿主机图片枚举器
            if (
              auth.scope.kind === 'share' &&
              !shareAllowsImagePath(auth.scope.sessionId, url.searchParams.get('path'))
            ) {
              return sendJson(res, 403, { error: '无权访问该图片' })
            }
            return await handleImage(res, url)
          }
          if (req.method === 'GET' && url.pathname === '/api/env') {
            return sendJson(res, 200, {
              platform: process.platform,
              homeDir: process.env.HOME || '',
              // 页面据此知道自己是完整应用还是分享视图（分享视图隐藏会话列表且不可打开）。
              // 这个值以服务端判定为准，页面自己写进去的 `share=1` 不作数。
              scope: auth.scope.kind === 'share' ? 'share' : 'full',
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
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'Method not allowed' })
        }
        return await serveStatic(req, res, rendererRoot, url.pathname)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) })
        else res.end()
      }
    })()
  })

  const host = options.host || '0.0.0.0'
  const port = await listenWithFallback(server, host, options.port || DEFAULT_PORT)
  // 分享链接要拼出「别人能连到」的地址，所以必须在端口确定（可能已回退）之后告知
  setRuntimeAddress({ port, host })

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
    stopNotifyBridge()
    // 攒在防抖里的界面状态是用户最后那次输入/拖动，必须在退出前落盘
    flushUiState()
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
  // 远程地址必须带令牌：能连上端口就等于拿到宿主 shell 与全部会话，所以远程访问要凭据。
  // 令牌放在片段里，不会进服务端日志或 Referer。
  const token = remoteAccessRequiresCredential() ? getAccessToken() : ''
  const suffix = token ? `/#token=${token}` : ''
  for (const address of lanAddresses(running.port)) {
    console.log(`[mica-desktop] 局域网访问: ${address}${suffix}`)
  }
  if (!token) {
    console.warn(
      '[mica-desktop] 警告: MICA_DESKTOP_TRUST_REMOTE=1 —— 局域网内任何人都能访问本机终端与文件，请仅在隔离网络使用'
    )
  } else if (process.env.MICA_DESKTOP_PUBLIC_URL) {
    console.log(`[mica-desktop] 公网地址: ${process.env.MICA_DESKTOP_PUBLIC_URL}${suffix}`)
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
