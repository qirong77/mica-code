/**
 * 右侧主区（`ChatView`）的组件缓存策略：切走的会话**不卸载**，只隐藏。
 *
 * 为什么需要它：`ChatView` 的思考内容、回合日志与 TODO 面板都只存在于**事件流**里
 * （磁盘上的会话历史只有 role/text，不含 tool/todo/reasoning），切走时会话组件被清空、
 * 再切回来只能靠 host 的事件缓冲重放重建——而那个缓冲有 500 条上限，长 turn 里早期的
 * TODO 项与思考早被挤掉了，于是回来看到的就是「状态在跑但思考是空的、TODO 卡住」。
 * 保留组件实例就没有「重建」这一步，状态天然还在。
 *
 * 只保留最近用过的若干个：每个实例都持有订阅、计时器与整段消息列表，全留下会一直涨。
 * 超出上限的按「最久没用过」淘汰，下次切回去走正常的 restore（与刷新页面同一条路径）。
 */

/** 最多同时挂着的会话数（含当前这个）。 */
export const CHAT_CACHE_LIMIT = 5

/**
 * 把 `activeId` 记成「最近用过」并裁到上限。`previous` 视为按使用时间升序
 * （末尾最新）。返回新数组，或**原引用**（没有任何变化时，避免无谓重渲染）。
 */
export function nextChatCache(previous, activeId, limit = CHAT_CACHE_LIMIT) {
  const list = Array.isArray(previous) ? previous : []
  if (!activeId) return list
  // 已经在末尾就是「最近用过」，别为了移动它而重建数组（每次都换新引用会拖着重渲染）
  if (list[list.length - 1] === activeId) return list
  const next = [...list.filter((id) => id !== activeId), activeId]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * 丢掉已经关掉的页签（节点没了就没人再切回来）。同样在没变化时返回原引用。
 * `aliveIds` 可以是数组或 Set。
 */
export function pruneChatCache(previous, aliveIds) {
  const list = Array.isArray(previous) ? previous : []
  const alive = aliveIds instanceof Set ? aliveIds : new Set(aliveIds || [])
  const next = list.filter((id) => alive.has(id))
  return next.length === list.length ? list : next
}

/**
 * 要渲染哪些会话组件，滤掉已经关掉的节点。调用方只负责接线。
 *
 * 顺序取**工作区里的节点顺序**，而不是缓存里的「最近用过」顺序：缓存会把刚用过的会话挪到
 * 末尾，照它渲染的话每切一次会话 React 就要把 `.chat-view` 节点在父容器里挪一次位置，
 * 而节点被移动会重建它的布局盒、把滚动容器的 `scrollTop` 清成 0（实测切回来时刚恢复好的
 * 位置会在 10ms 后被清掉）。按工作区顺序渲染时切会话只改 className，DOM 不动，滚动位置
 * 自己就守住了（见 chat-scroll.js）。缓存顺序仍然只用于淘汰。
 */
export function cachedChatNodes(cache, nodes) {
  const wanted = new Set(cache || [])
  if (!wanted.size) return []
  return (nodes || []).filter((node) => wanted.has(node.id))
}
