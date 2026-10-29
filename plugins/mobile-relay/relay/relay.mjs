/**
 * 手机访问网关（多机器）。
 *
 * 一台中转机可以接多台公司机：每台机器一个口令，手机用各自的口令打开各自的页面。
 * 状态（轮询时间、待办、命令队列、结果缓存、SSE 客户端、图片缓存）全部按口令隔离，
 * 一台机器的手机看不到另一台的任何内容。
 *
 * 托管桌面端真正的 renderer 产物；页面经同源 `/api/invoke` 与 `/api/events` 与本机运行时通信。
 *
 * 两条通道分别加密：
 * - 手机 ↔ 中转机：TLS 由前置 nginx 终结（Let's Encrypt 证书）；本进程只监听回环，
 *   从不直接面对公网，因此不自己处理证书；
 * - 公司机 ↔ 中转机：应用层 AES-256-GCM，密钥由口令经 HKDF 派生。
 *   即便链路上有 TLS 拦截代理，轮询体也是不可读的密文。
 *
 * 轮询体是二进制：iv(12) | tag(16) | ciphertext(gzip(json))，没有 base64 膨胀。
 */
import { createServer as createHttpServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import { extname, join, normalize } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

const PORT = Number(process.env.RELAY_PORT || 9200)
/** 默认只绑回环：公网入口只有 nginx 那一个，本进程不直接暴露。 */
const BIND = process.env.RELAY_BIND || '127.0.0.1'
const ROOT = process.env.RELAY_ROOT || join(import.meta.dirname, 'public')
/** 机器清单（id / 名字 / 口令）。由 setup.mjs 写入，本进程只读 + 回写名字。 */
const STATE_DIR = process.env.RELAY_STATE_DIR || '/var/lib/mobile-relay'
const AGENTS_FILE = join(STATE_DIR, 'agents.json')

const AGENT_STALE_MS = 20_000
const INVOKE_TIMEOUT_MS = 90_000
/** 页面有交互后，把轮询提速到这期间。 */
const AWAKE_MS = 20_000
const REPLAY_WINDOW_MS = 120_000
const IMAGE_CACHE_LIMIT = 24 * 1024 * 1024
const RESULT_CACHE_LIMIT = 200
/** 手机浏览器最多记住这么多台机器。 */
const MAX_REMEMBERED = 8
/** 自助注册的上限：防止有人把这个域名当成免费隧道。 */
const MAX_AGENTS = Number(process.env.RELAY_MAX_AGENTS || 32)
const REGISTER_WINDOW_MS = 60_000
const REGISTER_PER_WINDOW = 6

/* ------------------------------------------------------------ 机器与状态 */

function fail(message) {
  console.error(`[relay] ${message}`)
  process.exit(1)
}

/** 口令派生出的路由标识：只用来在海量机器里 O(1) 找对一格，不是凭据。 */
function agentId(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

/** 轮询通道的对称密钥：两端口令相同即可互通，不需要额外分发密钥。 */
function channelKey(token) {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.from('mica-relay-v1'), Buffer.from('poll-channel'), 32)
  )
}

function createState(entry) {
  return {
    id: agentId(entry.token),
    label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : '未命名机器',
    identityHash: typeof entry.identityHash === 'string' ? entry.identityHash : '',
    token: entry.token,
    key: channelKey(entry.token),
    createdAt: Number(entry.createdAt) || Date.now(),
    lastPollAt: 0,
    lastPollTs: 0,
    watch: null,
    env: null,
    awakeUntil: 0,
    pending: new Map(),
    commands: [],
    resultCache: new Map(),
    phones: new Set(),
    imageCache: new Map()
  }
}

function loadAgents() {
  let raw
  try {
    raw = readFileSync(AGENTS_FILE, 'utf8')
  } catch {
    fail(`没有 ${AGENTS_FILE}。先跑一次 setup.mjs 把机器登记进来。`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`${AGENTS_FILE} 不是合法 JSON。`)
  }
  const list = Array.isArray(parsed?.agents) ? parsed.agents : []
  const usable = list.filter((entry) => typeof entry?.token === 'string' && entry.token.length >= 16)
  if (!usable.length) fail(`${AGENTS_FILE} 里没有任何机器。先跑一次 setup.mjs。`)
  return usable
}

const agents = new Map()
for (const entry of loadAgents()) agents.set(createState(entry).token, createState(entry))

/**
 * 机器清单热加载。
 *
 * 另一台电脑接入时只追加一条记录，不该为了让它生效去重启服务——那会把已经连着的
 * 手机全部踢断一下。改动落在 mtime 上，重读时保留每台的运行态（轮询时刻、队列、在线设备）。
 */
let agentsMtime = 0
try {
  agentsMtime = statSync(AGENTS_FILE).mtimeMs
} catch {
  // 文件刚被删掉：保留内存里的清单，下一次成功读取再更新
}

function reloadAgents() {
  let mtime = 0
  try {
    mtime = statSync(AGENTS_FILE).mtimeMs
  } catch {
    return
  }
  if (mtime === agentsMtime) return
  agentsMtime = mtime
  let parsed
  try {
    parsed = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'))
  } catch {
    return
  }
  const list = Array.isArray(parsed?.agents) ? parsed.agents : []
  const usable = list.filter((entry) => typeof entry?.token === 'string' && entry.token.length >= 16)
  if (!usable.length) return
  const next = new Map()
  for (const entry of usable) {
    const existing = agents.get(entry.token)
    if (existing) {
      const name = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : existing.label
      next.set(entry.token, { ...existing, label: name })
    } else {
      const state = createState(entry)
      next.set(state.token, state)
      console.log(`[relay] 新增机器 ${state.label}`)
    }
  }
  for (const token of agents.keys()) {
    if (!next.has(token)) console.log(`[relay] 移除机器 ${agents.get(token).label}`)
  }
  agents.clear()
  for (const [token, state] of next) agents.set(token, state)
}

setInterval(reloadAgents, 5_000).unref()

/**
 * 用口令试解信封，解开的那个就是发起方。
 *
 * 不用额外的机器标识头：凭据只有口令一份，少一个「两边必须同步派生」的东西，
 * 老客户端也不会因为缺头被拒。机器数是个位数，几次 AES-GCM 是微秒级。
 */
function openAny(buffer) {
  for (const state of agents.values()) {
    try {
      return { state, body: open(state.key, buffer) }
    } catch {
      // 不是这一台，继续试
    }
  }
  return null
}

/** 名字改了才写盘；失败只记日志，不影响服务。 */
function persistAgents() {
  const payload = {
    version: 1,
    agents: [...agents.values()].map((state) => ({
      id: state.id,
      label: state.label,
      token: state.token,
      ...(state.identityHash ? { identityHash: state.identityHash } : {}),
      createdAt: state.createdAt
    }))
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(AGENTS_FILE, `${JSON.stringify(payload, null, 2)}\n`)
  } catch (error) {
    console.error('[relay] 写 agents.json 失败', error?.message || error)
  }
}

function agentOnline(state) {
  return Date.now() - state.lastPollAt < AGENT_STALE_MS
}

function phoneOnline(state) {
  return state.phones.size > 0
}

/* ---------------------------------------------------------------- 自助注册 */

/**
 * 注册通道的临时密钥对。
 *
 * 申请里带的是「这台机器是谁」的哈希和它的名字，不该以明文躺在中间环节里，
 * 所以走一次 ECDH：本机拿这把公钥协商出会话密钥，申请与返回的口令都封装起来。
 * 密钥对只在内存里，重启重生成——注册是低频动作，不需要持久化。
 */
const registerKeys = generateKeyPairSync('x25519')
const registerPublicDer = registerKeys.publicKey.export({ type: 'spki', format: 'der' })

function registerChannelKey(peerDer) {
  const shared = diffieHellman({
    privateKey: registerKeys.privateKey,
    publicKey: createPublicKey({ key: peerDer, format: 'der', type: 'spki' })
  })
  return Buffer.from(hkdfSync('sha256', shared, registerPublicDer, Buffer.from('mica-relay-register-v1'), 32))
}

function enrollKeyOf() {
  try {
    const parsed = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'))
    return typeof parsed?.enrollKey === 'string' ? parsed.enrollKey.trim() : ''
  } catch {
    return ''
  }
}

const registerHits = new Map()

function registerAllowed(ip) {
  const now = Date.now()
  const hits = (registerHits.get(ip) || []).filter((at) => now - at < REGISTER_WINDOW_MS)
  if (hits.length >= REGISTER_PER_WINDOW) {
    registerHits.set(ip, hits)
    return false
  }
  hits.push(now)
  registerHits.set(ip, hits)
  if (registerHits.size > 512) {
    for (const [key, value] of registerHits) {
      if (!value.some((at) => now - at < REGISTER_WINDOW_MS)) registerHits.delete(key)
    }
  }
  return true
}

function findRegistered(identityHash, label) {
  for (const state of agents.values()) {
    if (state.identityHash && state.identityHash === identityHash) return state
  }
  // 旧清单里的机器没有身份哈希：按名字认领，免得同一台机器重注册多出一条
  for (const state of agents.values()) {
    if (!state.identityHash && sameLabel(state.label, label)) {
      state.identityHash = identityHash
      persistAgents()
      return state
    }
  }
  return null
}

/** `xxx.local` 与 `xxx` 是同一台机器：macOS 主机名带后缀，界面上不带。 */
function sameLabel(left, right) {
  const normalize = (value) => String(value).trim().toLowerCase().replace(/\.local$/, '')
  return normalize(left) === normalize(right) && normalize(left) !== ''
}

function handleRegisterKey(req, res) {
  sendJson(res, 200, {
    ok: true,
    key: registerPublicDer.toString('base64url'),
    requiresKey: Boolean(enrollKeyOf()),
    capacity: MAX_AGENTS
  })
}

async function handleRegister(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim()
  if (!registerAllowed(ip)) return sendJson(res, 429, { ok: false, error: 'too-many-requests' })

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad-body' })
  }

  let channelKeyValue
  let request
  try {
    channelKeyValue = registerChannelKey(Buffer.from(String(body.peer || ''), 'base64url'))
    request = open(
      channelKeyValue,
      Buffer.concat([
        Buffer.from(String(body.iv || ''), 'base64url'),
        Buffer.from(String(body.tag || ''), 'base64url'),
        Buffer.from(String(body.data || ''), 'base64url')
      ])
    )
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad-envelope' })
  }

  const enrollKey = enrollKeyOf()
  if (enrollKey && String(request?.key || '') !== enrollKey) {
    return sendJson(res, 403, { ok: false, error: 'enroll-key-required' })
  }

  const identityHash = String(request?.identity || '')
  if (!/^[0-9a-f]{32,64}$/.test(identityHash)) {
    return sendJson(res, 400, { ok: false, error: 'bad-identity' })
  }
  const label = String(request?.label || '').trim().slice(0, 60) || '未命名机器'

  let state = findRegistered(identityHash, label)
  let created = false
  if (!state) {
    if (agents.size >= MAX_AGENTS) return sendJson(res, 429, { ok: false, error: 'no-capacity' })
    const token = randomBytes(24).toString('hex')
    state = createState({ token, label, identityHash, createdAt: Date.now() })
    agents.set(token, state)
    persistAgents()
    created = true
    console.log(`[relay] 注册机器 ${state.label}（共 ${agents.size} 台）`)
  } else {
    console.log(`[relay] 机器重复注册 ${state.label}（沿用原口令）`)
  }

  return sendJson(res, 200, {
    ok: true,
    sealed: seal(channelKeyValue, {
      token: state.token,
      label: state.label,
      id: state.id,
      created
    }).toString('base64url')
  })
}

/* ------------------------------------------------------------------ 加密 */

function seal(key, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = gzipSync(Buffer.from(JSON.stringify(value)))
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

function open(key, buffer) {
  if (buffer.length < 29) throw new Error('envelope too short')
  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(12, 28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()])
  return JSON.parse(gunzipSync(plain).toString('utf8'))
}

/* ------------------------------------------------------------- 口令与 cookie */

/** 单一口令：header → query → cookie。接口鉴权都走这条。 */
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

/** 这台手机记住的全部口令，只用于选机器那一页。 */
function rememberedTokens(req) {
  const cookie = req.headers.cookie || ''
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key !== 'mica_relays') continue
    return decodeURIComponent(rest.join('='))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => agents.has(value))
      .slice(-MAX_REMEMBERED)
  }
  return []
}

function rememberTokens(req, url) {
  const current = tokenFrom(req, url)
  const list = rememberedTokens(req)
  if (current && agents.has(current) && !list.includes(current)) list.push(current)
  const secure = isSecure(req) ? '; Secure' : ''
  const base = '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'
  const cookies = []
  if (current && agents.has(current)) cookies.push(`mica_relay=${encodeURIComponent(current)}${base}${secure}`)
  if (list.length) cookies.push(`mica_relays=${encodeURIComponent(list.join(','))}${base}${secure}`)
  return cookies
}

/** 反向代理后面判断「是不是 https」，用来给 cookie 加 Secure。 */
function isSecure(req) {
  if (req.socket?.encrypted) return true
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  return proto === 'https'
}

/** 页面请求对应的机器：当前口令优先，其次 cookie 里记住的第一台。 */
function currentState(req, url) {
  const explicit = tokenFrom(req, url)
  if (explicit && agents.has(explicit)) return agents.get(explicit)
  for (const token of rememberedTokens(req)) {
    const state = agents.get(token)
    if (state) return state
  }
  return null
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

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function shellPage(title, inner, extraStyle = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:dark}
  html,body{height:100%;margin:0;background:#1e1f22;color:#d6d6d6;
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
  .wrap{max-width:520px;margin:0 auto;padding:18vh 22px 0}
  h1{font-size:17px;font-weight:600;margin:0 0 10px}
  p{color:#9a9a9a;font-size:13px;margin:0 0 14px}
  p.hint{color:#6f747c;font-size:12px;margin:0 0 8px}
  button{background:#4c8bf5;border:0;border-radius:8px;padding:9px 14px;color:#fff;font-size:14px;font-weight:600}
  a.item{display:flex;align-items:center;gap:10px;padding:12px 14px;margin-bottom:8px;border-radius:10px;
    background:#26282c;border:1px solid #33363b;color:inherit;text-decoration:none}
  a.item:active{background:#2d3035}
  .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .ok{background:#4ec9a0}
  .idle{background:#6b6f76}
  .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .meta{color:#7d828a;font-size:12px}
  ${extraStyle}
</style></head><body>${inner}</body></html>`
}

function unavailablePage(state) {
  const label = escapeHtml(state.label)
  const seen = state.lastPollAt ? `${Math.max(1, Math.round((Date.now() - state.lastPollAt) / 1000))} 秒前` : '从未'
  const inner = `<div class="wrap">
<h1>${label} 暂时不可用</h1>
<p>这台机器当前没有连上中转机，桌面端可能没有运行。</p>
<p class="hint">最近一次连上：${seen}</p>
<p class="hint"><span id="count">5</span> 秒后自动重试</p>
<button onclick="clearInterval(timer);location.reload()">立即重试</button>
<script>
let left = 5
const label = document.getElementById('count')
const timer = setInterval(() => {
  left -= 1
  if (left <= 0) { clearInterval(timer); location.reload(); return }
  if (label) label.textContent = String(left)
}, 1000)
</script>
</div>`
  return shellPage('Mica · 暂时不可用', inner)
}

function pickerPage(states) {
  const items = states
    .map((state) => {
      const online = agentOnline(state)
      return `<a class="item" href="/?t=${encodeURIComponent(state.token)}">
<span class="dot ${online ? 'ok' : 'idle'}"></span>
<span class="name">${escapeHtml(state.label)}</span>
<span class="meta">${online ? '在线' : '离线'}</span>
</a>`
    })
    .join('\n')
  const inner = `<div class="wrap"><h1>选择机器</h1><p>这台手机记住的 Mica</p>${items}</div>`
  return shellPage('Mica · 选择机器', inner)
}

function loginPage(res, badToken) {
  const inner = `<div class="wrap">
<form method="get" action="/" style="display:flex;flex-direction:column;gap:12px">
<h1>Mica Code</h1><p>输入访问口令</p>
<input name="t" type="password" autofocus autocomplete="current-password" placeholder="访问口令"
  style="background:#2b2d31;border:1px solid #3a3d42;border-radius:8px;padding:10px 12px;color:inherit;font-size:16px;outline:none">
${badToken ? '<p style="color:#f48771">口令不对</p>' : ''}
<button type="submit" style="padding:10px">进入</button></form></div>`
  const body = shellPage('Mica · 连接', inner)
  res.writeHead(badToken ? 401 : 200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

/* ---------------------------------------------------------------- 调用通道 */

function cacheKey(channel, payload) {
  return `${channel}\u0000${JSON.stringify(payload ?? {})}`
}

function invokeRemote(state, channel, payload) {
  if (!agentOnline(state)) {
    return Promise.resolve({ ok: false, error: `${state.label} 当前没有连上中转机`, status: 503 })
  }
  const id = randomUUIDLike()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      resolve({ ok: false, error: `调用 ${channel} 超时`, status: 504 })
    }, INVOKE_TIMEOUT_MS)
    state.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      }
    })
    state.commands.push({ id, channel, payload })
  })
}

let idCounter = 0
function randomUUIDLike() {
  idCounter = (idCounter + 1) % 1_000_000
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${randomBytes(3).toString('hex')}`
}

function resolveResult(state, item) {
  if (item?.ok === false) return { ok: false, error: item.error || '调用失败', status: item.status }
  const key = cacheKey(item.channel, item.payload)
  if (item.unchanged) {
    const cached = state.resultCache.get(key)
    if (cached && cached.hash === item.hash) return { ok: true, result: cached.value }
  }
  const value = item.result ?? null
  state.resultCache.delete(key)
  state.resultCache.set(key, { hash: item.hash ?? '', value })
  if (state.resultCache.size > RESULT_CACHE_LIMIT) {
    const oldest = state.resultCache.keys().next().value
    if (oldest !== undefined) state.resultCache.delete(oldest)
  }
  return { ok: true, result: value }
}

/* ------------------------------------------------------------------ 处理函数 */

function broadcastEvents(state, events) {
  if (!state.phones.size) return
  let frame = ''
  for (const event of events) frame += `data: ${JSON.stringify(event)}\n\n`
  for (const client of state.phones) {
    try {
      client.write(frame)
    } catch {
      state.phones.delete(client)
    }
  }
}

async function handlePoll(req, res) {
  const opened = openAny(await readRaw(req))
  // 解不开就是没密钥 / 被篡改 / 被替换 / 不是这台中转机的机器。不区分原因，统一 401。
  if (!opened) return sendJson(res, 401, { ok: false, error: 'bad envelope' })
  const hinted = opened.state
  const body = opened.body
  const now = Date.now()
  const ts = Number(body?.ts || 0)
  if (!ts || Math.abs(now - ts) > REPLAY_WINDOW_MS) {
    return sendJson(res, 401, { ok: false, error: 'stale envelope' })
  }
  if (ts < hinted.lastPollTs - 5_000) {
    return sendJson(res, 401, { ok: false, error: 'replayed envelope' })
  }
  hinted.lastPollTs = ts

  const servedFreshly = now - hinted.lastPollAt > AGENT_STALE_MS
  hinted.lastPollAt = now
  if (typeof body.label === 'string' && body.label.trim() && body.label.trim() !== hinted.label) {
    hinted.label = body.label.trim()
    persistAgents()
  }
  if (body.watch !== undefined) hinted.watch = body.watch
  if (body.env) hinted.env = body.env

  for (const item of Array.isArray(body.results) ? body.results : []) {
    const entry = hinted.pending.get(item?.id)
    if (!entry) continue
    hinted.pending.delete(item.id)
    entry.resolve(resolveResult(hinted, item))
  }

  const events = Array.isArray(body.events) ? body.events : []
  if (events.length) broadcastEvents(hinted, events)

  const batch = hinted.commands.splice(0, hinted.commands.length)
  const streaming = events.length > 0
  const awake = Date.now() < hinted.awakeUntil
  // 间隔按「有没有人在用」分档：没人看时只要保证手机打开后能很快接上，
  // 15 秒足够，也把公司机的常态外联压到每小时 240 次以内。
  let intervalMs
  if (batch.length || streaming) intervalMs = 300
  else if (awake) intervalMs = 1000
  else if (phoneOnline(hinted)) intervalMs = 3000
  else intervalMs = 15_000

  const payload = seal(hinted.key, {
    ok: true,
    commands: batch,
    intervalMs,
    watch: hinted.watch,
    // 没有手机连着就别让公司机往外送事件：那是纯浪费的上行
    wanted: phoneOnline(hinted),
    resetCache: servedFreshly
  })
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': payload.length,
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function handleEvents(req, res, state) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write(': connected\n\n')
  state.phones.add(res)
  // 刚连上就提速一轮，否则首屏要等一个退避周期
  state.awakeUntil = Date.now() + AWAKE_MS

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
    state.phones.delete(res)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
}

async function handleInvoke(req, res, state) {
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad json' })
  }
  const channel = String(body?.channel || '')
  if (!channel) return sendJson(res, 400, { ok: false, error: '缺少 channel' })

  const result = await invokeRemote(state, channel, body?.payload ?? {})
  if (result.ok) return sendJson(res, 200, { ok: true, result: result.result })
  return sendJson(res, result.status || 200, { ok: false, error: result.error })
}

function handleAwake(req, res, state) {
  state.awakeUntil = Date.now() + AWAKE_MS
  sendJson(res, 200, { ok: true, until: state.awakeUntil })
}

function handleEnv(req, res, state) {
  const env = state.env || {}
  sendJson(res, 200, {
    platform: env.platform || 'darwin',
    homeDir: env.homeDir || '',
    sharePath: env.sharePath || '/share',
    shareEnabled: false,
    windowsBuildNumber: env.windowsBuildNumber ?? null
  })
}

async function handleImage(req, res, state, url) {
  const file = url.searchParams.get('path')
  if (!file) return sendJson(res, 400, { ok: false, error: '缺少 path' })

  const cached = state.imageCache.get(file)
  if (cached) {
    res.writeHead(200, { 'content-type': cached.type, 'cache-control': 'private, max-age=600' })
    return res.end(cached.buffer)
  }

  const result = await invokeRemote(state, '__image', { path: file })
  if (!result.ok) return sendJson(res, 404, { ok: false, error: result.error || '读取失败' })
  const buffer = Buffer.from(result.result.data, 'base64')
  state.imageCache.set(file, { buffer, type: result.result.type })
  const total = [...state.imageCache.values()].reduce((sum, item) => sum + item.buffer.length, 0)
  if (total > IMAGE_CACHE_LIMIT) state.imageCache.clear()
  res.writeHead(200, { 'content-type': result.result.type, 'cache-control': 'private, max-age=600' })
  res.end(buffer)
}

function sendHtml(res, status, body) {
  const payload = Buffer.from(body)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store'
  })
  res.end(payload)
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

async function serveIndex(req, res) {
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
}

async function serveStatic(req, res, url, state) {
  const pathname = decodeURIComponent(url.pathname)
  if (pathname === '/relay-awake.js') {
    const body = Buffer.from(AWAKE_SCRIPT)
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': body.length
    })
    return res.end(body)
  }
  if (pathname === '/mica-web' || pathname === '/mica-web/') {
    if (!agentOnline(state)) return sendHtml(res, 503, unavailablePage(state))
    return serveIndex(req, res)
  }
  if (!extname(pathname)) return serveIndex(req, res)

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

async function route(req, res) {
  const url = new URL(req.url, 'http://relay')
  const path = url.pathname

  // 轮询自带机器标识（不是凭据），因此排在口令鉴权之前。
  if (path === '/api/poll' && req.method === 'POST') return handlePoll(req, res)
  // 注册也是无凭据入口：新机器还没有口令，凭的是 ECDH 封装的机器标识。
  if (path === '/api/register-key' && req.method === 'GET') return handleRegisterKey(req, res)
  if (path === '/api/register' && req.method === 'POST') return handleRegister(req, res)

  const state = currentState(req, url)

  if (path === '/api/health') {
    if (!state) return sendJson(res, 200, { ok: true, agents: agents.size })
    return sendJson(res, 200, {
      ok: true,
      label: state.label,
      agentOnline: agentOnline(state),
      phoneOnline: phoneOnline(state),
      awake: Date.now() < state.awakeUntil,
      pending: state.pending.size,
      queued: state.commands.length
    })
  }

  if (path.startsWith('/api/')) {
    if (!state) return sendJson(res, 401, { ok: false, error: 'bad token' })
    if (path === '/api/invoke' && req.method === 'POST') return handleInvoke(req, res, state)
    if (path === '/api/awake' && req.method === 'POST') return handleAwake(req, res, state)
    if (path === '/api/events') return handleEvents(req, res, state)
    if (path === '/api/env') return handleEnv(req, res, state)
    if (path === '/api/image') return handleImage(req, res, state, url)
    if (path === '/api/paste') return sendJson(res, 501, { ok: false, error: '手机上不支持粘贴文件' })
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }

  if (path === '/') {
    const explicit = url.searchParams.get('t')
    if (explicit && !agents.has(explicit)) return loginPage(res, true)

    const remembered = rememberedTokens(req)
      .map((token) => agents.get(token))
      .filter(Boolean)
    if (!explicit && !remembered.length) return loginPage(res, false)

    const cookies = rememberTokens(req, url)
    if (cookies.length) res.setHeader('set-cookie', cookies)

    if (!explicit && remembered.length > 1) return sendHtml(res, 200, pickerPage(remembered))

    const target = explicit ? agents.get(explicit) : remembered[0]
    if (!agentOnline(target)) return sendHtml(res, 503, unavailablePage(target))
    return serveIndex(req, res)
  }

  if (!state) return loginPage(res, false)
  return serveStatic(req, res, url, state)
}

function buildServer() {
  const handler = (req, res) => {
    route(req, res).catch((error) => {
      console.error('[relay]', error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      else res.end()
    })
  }

  return createHttpServer(handler)
}

const server = buildServer()
server.listen(PORT, BIND, () => {
  console.log(
    `[relay] http://${BIND}:${PORT}  root=${ROOT}  agents=${agents.size}  （TLS 由前置 nginx 终结）`
  )
})
