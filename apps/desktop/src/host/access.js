/**
 * 运行时的接入层：可达地址（分享链接用）与两道与授权无关的校验。
 *
 * 这个运行时把宿主能力（终端 = 一个 shell、files = 任意读写、config-web = API key、
 * stats = 全部会话）通过 HTTP 暴露出去，默认又绑在 `0.0.0.0`。**它没有账号体系**：能连上
 * 端口就等于有权限，所有客户端（本机窗口、局域网浏览器、手机）都是**对等的完整客户端**，
 * 看到同一份运行时状态、也能操作它。
 *
 * 因此这里刻意不引入令牌与访问范围：多一层凭据就多一种「这台机器能做什么、那台不能」的
 * 分叉，而分享出去的链接本来就该是「把 agent 借给对方」。留下的是两件不花钱又必须做的事：
 *
 * - `Host` / `Origin` 校验：挡住 DNS rebinding 与「任意网页替访客静默请求本机」；
 * - 分享链接的基地址：必须是对方能到达的地址，不能是 `127.0.0.1`；主机可以取自分享者
 *   正在用的那个地址，端口一律是本运行时实际绑定的端口（分享视图就是同一个端口上的
 *   `/share`，见 @packages/mica-web-shared 的 app-paths）。
 *
 * 「谁来连」的收窄不在这个文件里判：请求落在哪个路径上由 `access-core` 的
 * `remoteRequestAllowed` 回答（非本机只给分享视图），接线在 server/index.js。这里只提供
 * 那份判定的输入——显式信任清单（`MICA_DESKTOP_TRUSTED_CLIENTS`）。
 *
 * 风险与边界写在 apps/desktop/README.md（「访问」一节），改这里时一并同步。
 */

import { hostname as osHostname, networkInterfaces } from 'node:os'
import { ipcMain } from 'electron'
import {
  hostAllowed,
  isLoopbackAddress,
  pickShareBaseUrl,
  sameSiteOriginAllowed
} from './access-core.js'
import { SHARE_BASE_PATH } from '@packages/mica-web-shared'

/** 缓存的主机名白名单；网卡变化很罕见，进程内复用即可。 */
let allowedHostnamesCache = null
/** 显式信任的客户端地址（`MICA_DESKTOP_TRUSTED_CLIENTS`）：这些来源按「本机」看待。 */
let trustedClientsCache = null
/** 运行时实际监听在哪，由 server 启动（含端口回退）后告知——分享链接要拼出别人能连的地址。 */
let runtimeAddress = null

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
  allowedHostnamesCache = null
  trustedClientsCache = null
  runtimeAddress = null
}

/**
 * 显式信任的客户端地址，逗号分隔，支持末段通配（`172.22.240.*`）。
 *
 * 运行时默认只把整台机器给本机（回环）连接；跨机器用完整应用（`connections` 连别的
 * 运行时、手机当完整客户端）必须在**被连的那台**上写下对方的地址。空清单 = 谁都不给，
 * 这是默认状态，不是「没配置就放开」。
 */
export function trustedClients() {
  if (trustedClientsCache) return trustedClientsCache
  const names = new Set()
  for (const entry of String(process.env.MICA_DESKTOP_TRUSTED_CLIENTS || '').split(',')) {
    const value = entry.trim().toLowerCase()
    if (value) names.add(value)
  }
  trustedClientsCache = names
  return names
}

/** server 启动（含端口回退）后调用；`host` 仅用于日志，端口才参与地址拼接。 */
export function setRuntimeAddress({ port, host, sharing = true } = {}) {
  runtimeAddress = {
    port: Number(port) || 0,
    host: host || '',
    // 分享视图关掉（`--no-share`）时拿不到分享地址，页面回落成「不提供分享」
    sharing: sharing !== false
  }
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
  if (!runtimeAddress?.sharing) return null
  return pickShareBaseUrl({
    publicUrl: process.env.MICA_DESKTOP_PUBLIC_URL || '',
    port: runtimeAddress?.port,
    basePath: SHARE_BASE_PATH,
    addresses: networkAddresses(),
    preferredOrigin,
    allowedHostnames: allowedHostnames()
  })
}

/**
 * 每个 `/api/*` 请求都要过的两道校验，顺序不能调换：
 *
 * 1. `Host` —— 挡住把攻击者域名解析到本机的 DNS rebinding；
 * 2. `Origin` —— 挡住任意网页对 `127.0.0.1:8787` 发起的跨站请求（本机连接同样要过这一关，
 *    因为浏览器发来的本机请求 `remoteAddress` 也是 127.0.0.1）。
 *
 * 隧道 / 反向代理这类「浏览器发的是公网地址、运行时只看到回环连接」的场景用
 * `MICA_DESKTOP_ALLOWED_HOSTS`（逗号分隔的名字或 IP）放行，不是放宽这两条本身。
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

/* ------------------------------------------------------------------- IPC */

export function registerAccessIpc() {
  ipcMain.handle('access:info', (_event, payload) => {
    // renderer 传自己的 `location.origin`：分享者从哪张网打开页面，那张网他最清楚
    // （docker0 之类的网卡常常是别的机器连不到的）。端口不跟着走：一律换成运行时自己的
    // 端口，路径换成 /share。
    const preferredOrigin = typeof payload?.origin === 'string' ? payload.origin : ''
    const port = runtimeAddress?.port || 0
    const sharing = runtimeAddress?.sharing !== false
    return {
      shareBaseUrl: shareBaseUrl({ preferredOrigin }),
      sharePath: SHARE_BASE_PATH,
      shareEnabled: sharing,
      lanUrls: networkAddresses()
        .filter(
          (entry) =>
            !entry.internal && !isLoopbackAddress(entry.address) && !entry.address.includes(':')
        )
        .map((entry) => `http://${entry.address}:${port}${SHARE_BASE_PATH}`)
    }
  })
}
