/**
 * 顶栏浏览器图标要用的纯逻辑：哪些窗口属于当前会话、图标标题/状态文案怎么拼。
 *
 * 窗口由 Electron 主进程持有、经运行时的 `browser-control:list` 与 `browser:changed`
 * 送过来（形状见 apps/desktop/src/host/browser-control-core.js 的归一化函数）。
 */
import { compactUrl } from '@packages/mica-web-shared'

/**
 * 归属当前页签的窗口：owner 是这条会话的 sessionId（agent 调的），也可能是页签 id
 * （草稿还没绑定会话时用页签名）。
 *
 * **归属是唯一依据**：没有归属的窗口不在这里出现（主进程会直接销毁它们，见
 * apps/desktop/src/main/browser/browser-service.js 的 pruneUnowned），所以留在列表里的
 * 只可能是别人的窗口——切会话时它就该消失。
 */
export function nodeBrowsers(browsers, node) {
  const list = Array.isArray(browsers) ? browsers : []
  const ids = new Set([node?.id, node?.sessionId].filter(Boolean).map((value) => String(value)))
  return list.filter((item) => item?.owner && ids.has(String(item.owner)))
}

/** 这个窗口是不是「当前页签自己的」 */
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

/** 图标 tooltip：让用户能分清是哪个窗口（标题 + 地址 + 状态） */
export function browserIconTitle(browser) {
  if (!browser) return ''
  const parts = [browser.label || '受控浏览器']
  const title = String(browser.title || '').trim()
  if (title && title !== browser.label) parts.push(title)
  const url = String(browser.url || '').trim()
  if (url && url !== 'about:blank') parts.push(url)
  const tabs = Array.isArray(browser.tabs) ? browser.tabs.length : 0
  if (tabs > 1) parts.push(`${tabs} 个标签页`)
  parts.push(browserStatusLabel(browser))
  // 窗口默认由 agent 在后台用（全程不显示），这枚图标是用户自己唤出/收起的入口
  parts.push(browser.visible ? '点击收起' : '点击唤出')
  parts.push('右键关闭')
  return parts.filter(Boolean).join(' · ')
}

/**
 * 顶栏只有一枚常驻的浏览器按钮，窗口数量写在它的右下角：一个窗口时不用写，
 * 两个以上才下标——用户要看的是「是不是不止一个」。
 */
export function browserCountBadge(browsers) {
  const count = (Array.isArray(browsers) ? browsers : []).filter((item) => item?.id).length
  return count > 1 ? String(count) : ''
}

/**
 * 常驻按钮的 tooltip。没有窗口时说清「没有」而不是让按钮无声无息；一个窗口时沿用逐窗口
 * 那份说明（点击收起 / 唤出、右键关闭）；多个时说清按钮和下拉各自做什么。
 */
export function browserButtonTitle(browsers) {
  const list = (Array.isArray(browsers) ? browsers : []).filter((item) => item?.id)
  if (!list.length) return '浏览器\n当前会话还没有打开的窗口'
  if (list.length === 1) return browserIconTitle(list[0])
  const visible = list.filter((item) => item.visible).length
  return `浏览器 · ${list.length} 个窗口${visible ? `（${visible} 个已显示）` : ''}\n悬停或点击选择窗口 · 行上右键关闭`
}

/**
 * 下拉里的一行：agent 给的名字优先，第二行是去掉协议的地址，右边是状态。
 * 名字与地址都缺时退回「受控浏览器」，行不会变成一片空白。
 */
export function browserMenuRow(browser) {
  const label = String(browser?.label || '').trim()
  const title = String(browser?.title || '').trim()
  const url = String(browser?.url || '').trim()
  return {
    id: String(browser?.id || ''),
    name: label || title || '受控浏览器',
    detail: url && url !== 'about:blank' ? compactUrl(url) : '',
    status: browserStatusLabel(browser),
    tooltip: browserIconTitle(browser),
    visible: Boolean(browser?.visible),
    loading: Boolean(browser?.loading)
  }
}

/** 下拉的整份行模型：没有 id 的条目直接丢掉（界面上点不中它） */
export function browserMenuRows(browsers) {
  return (Array.isArray(browsers) ? browsers : []).filter((item) => item?.id).map(browserMenuRow)
}
