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

import { SHARE_BASE_PATH, isSharePath, normalizePathname } from '@packages/mica-web-shared'

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
  const value = stripMappedPrefix(address)
  if (value === '::1') return true
  const parts = value.split('.')
  if (parts.length !== 4) return false
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return false
  return Number(parts[0]) === 127
}

/**
 * 双栈 socket 上 Node 把 IPv4 报成 `::ffff:172.22.240.9`，判网段与比对地址前都要先剥掉。
 */
function stripMappedPrefix(address) {
  const value = String(address || '')
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

/**
 * 客户端地址是否在显式信任清单里（`MICA_DESKTOP_TRUSTED_CLIENTS`）。
 *
 * 信任清单是「这台机器允许谁当 owner」的唯一旋钮：分享链接是给对方的（只能看 `/share`），
 * 而 `connections` 这类用途要的是**完整的这台机器**（对方的主页面、侧栏、终端）。默认空，
 * 也就是谁都不给；需要时由本机使用者自己写下那台机器的地址。支持末段通配
 * （`172.22.240.*`），因为同一张网里 DHCP 换地址是常事。
 */
export function isTrustedClientAddress(address, trustedClients) {
  const value = stripMappedPrefix(address)
  if (!value) return false
  if (!(trustedClients instanceof Set) || trustedClients.size === 0) return false
  if (trustedClients.has(value)) return true
  const dot = value.lastIndexOf('.')
  if (dot < 0) return false
  return trustedClients.has(`${value.slice(0, dot + 1)}*`)
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

/**
 * 产物里的静态资源类型：分享页自己也要 JS / CSS / 字体 / 图片才画得出来，这些对远程
 * 必须可读。`.html` 刻意不在表里——文档入口就是「页面」，远程只能拿分享那一个。
 */
const REMOTE_ASSET_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.map',
  '.json',
  '.webmanifest',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.wasm',
  '.txt'
])

/**
 * 判定用的规范化路径：先解一次百分号编码，再把 `..` / 多余斜杠折掉。
 *
 * 只靠原始 `req.url` 判前缀会被 `/share/../terminal.html` 这种路径绕过去（前缀确实是
 * `/share`），所以这里按「真正会被打开的那个路径」判。
 */
export function canonicalPathname(pathname) {
  const text = String(pathname ?? '')
  // 调用方偶尔会连 query 一起传进来（`/share?session=x`）：路径判定不看查询串
  const cut = text.search(/[?#]/)
  const raw = cut < 0 ? text : text.slice(0, cut)
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // 编码坏掉的路径按原样判：下面命不中白名单，等于拒绝
  }
  // 手写折叠而不是过 `new URL(decoded, base)`：`//host/x` 会被 URL 当成协议相对地址，
  // pathname 变成 `/x`，前缀判定就被骗过去了。
  const segments = []
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return normalizePathname(`/${segments.join('/')}`)
}

/**
 * 非本机请求能碰到的东西：只有分享视图。
 *
 * 运行时把整台机器挂在同一个端口上（终端是一个真 shell、files 是任意读写、配置页里有
 * API key、stats 是全部会话），而分享出去的链接只是 `/share?session=<id>`。拿到这个端口
 * 不等于该拿到主页面，所以远程请求只放行三类路径：
 *
 * 1. 分享视图（`/share` 及其下资源）；
 * 2. `/api/*`——分享页和主应用共用同一份接口，收窄它等于把分享链接废掉（分享的语义就是
 *    「把这条会话连同它背后的 agent 借给对方」，见 apps/desktop/README.md 的访问一节）；
 * 3. 产物里的静态资源（白名单扩展名）。
 *
 * 其余一律当不存在：主页面（`/`、`/mica-web`）、`/files`、`/terminal-control`、
 * `/remote/*`（受控浏览器与终端）、`/mcp/*`、`/terminal.html`、`/files.html`。
 *
 * 白名单而不是黑名单是刻意的：以后新增一个页面入口不会自动对远程开放。漏掉某种资源
 * 扩展名的表现是分享页缺个文件（一眼可见），而不是把新界面悄悄暴露出去。
 */
export function remoteRequestAllowed(pathname) {
  const value = canonicalPathname(pathname)
  if (isSharePath(value)) return true
  // 只认 `/api/`：`/api` 本身没有处理器，会落到「SPA 回退成 index.html」上
  if (value.startsWith('/api/')) return true
  return isAssetPath(value)
}

/** 产物里的静态资源（白名单扩展名）。分享页与登录页都要靠它才画得出来。 */
export function isAssetPath(pathname) {
  const value = canonicalPathname(pathname)
  const last = value.slice(value.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot > 0 && REMOTE_ASSET_EXTENSIONS.has(last.slice(dot).toLowerCase())
}
