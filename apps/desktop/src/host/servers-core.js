import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * 「切换 Mica 服务器」的清单与探活（纯逻辑，不依赖 electron，便于单测）。
 *
 * 页面本身可以从一台运行时的地址切到另一台（就是一次整页导航，和用浏览器直接打开
 * 那个地址完全等价），但有两件事页面自己做不了，所以由运行时代劳：
 * - 跨源探测：`fetch('http://other:8787/api/health')` 受 CORS 限制读不到结果；
 * - 跨源持久化：清单落在运行时所在机器的 userData 里，切过去之后仍然读得到。
 */

const STORE_FILE = 'mica-servers.json'
const STORE_VERSION = 1
const MAX_SERVERS = 12
export const MAX_SERVER_NOTE = 40

export const DEFAULT_SERVER_PORT = 8787
export const PROBE_TIMEOUT_MS = 2000

export function serverStorePath(userDataDir) {
  return join(userDataDir, STORE_FILE)
}

/** 备注是用户给连接过的机器起的名字：单行、去首尾空白、超长截断 */
export function normalizeServerNote(input) {
  if (typeof input !== 'string') return ''
  return input.replace(/\s+/g, ' ').trim().slice(0, MAX_SERVER_NOTE)
}

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

/** 落盘前收敛：丢弃非法/重复项，超出上限的截掉 */
export function sanitizeServerStore(data) {
  const servers = []
  const list = Array.isArray(data?.servers) ? data.servers : []
  for (const item of list) {
    const url = normalizeServerUrl(item?.url)
    if (!url || servers.some((entry) => entry.url === url)) continue
    servers.push({
      url,
      note: normalizeServerNote(item?.note),
      lastUsedAt: typeof item?.lastUsedAt === 'string' ? item.lastUsedAt : new Date(0).toISOString()
    })
    if (servers.length >= MAX_SERVERS) break
  }
  return { version: STORE_VERSION, servers }
}

/** 最近用过的排最前，同一个地址只留一条；已存在的备注跟着保留 */
export function mergeServerUrl(servers, url, now = new Date().toISOString()) {
  const list = Array.isArray(servers) ? servers : []
  const existing = list.find((entry) => entry?.url === url)
  const rest = list.filter((entry) => entry?.url !== url)
  return [{ url, note: normalizeServerNote(existing?.note), lastUsedAt: now }, ...rest].slice(
    0,
    MAX_SERVERS
  )
}

export function removeServerUrl(servers, url) {
  return (Array.isArray(servers) ? servers : []).filter((entry) => entry?.url !== url)
}

/** 改备注：地址不在清单里就原样返回（不给没连接过的地址凭空建条目） */
export function setServerNote(servers, url, note) {
  const text = normalizeServerNote(note)
  return (Array.isArray(servers) ? servers : []).map((entry) =>
    entry?.url === url ? { ...entry, note: text } : entry
  )
}

export function readServerStore(userDataDir) {
  const file = serverStorePath(userDataDir)
  if (!existsSync(file)) return sanitizeServerStore(null)
  try {
    return sanitizeServerStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return sanitizeServerStore(null)
  }
}

export function writeServerStore(userDataDir, store) {
  const file = serverStorePath(userDataDir)
  try {
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
  } catch (error) {
    console.error('[mica-desktop] 写入服务器清单失败', error)
  }
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
