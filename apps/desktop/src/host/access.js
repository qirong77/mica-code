/**
 * 运行时的访问控制：凭据、分享链接，以及「这个请求被允许看到什么」。
 *
 * 背景：这个运行时把宿主能力（终端 = 一个 shell、files = 任意读写、config-web = API key、
 * stats = 全部会话）通过 HTTP 暴露出去，而它原本**没有任何认证**——能连上端口就等于拿到
 * 宿主 shell。默认又绑在 `0.0.0.0`，于是同一局域网里的任何人都能直接接管这台机器；
 * 分享链接更只是个前端提示，把 URL 里的参数删掉就能看到全部。
 *
 * 现在收敛成两个范围（判定在 access-core.js，这里只管状态与凭据）：
 *
 * - 本机连接 → full，无需凭据（Electron 容器与本机浏览器不受影响）。
 * - 远程连接 → 必须持有凭据：
 *   - 运行时访问令牌 → full；
 *   - 分享链接令牌   → share，只读、且只读被分享的那一个会话，可设有效期、可撤销。
 *
 * 凭据通过 `#token=xxx` 首次交给页面（片段不会进服务端日志、Referer 或链接预览），
 * 页面拿它换一枚 HttpOnly cookie，之后所有请求自动携带。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, hostname as osHostname, networkInterfaces } from 'node:os'
import { app, ipcMain } from 'electron'
import {
  ACCESS_COOKIE,
  ACCESS_STATE_FILE,
  SHARE_TTL_MS,
  activeShareLinks,
  createShareRecord,
  emptyAccessState,
  grantFromState,
  hostAllowed,
  isLoopbackAddress,
  normalizeImagePath,
  parseAccessState,
  parseCookieHeader,
  pickShareBaseUrl,
  revokeShareRecord,
  scanImagePaths,
  sessionFilePath,
  sameSiteOriginAllowed
} from './access-core.js'

/** 远程访问被拒时的文案：明确告诉对方需要什么，而不是给一个 401 白屏。 */
export const CREDENTIAL_REQUIRED_MESSAGE =
  '需要访问令牌：请使用运行时启动时打印的局域网地址，或向分享者索取分享链接'

let state = null
/** 缓存的主机名白名单；网卡变化很罕见，进程内复用即可。 */
let allowedHostnamesCache = null
/** 运行时实际监听在哪，由 server 启动后告知——分享链接要拼出别人能连的地址。 */
let runtimeAddress = null

function stateFile() {
  return join(app.getPath('userData'), ACCESS_STATE_FILE)
}

function readState() {
  const file = stateFile()
  if (!existsSync(file)) return null
  try {
    return parseAccessState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

function writeState(next) {
  const file = stateFile()
  mkdirSync(dirname(file), { recursive: true })
  // 先写临时文件再 rename：崩在写盘中途不会留下一份读不出来的凭据、把用户永久锁在门外
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/**
 * 令牌**跨重启保持稳定**：手机/另一台机器上存下的局域网地址不该因为宿主重启而失效。
 * 想固定值（容器、CI）用 `MICA_DESKTOP_ACCESS_TOKEN`，此时不落盘。
 */
function ensureState() {
  if (state) return state
  const pinned = (process.env.MICA_DESKTOP_ACCESS_TOKEN || '').trim()
  if (pinned) {
    state = emptyAccessState(pinned)
    return state
  }
  const loaded = readState()
  state = loaded || emptyAccessState()
  if (!loaded) writeState(state)
  return state
}

function persist() {
  if ((process.env.MICA_DESKTOP_ACCESS_TOKEN || '').trim()) return
  writeState(ensureState())
}

/**
 * 远程访问是否必须凭据。`MICA_DESKTOP_TRUST_REMOTE=1` 退回「能连上就等于有权限」的
 * 旧行为（**不安全**，只在明确隔离的可信网络里用）。
 */
export function remoteAccessRequiresCredential() {
  return process.env.MICA_DESKTOP_TRUST_REMOTE !== '1'
}

export function getAccessToken() {
  return ensureState().accessToken
}

/** 本机确实拥有的主机名/IP，用于 `Host` 校验（挡 DNS rebinding）。 */
export function allowedHostnames() {
  if (allowedHostnamesCache) return allowedHostnamesCache
  const names = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  const hostname = osHostname()
  if (hostname) names.add(hostname.toLowerCase())
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      const address = String(entry.address || '').toLowerCase()
      if (!address) continue
      names.add(address)
      // `Host` 里的 IPv6 带方括号
      if (address.includes(':')) names.add(`[${address}]`)
    }
  }
  for (const extra of String(process.env.MICA_DESKTOP_ALLOWED_HOSTS || '').split(',')) {
    const value = extra.trim().toLowerCase()
    if (value) names.add(value)
  }
  allowedHostnamesCache = names
  return names
}

export function resetAccessForTests() {
  state = null
  allowedHostnamesCache = null
  runtimeAddress = null
}

/** server 启动（含端口回退）后调用；`host` 仅用于日志，端口才参与地址拼接。 */
export function setRuntimeAddress({ port, host } = {}) {
  runtimeAddress = { port: Number(port) || 0, host: host || '' }
}

/** 本机确实拥有的网卡地址，交给 access-core 挑选。 */
function networkAddresses() {
  const entries = []
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list || [])
      entries.push({ address: entry.address, internal: entry.internal })
  }
  return entries
}

/**
 * 分享链接的基地址：公网配置 > 分享者自己的局域网地址 > 挑一张网卡。
 * 拿不到可用地址时返回 null，页面据此不提供分享（见 access-core 的 pickShareBaseUrl）。
 */
export function shareBaseUrl({ preferredOrigin = '' } = {}) {
  return pickShareBaseUrl({
    publicUrl: process.env.MICA_DESKTOP_PUBLIC_URL || '',
    port: runtimeAddress?.port,
    addresses: networkAddresses(),
    preferredOrigin,
    allowedHostnames: allowedHostnames()
  })
}

/* --------------------------------------------------------------- 分享链接 */

export function createShareLink({ sessionId, ttlMs = SHARE_TTL_MS, label = '' } = {}) {
  const current = ensureState()
  const { token, record } = createShareRecord({ sessionId, ttlMs, label })
  // 顺手清掉已过期/已撤销的，免得凭据文件只增不减
  current.shareLinks = [...activeShareLinks(current.shareLinks), record]
  persist()
  // 原始令牌只在这里返回一次，磁盘上只留哈希
  return { id: record.id, token, sessionId: record.sessionId, expiresAt: record.expiresAt }
}

export function listShareLinks() {
  return activeShareLinks(ensureState().shareLinks).map(
    ({ id, sessionId, createdAt, expiresAt, label }) => ({
      id,
      sessionId,
      createdAt,
      expiresAt,
      label
    })
  )
}

export function revokeShareLink(id) {
  const current = ensureState()
  if (!revokeShareRecord(current.shareLinks, id)) return false
  persist()
  return true
}

/**
 * 令牌 → 范围。访问令牌给 full，分享令牌给这个会话的只读范围；
 * 撤销、过期、乱猜一律 null。
 */
export function resolveGrant(token) {
  return grantFromState(ensureState(), token)
}

/** 从请求里解出 cookie 令牌并转成范围；没有凭据返回 null。 */
export function scopeFromRequest(req) {
  const token = parseCookieHeader(req?.headers?.cookie)[ACCESS_COOKIE]
  return resolveGrant(token)
}

/* --------------------------------------------------------------- 图片授权 */

/** sessionId -> { stamp, paths }；会话文件不改就不重扫。 */
const imagePathCache = new Map()

// 每次现算：MICA_HOME 在进程内可能被测试或启动流程改写，模块加载时冻结会读错目录
function micaHomeDir() {
  return process.env.MICA_HOME || join(homedir(), '.mica')
}

/** 展开 `~` 用的 home 必须与 `/api/env` 交给页面的那个一致（页面用它拼出绝对路径）。 */
function runtimeHomeDir() {
  return process.env.HOME || homedir()
}

/**
 * 这个会话里出现过的图片路径。
 *
 * 分享视图者本来就该看到这条会话里的图片（渲染 `[Image](路径)` 时浏览器会来取
 * `/api/image?path=`），但接口本身接受任意路径，不设限就等于给外面开了一个「枚举
 * 宿主机上所有图片」的口子。所以只放行确实出现在这条会话正文里的路径。
 * 会话文件没变就不重扫（turn 运行中每取一张图都重读几 MB 是不可接受的）。
 */
function sessionImagePaths(sessionId) {
  const file = sessionFilePath(micaHomeDir(), sessionId)
  if (!file || !existsSync(file)) return new Set()
  let text = ''
  let stamp = ''
  try {
    const info = statSync(file)
    stamp = `${info.mtimeMs}:${info.size}`
    const cached = imagePathCache.get(sessionId)
    if (cached && cached.stamp === stamp) return cached.paths
    text = readFileSync(file, 'utf8')
  } catch {
    return new Set()
  }
  const paths = scanImagePaths(text, runtimeHomeDir())
  imagePathCache.set(sessionId, { stamp, paths })
  return paths
}

/**
 * 分享范围取图：请求的路径必须归一后命中这条会话里出现过的图片。
 * `homeDir` 与 `/api/env` 交给页面的那个 home 之间必须一致，否则永远匹配不上。
 */
export function shareAllowsImagePath(sessionId, requestedPath) {
  const normalized = normalizeImagePath(requestedPath, runtimeHomeDir())
  if (!normalized) return false
  return sessionImagePaths(sessionId).has(normalized)
}

export function resetImagePathCacheForTests() {
  imagePathCache.clear()
}

/**
 * 与凭据无关的两道校验。顺序不能调换：
 *
 * 1. `Host` —— 挡住把攻击者域名解析到本机的 DNS rebinding；
 * 2. `Origin` —— 挡住任意网页对 `127.0.0.1:8787` 发起的跨站请求（本机连接同样要过这一关，
 *    因为浏览器发来的本机请求 `remoteAddress` 也是 127.0.0.1）。
 *
 * 「令牌换 cookie」这一步还没有 cookie，所以它只用这两道校验。
 */
export function verifyRequestOrigin(req) {
  const host = req?.headers?.host || ''
  if (!hostAllowed(host, allowedHostnames())) {
    return { ok: false, status: 403, error: 'Host 不被允许' }
  }
  if (!sameSiteOriginAllowed(req?.headers?.origin, host, allowedHostnames())) {
    return { ok: false, status: 403, error: '跨源请求被拒绝' }
  }
  return { ok: true }
}

/** 每个 `/api/*` 请求的统一入口判定：先过上面两道，再按「本机 / 凭据」给范围。 */
export function authorizeRequest(req) {
  const origin = verifyRequestOrigin(req)
  if (!origin.ok) return origin
  if (isLoopbackAddress(req?.socket?.remoteAddress)) {
    return { ok: true, scope: { kind: 'full', via: 'loopback' } }
  }
  if (!remoteAccessRequiresCredential()) {
    return { ok: true, scope: { kind: 'full', via: 'trusted-remote' } }
  }
  const scope = scopeFromRequest(req)
  if (!scope) return { ok: false, status: 401, error: CREDENTIAL_REQUIRED_MESSAGE }
  return { ok: true, scope }
}

/* ------------------------------------------------------------------- IPC */

export function registerAccessIpc() {
  ipcMain.handle('share:create', (_event, { preferredOrigin, ...payload } = {}) => {
    const created = createShareLink(payload)
    // 只回令牌与基地址，完整 URL 由页面拼——页面才知道自己这条链接要展示成什么样。
    // baseUrl 来自网卡/公网配置而非页面 origin，否则本机窗口会发出 127.0.0.1 的链接。
    return {
      token: created.token,
      sessionId: created.sessionId,
      expiresAt: created.expiresAt,
      baseUrl: shareBaseUrl({ preferredOrigin })
    }
  })
  ipcMain.handle('share:list', (_event, payload = {}) => {
    const all = listShareLinks()
    return payload?.sessionId ? all.filter((link) => link.sessionId === payload.sessionId) : all
  })
  ipcMain.handle('share:revoke', (_event, { id } = {}) => revokeShareLink(id))
  // 页面只在「本机 / 已授权」时能走到这里，因此可以直接回访问令牌：用户需要它才能
  // 把局域网地址交给自己的手机。
  ipcMain.handle('access:info', () => ({
    token: getAccessToken(),
    remoteRequiresCredential: remoteAccessRequiresCredential(),
    // 已经能走到这里的页面一定是「本机或已授权」，所以可以放心把令牌与可达地址给它：
    // 用户正是需要它们才能把局域网地址交给自己的手机。
    shareBaseUrl: shareBaseUrl(),
    lanUrls: networkAddresses()
      .filter(
        (entry) =>
          !entry.internal && !isLoopbackAddress(entry.address) && !entry.address.includes(':')
      )
      .map((entry) => `http://${entry.address}:${runtimeAddress?.port || 0}`)
  }))
}
