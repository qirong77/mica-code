/**
 * 手机访问网关。
 *
 * 托管桌面端真正的 renderer 产物；页面经同源 `/api/invoke` 与 `/api/events` 与本机运行时通信。
 *
 * 两条通道分别加密：
 * - 手机 ↔ 中转机：TLS（自动签发自签证书，`RELAY_TLS=off` 可关）；
 * - 公司机 ↔ 中转机：应用层 AES-256-GCM，密钥由口令经 HKDF 派生。
 *   即便链路上有 TLS 拦截代理，轮询体也是不可读的密文。
 *
 * 轮询体是二进制：iv(12) | tag(16) | ciphertext(gzip(json))，没有 base64 膨胀。
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { dirname, extname, join, normalize } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

const PORT = Number(process.env.RELAY_PORT || 9200)
/** 放在 nginx 后面时绑回环：公网只留 nginx 那个入口。 */
const BIND = process.env.RELAY_BIND || '0.0.0.0'
/** `RELAY_TLS=off` 表示 TLS 由前面的反向代理终结。 */
const TLS_ON = String(process.env.RELAY_TLS || 'on').toLowerCase() !== 'off'
const TOKEN = String(process.env.RELAY_TOKEN || '')
const ROOT = process.env.RELAY_ROOT || join(import.meta.dirname, 'public')
const AGENT_STALE_MS = 20_000
/** 只存「为什么下线」这一件事：relay 重启后不该忘记正在时段外。 */
const STATE_DIR = process.env.RELAY_STATE_DIR || '/var/lib/mobile-relay'
const STATE_FILE = join(STATE_DIR, 'state.json')
const INVOKE_TIMEOUT_MS = 90_000
/** 页面有交互后，把轮询提速到这期间。 */
const AWAKE_MS = 20_000
const REPLAY_WINDOW_MS = 120_000

if (!TOKEN) {
  console.error('RELAY_TOKEN 未设置：拒绝在没有口令的情况下启动。')
  process.exit(1)
}

/** 轮询通道的对称密钥：两端口令相同即可互通，不需要额外分发密钥。 */
const CHANNEL_KEY = Buffer.from(
  hkdfSync('sha256', Buffer.from(TOKEN, 'utf8'), Buffer.from('mica-relay-v1'), Buffer.from('poll-channel'), 32)
)

function seal(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', CHANNEL_KEY, iv)
  const body = gzipSync(Buffer.from(JSON.stringify(value)))
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

function open(buffer) {
  if (buffer.length < 29) throw new Error('envelope too short')
  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(12, 28)
  const decipher = createDecipheriv('aes-256-gcm', CHANNEL_KEY, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()])
  return JSON.parse(gunzipSync(plain).toString('utf8'))
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.map'])

/** 公司机侧状态。 */
const agent = {
  lastPollAt: 0,
  lastPollTs: 0,
  watch: null,
  env: null,
  /** 主动下线（不在允许时段）时由公司机上报告。 */
  offline: null
}

const phoneClients = new Set()
const imageCache = new Map()
const IMAGE_CACHE_LIMIT = 24 * 1024 * 1024
let awakeUntil = 0

function loadOfflineState() {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (saved?.offline && Number(saved.offline.until) > Date.now()) return saved.offline
  } catch {
    /* 首次启动或文件损坏 */
  }
  return null
}

function saveOfflineState(offline) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ offline: offline ?? null }))
  } catch {
    /* 状态目录不可写时只是丢了「为什么离线」，不影响服务 */
  }
}

agent.offline = loadOfflineState()

const commands = []
const resultCache = new Map()
const RESULT_CACHE_LIMIT = 200

function cacheKey(channel, payload) {
  return `${channel}\u0000${JSON.stringify(payload ?? {})}`
}

function agentOnline() {
  // 主动下线（不在允许时段）时别再等一个不会到来的轮询：手机端要立刻拿到原因
  if (agent.offline && Number(agent.offline.until) > Date.now()) return false
  return Date.now() - agent.lastPollAt < AGENT_STALE_MS
}

function phoneOnline() {
  return phoneClients.size > 0
}

function tokenFrom(req, url) {
  const header = req.headers['x-relay-token']
  if (typeof header === 'string' && header) return header
  if (url.searchParams.get('t')) return url.searchParams.get('t')
  const cookie = req.headers.cookie || ''
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === 'mica_relay') return decodeURIComponent(rest.join('='))
  }
  return ''
}

function authorized(req, url) {
  const value = tokenFrom(req, url)
  return value.length > 0 && value === TOKEN
}

/** 反向代理后面判断「是不是 https」，用来给 cookie 加 Secure。 */
function isSecure(req) {
  if (req.socket?.encrypted) return true
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  return proto === 'https'
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store'
  })
  res.end(payload)
}

async function readRaw(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('payload too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody(req) {
  const raw = await readRaw(req)
  if (!raw.length) return {}
  return JSON.parse(raw.toString('utf8'))
}

function offlineMessage() {
  if (!agent.offline) return null
  // 钟点由公司机按它自己的时区格式化好；中转机只管展示
  const label =
    agent.offline.label ||
    (agent.offline.until ? new Date(agent.offline.until).toISOString().slice(11, 16) + ' UTC' : '稍后')
  return `不在允许的开启时段，预计 ${label} 恢复`
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function offlinePage() {
  const reason = offlineMessage() || '公司机当前没有连上中转机，桌面端可能没有运行。'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mica · 暂时不可用</title>
<style>
  html,body{height:100%;margin:0;background:#1e1f22;color:#d6d6d6;
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
  .w{display:flex;height:100%;align-items:center;justify-content:center;padding:24px}
  .c{max-width:340px}
  h1{font-size:17px;font-weight:600;margin:0 0 10px;color:#e8e8e8}
  p{margin:0;color:#8b8b8b}
  button{margin-top:18px;padding:9px 18px;border-radius:8px;border:1px solid #3a3b40;
    background:#2a2b30;color:#d6d6d6;font-size:14px}
</style></head>
<body><div class="w"><div class="c">
  <h1>暂时不可用</h1><p>${escapeHtml(reason)}</p>
  <button onclick="location.reload()">重新检查</button>
</div></div></body></html>`
}

function invokeRemote(channel, payload) {
  if (!agentOnline()) {
    const message = offlineMessage() || '公司机当前没有连上中转机（poller 未运行）'
    return Promise.resolve({ ok: false, error: message, status: 503 })
  }
  const id = randomUUIDLike()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      agent.pending.delete(id)
      resolve({ ok: false, error: `调用 ${channel} 超时`, status: 504 })
    }, INVOKE_TIMEOUT_MS)
    agent.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      }
    })
    commands.push({ id, channel, payload })
  })
}

agent.pending = new Map()

let idCounter = 0
function randomUUIDLike() {
  idCounter = (idCounter + 1) % 1_000_000
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${randomBytes(3).toString('hex')}`
}

function resolveResult(item) {
  if (item?.ok === false) return { ok: false, error: item.error || '调用失败', status: item.status }
  const key = cacheKey(item.channel, item.payload)
  if (item.unchanged) {
    const cached = resultCache.get(key)
    if (cached && cached.hash === item.hash) return { ok: true, result: cached.value }
  }
  const value = item.result ?? null
  resultCache.delete(key)
  resultCache.set(key, { hash: item.hash ?? '', value })
  if (resultCache.size > RESULT_CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value
    if (oldest !== undefined) resultCache.delete(oldest)
  }
  return { ok: true, result: value }
}

async function handlePoll(req, res) {
  let body
  try {
    body = open(await readRaw(req))
  } catch {
    // 解不开就是没密钥 / 被篡改 / 被替换。不区分原因，统一 401。
    return sendJson(res, 401, { ok: false, error: 'bad envelope' })
  }
  const now = Date.now()
  const ts = Number(body?.ts || 0)
  if (!ts || Math.abs(now - ts) > REPLAY_WINDOW_MS) {
    return sendJson(res, 401, { ok: false, error: 'stale envelope' })
  }
  if (ts < agent.lastPollTs - 5_000) {
    return sendJson(res, 401, { ok: false, error: 'replayed envelope' })
  }
  agent.lastPollTs = ts

  const servedFreshly = now - agent.lastPollAt > AGENT_STALE_MS
  agent.lastPollAt = now
  const nextOffline = body.offline ?? null
  const changed = Boolean(nextOffline) !== Boolean(agent.offline)
  agent.offline = nextOffline
  if (changed) saveOfflineState(nextOffline)
  if (body.watch !== undefined) agent.watch = body.watch
  if (body.env) agent.env = body.env

  for (const item of Array.isArray(body.results) ? body.results : []) {
    const entry = agent.pending.get(item?.id)
    if (!entry) continue
    agent.pending.delete(item.id)
    entry.resolve(resolveResult(item))
  }

  const events = Array.isArray(body.events) ? body.events : []
  if (events.length) broadcastEvents(events)

  const batch = commands.splice(0, commands.length)
  const streaming = events.length > 0
  const awake = Date.now() < awakeUntil
  let intervalMs
  if (batch.length || streaming) intervalMs = 300
  else if (awake) intervalMs = 1000
  else if (phoneOnline()) intervalMs = 3000
  else intervalMs = 6000

  const payload = seal({
    ok: true,
    commands: batch,
    intervalMs,
    watch: agent.watch,
    // 没有手机连着就别让公司机往外送事件：那是纯浪费的上行
    wanted: phoneOnline(),
    resetCache: servedFreshly
  })

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': payload.length,
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function broadcastEvents(events) {
  if (!phoneClients.size) return
  let frame = ''
  for (const event of events) frame += `data: ${JSON.stringify(event)}\n\n`
  for (const client of phoneClients) {
    try {
      client.write(frame)
    } catch {
      phoneClients.delete(client)
    }
  }
}

function handleEvents(req, res) {
  const url = new URL(req.url, 'http://relay')
  if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: 'bad token' })

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write(': connected\n\n')
  phoneClients.add(res)
  // 刚连上就提速一轮，否则首屏要等一个退避周期
  awakeUntil = Date.now() + AWAKE_MS

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      clearInterval(heartbeat)
    }
  }, 20_000)
  heartbeat.unref?.()

  const cleanup = () => {
    clearInterval(heartbeat)
    phoneClients.delete(res)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
}

async function handleInvoke(req, res) {
  const url = new URL(req.url, 'http://relay')
  if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: 'bad token' })

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad json' })
  }
  const channel = String(body?.channel || '')
  if (!channel) return sendJson(res, 400, { ok: false, error: '缺少 channel' })

  const result = await invokeRemote(channel, body?.payload ?? {})
  if (result.ok) return sendJson(res, 200, { ok: true, result: result.result })
  return sendJson(res, result.status || 200, { ok: false, error: result.error })
}

function handleAwake(req, res) {
  const url = new URL(req.url, 'http://relay')
  if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: 'bad token' })
  awakeUntil = Date.now() + AWAKE_MS
  sendJson(res, 200, { ok: true, until: awakeUntil })
}

function handleEnv(req, res) {
  const url = new URL(req.url, 'http://relay')
  if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: 'bad token' })
  const env = agent.env || {}
  sendJson(res, 200, {
    platform: env.platform || 'darwin',
    homeDir: env.homeDir || '',
    sharePath: env.sharePath || '/share',
    shareEnabled: false,
    windowsBuildNumber: env.windowsBuildNumber ?? null
  })
}

async function handleImage(req, res) {
  const url = new URL(req.url, 'http://relay')
  if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: 'bad token' })
  const file = url.searchParams.get('path')
  if (!file) return sendJson(res, 400, { ok: false, error: '缺少 path' })

  const cached = imageCache.get(file)
  if (cached) {
    res.writeHead(200, { 'content-type': cached.type, 'cache-control': 'private, max-age=600' })
    return res.end(cached.buffer)
  }

  const result = await invokeRemote('__image', { path: file })
  if (!result.ok) return sendJson(res, 404, { ok: false, error: result.error || '读取失败' })
  const buffer = Buffer.from(result.result.data, 'base64')
  imageCache.set(file, { buffer, type: result.result.type })
  const total = [...imageCache.values()].reduce((sum, item) => sum + item.buffer.length, 0)
  if (total > IMAGE_CACHE_LIMIT) imageCache.clear()
  res.writeHead(200, { 'content-type': result.result.type, 'cache-control': 'private, max-age=600' })
  res.end(buffer)
}

/** 页面交互信标：让公司机在「有人真的在操作」时才提速。 */
const AWAKE_SCRIPT = `(() => {
  let last = 0
  const ping = () => {
    const now = Date.now()
    if (now - last < 4000) return
    last = now
    fetch('/api/awake', { method: 'POST', keepalive: true }).catch(() => {})
  }
  ping()
  addEventListener('pointerdown', ping, { passive: true })
  addEventListener('keydown', ping, { passive: true })
  addEventListener('visibilitychange', () => {
    if (!document.hidden) ping()
  })
})()
`

async function serveIndex(req, res, url) {
  const absolute = join(ROOT, 'index.html')
  if (!existsSync(absolute)) return sendJson(res, 404, { ok: false, error: 'renderer 未部署' })
  const html = readFileSync(absolute, 'utf8').replace(
    '</body>',
    '  <script src="/relay-awake.js" defer></script>\n</body>'
  )
  const packed = gzipSync(Buffer.from(html))
  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
    ...(acceptsGzip ? { 'content-encoding': 'gzip' } : {}),
    'content-length': acceptsGzip ? packed.length : Buffer.byteLength(html)
  })
  res.end(acceptsGzip ? packed : html)
  void url
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/relay-awake.js') {
    const body = Buffer.from(AWAKE_SCRIPT)
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': body.length
    })
    return res.end(body)
  }
  if (pathname === '/' || pathname === '/mica-web' || pathname === '/mica-web/') {
    if (!agentOnline()) {
      const body = Buffer.from(offlinePage())
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length })
      return res.end(body)
    }
    return serveIndex(req, res, url)
  }
  if (!extname(pathname)) return serveIndex(req, res, url)

  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const absolute = join(ROOT, safe)
  if (!absolute.startsWith(ROOT)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }

  const info = statSync(absolute)
  const ext = extname(absolute).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag })
    return res.end()
  }

  const immutable = pathname.startsWith('/assets/')
  const headers = {
    'content-type': type,
    etag,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
  }

  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip')
  if (acceptsGzip && COMPRESSIBLE.has(ext) && info.size < 4 * 1024 * 1024) {
    const packed = gzipSync(await readFile(absolute))
    headers['content-encoding'] = 'gzip'
    headers['content-length'] = packed.length
    headers.vary = 'accept-encoding'
    res.writeHead(200, headers)
    return res.end(packed)
  }

  headers['content-length'] = info.size
  res.writeHead(200, headers)
  createReadStream(absolute).pipe(res)
}

function loginPage(res, badToken) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Mica · 连接</title><style>
:root{color-scheme:dark}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1f22;
color:#e6e6e6;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
form{width:min(320px,80vw);display:flex;flex-direction:column;gap:12px}
h1{font-size:16px;font-weight:600;margin:0 0 4px}
p{color:#9a9a9a;font-size:13px;margin:0}
input{background:#2b2d31;border:1px solid #3a3d42;border-radius:8px;padding:10px 12px;color:inherit;
font-size:16px;outline:none}
input:focus{border-color:#4c8bf5}
button{background:#4c8bf5;border:0;border-radius:8px;padding:10px;color:#fff;font-size:15px;font-weight:600}
.err{color:#f48771;font-size:13px}
</style></head><body><form method="get" action="/">
<h1>Mica Code</h1><p>输入访问口令</p>
<input name="t" type="password" autofocus autocomplete="current-password" placeholder="访问口令">
${badToken ? '<div class="err">口令不对</div>' : ''}
<button type="submit">进入</button></form></body></html>`
  res.writeHead(badToken ? 401 : 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(html)
}

async function route(req, res) {
  const url = new URL(req.url, 'http://relay')
  const path = url.pathname

  if (path === '/api/poll' && req.method === 'POST') return handlePoll(req, res)
  if (path === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      agentOnline: agentOnline(),
      phoneOnline: phoneOnline(),
      awake: Date.now() < awakeUntil,
      pending: agent.pending.size,
      queued: commands.length,
      offline: agent.offline
    })
  }
  if (path === '/api/invoke' && req.method === 'POST') return handleInvoke(req, res)
  if (path === '/api/awake' && req.method === 'POST') return handleAwake(req, res)
  if (path === '/api/events') return handleEvents(req, res)
  if (path === '/api/env') return handleEnv(req, res)
  if (path === '/api/image') return handleImage(req, res)
  if (path === '/api/paste') return sendJson(res, 501, { ok: false, error: '手机上不支持粘贴文件' })

  if (path === '/') {
    const token = url.searchParams.get('t')
    if (token && token === TOKEN) {
      res.setHeader(
        'set-cookie',
        `mica_relay=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` +
          (isSecure(req) ? '; Secure' : '')
      )
    } else if (!authorized(req, url)) {
      return loginPage(res, Boolean(token))
    }
    if (!agentOnline()) {
      const body = Buffer.from(offlinePage())
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length })
      return res.end(body)
    }
    return serveIndex(req, res, url)
  }

  return serveStatic(req, res, url)
}

/* ---------------------------------------------------------------- TLS */

function ensureCertificate() {
  const certPath = process.env.RELAY_CERT || join(import.meta.dirname, 'cert.pem')
  const keyPath = process.env.RELAY_KEY || join(import.meta.dirname, 'key.pem')
  if (existsSync(certPath) && existsSync(keyPath)) return { certPath, keyPath }

  mkdirSync(dirname(certPath), { recursive: true })
  const host = process.env.RELAY_HOST || ''
  const san = ['DNS:localhost', 'IP:127.0.0.1', host ? `IP:${host}` : ''].filter(Boolean).join(',')
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=mica-relay',
      '-addext', `subjectAltName=${san}`
    ],
    { stdio: 'ignore' }
  )
  console.log(`[relay] 已生成自签证书 ${certPath}`)
  return { certPath, keyPath }
}

function buildServer() {
  const handler = (req, res) => {
    route(req, res).catch((error) => {
      console.error('[relay]', error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      else res.end()
    })
  }

  if (!TLS_ON) return { server: createHttpServer(handler), scheme: 'http' }
  try {
    const { certPath, keyPath } = ensureCertificate()
    const server = createHttpsServer(
      { cert: readFileSync(certPath), key: readFileSync(keyPath), minVersion: 'TLSv1.2' },
      handler
    )
    return { server, scheme: 'https' }
  } catch (error) {
    // 不静默降级：用户以为在加密、其实在明文，比启动失败更糟
    console.error('[relay] TLS 初始化失败：', String(error?.message || error))
    process.exit(1)
  }
}

const { server, scheme } = buildServer()
server.listen(PORT, BIND, () => {
  console.log(`[relay] ${scheme}://${BIND}:${PORT}  root=${ROOT}`)
})
