/**
 * 侧栏会话的排序与拖放决策。抽成纯函数是因为 HTML5 拖拽没法在自动化里驱动：
 * 这里能覆盖「同分区重排 / 跨分区移动 / 不合法 drop」的全部分支，组件只负责调用。
 */

export function byUpdatedDesc(a, b) {
  return (b.updatedAtMs || 0) - (a.updatedAtMs || 0)
}

/** 按手动顺序排序，未收录的新会话按 fallback 追加到末尾 */
export function orderSessions(items, order, fallback) {
  const byId = new Map(items.map((session) => [session.id, session]))
  const known = order.map((id) => byId.get(id)).filter(Boolean)
  const seen = new Set(known.map((session) => session.id))
  const rest = items.filter((session) => !seen.has(session.id)).sort(fallback)
  return [...known, ...rest]
}

/** 只有同一工作目录下才允许手动重排，否则 Recent 里会串成一片 */
function sameGroup(a, b) {
  if (!a || !b) return false
  return (a.cwd || '~') === (b.cwd || '~')
}

/**
 * 一次 drop 该做什么：
 * - 跨分区（或跨分组）= 移动，目标分区由落点决定（Pinned / 某个分组 / Recent 三选一）；
 * - 同分区 = 手动重排（Recent 按时间排序，不参与）；
 * - 其余情况返回 null，表示这次 drop 不产生任何变更。
 */
export function resolveDrop({
  drag,
  section,
  targetId,
  groupId = null,
  items = [],
  order = [],
  position = null
}) {
  if (!drag) return null
  if (drag.id === targetId) return null
  const sameTarget = drag.section === section && (drag.groupId ?? null) === (groupId ?? null)
  if (!sameTarget) return { kind: 'move', target: { section, groupId } }
  if (drag.kind !== 'session' || section === 'recent') return null

  const byId = new Map(items.map((session) => [session.id, session]))
  if (!sameGroup(byId.get(drag.id), byId.get(targetId))) return null

  const ids = orderSessions(items, order, byUpdatedDesc).map((session) => session.id)
  const from = ids.indexOf(drag.id)
  if (from < 0) return null
  ids.splice(from, 1)
  const at = ids.indexOf(targetId)
  if (at < 0) return null
  ids.splice(position === 'before' ? at : at + 1, 0, drag.id)
  return { kind: 'reorder', ids }
}
