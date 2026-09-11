/**
 * Projects 分区在渲染层的取数规则。归属（assignments）是唯一事实来源：
 * 一个会话要么在 Pinned、要么在某个分组、要么落在 Recent，绝不重复出现。
 * 纯函数，方便单测；渲染只负责把它画出来。
 */

function knownGroupIds(projects) {
  return new Set((projects?.groups || []).map((group) => group.id))
}

export function groupById(projects) {
  return new Map((projects?.groups || []).map((group) => [group.id, group]))
}

export function childGroups(projects, parentId = null) {
  return (projects?.groups || []).filter((group) => (group.parentId || null) === (parentId || null))
}

/** 分组自身 + 全部后代分组 id。 */
export function groupSubtreeIds(projects, groupId) {
  const ids = new Set()
  if (!groupId) return ids
  const childrenOf = new Map()
  let known = false
  for (const group of projects?.groups || []) {
    if (group.id === groupId) known = true
    const key = group.parentId || null
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key).push(group.id)
  }
  if (!known) return ids
  const walk = (id) => {
    if (ids.has(id)) return
    ids.add(id)
    for (const child of childrenOf.get(id) || []) walk(child)
  }
  walk(groupId)
  return ids
}

/** 会话落在哪个分区：Pinned 优先，其次分组，最后 Recent。 */
export function sessionSectionOf(sessionId, { pins, projects } = {}) {
  if (pins?.[sessionId]) return { section: 'pinned', groupId: null }
  const groupId = projects?.assignments?.[sessionId]
  if (groupId && knownGroupIds(projects).has(groupId)) return { section: 'project', groupId }
  return { section: 'recent', groupId: null }
}

/** groupId -> 直接归属该分组的会话 id（不含后代分组）。 */
export function sessionsByGroup(projects) {
  const known = knownGroupIds(projects)
  const map = new Map()
  for (const [sessionId, groupId] of Object.entries(projects?.assignments || {})) {
    if (!known.has(groupId)) continue
    if (!map.has(groupId)) map.set(groupId, [])
    map.get(groupId).push(sessionId)
  }
  return map
}

/**
 * 在某个分组里新建会话时用的默认工作目录：先看该分组子树里最近一条带 cwd 的会话，
 * 没有再往上找父分组，最后交给调用方兜底。
 */
export function resolveGroupCwd(projects, sessions, groupId) {
  if (!groupId) return null
  const groups = groupById(projects)
  const sessionById = new Map((sessions || []).map((session) => [session.id, session]))
  const assignments = projects?.assignments || {}

  const cwdInScope = (ids) => {
    let best = null
    let bestAt = -1
    for (const [sessionId, assigned] of Object.entries(assignments)) {
      if (!ids.has(assigned)) continue
      const session = sessionById.get(sessionId)
      const cwd = typeof session?.cwd === 'string' ? session.cwd.trim() : ''
      if (!cwd) continue
      const at = Number(session.updatedAtMs) || 0
      if (at > bestAt) {
        bestAt = at
        best = cwd
      }
    }
    return best
  }

  let current = groups.get(groupId)
  while (current) {
    const cwd = cwdInScope(groupSubtreeIds(projects, current.id))
    if (cwd) return cwd
    current = current.parentId ? groups.get(current.parentId) : null
  }
  return null
}
