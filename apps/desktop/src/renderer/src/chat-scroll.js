/**
 * 会话切换时保留滚动位置。
 *
 * 需要它的不是「隐藏」本身：节点不动时，`display:none` 隐藏再显示并不会清掉滚动容器的
 * `scrollTop`（实测 4511 保持 4511）。真正会把它清掉的是**节点在父容器里被移动**——React 按
 * 「最近用过」顺序渲染时每切一次会话都要重排一次 children，节点被移动会重建布局盒、把位置
 * 清成 0（实测把节点手工挪到父容器末尾：3011 → 0）。那条由 `chat-cache.js` 的工作区渲染顺序挡掉。
 *
 * 这里补的是浏览器管不了的两件事：
 * 1. 组件被缓存淘汰（超过上限）后重建时 DOM 已经销毁，位置只能从这份模块级记录里恢复；
 * 2. 「贴底意图」：隐藏期间后台 turn 追加了消息，回来仍要贴底，而浏览器只会保留旧的像素值。
 *
 * 位置按节点记、放在模块级，与 `transcriptCache` 同一套。
 */

/** 最多记多少个会话的滚动位置（与组件缓存同量级即可）。 */
export const SCROLL_CACHE_LIMIT = 8

/**
 * 记下某个会话的滚动位置，并把最久没用过的裁掉。
 * 原地更新传入的 Map（它是模块级的，当作 store 用），返回同一个 Map 方便链式使用。
 */
export function writeScrollEntry(entries, nodeId, entry) {
  if (!entries || !nodeId) return entries
  entries.delete(nodeId)
  entries.set(nodeId, entry)
  while (entries.size > SCROLL_CACHE_LIMIT) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
  return entries
}

/** 读某个会话的滚动位置；命中即刷新到 LRU 末尾。没有记录时返回 null。 */
export function readScrollEntry(entries, nodeId) {
  if (!entries || !nodeId) return null
  const saved = entries.get(nodeId)
  if (!saved) return null
  entries.delete(nodeId)
  entries.set(nodeId, saved)
  return saved
}

/**
 * 切进一个会话时该把滚动放哪儿。
 *
 * - 没有记录（第一次打开这个会话）→ 跟随底部，与刷新页面同一条路径；
 * - 上次停在底部 → 继续跟随底部（内容在隐藏期间可能变长了）；
 * - 上次停在中间 → 恢复那个位置，并让「回到最新」按钮出现。
 */
export function resolveScrollRestore(saved) {
  if (!saved || saved.stick) return { stick: true, top: 0 }
  const top = Number.isFinite(saved.top) ? Math.max(0, saved.top) : 0
  return { stick: false, top }
}
