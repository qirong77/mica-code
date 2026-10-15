/**
 * 顶栏浏览器图标要用的纯逻辑：哪些窗口属于当前会话、图标标题/状态文案怎么拼。
 *
 * 窗口由 Electron 主进程持有、经运行时的 `browser-control:list` 与 `browser:changed`
 * 送过来（形状见 apps/desktop/src/host/browser-control-core.js 的归一化函数）。
 */

/** owner 短标签：会话 id 也可能是页签 id，取尾部 6 位够区分又不至于把整栏撑开 */
export function shortOwner(owner) {
  const value = String(owner || '')
  if (!value) return ''
  return value.length > 6 ? value.slice(-6) : value
}

/**
 * 归属当前页签的窗口：owner 可能是这条会话的 sessionId（agent 调的），也可能是页签 id
 * （草稿还没绑定会话时用页签名）。没有 owner 的窗口（终端里手跑 curl、设置页新建的）
 * 仍然要能看见——否则它们开着却没有任何入口，只能靠猜。
 */
export function nodeBrowsers(browsers, node) {
  const list = Array.isArray(browsers) ? browsers : []
  const ids = new Set([node?.id, node?.sessionId].filter(Boolean).map((value) => String(value)))
  return list.filter((item) => !item?.owner || ids.has(String(item.owner)))
}

/** 这个窗口是不是「当前页签自己的」：用来区分未归属窗口的图标样式 */
export function isOwnedByNode(browser, node) {
  const owner = String(browser?.owner || '')
  if (!owner) return false
  return owner === String(node?.id || '') || (node?.sessionId && owner === String(node.sessionId))
}

export function browserStatusLabel(browser) {
  if (!browser) return ''
  if (browser.loading) return '加载中'
  return browser.visible ? '已显示' : '已隐藏'
}

/** 图标 tooltip：让用户能分清是哪个窗口（标题 + 地址 + 归属 + 状态） */
export function browserIconTitle(browser, node) {
  if (!browser) return ''
  const parts = [browser.label || '受控浏览器']
  const title = String(browser.title || '').trim()
  if (title && title !== browser.label) parts.push(title)
  const url = String(browser.url || '').trim()
  if (url && url !== 'about:blank') parts.push(url)
  const tabs = Array.isArray(browser.tabs) ? browser.tabs.length : 0
  if (tabs > 1) parts.push(`${tabs} 个标签页`)
  if (!isOwnedByNode(browser, node)) parts.push('未归属（点击可管理）')
  parts.push(browserStatusLabel(browser))
  parts.push(browser.visible ? '点击隐藏' : '点击显示')
  parts.push('右键关闭')
  return parts.filter(Boolean).join(' · ')
}

/** 一个窗口在图标上只需要一个字符级的区分：按列表顺序给第 2 个及以后标序号 */
export function browserIconBadge(browsers, browser) {
  const list = Array.isArray(browsers) ? browsers : []
  if (list.length < 2) return ''
  const index = list.findIndex((item) => item?.id === browser?.id)
  return index >= 0 ? String(index + 1) : ''
}
