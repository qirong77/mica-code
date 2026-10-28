/**
 * 远程访问口令：纯逻辑（不碰磁盘、electron、node:http），便于单测。
 *
 * 运行时的默认边界在 `access-core.remoteRequestAllowed`——非本机只拿得到分享视图。
 * 但「另一台机器用完整应用」是个正当需求（connections 连别的运行时、手机当完整客户端），
 * 所以这里给它一条通道：**口令对了就当本机**。
 *
 * 三个刻意为之的取舍：
 *
 * 1. 口令不是账号体系：只有一条口令、没有用户名、没有按会话的可见范围。过门之后依旧是
 *    「对等的完整客户端」，和回环连接完全一样。多一层角色分叉只会让边界更难解释。
 * 2. 分享视图永远免密。分享出去的链接本来就是「把这条会话借给对方」，给它加一道口令等于
 *    把已经发出去的链接全部作废；开启口令保护的是「完整界面」。
 * 3. cookie 里的令牌由 `secret` + 口令派生，不落库、不存清单：改口令即全部失效，也不存在
 *    「已签发的令牌列表」这种需要清理的状态。代价是无法单独踢掉某台设备。
 *
 * 存储与接线在 remote-access.js / server/index.js。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isSharePath } from '@packages/mica-web-shared'
import { canonicalPathname, isAssetPath } from './access-core.js'

export const REMOTE_ACCESS_VERSION = 1

/** 口令的初始值。它是**默认值**，不是「安全值」：开关打开后请当成公开信息看待。 */
export const DEFAULT_REMOTE_ACCESS_PASSWORD = '0000'

/** 过门之后用的 cookie：凭它拿到「本机」待遇。 */
export const REMOTE_ACCESS_COOKIE = 'mica_remote_access'

/**
 * 打开过分享页的凭据：分享页要用 `/api/*`，而 `/api/*` 在开启口令后需要凭据。
 * 它只对 `/api/*` 有效，打不开主界面。
 */
export const SHARE_SCOPE_COOKIE = 'mica_share_scope'

export const REMOTE_ACCESS_LOGIN_PATH = '/__access'
export const REMOTE_ACCESS_LOGIN_ENDPOINT = '/__access/login'
export const REMOTE_ACCESS_LOGOUT_ENDPOINT = '/__access/logout'

/** 口令长度上限：它只经表单和 cookie 走一遭，不参与任何密码学运算本身。 */
const MAX_PASSWORD_LENGTH = 64
/** 过门 cookie 的有效期（秒）。改口令会让已签发的令牌立即失效，不需要更短。 */
export const REMOTE_ACCESS_MAX_AGE = 7 * 24 * 60 * 60

/** 空的策略：默认不暴露完整接口，口令是默认值。 */
export function emptyRemoteAccessPolicy() {
  return {
    version: REMOTE_ACCESS_VERSION,
    enabled: false,
    password: DEFAULT_REMOTE_ACCESS_PASSWORD,
    secret: ''
  }
}

/** 口令清洗：去首尾空白、拒绝换行与超长。返回 null 表示不能用。 */
export function normalizeRemoteAccessPassword(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > MAX_PASSWORD_LENGTH) return null
  if (/[\r\n\t]/.test(text)) return null
  return text
}

/** secret 只由宿主生成；这里只判断形状，坏掉就当没有（签不出可用令牌）。 */
function normalizeSecret(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[0-9a-f]{32,128}$/i.test(text) ? text : ''
}

/**
 * 收敛一份策略。文件缺失、被手改、版本不认识，一律落回「不启用 + 默认口令」：
 * 读不出一条能用的策略时，宁可回到默认边界，也不要放开。
 */
export function normalizeRemoteAccessPolicy(raw) {
  const base = emptyRemoteAccessPolicy()
  if (!raw || typeof raw !== 'object') return base
  const password = normalizeRemoteAccessPassword(raw.password) ?? base.password
  return {
    version: REMOTE_ACCESS_VERSION,
    enabled: raw.enabled === true,
    password,
    secret: normalizeSecret(raw.secret)
  }
}

/** 补一个 secret（首次保存时用）。已有合法 secret 时原样返回。 */
export function withGeneratedSecret(policy) {
  const normalized = normalizeRemoteAccessPolicy(policy)
  if (normalized.secret) return normalized
  return { ...normalized, secret: randomBytes(24).toString('hex') }
}

/**
 * cookie 里的令牌：HMAC(secret, 作用域 + 口令)。
 *
 * 作用域把「过门」与「打开过分享页」分成两个互不通用令牌——分享页的凭据不该能打开主界面。
 * 派生而不是存清单，于是改口令 = 所有已签发令牌同时失效。
 */
export function remoteAccessToken(policy, scope = 'access') {
  const normalized = normalizeRemoteAccessPolicy(policy)
  if (!normalized.secret) return ''
  return createHmac('sha256', normalized.secret)
    .update(`mica-remote-access:${scope}:${normalized.password}`)
    .digest('hex')
}

/** 常量时间比对；长度不同直接不匹配（长度本身不是秘密）。 */
export function tokensMatch(value, expected) {
  const left = String(value ?? '')
  const right = String(expected ?? '')
  if (!left || !right || left.length !== right.length) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 口令对不对。空口令永远不对——不启用是另一件事，不能靠空串过门。 */
export function verifyRemoteAccessPassword(input, policy) {
  const normalized = normalizeRemoteAccessPolicy(policy)
  const candidate = normalizeRemoteAccessPassword(input)
  if (!candidate) return false
  // 先各自摘要再比：口令长度不进入比较过程
  const digest = (value) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(candidate), digest(normalized.password))
}

/** `Cookie` 头 → 名字到值的映射。坏掉的分段跳过，不因为一个畸形 cookie 拒掉整个请求。 */
export function parseCookies(header) {
  const cookies = new Map()
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    let value = part.slice(index + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      value = value.slice(1, -1)
    cookies.set(name, value)
  }
  return cookies
}

/** 请求带的某个作用域令牌是否有效。 */
export function hasScopeToken(cookies, policy, scope) {
  const expected = remoteAccessToken(policy, scope)
  if (!expected) return false
  const name = scope === 'share' ? SHARE_SCOPE_COOKIE : REMOTE_ACCESS_COOKIE
  return tokensMatch(cookies?.get?.(name), expected)
}

/**
 * 签发 cookie。局域网是明文 http，不能带 `Secure`（带上浏览器直接不存）；
 * `HttpOnly` + `SameSite=Lax` 足以挡住脚本读取与跨站携带。
 */
export function remoteAccessCookie(name, value, { maxAge = 0 } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (maxAge > 0) parts.push(`Max-Age=${Math.floor(maxAge)}`)
  return parts.join('; ')
}

/** 清掉一个 cookie（登出）。 */
export function clearedCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/**
 * 登录后往哪儿跳：只接受本站的相对路径。
 *
 * 挡两类东西：`//evil.example`（协议相对地址，浏览器会当成别的站点）与含 `..` 的路径。
 * 认不出来就回首页，绝不把用户送到请求方指定的外站。
 */
export function safeNextPath(value) {
  const text = String(value ?? '').trim()
  if (!text.startsWith('/') || text.startsWith('//')) return '/'
  if (text.includes('\\') || text.includes('..')) return '/'
  return text
}

/**
 * 一个远程请求该被怎么处理。
 *
 * - `allow`：放行（本机、令牌有效、分享视图与它要用的资源）；
 * - `login`：需要口令（完整界面，或开启口令后的 `/api/*`）；
 * - `not-found`：按不存在处理（没开口令时碰到了分享视图之外的东西）。
 *
 * 分享视图与静态资源始终放行：已经发出去的链接不该因为开了口令而失效。开启口令之后，
 * `/api/*` 要求令牌——裸 curl 不再能直接操作这台机器，而分享页打开时会先拿到
 * share 作用域的 cookie，所以分享出来的那一页照旧能用。
 */
export function remoteAccessDecision({
  local = false,
  policy = emptyRemoteAccessPolicy(),
  pathname,
  hasAccess = false,
  hasShare = false
} = {}) {
  if (local || hasAccess) return 'allow'
  if (typeof pathname !== 'string' || !pathname) return policy.enabled ? 'login' : 'not-found'
  const value = canonicalPathname(pathname)
  if (isSharePath(value) || isAssetPath(value)) return 'allow'
  if (value.startsWith('/api/')) {
    if (!policy.enabled) return 'allow'
    return hasShare ? 'allow' : 'login'
  }
  return policy.enabled ? 'login' : 'not-found'
}
