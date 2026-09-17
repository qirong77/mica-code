/**
 * 「切换 Mica 服务器」的地址规范化与探活（纯逻辑，不依赖 electron，便于单测）。
 *
 * 页面本身可以从一台运行时的地址切到另一台，但「这个地址上是不是一台 Mica Code 运行
 * 时」页面判断不了：`fetch('http://other:8787/api/health')` 受 CORS 限制读不到结果，
 * 所以探活由运行时代劳。
 */

export const DEFAULT_SERVER_PORT = 8787
export const PROBE_TIMEOUT_MS = 2000

/**
 * 把用户输入的 `[http://]host[:port]` 规范成某个运行时的 origin，非法返回 null。
 * 端口缺省补 8787（应用默认端口）；路径/查询/锚点一律丢掉——一个服务器就是一个 origin。
 */
export function normalizeServerUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw || /\s/.test(raw)) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let url
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  // `url.port` 会把协议默认端口（http 的 80）吞成空串，所以显式端口从原文里认。
  const authority = candidate.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]
  const explicit = authority.match(/:(\d+)$/)
  const port = explicit ? explicit[1] : String(DEFAULT_SERVER_PORT)
  // IPv6 的 hostname 规范上带方括号，兜底再加一层以免拼出 [[::1]]
  const host =
    url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname
  return `${url.protocol}//${host}:${port}`
}

function probeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '连接超时'
  return '无法连接该地址'
}

/** 探活：这个地址上是不是一台 Mica Code 运行时 */
export async function probeServer(input, timeoutMs = PROBE_TIMEOUT_MS) {
  const url = normalizeServerUrl(input)
  if (!url) return { ok: false, error: '地址格式不正确' }
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false, error: `目标地址返回 HTTP ${response.status}` }
    const body = await response.json()
    if (body?.app !== 'mica-code-app') return { ok: false, error: '目标地址不是 Mica Code 运行时' }
    return { ok: true, url, port: Number.isInteger(body.port) ? body.port : null }
  } catch (error) {
    return { ok: false, error: probeError(error) }
  }
}
