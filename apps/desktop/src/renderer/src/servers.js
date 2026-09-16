/**
 * 「切换 Mica 服务器」在页面侧的显示逻辑（纯函数）。
 *
 * 页面永远由「当前那一台」运行时托管，所以切换服务器就是一次整页导航——和用浏览器
 * 直接打开那个地址完全等价。跨源探测与清单持久化页面自己做不了，走 `window.mica.app.servers`
 * （见 src/host/servers.js）。
 */

export const DEFAULT_SERVER_PORT = 8787

/** 默认端口上的回环地址：窗口/浏览器所在的这台机器，也就是「本机」 */
export const LOCAL_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`

/** 当前页面所在的服务器（页面就是它托管的，所以 origin 即地址） */
export function currentServerUrl(location) {
  return String(location?.origin || '')
}

export function parseServerUrl(url) {
  try {
    return new URL(String(url))
  } catch {
    return null
  }
}

export function isLoopbackServer(url) {
  const parsed = parseServerUrl(url)
  if (!parsed) return false
  return (
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1'
  )
}

export function isSameServer(a, b) {
  const left = parseServerUrl(a)
  const right = parseServerUrl(b)
  if (!left || !right) return false
  return left.host === right.host
}

/** 列表里显示的名字：回环地址一律叫「本机」，其余用 host:port */
export function serverLabel(url) {
  const parsed = parseServerUrl(url)
  if (!parsed) return String(url || '')
  if (isLoopbackServer(url)) return '本机'
  return parsed.host || parsed.hostname
}
