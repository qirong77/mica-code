/**
 * 「切换 Mica 服务器」在页面侧的显示与打开逻辑。
 *
 * 页面永远由「当前那一台」运行时托管，所以「在哪台服务器上」就是 `location.origin`——
 * 切换就是打开那个地址：桌面应用里由外壳弹出新窗口（见 src/main/index.js），浏览器里
 * 开新标签页。跨源探测页面自己做不了，走 `window.mica.app.servers.probe`
 * （见 src/host/servers.js）。
 */

export const DEFAULT_SERVER_PORT = 8787

/** 默认端口上的回环地址：窗口/浏览器所在的这台机器，也就是「本机」 */
export const LOCAL_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`

/** 「连接过的服务器」存在页面本地：它只是这台机器上这个页面的回访清单 */
export const RECENT_SERVERS_KEY = 'mica-servers'
export const MAX_RECENT_SERVERS = 8

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

/** 页面是不是跑在 Electron 外壳里（外壳的 UA 带 Electron 标记，普通浏览器没有） */
export function isElectronShell(userAgent) {
  return /\bElectron\//i.test(String(userAgent || ''))
}

/** 规范成某个运行时的 origin（`[http://]host[:port]` 一律补全端口、丢掉路径） */
function serverOrigin(value) {
  const parsed = parseServerUrl(value)
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null
  return parsed.origin
}

function browserStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 读出来的清单可能是旧版本或被手改过的：非法项丢掉、同 host 去重、超上限截断 */
export function parseRecentServers(raw) {
  const source = Array.isArray(raw) ? raw : []
  const urls = []
  for (const value of source) {
    const origin = serverOrigin(value)
    if (!origin || urls.some((entry) => isSameServer(entry, origin))) continue
    urls.push(origin)
    if (urls.length >= MAX_RECENT_SERVERS) break
  }
  return urls
}

export function readRecentServers(storage = browserStorage()) {
  if (!storage) return []
  try {
    return parseRecentServers(JSON.parse(storage.getItem(RECENT_SERVERS_KEY) || '[]'))
  } catch {
    return []
  }
}

/** 连接成功后记一笔，最近用的排最前；返回新清单供调用方直接渲染 */
export function rememberServer(url, storage = browserStorage()) {
  const origin = serverOrigin(url)
  const list = readRecentServers(storage)
  if (!origin) return list
  const next = [origin, ...list.filter((entry) => !isSameServer(entry, origin))].slice(
    0,
    MAX_RECENT_SERVERS
  )
  try {
    storage?.setItem(RECENT_SERVERS_KEY, JSON.stringify(next))
  } catch {
    // 存储不可写（隐私模式/配额）时列表降级为本次会话内的内存值
  }
  return next
}

/**
 * 卡片里要列出来的服务器：当前那台单独一行（标「当前」），其余是连接过的。
 * 当前这台与「本机」快捷方式（同一个地址）不再重复出现在清单里。
 */
export function serverListRows(current, recent) {
  const showLocal = !isLoopbackServer(current)
  return parseRecentServers(recent).filter((url) => {
    if (isSameServer(url, current)) return false
    if (showLocal && isSameServer(url, LOCAL_SERVER_URL)) return false
    return true
  })
}

/**
 * 打开另一台服务器。外壳里交给主进程：`location.assign` 触发的导航会被 `will-navigate`
 * 接管，改成弹出新窗口，本窗口不动；浏览器里开新标签页，被弹窗拦截时退回本标签页。
 * 依赖可注入，便于单测。
 */
export function openServerTarget(url, { userAgent, open, assign } = {}) {
  const agent = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const navigate = assign ?? ((target) => window.location.assign(target))

  if (isElectronShell(agent)) {
    navigate(url)
    return 'window'
  }

  const spawnTab = open ?? ((target) => window.open(target, '_blank'))
  const spawned = spawnTab(url)
  if (spawned) {
    // 不用 window.open 的 `noopener` 特性串：它会让 window.open 恒返回 null，弹窗被
    // 拦截时就分辨不出来、退路也没了；直接在拿到的窗口上掐掉 opener 等价。
    try {
      spawned.opener = null
    } catch {
      // 某些浏览器不让写，忽略
    }
    return 'tab'
  }

  navigate(url)
  return 'same-tab'
}
