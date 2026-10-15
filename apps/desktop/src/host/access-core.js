/**
 * 运行时接入层里与副作用无关的纯逻辑。
 *
 * 这个运行时**没有账号体系**：能连上端口就等于拿到这台机器（终端是一个真 shell，
 * files 是任意读写，config-web 里有 API key）。所以这里不做「谁能看到什么」的判断，
 * 只留两件与授权无关、却必须做的事：
 *
 * 1. `Host` / `Origin` 两道校验（挡 DNS rebinding 与「任意网页替访客静默请求本机」）；
 * 2. 拼出**别人能连到**的地址——分享链接必须指向局域网/公网地址，而不是 `127.0.0.1`。
 *
 * 读写状态在 access.js，接线在 server/index.js。
 */

import { SHARE_BASE_PATH } from '@packages/mica-web-shared'

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
 * `::ffff:127.0.0.1`，必须先剥掉这个前缀。
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
 * （curl、脚本、SSE 重连），放行。`Origin: null`（沙箱 iframe / file://）解析失败，按拒绝处理。
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

/** 给一个基地址补上服务路径：原地址没有路径（`/`）时用 `pathname`，否则原样保留。 */
function withBasePath(baseUrl, pathname) {
  if (!pathname) return baseUrl
  try {
    const url = new URL(baseUrl)
    if (!url.pathname || url.pathname === '/') url.pathname = pathname
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return baseUrl
  }
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
 * 端口一律用**运行时自己的端口**（`port`），路径带上分享视图的基路径（`basePath`，
 * 默认 `/share`）——分享出去的那一份界面就是同一个端口上的 `/share`（只带一条会话、
 * 没有左侧会话列表），不是另一个监听。
 *
 * 没有可用地址（只有环回）时返回 null，此时页面回落成「不提供分享」。
 */
export function pickShareBaseUrl({
  publicUrl = '',
  port,
  basePath = SHARE_BASE_PATH,
  addresses = [],
  preferredOrigin = '',
  allowedHostnames = null
} = {}) {
  const pinned = normalizeBaseUrl(publicUrl)
  // 公网地址通常只写到域名（`https://mica.example.com`），分享视图的路径要补上，
  // 否则分享出去的链接落在完整应用上（带左侧会话列表）；已经自带路径的按原样用，
  // 反向代理挂在子路径下的部署由使用者自己写清。
  if (pinned) return withBasePath(pinned, normalizeBasePath(basePath))

  const listenPort = Number(port)
  if (!listenPort) return null
  const pathname = normalizeBasePath(basePath)

  const preferred = normalizeBaseUrl(preferredOrigin)
  if (preferred) {
    const url = new URL(preferred)
    const host = hostnameOf(url.host)
    const known = allowedHostnames instanceof Set ? allowedHostnames.has(host) : false
    // 端口换成运行时自己的端口、路径换成分享基路径：preferredOrigin 只用来认「分享者
    // 走的是哪张网」，它自己的端口/路径（dev 下甚至是 Vite 的 5173）不能原样带过去。
    if (known && !LOOPBACK_NAMES.has(host) && !isLoopbackAddress(host))
      return `${url.protocol}//${url.hostname}:${listenPort}${pathname}`
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
  return `http://${formatHost(candidates[0].address)}:${listenPort}${pathname}`
}

/** 分享视图的基路径：去尾斜杠、补前导斜杠，空值回落成共享常量里的 `/share`。 */
function normalizeBasePath(value) {
  const text = String(value ?? '').trim()
  if (!text || text === '/') return ''
  const withLeading = text.startsWith('/') ? text : `/${text}`
  return withLeading.replace(/\/+$/, '')
}
