/**
 * 派生会话（子会话 / fork）在侧栏里的渲染顺序。
 *
 * 会话文件里只有一个 `parentSessionId`，没有任何排序信息：父子关系是「谁派生的谁」，
 * 不是用户拖出来的结构。所以这里只做一次重排——父行后面紧跟它的子树，子树内部沿用
 * 输入列表自己的顺序（Recent 按时间、分组按手动顺序）。
 *
 * 三种降级都必须能正常渲染，否则一条坏数据就会让整个侧栏空掉：
 * - 父会话不在这次列表里（例如被删除）→ 当顶层；
 * - 父指向自己 → 当顶层；
 * - 成环（A 的父是 B，B 的父是 A）→ 选环中最先出现的会话为根，保留其余行。
 */

/** 最大嵌套深度：再深的派生链按同一层渲染，避免一串缩进把标题挤没。 */
const MAX_DEPTH = 3

/** Resolve each visible parent chain to one stable root, including malformed cycles. */
export function sessionRoots(items) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const index = new Map(items.map((item, i) => [item.id, i]))
  const roots = new Map()
  for (const item of items) {
    if (roots.has(item.id)) continue
    const path = []
    const positions = new Map()
    let current = item
    let root
    while (current) {
      if (roots.has(current.id)) {
        root = roots.get(current.id)
        break
      }
      if (positions.has(current.id)) {
        const cycle = path.slice(positions.get(current.id))
        root = cycle.reduce((first, id) => index.get(id) < index.get(first) ? id : first)
        break
      }
      positions.set(current.id, path.length)
      path.push(current.id)
      const parent = byId.get(current.parentSessionId)
      if (!parent) {
        root = current.id
        break
      }
      current = parent
    }
    for (const id of path) roots.set(id, root)
  }
  return roots
}

/** Select whole trees by root count, retaining the input order. */
export function paginateSessionTrees(items, roots, limit) {
  const rootIds = items.filter((item) => roots.get(item.id) === item.id).map((item) => item.id)
  const visible = new Set(rootIds.slice(0, limit))
  return {
    items: items.filter((item) => visible.has(roots.get(item.id))),
    overflow: items.filter((item) => !visible.has(roots.get(item.id))),
    remainingRoots: Math.max(0, rootIds.length - limit)
  }
}

/**
 * @param {Array<{id: string, parentSessionId?: string|null}>} items 已按分区规则排好序的会话
 * @param {{ collapsed?: Set<string> }} [options] `collapsed` 里的会话不渲染其子树（折叠）
 * @returns {Array<{
 *   session: object,
 *   depth: number,
 *   childCount: number,
 *   collapsed: boolean,
 *   hidden: object[]
 * }>} `hidden` 是折叠起来、没有渲染出来的后代（父行据此代显它们的状态）
 */
export function nestSessions(items, { collapsed } = {}) {
  const byId = new Map(items.map((session) => [session.id, session]))
  const childrenOf = new Map()
  const roots = sessionRoots(items)
  const top = []
  for (const session of items) {
    const parentId = session.parentSessionId
    if (parentId && roots.get(session.id) !== session.id && byId.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, [])
      childrenOf.get(parentId).push(session)
    } else {
      top.push(session)
    }
  }

  const rows = []
  const visited = new Set()

  const collectDescendants = (session, seen) => {
    const found = []
    for (const child of childrenOf.get(session.id) || []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      found.push(child, ...collectDescendants(child, seen))
    }
    return found
  }

  const walk = (session, depth) => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    const children = childrenOf.get(session.id) || []
    const isCollapsed = children.length > 0 && collapsed instanceof Set && collapsed.has(session.id)
    const hidden = isCollapsed ? collectDescendants(session, new Set([session.id])) : []
    rows.push({
      session,
      depth: Math.min(depth, MAX_DEPTH),
      childCount: children.length,
      collapsed: isCollapsed,
      hidden
    })
    if (isCollapsed) {
      // 折叠的行也算「已渲染」：最后补漏那一步不能再把它们画成顶层。
      for (const child of hidden) visited.add(child.id)
      return
    }
    for (const child of children) walk(child, depth + 1)
  }

  for (const session of top) walk(session, 0)
  // 兜底补齐尚未访问的行，避免异常数据导致漏行。
  for (const session of items) walk(session, 0)
  return rows
}
