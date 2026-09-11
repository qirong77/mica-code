/**
 * 侧栏 Projects 分区的本地模型：可嵌套的分组 + 会话归属。
 *
 * 会话在侧栏只出现在一个分区（Pinned > Projects > Recent），所以归属是一份显式的
 * `assignments: { sessionId -> groupId }` 映射，而不是让每个分组自己持有会话列表——
 * 这样「拖到别处」永远是一次赋值，不会出现两个分区同时列出同一个会话。
 */
export const PROJECTS_VERSION = 1

export function emptyProjects() {
  return { version: PROJECTS_VERSION, groups: [], assignments: {} }
}

function cleanName(name) {
  const text = typeof name === 'string' ? name.trim() : ''
  return text.slice(0, 120)
}

/** 读出磁盘内容后一律过这里：非字符串 id 丢弃，悬空/成环的 parentId 收敛到根。 */
export function normalizeProjects(raw) {
  const groups = []
  const seen = new Set()
  const source = Array.isArray(raw?.groups) ? raw.groups : []
  for (const item of source) {
    if (!item || typeof item.id !== 'string') continue
    const id = item.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    groups.push({
      id,
      name: cleanName(item.name) || '未命名分组',
      parentId:
        typeof item.parentId === 'string' && item.parentId.trim() ? item.parentId.trim() : null,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0
    })
  }

  const byId = new Map(groups.map((group) => [group.id, group]))
  for (const group of groups) {
    if (group.parentId && !byId.has(group.parentId)) group.parentId = null
  }
  for (const group of groups) {
    const path = new Set([group.id])
    let current = group
    while (current?.parentId) {
      if (path.has(current.parentId)) {
        current.parentId = null
        break
      }
      path.add(current.parentId)
      current = byId.get(current.parentId)
    }
  }

  const assignments = {}
  for (const [sessionId, groupId] of Object.entries(raw?.assignments || {})) {
    if (!sessionId || typeof groupId !== 'string') continue
    if (!byId.has(groupId)) continue
    assignments[sessionId] = groupId
  }

  return { version: PROJECTS_VERSION, groups, assignments }
}

export function childGroups(projects, parentId = null) {
  return (projects?.groups || []).filter((group) => (group.parentId || null) === (parentId || null))
}

/** 分组自身 + 全部后代分组 id。 */
export function groupSubtreeIds(projects, groupId) {
  const ids = new Set()
  if (typeof groupId !== 'string' || !groupId) return ids
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

export function createGroup(projects, { id, name, parentId = null, now = Date.now() }) {
  const current = normalizeProjects(projects)
  const groupId = typeof id === 'string' && id.trim() ? id.trim() : ''
  if (!groupId) return current
  const parent = typeof parentId === 'string' && parentId.trim() ? parentId.trim() : null
  const known = new Set(current.groups.map((group) => group.id))
  current.groups.push({
    id: groupId,
    name: cleanName(name) || '新建分组',
    parentId: parent && known.has(parent) ? parent : null,
    createdAt: now
  })
  return current
}

export function renameGroup(projects, groupId, name) {
  const current = normalizeProjects(projects)
  const next = cleanName(name)
  if (!next) return current
  current.groups = current.groups.map((group) =>
    group.id === groupId ? { ...group, name: next } : group
  )
  return current
}

/** 删除分组连同其子树；落在子树里的会话回到 Recent（即清掉归属）。 */
export function deleteGroup(projects, groupId) {
  const current = normalizeProjects(projects)
  const removed = groupSubtreeIds(current, groupId)
  if (removed.size === 0) return current
  current.groups = current.groups.filter((group) => !removed.has(group.id))
  for (const [sessionId, assigned] of Object.entries(current.assignments)) {
    if (removed.has(assigned)) delete current.assignments[sessionId]
  }
  return current
}

export function setAssignment(projects, sessionId, groupId) {
  const current = normalizeProjects(projects)
  if (!sessionId) return current
  const known = new Set(current.groups.map((group) => group.id))
  if (groupId && known.has(groupId)) current.assignments[sessionId] = groupId
  else delete current.assignments[sessionId]
  return current
}

export function assignmentOf(projects, sessionId) {
  const groupId = projects?.assignments?.[sessionId]
  if (!groupId) return null
  return (projects?.groups || []).some((group) => group.id === groupId) ? groupId : null
}
