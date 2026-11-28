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
 * 顶栏只有一枚常驻的浏览器按钮，窗口数量写在它的右下角：**有一扇就写 1**。
 * 之前一扇时不写、两扇起才出现，用户看不出「这枚图标现在归谁」——数量是这枚按钮
 * 唯一的「当前会话有窗口」证据，不能等第二个窗口才出现。
 */
export function browserCountBadge(browsers) {
  const count = (Array.isArray(browsers) ? browsers : []).filter((item) => item?.id).length
  return count ? String(count) : ''
}

/**
 * 常驻按钮的 tooltip。按钮点一下只展开窗口列表（不再直接新建 / 显示某一扇），
 * 所以两行说的是「点开会看到什么」：没有窗口时列表里只有新建，有窗口时一行一扇。
 */
export function browserButtonTitle(browsers) {
  const list = (Array.isArray(browsers) ? browsers : []).filter((item) => item?.id)
  const visible = list.filter((item) => item.visible).length
  if (!list.length) return '浏览器\n点击展开窗口列表（当前会话还没有窗口，列表里可以新建）'
  const head = `浏览器 · ${list.length} 个窗口${visible ? `（${visible} 个已显示）` : ''}`
  return `${head}\n点击展开窗口列表：点哪一行就显示 / 收起哪一扇，行上右键关闭`
}

/** 窗口没有 agent 给的名字时的默认名（`normalizeLabel` 的兜底值） */
export const DEFAULT_BROWSER_LABEL = '受控浏览器'

/**
 * 下拉里的一行（组件库菜单项的单行形态）：名字 + 右侧去掉协议的地址。
 *
 * 名字优先用 agent 给的那个；没有就退回当前页面标题——**默认名不算名字**：用户点出来的
 * 每一扇窗口都叫「受控浏览器」，拿它当名字，几扇窗口在列表里就长得一模一样，地址才是
 * 唯一能分辨的线索。显示 / 隐藏由行的选中态表达，状态文字留在 tooltip 里。
 */
export function browserMenuRow(browser) {
  const label = String(browser?.label || '').trim()
  const title = String(browser?.title || '').trim()
  const url = String(browser?.url || '').trim()
  const named = label && label !== DEFAULT_BROWSER_LABEL
  return {
    id: String(browser?.id || ''),
    name: (named ? label : title || label) || DEFAULT_BROWSER_LABEL,
    detail: url && url !== 'about:blank' ? compactUrl(url) : '',
    tooltip: browserIconTitle(browser),
    visible: Boolean(browser?.visible),
    loading: Boolean(browser?.loading),
    lastUsedAt: Number(browser?.lastUsedAt) || 0
  }
}

/**
 * 下拉的整份行模型：没有 id 的条目直接丢掉（界面上点不中它）。服务端的窗口创建顺序
 * 必须保留；切换窗口只改变状态，不能把最近操作的窗口挪到第一行。
 */
export function browserMenuRows(browsers) {
  return (Array.isArray(browsers) ? browsers : []).filter((item) => item?.id).map(browserMenuRow)
}
