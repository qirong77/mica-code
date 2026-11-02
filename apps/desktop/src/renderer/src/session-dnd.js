/**
 * 侧栏会话的排序与拖放决策。抽成纯函数是因为 HTML5 拖拽没法在自动化里驱动：
 * 这里能覆盖「同分区重排 / 跨分区移动 / 不合法 drop」的全部分支，组件只负责调用。
 */

import { groupSubtreeIds } from './session-projects'

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
 * 分组换父级：落到分组行 = 挂进那个分组，落到 Projects 标题 = 回到根。
 * 自己、自己的子树、以及本来就在那个父级下的落点都返回 null（不产生变更）。
 */
function resolveGroupDrop({ drag, section, groupId, groups }) {
  if (section !== 'project') return null
  const parentId = groupId ?? null
  if (parentId === drag.id) return null
  if (parentId && groupSubtreeIds({ groups }, drag.id).has(parentId)) return null
  if ((drag.groupId ?? null) === parentId) return null
  return { kind: 'move-group', groupId: drag.id, parentId }
}

/**
 * 一次 drop 该做什么：
 * - 跨分区（或跨分组）= 移动，目标分区由落点决定（Pinned / 某个分组 / Recent 三选一）；
 * - 拖的是分组 = 换父级（嵌套），见 resolveGroupDrop；
 * - 落到会话行正中 = 成为它的子会话（`parentSessionId`）；拖的是子会话时，
 *   落到别处 = 解除父子关系，见下面的 `kind: 'unnest'`；
 * - 同分区 = 手动重排（Recent 按时间排序，不参与）；
 * - 其余情况返回 null，表示这次 drop 不产生任何变更。
 *
 * `descendantIds` 是被拖动会话自己的子树：拖进子树会把父子关系弄成环，
 * 所以那种落点一律拒绝（数据上不合法，不是界面偏好）。
 */
export function resolveDrop({
  drag,
  section,
  targetId,
  groupId = null,
  groups = [],
  items = [],
  order = [],
  position = null,
  descendantIds = null
}) {
  if (!drag) return null
  if (drag.kind === 'group') return resolveGroupDrop({ drag, section, groupId, groups })
  if (drag.id === targetId) return null
  // 落到会话行正中 = 拖进这个会话。草稿还没落盘，没有可以挂父级的会话文件。
  if (position === 'into') {
    if (drag.kind !== 'session') return null
    if ((drag.parentSessionId ?? null) === targetId) return null
    if (descendantIds instanceof Set && descendantIds.has(targetId)) return null
    return { kind: 'nest', parentId: targetId }
  }
  // 子会话在侧栏里的位置由父会话决定，所以它的每一次移动都先解除父子关系：
  // 拖到别的分区 = 移出去，留在同分区 = 只把自己提到顶层。
  const isChild = !!drag.parentSessionId
  const sameTarget = drag.section === section && (drag.groupId ?? null) === (groupId ?? null)
  if (!sameTarget) {
    const plan = { kind: 'move', target: { section, groupId } }
    return isChild ? { ...plan, clearParent: true } : plan
  }
  if (isChild) return { kind: 'unnest' }
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
