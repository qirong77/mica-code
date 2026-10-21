import { request as httpRequest } from 'node:http'
import { BROWSER_CONTROL_PREFIX } from './browser-control-core.js'

/**
 * 把运行时的 `/remote/control/*` 转发给主进程的浏览器服务（Unix socket）。
 *
 * 为什么要有这一层：受控浏览器的窗口只能由 Electron 主进程创建，而 agent 只会发 HTTP。
 * 让主进程自己监一个 TCP 端口是最直接的，但那要多开一个端口、多一套要单独维护的
 * Host/Origin 入口；走 socket 转发则让整个能力挂在**运行时已有的端口**上，agent 拿到的
 * 就是一个普通地址（`MICA_BROWSER_URL` = 运行时地址 + 这个前缀），安全边界也只有一处。
 *
 * 转发是流式的：SSE（`/remote/control/browser/events`）与截图这类响应都不缓冲，
 * 否则页面顶栏的窗口状态要等到整条流结束才会更新。
 */

/** 逐跳头不能透传：它们的语义只对「这一段连接」有效，转发后就不成立了。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/** 这个路径是不是要转给浏览器服务（前缀本身与它下面的一切）。 */
export function isBrowserControlPath(pathname, prefix = BROWSER_CONTROL_PREFIX) {
  const value = String(pathname || '')
  return value === prefix || value.startsWith(`${prefix}/`)
}

/**
 * 去掉代理前缀后的目标路径（含 query）；不是代理请求则返回 null。
 *
 * `stripPrefix` 默认等于匹配前缀；终端控制会传 `/remote`，因为它的服务路由是
 * `/terminal/*`（`/remote/terminal/sessions` → `/terminal/sessions`）。
 */
export function browserControlTargetPath(
  pathname,
  search = '',
  prefix = BROWSER_CONTROL_PREFIX,
  stripPrefix = prefix
) {
  if (!isBrowserControlPath(pathname, prefix)) return null
  const rest = String(pathname).slice(stripPrefix.length)
  return `${rest || '/'}${search || ''}`
}

/**
 * 构造转给主进程服务的请求头。`Host` 一律写成 `127.0.0.1`：服务那侧只接受本机请求，
 * 而运行时的 `Host` 可能是一个局域网地址（局域网客户端也会走这条代理）。
 *
 * `Origin` 直接丢掉：运行时入口已经按 access 规则校验过来源，代理之后这条请求就是
 * 「本机运行时替客户端发给主进程」；把局域网页面的 Origin 透传下去，会让主进程把它
 * 误判成跨站请求（终端窗口页面正是从运行时地址发起的同源请求）。
 */
export function proxyRequestHeaders(headers = {}) {
  const next = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key).toLowerCase()
    if (HOP_BY_HOP.has(name) || name === 'host' || name === 'origin') continue
    next[key] = value
  }
  next.host = '127.0.0.1'
  return next
}

/** 构造回给客户端的响应头（同样剔除逐跳头）。 */
export function proxyResponseHeaders(headers = {}) {
  const next = {}
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(String(key).toLowerCase())) continue
    if (value === undefined) continue
    next[key] = value
  }
  return next
}

/**
 * 造一个代理处理函数。没有 socket 路径（纯 `npm run start:web`）时返回 null，调用方据此
 * 直接把这条路径当普通请求处理掉。
 */
export function describeSocketError(error, label, socketPath) {
  const code = error?.code || ''
  if (code === 'ENOENT') {
    // 分两种：从来没这个服务（纯 Web 宿主），或应用之前退出/被打断后 socket 已 unlink。
    return `${label}未就绪：${socketPath} 不存在。只有 Mica Code 应用会提供这个服务；如果应用正在运行，重启它可恢复。`
  }
  if (code === 'ECONNREFUSED') {
    return `${label}未响应：${socketPath} 存在但没人监听。重启 Mica Code 应用可恢复。`
  }
  return `${label}不可用：${error?.message || error}`
}

export function createBrowserControlProxy({
  socketPath,
  prefix = BROWSER_CONTROL_PREFIX,
  stripPrefix = prefix,
  label = '受控浏览器服务'
} = {}) {
  if (!socketPath) return null

  return function proxyBrowserControl(req, res, url) {
    const target = browserControlTargetPath(url?.pathname, url?.search, prefix, stripPrefix)
    if (target === null) return false

    const upstream = httpRequest(
      {
        socketPath,
        path: target,
        method: req.method,
        headers: proxyRequestHeaders(req.headers)
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, proxyResponseHeaders(upstreamRes.headers))
        upstreamRes.pipe(res)
      }
    )

    upstream.on('error', (error) => {
      // 浏览器宿主没起来（或应用已退出）：回一个能读懂的 503，不发 5xx 空响应
      if (res.headersSent) {
        res.end()
        return
      }
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: false,
          error: describeSocketError(error, label, socketPath)
        })
      )
    })

    // 下游断开（页面刷新、窗口销毁、SSE 客户端取消）时必须掐掉上游：否则 Unix socket
    // 一直开着，主进程那侧的订阅者永远收不到 close，越积越多
    res.on('close', () => {
      if (!upstream.destroyed) upstream.destroy()
    })

    // 请求体原样流过去；GET/HEAD 没有体，直接结束
    if (req.method === 'GET' || req.method === 'HEAD') upstream.end()
    else req.pipe(upstream)

    return true
  }
}
