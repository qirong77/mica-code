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

/**
 * 分组换父级：落到分组行 = 挂进那个分组，落到 Projects 标题 = 回到根。
 * 自己、自己的子树、以及本来就在那个父级下的落点都返回 null（不产生变更）。
 */
function resolveGroupDrop({ drag, section, groupId, groups, position }) {
  if (section !== 'project') return null
  const source = groups.find((group) => group.id === drag.id)
  if (!source) return null
  if (position === 'before' || position === 'after') {
    const target = groups.find((group) => group.id === groupId)
    if (!target || groupSubtreeIds({ groups }, drag.id).has(target.id)) return null
    return {
      kind: 'move-group',
      groupId: drag.id,
      parentId: target.parentId ?? null,
      placement: { targetId: target.id, position }
    }
  }
  const parentId = groupId ?? null
  if (parentId && !groups.some((group) => group.id === parentId)) return null
  if (parentId === drag.id) return null
  if (parentId && groupSubtreeIds({ groups }, drag.id).has(parentId)) return null
  if ((source.parentId ?? null) === parentId) return null
  return { kind: 'move-group', groupId: drag.id, parentId }
}

/**
 * 一次 drop 该做什么：
 * - 跨分区（或跨分组）= 移动，目标分区由落点决定（Pinned / 某个分组 / Recent 三选一）；
 * - 拖的是分组 = 换父级（嵌套），见 resolveGroupDrop；
 * - 落到会话行中间那条带子 = 成为它的子会话（`parentSessionId`）；拖的是子会话时，
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
  if (drag.kind === 'group') return resolveGroupDrop({ drag, section, groupId, groups, position })
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
  // Recent 按时间排，没有手动顺序可言；Pinned 与分组内则不看工作目录——
  // 侧栏是「我自己的清单」，跨目录的两个会话照样要能前后挪。
  if (drag.kind !== 'session' || section === 'recent') return null

  const ids = orderSessions(items, order, byUpdatedDesc).map((session) => session.id)
  const from = ids.indexOf(drag.id)
  if (from < 0) return null
  ids.splice(from, 1)
  const at = ids.indexOf(targetId)
  if (at < 0) return null
  ids.splice(position === 'before' ? at : at + 1, 0, drag.id)
  return { kind: 'reorder', ids }
}

/**
 * 拖到一行上时，光标在纵向的哪个位置、算哪种落点。
 *
 * 中间一半 = 嵌套 / 进入这一级，上下各四分之一 = 排到前面或后面。行高只有 24px，
 * 所以上下两条带子留得不宽：想把会话挂到另一条下面时，往行的中间放就行，不用按修饰键。
 *
 * `canNest` 由调用方判断（草稿没有会话文件、拖进自己的子树会成环、已经在里面了……），
 * 这里只管纵向位置这一层，分组行与会话行共用同一套规则。
 */
export function rowDropPosition({ ratio, canNest = true } = {}) {
  const value = Number.isFinite(ratio) ? ratio : 0.5
  if (canNest && value > 0.25 && value < 0.75) return 'into'
  return value < 0.5 ? 'before' : 'after'
}
