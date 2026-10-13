/**
 * 访问控制中与副作用无关的纯逻辑。
 *
 * 运行时把「谁能看到什么」收敛成两个范围，别处一律不要自制判断：
 *
 * - `full`  ：本机（loopback）连接，或持有运行时访问令牌的连接——完整应用。
 * - `share` ：持有某条分享链接令牌的连接——只有它被分享的那一个会话，但可以像本机一样
 *   驱动这个会话（对话、中断、排队、压缩、改工作目录、贴图），只是拿不到别的会话与
 *   宿主层面的能力（文件树、终端、git、配置里的凭据）。
 *
 * 这里只做判定与纯计算，不碰磁盘、不碰网络：读写状态在 access.js，接线在 server/index.js。
 * `share` 能做什么是一份**显式白名单**——新增 host 能力默认对分享者不可见，必须回到
 * SHARE_SESSION_CHANNELS / SHARE_NODE_CHANNELS / SHARE_SESSIONLESS_CHANNELS 确认
 * 「确实归属这个会话（或确实与单个会话无关）」才允许加进去。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 承载访问凭据的 cookie。HttpOnly，页面脚本读不到。 */
export const ACCESS_COOKIE = 'mica_access'

/** 分享链接默认有效期：7 天。分享是临时协作，不该变成永久后门。 */
export const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 落盘格式版本：读不懂的旧文件一律当没有，重新签发而不是猜。 */
export const ACCESS_STATE_VERSION = 1
export const ACCESS_STATE_FILE = 'access.json'

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 私有网段（RFC1918）。分享链接优先落在这些地址上：它们才是同事能连到的那张网。 */
export function isPrivateLanAddress(address) {
  const parts = String(address || '').split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false
  const [a, b] = parts.map(Number)
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/**
 * `127.0.0.0/8` 与 `::1` 视为本机。Node 在双栈 socket 上会把 IPv4 报成
 * `::ffff:127.0.0.1`，必须先剥掉这个前缀，否则本机请求会被误判成远程而要求令牌。
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || !address) return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  if (value === '::1') return true
  const parts = value.split('.')
  if (parts.length !== 4) return false
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return false
  return Number(parts[0]) === 127
}

export function parseCookieHeader(header) {
  const cookies = {}
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      cookies[name] = part.slice(index + 1).trim()
    }
  }
  return cookies
}

/**
 * SameSite 用 Lax 而不是 Strict：从外部应用点开链接、或之后刷新页面都是「跨站顶层导航」，
 * Strict 会把 cookie 一起丢掉、把已授权的用户锁在门外；Lax 只在顶层 GET 上携带、跨站
 * POST 不带，配合下面基于 Origin 的校验已经足够挡住表单 CSRF。
 */
export function buildSetCookie(name, value, { maxAgeSeconds = 0 } = {}) {
  const lifetime = Math.floor(Number(maxAgeSeconds) || 0)
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    lifetime > 0 ? `Max-Age=${lifetime}` : 'Max-Age=0'
  ].join('; ')
}

/** 取 `Host` 头里的主机名（去端口，保留 IPv6 的方括号）。 */
export function hostnameOf(hostHeader) {
  const raw = String(hostHeader || '')
    .trim()
    .toLowerCase()
  if (!raw) return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end > 0 ? raw.slice(0, end + 1) : raw
  }
  const colon = raw.lastIndexOf(':')
  return colon > 0 ? raw.slice(0, colon) : raw
}

/**
 * `Host` 必须是本机确实拥有的名字/IP。这是挡 DNS rebinding 的那一步：攻击者把自己
 * 的域名解析到 127.0.0.1 时，浏览器发来的 `Host` 是他自己的域名，不在白名单里。
 */
export function hostAllowed(hostHeader, allowedHostnames) {
  const name = hostnameOf(hostHeader)
  if (!name) return false
  if (LOOPBACK_NAMES.has(name)) return true
  return allowedHostnames instanceof Set ? allowedHostnames.has(name) : false
}

/**
 * 带 `Origin` 的请求必须是同站。没有 `Origin` 的不是浏览器发起的跨站请求
 * （curl、脚本、SSE 重连），放行——它们仍然要过令牌这一关。
 * `Origin: null`（沙箱 iframe / file://）解析失败，按拒绝处理。
 *
 * 判定分两级：`Origin` 的 host 与 `Host` 完全相同（生产形态，页面由运行时自己托管），
 * 或者 `Origin` 的 host 名是本机/局域网地址（`allowedHostnames` 里的那些）。
 * 后者是给 `npm run dev` 用的：页面由 Vite 起在 `localhost:5173`、`/api` 反代到运行时，
 * 两边端口不同但都属于同一台机器，按 host:port 严格比对会把开发模式整个拒掉。
 * 浏览器不允许页面伪造 `Origin`，所以真正要挡住的外部站点仍然是挡住的。
 */
export function sameSiteOriginAllowed(origin, hostHeader, allowedHostnames) {
  const value = String(origin || '').trim()
  if (!value) return true
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const host = String(hostHeader || '')
    .trim()
    .toLowerCase()
  if (url.host.toLowerCase() === host) return true
  const name = String(url.hostname || '').toLowerCase()
  if (!name) return false
  if (LOOPBACK_NAMES.has(name)) return true
  return allowedHostnames instanceof Set ? allowedHostnames.has(name) : false
}

/**
 * 分享范围的 channel 规则：不是「只读」，而是「只有这一个会话」。
 *
 * 访客能像本机一样驱动这个会话——对话、编辑重发、中断、排队、压缩、改工作目录、贴图；
 * 差别只在于拿不到**别的会话**，也拿不到宿主层面的东西（文件树、终端、git、配置里的凭据）。
 * 后者是「这台机器」，不是「这个会话」，所以一律不在白名单里：能连上端口的访客不该顺手
 * 得到宿主 shell 与 API key。
 *
 * 分三类：
 * - **会话类**：payload 带 `sessionId`，必须等于被分享的会话；
 * - **节点类**：只带 nodeId 的运行态操作（中断 / 撤回排队 / 后台任务与 subagent）。
 *   节点归属由 host 侧 `resolveNodeSession` 解析，**不接受客户端自称**——否则拿一个会话的
 *   令牌去操作另一个会话的 run 就成了；
 * - **无会话类**：本身是「列表」或「目录」类（`stats:list-sessions` 的返回由
 *   `filterSessionsForShare` 裁成一行；模型 / 角色只是目录）。
 */
export const SHARE_SESSION_CHANNELS = new Set([
  'chat:history',
  'chat:meta',
  'chat:is-running',
  'chat:start',
  'chat:edit-message',
  'chat:compact',
  'chat:update-cwd',
  // 改工作目录的连带查询：`chat:update-cwd` 既然放行，判断这个目录存不存在就没多给
  // 任何东西（只是 `fs.exists`），但不放行的话页面上「目录不存在」的提示一直是哑的。
  'chat:check-cwd',
  'stats:session-detail',
  'stats:session-title',
  'stats:rename-session'
])

/** 只带 nodeId 的运行态操作：节点归属必须由 host 侧解析出来并等于被分享的会话。 */
export const SHARE_NODE_CHANNELS = new Set([
  'chat:abort',
  'chat:recall-queued',
  'chat:dispose',
  'chat:background-task-output',
  'chat:kill-background-task',
  'chat:subagent-detail',
  'chat:kill-subagent'
])

export const SHARE_SESSIONLESS_CHANNELS = new Set([
  'stats:list-sessions',
  'chat:models',
  'chat:roles'
])

/**
 * 分享范围要**剥掉**的请求入参：这些参数会写进宿主里那份会话快照（也就是分享者的会话），
 * 而它们不属于「驱动这个会话」——访客能发消息，但不能把分享者的会话改成自己的配置。
 *
 * 三个参数都是「会话级、随会话持久化」的（`turn/start` 的 Mica 扩展，见
 * apps/cli/src/cli/runAppServer.ts）：`role` 走 applyRoleOverride，`model`/`effort` 走
 * configureForRun(override, true) —— 后者会把新的 model 写进
 * client 快照，而 turn 的 running checkpoint 随后把它落盘。也就是说访客点一下模型选择器，
 * 改的是**分享者磁盘上的那个会话**，下次分享者自己打开就变味了。
 *
 * 宿主侧对「没带这些参数」一律是原样保留（applyRoleOverride 保留原 role；
 * `if (model || effort)` 不成立时根本不调 configureForRun），所以剥掉即是「不许改」，
 * 而不是「重置成默认值」。
 */
export const SHARE_LOCKED_PARAMS = Object.freeze({
  'chat:start': ['role', 'model', 'effort'],
  'chat:edit-message': ['role', 'model', 'effort']
})

/**
 * 按范围收敛请求入参，返回可直接交给 host 的 payload。
 *
 * 与 `scopeAllowsChannel` 是同一件事的两半：那个决定「能不能调这个 channel」，
 * 这个决定「调用时允许带哪些参数」。两者都在服务端执行——渲染层把按钮藏起来只是
 * 不让用户误点，**不是**授权，照抄一份请求照样会被这里拦住。
 * `full` 范围（本机窗口）原样返回，不改任何东西。
 */
export function sanitizeScopedPayload(scope, channel, payload) {
  if (!scope || scope.kind === 'full') return payload
  const locked = SHARE_LOCKED_PARAMS[channel]
  if (!locked || !payload || typeof payload !== 'object') return payload
  let next = payload
  for (const key of locked) {
    if (!(key in next)) continue
    if (next === payload) next = { ...payload }
    delete next[key]
  }
  return next
}

export function shareAllowsChannel(channel, payload, sessionId, resolveNodeSession) {
  if (SHARE_SESSIONLESS_CHANNELS.has(channel)) return true
  const resolved = typeof resolveNodeSession === 'function' ? resolveNodeSession(payload?.id) : null
  if (SHARE_NODE_CHANNELS.has(channel))
    return typeof resolved === 'string' && resolved === sessionId
  if (!SHARE_SESSION_CHANNELS.has(channel)) return false
  if (typeof payload?.sessionId !== 'string' || payload.sessionId !== sessionId) return false
  // 这个 node 在本运行时已经有 run 时，它的会话必须就是被分享的那个：客户端自称的
  // sessionId 只决定「写哪个会话」，不能让它把一个外来的 node 当成操作对象。
  if (typeof resolved === 'string' && resolved !== sessionId) return false
  return true
}

/**
 * 分享范围下 `stats:list-sessions` 的返回要裁成一行。
 *
 * 这个 channel 不带 sessionId（它就是用来列全部会话的），所以进白名单，
 * 但整份清单里有其它会话的标题与工作目录——分享一个会话不该顺手泄露别人的。
 * 裁成一行之后页面才拿得到被分享会话的标题（只认 null，避免误改数组引用语义）。
 */
export function filterSessionsForShare(result, sessionId) {
  if (!result || !Array.isArray(result.sessions)) return result
  return { ...result, sessions: result.sessions.filter((item) => item?.id === sessionId) }
}

export function scopeAllowsChannel(scope, channel, payload, resolveNodeSession) {
  if (!scope) return false
  if (scope.kind === 'full') return true
  return shareAllowsChannel(channel, payload, scope.sessionId, resolveNodeSession)
}

/** 分享范围只能看这一个会话的事件；`full` 看全部。 */
export function scopeAllowsSessionEvent(scope, sessionId) {
  if (!scope) return false
  if (scope.kind === 'full') return true
  return typeof sessionId === 'string' && sessionId === scope.sessionId
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '')
    .trim()
    .replace(/\/+$/, '')
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return trimmed
  } catch {
    return null
  }
}

function formatHost(address) {
  return String(address).includes(':') ? `[${address}]` : String(address)
}

/**
 * 分享链接该用哪个地址。
 *
 * **不能用 `location.origin`**：本机窗口的 origin 是 `127.0.0.1`，把它发给同事，
 * 对方点开连的是他自己那台机器。分享链接必须指向对方能到达的地址，优先级：
 *
 * 1. `publicUrl`（`MICA_DESKTOP_PUBLIC_URL`）——走公网/反向代理部署时唯一正确的答案；
 * 2. `preferredOrigin`——分享者自己就是从某个局域网地址打开页面时，那一张网他最清楚，
 *    同源之外的网卡（docker0 之类）常常是别的机器连不到的；
 * 3. 网卡地址里挑一个：私有网段 IPv4 > 其它 IPv4 > IPv6（链路本地 `fe80::` 排除，
 *    那个地址跨机器不可达）。
 *
 * 没有可用地址（只有环回）时返回 null，此时页面回落成「不提供分享」。
 */
export function pickShareBaseUrl({
  publicUrl = '',
  port,
  addresses = [],
  preferredOrigin = '',
  allowedHostnames = null
} = {}) {
  const pinned = normalizeBaseUrl(publicUrl)
  if (pinned) return pinned

  const listenPort = Number(port)
  if (!listenPort) return null

  const preferred = normalizeBaseUrl(preferredOrigin)
  if (preferred) {
    const host = hostnameOf(new URL(preferred).host)
    const known = allowedHostnames instanceof Set ? allowedHostnames.has(host) : false
    if (known && !LOOPBACK_NAMES.has(host) && !isLoopbackAddress(host)) return preferred
  }

  const candidates = []
  for (const entry of addresses) {
    const address = String(entry?.address || '')
    if (!address || entry?.internal) continue
    if (isLoopbackAddress(address)) continue
    const ipv6 = address.includes(':')
    if (ipv6 && /^fe80:/i.test(address)) continue
    const rank = ipv6 ? 2 : isPrivateLanAddress(address) ? 0 : 1
    candidates.push({ address, rank })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.rank - b.rank)
  return `http://${formatHost(candidates[0].address)}:${listenPort}`
}

/* ------------------------------------------------------------------ 令牌 */

export function newAccessToken() {
  return randomBytes(32).toString('base64url')
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** 定长十六进制串的比较走 timingSafeEqual，避免比较本身成为时序侧信道。 */
export function tokenMatches(token, hash) {
  if (typeof token !== 'string' || !token || typeof hash !== 'string') return false
  const candidate = Buffer.from(tokenHash(token), 'utf8')
  const expected = Buffer.from(hash, 'utf8')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

/* -------------------------------------------------------------- 分享链接 */

function sanitizeShareLinks(value) {
  if (!Array.isArray(value)) return []
  const links = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const { id, hash, sessionId } = entry
    if (typeof id !== 'string' || typeof hash !== 'string' || typeof sessionId !== 'string')
      continue
    if (!id || !hash || !sessionId) continue
    links.push({
      id,
      hash,
      sessionId,
      createdAt: Number(entry.createdAt) || 0,
      expiresAt: Number(entry.expiresAt) || 0,
      revokedAt: Number(entry.revokedAt) || 0,
      label: typeof entry.label === 'string' ? entry.label : ''
    })
  }
  return links
}

/** 解析磁盘上的凭据文件；版本不符或没有访问令牌就当没有（重新签发）。 */
export function parseAccessState(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.version !== ACCESS_STATE_VERSION) return null
  const accessToken =
    typeof raw.accessToken === 'string' && raw.accessToken ? raw.accessToken : null
  if (!accessToken) return null
  return {
    version: ACCESS_STATE_VERSION,
    accessToken,
    shareLinks: sanitizeShareLinks(raw.shareLinks)
  }
}

export function emptyAccessState(accessToken = newAccessToken()) {
  return { version: ACCESS_STATE_VERSION, accessToken, shareLinks: [] }
}

/** 令牌只存哈希；原始令牌只回给调用方一次，由它转交给分享者。 */
export function createShareRecord({
  sessionId,
  ttlMs = SHARE_TTL_MS,
  now = Date.now(),
  label = ''
} = {}) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少会话 id')
  const token = newAccessToken()
  const lifetime = Number(ttlMs) > 0 ? Number(ttlMs) : SHARE_TTL_MS
  return {
    token,
    record: {
      id: randomBytes(8).toString('hex'),
      hash: tokenHash(token),
      sessionId,
      createdAt: now,
      expiresAt: now + lifetime,
      revokedAt: 0,
      label: String(label || '')
    }
  }
}

/** 仍然有效的分享链接（未撤销、未过期）。 */
export function activeShareLinks(links, now = Date.now()) {
  if (!Array.isArray(links)) return []
  return links.filter((link) => !link.revokedAt && link.expiresAt > now)
}

export function revokeShareRecord(links, id, now = Date.now()) {
  const link = (Array.isArray(links) ? links : []).find((item) => item.id === id && !item.revokedAt)
  if (!link) return false
  link.revokedAt = now
  return true
}

/**
 * 令牌 → 范围。访问令牌给 full；分享令牌给这个会话的只读范围；
 * 撤销、过期、乱猜一律 null。
 */
export function grantFromState(state, token, now = Date.now()) {
  if (!state || typeof token !== 'string' || !token) return null
  if (tokenMatches(token, tokenHash(state.accessToken))) return { kind: 'full', via: 'token' }
  for (const link of activeShareLinks(state.shareLinks, now)) {
    if (tokenMatches(token, link.hash))
      return { kind: 'share', sessionId: link.sessionId, via: 'share' }
  }
  return null
}

/* ------------------------------------------------------------ 图片白名单 */

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i
/**
 * 只认渲染层真会去取的路径：`~/…`、POSIX 绝对路径、带盘符的 Windows 路径
 * （`resolveImageSource` 只处理这几种，相对路径根本不走 /api/image）。
 *
 * 前面的 lookbehind 要求路径起始处是真正的边界：少了它，`assets/logo.png` 里的 `/logo.png`
 * 会被当成一条绝对路径收进白名单——渲染层根本不会去取它，收进来只是白白扩大放行范围。
 */
const IMAGE_CANDIDATE =
  /(?<![A-Za-z0-9._~/-])(?:[A-Za-z]:)?(?:~[\\/]|[\\/])[^\s"'`()[\],]*\.(?:png|jpe?g|gif|webp|bmp|avif|svg)/gi
/** 会话文件里内联的 base64（几千字符起）先抹掉：长串上跑候选正则代价是平方级的。 */
const BASE64_RUN = /[A-Za-z0-9+/=]{200,}/g
/** JSON 里的路径反斜杠是成对的（`C:\\Users\\…`），扫描前先还原成单个。 */
const ESCAPED_BACKSLASH = /\\\\/g
/** 单条会话最多记住多少张图，避免异常文件把内存撑起来。 */
const MAX_IMAGE_PATHS = 5000

/**
 * `~` 要按 `/api/env` 交给页面的同一个 home 展开：页面用那个值拼出绝对路径再回头请求
 * /api/image，两边算出的字符串必须逐字相同，否则白名单永远匹配不上。
 */
export function normalizeImagePath(value, homeDir = process.env.HOME || homedir()) {
  let path = String(value || '')
    .trim()
    .replace(/\\/g, '/')
  if (!path) return ''
  if (path === '~') path = homeDir
  else if (path.startsWith('~/')) path = `${homeDir}${path.slice(1)}`
  return path
}

/**
 * 会话正文里出现过的图片路径。
 *
 * 分享视图者本来就该看到这条会话里的图片——渲染 `[Image](路径)` 时浏览器会来取
 * `/api/image?path=`。但那个接口本身接受任意路径，等于给外面开了一个「枚举宿主机上
 * 所有图片」的口子。所以分享范围只允许**确实出现在这条会话里**的路径：不在其中就是
 * 在被拿来当文件探测器。
 */
export function scanImagePaths(text, homeDir) {
  const paths = new Set()
  const scannable = String(text || '')
    .replace(BASE64_RUN, ' ')
    .replace(ESCAPED_BACKSLASH, '\\')
  for (const match of scannable.match(IMAGE_CANDIDATE) || []) {
    const normalized = normalizeImagePath(match, homeDir)
    if (!normalized || !IMAGE_EXTENSIONS.test(normalized)) continue
    paths.add(normalized)
    if (paths.size >= MAX_IMAGE_PATHS) break
  }
  return paths
}

/** sessionId -> 会话文件，只接受纯 id（防目录穿越）。 */
export function sessionFilePath(micaHome, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || /[/\\]/.test(sessionId)) return null
  return join(micaHome, 'sessions', `${sessionId}.json`)
}
