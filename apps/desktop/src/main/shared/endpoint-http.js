/**
 * 主进程里「本机 HTTP 服务」共用的最小工具：路径匹配、路由编译、owner 解析与本机请求校验。
 *
 * 受控浏览器与终端控制各有一套端点目录，但两者的路由语义、归属头和 Host/Origin 守卫
 * 必须完全一致（它们都挂在运行时的同一个端口上，只是前缀不同）。放在这里而不是各写
 * 一份，改一处就是改两处。
 *
 * 刻意不 import electron：这一层只做纯计算，bun test 可以直接覆盖。
 */

export const OWNER_HEADER = 'x-mica-owner'
const OWNER_MAX = 120

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 命中模板（`/terminal/sessions/:id/input`）时返回参数，不命中返回 null。 */
export function matchPath(template, pathname) {
  const expected = template.split('/')
  const actual = String(pathname || '').split('/')
  if (expected.length !== actual.length) return null
  const params = {}
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index]
    if (!segment.startsWith(':')) {
      if (segment !== actual[index]) return null
      continue
    }
    if (!actual[index]) return null
    params[segment.slice(1)] = decodeURIComponent(actual[index])
  }
  return params
}

/** 端点目录 → 路由表：目录与文档同源，不存在「文档写了但没实现」的漂移。 */
export function compileRoutes(endpoints) {
  const routes = []
  for (const endpoint of endpoints) {
    if (endpoint.method === 'SSE') {
      routes.push({ endpoint, method: 'GET', template: endpoint.path, stream: true })
      continue
    }
    routes.push({ endpoint, method: endpoint.method, template: endpoint.path, stream: false })
  }
  return routes
}

export function resolveRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue
    const params = matchPath(route.template, pathname)
    if (params) return { endpoint: route.endpoint, params, stream: route.stream }
  }
  return null
}

export function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const lowered = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false
  return undefined
}

function text(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

export function normalizeOwner(value) {
  const owner = text(value, OWNER_MAX)
  return owner || null
}

/**
 * 归属解析：请求头优先（agent 调用时最省事），其次 body，最后 query。取不到就是 null ——
 * 未归属的窗口/会话照样可用，只是不挂到某个会话的图标行上。
 */
export function resolveOwner({ headers, body, query } = {}) {
  const header = headers?.[OWNER_HEADER] ?? headers?.[OWNER_HEADER.toUpperCase()]
  const fromHeader = normalizeOwner(Array.isArray(header) ? header[0] : header)
  if (fromHeader) return fromHeader
  const fromBody = normalizeOwner(body?.owner)
  if (fromBody) return fromBody
  return normalizeOwner(query?.owner)
}

function hostnameOf(value) {
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}

function isLocalHostHeader(host) {
  const raw = String(host || '').trim()
  if (!raw) return true
  const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
  return LOCAL_HOSTNAMES.has(name.toLowerCase())
}

/**
 * 主进程服务的兜底校验（与运行时 access-core 同一套思路）：
 * - `Host` 不是本机名（挡 DNS rebinding）；
 * - 带 `Origin` 且不是本机 origin（挡「任意网页替访客静默请求 127.0.0.1」）。
 *
 * 服务本身刻意不发 CORS 头，非 GET 要求 JSON 体，浏览器页面因此发不出可用请求。
 */
export function verifyLocalRequest(req) {
  if (!isLocalHostHeader(req.headers?.host)) {
    return { ok: false, status: 403, error: '只接受本机请求' }
  }
  const origin = req.headers?.origin
  if (origin && !LOCAL_HOSTNAMES.has(hostnameOf(origin).toLowerCase())) {
    return { ok: false, status: 403, error: '拒绝来自网页的跨站请求' }
  }
  return { ok: true }
}
