import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces, release as osRelease } from 'node:os'
import { createGzip } from 'node:zlib'
import { setBroadcast, invokeChannel, ipcMain } from './electron-shim.js'
import {
  registerAccessIpc,
  setRuntimeAddress,
  trustedClients,
  verifyRequestOrigin
} from '../host/access.js'
import { isLoopbackAddress, isTrustedClientAddress } from '../host/access-core.js'
import {
  REMOTE_ACCESS_COOKIE,
  REMOTE_ACCESS_LOGIN_ENDPOINT,
  REMOTE_ACCESS_LOGIN_PATH,
  REMOTE_ACCESS_LOGOUT_ENDPOINT,
  REMOTE_ACCESS_MAX_AGE,
  SHARE_SCOPE_COOKIE,
  clearedCookie,
  createLoginThrottle,
  hasScopeToken,
  parseCookies,
  remoteAccessCookie,
  remoteAccessDecision,
  remoteAccessToken,
  safeNextPath,
  verifyRemoteAccessPassword
} from '../host/remote-access-core.js'
import { readRemoteAccessPolicy, setRemoteAccessPort } from '../host/remote-access.js'
import { createNotifyServer } from '../host/notifyServer.js'
import { disposeAllTerminals, registerTerminalIpc, setNotifyServer } from '../host/terminals.js'
import {
  disposeAllChatRuns,
  registerChatIpc,
  runLoopTurn,
  sessionExists,
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
import {
  registerTerminalControlIpc,
  setTerminalControlBroadcaster,
  startTerminalControl,
  stopTerminalControl
} from '../host/terminal-control.js'
import {
  TERMINAL_CONTROL_PREFIX,
  TERMINAL_SOCKET_ENV,
  TERMINAL_URL_ENV
} from '../host/terminal-control-core.js'
import {
  createTerminalControlProxy,
  isTerminalControlPath
} from '../host/terminal-control-proxy.js'
import { CONTROL_MCP_PREFIX, createControlMcpHandler } from '../host/control-mcp.js'
import { requestJson } from '../host/control-client.js'
import { CONTROL_ORIGIN_ENV, removeLegacyControlSkills } from '../host/control-mcp-config.js'
import { resolveMicaHome } from '@packages/mica-config/index.js'
import {
  DEFAULT_RUNTIME_PORT,
  RUNTIME_PORT_ENV,
  SHARE_BASE_PATH,
  isFilesPagePath,
  isSharePath,
  isTerminalPagePath,
  parseRuntimePort,
  toAssetPath
} from '@packages/mica-web-shared'
import { registerFilesIpc } from '../host/files.js'
import { registerGitIpc } from '../host/git.js'
import { registerStatsIpc } from '../host/stats.js'
import { registerSkillsIpc } from '../host/skills.js'
import { registerMcpCandidatesIpc } from '../host/mcp-candidates.js'
import { registerPerfIpc } from '../host/perf.js'
import { logger, flushLogs, registerDiagnosticsIpc } from '../host/log.js'
import { registerClipboardIpc } from '../host/clipboard.js'
import { registerPluginHostIpc } from '../host/plugin-host.js'
import { registerConfigWebIpc } from '../host/configWeb.js'
import { flushUiState, registerUiStateIpc, setUiStateSender } from '../host/ui-state.js'
import { registerSharedSessionIpc } from '../host/shared-sessions.js'
import { initializeDesktopProcessPath, stripContainerEnv } from '../host/desktop-process-env.js'
import { warmShellEnv } from '../host/shell-env.js'
import { saveImageDataUrl } from '../host/chat-images.js'

// host 通道统一计时：一次调用超过阈值就记 slow，并累计到 slowReport。
const invokeLog = logger('invoke')
const runtimeLog = logger('runtime')

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
 * 唯一的路径级收窄在「谁在连」这一侧：非本机（非回环、也不在 `MICA_DESKTOP_TRUSTED_CLIENTS`
 * 里）的连接只拿得到分享视图与它用到的 `/api/*`，主页面 / 文件页 / 终端窗口 / `/remote/*`
 * / `/mcp/*` 一律 404。目的不是给它一个只读视图（分享本来就是把 agent 借出去），而是别让
 * 「同一个局域网 + 一个 IP」就等于拿到这台机器的入口。
 *
 * 用法：node out/server/index.mjs [--host 0.0.0.0] [--port 8787] [--no-share]
 *                                [--renderer <dir>]
 */

const MODULE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)))
const PACKAGE_ROOT = resolve(MODULE_DIR, '..', '..')
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
    port: parseRuntimePort(process.env[RUNTIME_PORT_ENV]),
    sharing: parseSharing(process.env.MICA_DESKTOP_SHARE_PORT ?? process.env.MICA_DESKTOP_SHARING),
    renderer: process.env.MICA_DESKTOP_RENDERER || join(PACKAGE_ROOT, 'out', 'renderer'),
    // dev 模式下页面由 Vite dev server 提供，服务端只承载 API
    requireRenderer: process.env.MICA_DESKTOP_ALLOW_MISSING_RENDERER !== '1'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--host' && argv[index + 1]) options.host = argv[(index += 1)]
    else if (arg === '--port' && argv[index + 1])
      options.port = parseRuntimePort(argv[(index += 1)])
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

/**
 * 这个连接算不算「本机」：回环，或使用者显式信任的客户端（`MICA_DESKTOP_TRUSTED_CLIENTS`）。
 *
 * 只看连接的对端地址，**不看** `Host` / `X-Forwarded-For`：那些是请求方自己写的，拿它们
 * 判断等于把「你是不是本机」交给对方回答。代价是隧道 / 反向代理后面的请求全部看起来
 * 来自回环——那种部署本来就是把这台机器放到公网上，边界交给隧道自己。
 */
function isLocalClient(req) {
  const address = req?.socket?.remoteAddress || ''
  return isLoopbackAddress(address) || isTrustedClientAddress(address, trustedClients())
}

/**
 * 请求行里的路径部分，只接受 origin-form（一个前导斜杠）。
 *
 * 不用 `url.pathname` 判可见性：`new URL('//host/x', base)` 会把它当成**协议相对地址**
 * （host 变成 host、pathname 变成 `/x`），于是 `//evil.example/share` 在判定里看起来就是
 * `/share`，而静态服务取文件时走的又是另一个路径。别的形态（协议相对、absolute-form）
 * 一律返回 null，交给调用方按拒绝处理。
 */
function requestPathname(req) {
  const target = String(req?.url || '')
  if (!target.startsWith('/') || target.startsWith('//')) return null
  const cut = target.search(/[?#]/)
  return cut < 0 ? target : target.slice(0, cut)
}

/**
 * 远程请求碰到了分享视图之外的东西。
 *
 * 回 404 而不是 403：对远程来说这个地址上就是「没有这些页面」，403 等于承认那里有东西。
 * 浏览器导航给一段能自己解释的提示（同事输错地址时不用猜是不是运行时坏了），其余请求
 * 走和「路径不存在」一样的 JSON。
 */
function sendRemoteNotFound(req, res) {
  if (!/\btext\/html\b/.test(String(req.headers?.accept || ''))) {
    return sendJson(res, 404, { ok: false, error: 'Not found' })
  }
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Not Found</title>
<style>
:root { color-scheme: dark }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #1e1f22; color: #d7dae0;
  font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
main { max-width: 32rem; padding: 2rem }
h1 { margin: 0 0 0.75rem; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.08em; color: #8b909a }
p { margin: 0.4rem 0 }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #cdd3dd }
</style>
</head>
<body>
<main>
<h1>NOT FOUND</h1>
<p>这个地址只提供分享出去的会话：请用分享链接（<code>/share?session=…</code>）打开。</p>
<p>其余页面只在运行这本机的 Mica Code 里可用。</p>
</main>
</body>
</html>`
  res.writeHead(404, {
    'content-type': MIME_TYPES['.html'],
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

/**
 * 限速本身在 `remote-access-core` 的 `createLoginThrottle` 里（要能单测）；这里只是按
 * 来源地址取一个键。进程内记录，重启即清空——这条口令不是账号体系。
 */
const loginThrottle = createLoginThrottle()

function loginPeer(req) {
  return String(req?.socket?.remoteAddress || '')
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 口令登录页。刻意做成一张自包含的静态表单：它要在**页面产物之外**工作——
 * 没过口令时主界面根本不该被下发，这里也就不能依赖它。
 */
function renderLoginPage({ next = '/', error = '', locked = false, enabled = true } = {}) {
  const hint = !enabled
    ? `<p class="hint">这台机器没有开启远程访问：完整界面只在本机可用，别的设备只能打开分享链接。</p>`
    : error
      ? `<p class="error">${escapeHtml(error)}</p>`
      : `<p class="hint">这台机器上的 Mica Code 要求先输入访问口令。口令在它侧栏的 Connections 卡片里（「其他机器访问这台机器」）。</p>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Mica Code</title>
<style>
:root { color-scheme: dark }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #1e1f22; color: #d7dae0;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
}
main { width: min(22rem, calc(100vw - 3rem)); padding: 2rem 0 }
h1 { margin: 0 0 0.2rem; font-size: 1rem; font-weight: 600 }
.sub { margin: 0 0 1.2rem; font-size: 0.72rem; letter-spacing: 0.1em; color: #8b909a }
.hint, .error { margin: 0 0 1rem; font-size: 0.75rem; line-height: 1.7; color: #8b909a }
.error { color: #f0a8a8 }
form { display: grid; gap: 0.6rem }
input {
  height: 2.25rem; padding: 0 0.7rem; border-radius: 4px;
  border: 1px solid #3a3d44; background: #26282c; color: #e6e8ec;
  font-size: 0.95rem; letter-spacing: 0.18em;
}
input:focus { outline: none; border-color: #5c6470 }
button {
  height: 2.25rem; border: 0; border-radius: 4px; cursor: pointer;
  background: #3f4550; color: #f0f2f5; font-size: 0.85rem;
}
button:hover { background: #4a515d }
button:disabled, input:disabled { background: #2f333a; color: #6d737d; cursor: default }
</style>
</head>
<body>
<main>
<h1>Mica Code</h1>
<p class="sub">REMOTE ACCESS</p>
${hint}
<form method="post" action="${REMOTE_ACCESS_LOGIN_ENDPOINT}">
<input type="hidden" name="next" value="${escapeHtml(next)}" />
<input type="password" name="password" autocomplete="current-password" placeholder="访问口令" autofocus ${locked || !enabled ? 'disabled' : ''} />
<button type="submit" ${locked || !enabled ? 'disabled' : ''}>${locked ? '稍后再试' : enabled ? '进入' : '未开启'}</button>
</form>
</main>
</body>
</html>`
}

function sendLoginPage(req, res, options = {}) {
  const body = renderLoginPage({ ...options, enabled: readRemoteAccessPolicy().enabled })
  res.writeHead(options.locked ? 429 : options.error ? 401 : 200, {
    'content-type': MIME_TYPES['.html'],
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function parseFormBody(text) {
  const params = new URLSearchParams(String(text ?? ''))
  return { password: params.get('password') ?? '', next: params.get('next') ?? '/' }
}

/** 登录提交：过限速 → 校验口令 → 发 cookie → 回到原来想去的路径。 */
async function handleLoginSubmit(req, res) {
  const peer = loginPeer(req)
  if (loginThrottle.retryAfterMs(peer) > 0) {
    return sendLoginPage(req, res, { locked: true, error: '尝试次数过多，请稍后再试' })
  }
  let form = { password: '', next: '/' }
  try {
    form = parseFormBody(await readBody(req))
  } catch {
    return sendLoginPage(req, res, { error: '请求体读不出来' })
  }
  const policy = readRemoteAccessPolicy()
  if (!verifyRemoteAccessPassword(form.password, policy)) {
    loginThrottle.recordFailure(peer)
    return sendLoginPage(req, res, { next: safeNextPath(form.next), error: '口令不对' })
  }
  loginThrottle.recordSuccess(peer)
  res.setHeader(
    'set-cookie',
    remoteAccessCookie(REMOTE_ACCESS_COOKIE, remoteAccessToken(policy, 'access'), {
      maxAge: REMOTE_ACCESS_MAX_AGE
    })
  )
  res.writeHead(303, { location: safeNextPath(form.next), 'cache-control': 'no-store' })
  res.end()
}

function handleLogout(_req, res) {
  res.setHeader('set-cookie', [
    clearedCookie(REMOTE_ACCESS_COOKIE),
    clearedCookie(SHARE_SCOPE_COOKIE)
  ])
  res.writeHead(303, { location: REMOTE_ACCESS_LOGIN_PATH, 'cache-control': 'no-store' })
  res.end()
}

/** 一个远程请求过不过门（判定本身在 remote-access-core）。 */
function remoteGate(req, pathname) {
  const policy = readRemoteAccessPolicy()
  const cookies = parseCookies(req?.headers?.cookie)
  return remoteAccessDecision({
    local: isLocalClient(req),
    policy,
    pathname: pathname ?? '',
    hasAccess: hasScopeToken(cookies, policy, 'access'),
    hasShare: hasScopeToken(cookies, policy, 'share'),
    shareLink: Boolean(shareLinkSessionId(req?.url))
  })
}

/**
 * 这个路径是不是「一条有效的分享链接」：必须是 `/share` 本身、带 `session` 参数，而且那条
 * 会话在这台机器上确实存在。
 *
 * 分享链接就是凭据（见 remote-access-core 的注释），所以这里绝不能只看到 `/share` 就认：
 * 裸 `/share` 是分享列表页，随便编个 id 更不该换到任何东西。
 */
function shareLinkSessionId(target) {
  // 用原始请求目标而不是 requestPathname：后者已经把查询串去掉了，`?session=` 就丢了
  const value = String(target ?? '')
  if (!value.startsWith('/') || value.startsWith('//')) return ''
  const cut = value.search(/[?#]/)
  const path = cut < 0 ? value : value.slice(0, cut)
  if (path !== SHARE_BASE_PATH) return ''
  const query = cut < 0 ? '' : value.slice(cut).replace(/^[?#]/, '')
  const sessionId = new URLSearchParams(query).get('session')
  return sessionId && sessionExists(sessionId) ? sessionId : ''
}

/**
 * 没过口令。
 *
 * 浏览器导航送去登录页并记住原来想去的地址；其余（`fetch`、curl）回 401——它们没有
 * 表单可填，给一个 HTML 只会让调用方更难判断。
 */
function sendLoginRequired(req, res, pathname, search = '') {
  const acceptsHtml = /\btext\/html\b/.test(String(req?.headers?.accept || ''))
  if (!acceptsHtml) {
    return sendJson(res, 401, { ok: false, error: '需要访问口令', login: REMOTE_ACCESS_LOGIN_PATH })
  }
  const next = `${pathname}${search}`
  res.writeHead(302, {
    location: `${REMOTE_ACCESS_LOGIN_PATH}?next=${encodeURIComponent(safeNextPath(next))}`,
    'cache-control': 'no-store'
  })
  res.end()
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
  // 所有功能都从这一个入口进入，所以只在这里计时就能覆盖 chat/files/git/stats/config…
  try {
    const result = await invokeLog.timed(channel, () => invokeChannel(channel, body.payload))
    sendJson(res, 200, { ok: true, result })
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
  // 这两个能力以前以 skill 形式接入：清掉应用自己写的那两个技能文件，避免 agent
  // 同时看到「技能」和「MCP 工具」两套入口（用户改过的文件不动，见 control-mcp-config.js）。
  removeLegacyControlSkills({
    homeDir: resolveMicaHome(),
    separator: process.platform === 'win32' ? '\\' : '/'
  })

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
  // 终端控制同理：会话状态变化推给页面，顶栏图标与设置页据此显示
  setTerminalControlBroadcaster(broadcast)
  // 与 Electron 版 index.js 的 notify 桥一致：PTY 里的插件上报状态后推给所有页面
  const stopNotifyBridge = notifyServer.onChange((payload) => broadcast('notify:changed', payload))

  registerTerminalIpc()
  registerChatIpc()
  registerLoopIpc()
  registerBrowserControlIpc()
  registerTerminalControlIpc()
  registerUiStateIpc()
  registerFilesIpc()
  registerGitIpc()
  registerStatsIpc()
  registerSkillsIpc()
  registerMcpCandidatesIpc()
  registerPerfIpc()
  registerDiagnosticsIpc(ipcMain)
  registerClipboardIpc()
  registerPluginHostIpc()
  registerConfigWebIpc()
  registerAccessIpc()
  registerSharedSessionIpc()

  // renderer 会用「窗口是否聚焦/可见」决定是否把通知标记为已读；网页端没有窗口，
  // 统一返回可见（真实的可读性由浏览器 tab 的 document.visibilityState 参与判断）
  ipcMain.handle('app:get-window-state', () => ({ focused: true, visible: true }))

  // 受控浏览器的窗口服务只监听 Unix socket（Electron 外壳给的 `MICA_BROWSER_SOCKET`），
  // 这里把它代理成自己端口上的 /remote/control——agent 因此只需要一个已有的端口。
  const browserProxy = createBrowserControlProxy({ socketPath: process.env[BROWSER_SOCKET_ENV] })
  // 终端控制服务同样只监听主进程的 Unix socket，这里代理成 /remote/terminal
  const terminalProxy = createTerminalControlProxy({
    socketPath: process.env[TERMINAL_SOCKET_ENV]
  })
  // agent 面向的入口是 MCP：两个能力各暴露一个 `/mcp/<kind>` 端点，只挂一个 tool，
  // 文档按需返回（见 host/control-mcp.js）。纯 Web 宿主没有主进程服务，这里就是空的。
  const controlMcp = createControlMcpEndpoints({
    browserSocket: process.env[BROWSER_SOCKET_ENV],
    terminalSocket: process.env[TERMINAL_SOCKET_ENV]
  })

  const sharing = options.sharing !== false
  const server = createServer(
    createRequestHandler({ rendererRoot, sharing, browserProxy, terminalProxy, controlMcp })
  )
  const host = options.host || '0.0.0.0'
  const port = await listenWithFallback(server, host, options.port || DEFAULT_RUNTIME_PORT, {
    label: '端口'
  })

  // 分享链接要拼出「别人能连到」的地址（自己这个端口 + /share），所以必须在端口确定
  // （可能已回退）之后告知
  setRuntimeAddress({ port, host, sharing })
  // 口令卡片要回答「别人从哪个地址进来」，端口可能已从默认值回退，所以只能等到这里才告知
  setRemoteAccessPort(port)

  // 会话进程按这个地址拼 MCP 端点（`${origin}/mcp/browser`）；端口可能从默认值回退，
  // 所以只能等到这里才写。
  process.env[CONTROL_ORIGIN_ENV] = `http://127.0.0.1:${port}`

  // HTTP 代理地址：**运行时自己的端口** + /remote/control（端口可能已从默认值回退，
  // 所以必须等到这里才定）。页面与排查用的 curl 仍走这条路径；agent 走上面的 MCP 端点。
  if (process.env[BROWSER_SOCKET_ENV]) {
    process.env[BROWSER_URL_ENV] = `http://127.0.0.1:${port}${BROWSER_CONTROL_PREFIX}`
  }
  // 挂上浏览器服务：取一次窗口列表 + 文档（设置页要用），再订阅它的 SSE。
  // 纯浏览器宿主（`npm run start:web`）没有 socket，什么都不做。
  void startBrowserControl()

  // 终端控制：端点路径相对服务根（`/sessions`…），所以给的就是服务根，
  // agent 拼出来是 `$MICA_TERMINAL_URL/sessions` = `/remote/terminal/sessions`
  if (process.env[TERMINAL_SOCKET_ENV]) {
    process.env[TERMINAL_URL_ENV] = `http://127.0.0.1:${port}${TERMINAL_CONTROL_PREFIX}`
  }
  void startTerminalControl()

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
    stopTerminalControl()
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
 * 两个受控能力的 MCP 端点（`/mcp/browser`、`/mcp/terminal`）。
 *
 * 主进程没给 socket 就不创建：纯浏览器宿主（`npm run start:web`）里没有窗口与终端服务，
 * 与其挂一个只会超时的假入口，不如让它 404 —— agent 的 mcp-config 本来也不会指向它。
 */
function createControlMcpEndpoints({ browserSocket, terminalSocket }) {
  const endpoints = {}
  if (browserSocket) {
    endpoints.browser = createControlMcpHandler({
      kind: 'mica-browser',
      title: '受控浏览器',
      usage:
        '驱动 Mica 桌面端内置的浏览器窗口：新开窗口与标签页、导航、读页面内容、点击、输入、按键、滚动、截图、读 cookie 与控制台/网络记录。',
      socketPath: browserSocket,
      label: '受控浏览器服务',
      loadCatalog: () =>
        requestJson(browserSocket, '/browser/docs', {
          timeoutMs: 4000,
          label: '受控浏览器服务'
        })
    })
  }
  if (terminalSocket) {
    endpoints.terminal = createControlMcpHandler({
      kind: 'mica-terminal',
      title: '终端控制',
      usage:
        '操作 Mica 桌面端内置的真实终端（node-pty）：新开会话、写输入、发按键、改尺寸、按条件等待输出、读当前屏幕、显示/隐藏/关闭窗口。',
      socketPath: terminalSocket,
      label: '终端控制服务',
      loadCatalog: () =>
        requestJson(terminalSocket, '/docs', {
          timeoutMs: 4000,
          label: '终端控制服务'
        })
    })
  }
  return endpoints
}

/**
 * 一个端口上的请求处理：先按路径分派服务（/api/*、/remote/control/*、/share、页面产物），
 * 再交给静态服务。`/share` 与 `/mica-web` 都是页面产物的别名，页面自己按 location.pathname
 * 判断「是不是分享视图」——判断只有一份，在 @packages/mica-web-shared 的 app-paths 里。
 */
function createRequestHandler({
  rendererRoot,
  sharing = true,
  browserProxy = null,
  terminalProxy = null,
  controlMcp = {}
}) {
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      try {
        const pathname = requestPathname(req)

        // 口令登录页 / 登录 / 登出：它就是这道门本身，必须在判定之前处理。
        if (
          pathname === REMOTE_ACCESS_LOGIN_PATH &&
          (req.method === 'GET' || req.method === 'HEAD')
        ) {
          return sendLoginPage(req, res, {
            next: safeNextPath(url.searchParams.get('next')),
            locked: loginThrottle.retryAfterMs(loginPeer(req)) > 0
          })
        }
        if (pathname === REMOTE_ACCESS_LOGIN_ENDPOINT && req.method === 'POST') {
          return await handleLoginSubmit(req, res)
        }
        if (pathname === REMOTE_ACCESS_LOGOUT_ENDPOINT) return handleLogout(req, res)

        // 同一个端口上挂着整台机器，而分享出去的链接只是 `/share?session=<id>`：
        // 远程只有三件事可做——打开分享视图、用它的资源、在开启口令后凭口令进完整应用。
        // 判定在 remote-access-core 的 remoteAccessDecision 里，这里只负责接线。
        if (pathname === null) return sendRemoteNotFound(req, res)
        const gate = remoteGate(req, pathname)
        if (gate === 'not-found') return sendRemoteNotFound(req, res)
        if (gate === 'login') return sendLoginRequired(req, res, pathname, url.search)

        // 打开一条**有效**的分享链接，才给它一张用 `/api/*` 的凭据：链接本身即凭据，
        // 所以裸 `/share`、编造的 id 都换不到。分享页因此不必输口令，而没拿到链接的人
        // 连接口都摸不到——之前只要请求一次 `/share` 就能换到这张 cookie，等于口令形同虚设。
        const accessPolicy = readRemoteAccessPolicy()
        const shareLinkSession = shareLinkSessionId(req.url)
        if (shareLinkSession && /\btext\/html\b/.test(String(req.headers.accept || ''))) {
          res.setHeader(
            'set-cookie',
            remoteAccessCookie(SHARE_SCOPE_COOKIE, remoteAccessToken(accessPolicy, 'share'))
          )
        }

        // 分享视图（/share 与其子路径）：关掉分享时直接 404，免得以为还能分享。
        if (isSharePath(url.pathname) && !sharing) {
          return sendJson(res, 404, { ok: false, error: '分享视图已关闭' })
        }

        // 受控能力的 MCP 端点（/mcp/browser、/mcp/terminal）：agent 的唯一入口。
        // 和 /api 同一套来源校验；MCP 用 POST/GET/DELETE，不能落到下面「只允许 GET」的兜底上。
        if (url.pathname.startsWith(`${CONTROL_MCP_PREFIX}/`)) {
          const origin = verifyRequestOrigin(req)
          if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error })
          const kind = url.pathname.slice(CONTROL_MCP_PREFIX.length + 1)
          const handler = controlMcp[kind]
          if (!handler) {
            return sendJson(res, 404, {
              ok: false,
              error: `没有这个 MCP 端点：${url.pathname}（只有桌面应用里才有）`
            })
          }
          return await handler(req, res)
        }

        // 受控浏览器：窗口服务住在 Electron 主进程里（只有它开得了窗口），只监听 Unix
        // socket，这里原样转发，agent 于是只用到运行时这一个端口。校验与 /api 同款
        // （curl 没有 Origin、Host 是本机，正常放行；网页发来的跨站请求被挡住）。
        if (browserProxy && isBrowserControlPath(url.pathname)) {
          const origin = verifyRequestOrigin(req)
          if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error })
          if (browserProxy(req, res, url)) return
        }

        // 终端控制：真实 PTY 与窗口在 Electron 主进程里，同样只监听 Unix socket，
        // 这里代理成 /remote/terminal/*（AI 与终端页面都用这一个地址）。
        if (isTerminalControlPath(url.pathname)) {
          const origin = verifyRequestOrigin(req)
          if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error })
          if (terminalProxy && terminalProxy(req, res, url)) return
          // 纯浏览器宿主没有主进程：明确回 503，别让 SPA 回退把首页当成接口响应
          return sendJson(res, 503, {
            ok: false,
            error: '终端控制服务不可用（只有在 Mica Code 桌面应用里才有）'
          })
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
                  : null
            })
          }
          // `/api/` 下没命中的路径没有东西可给了：**不能**掉进下面的静态服务。它会把
          // `/api/任意东西` 回退成 index.html——那是主应用页面，而 `/api/*` 恰好是远程
          // 唯一被放行的非分享前缀（分享页要用它），于是 `GET /api/invoke` 就等于「用
          // 浏览器拿到完整界面」。
          return sendJson(res, 404, { ok: false, error: 'Not found' })
        }
        // 受控浏览器：主进程的窗口服务只监听 Unix socket，这里把它代理成运行时端口上的
        // /remote/control/*。校验与 /api 同款（curl 没有 Origin、Host 是本机，正常放行；
        // 网页发来的跨站请求被挡住）。
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'Method not allowed' })
        }
        // 终端控制窗口的页面：独立入口（terminal.html），与主应用共享同一份产物目录。
        // 页面通过同源 /remote/terminal/* 读写终端，所以窗口只需要运行时地址。
        if (isTerminalPagePath(url.pathname)) {
          return await serveStatic(req, res, rendererRoot, '/terminal.html')
        }
        // 独立文件窗口的页面：又一个独立入口（files.html），页面里只有文件树与编辑器。
        // 它和主应用共用同一份产物目录与同一台运行时（`/api/*` 照旧可用）。
        if (isFilesPagePath(url.pathname)) {
          return await serveStatic(req, res, rendererRoot, '/files.html')
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
  runtimeLog.info('ready', {
    port: running.port,
    version: process.env.MICA_DESKTOP_CLI_VERSION || undefined,
    node: process.version,
    pid: process.pid
  })
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
    runtimeLog.info('shutdown', { signal })
    flushLogs()
    await running.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // 未捕获异常记下来再走默认流程：进程被杀后这些是唯一线索。
  process.on('uncaughtException', (error) => {
    runtimeLog.error('uncaughtException', { error })
    flushLogs()
  })
  process.on('unhandledRejection', (reason) => {
    runtimeLog.error('unhandledRejection', { error: reason })
    flushLogs()
  })

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
