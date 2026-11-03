/**
 * 侧栏分区的取数规则。归属（assignments）是唯一事实来源：
 * 一个会话要么在 Pinned、要么在某个分组、要么落在 Recent，绝不重复出现。
 * 挂了定时循环不影响归属（只由行首的时钟图标标识），纯函数，方便单测；渲染只负责把它画出来。
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

/**
 * 会话落在哪个分区：手动归属（Pinned > 分组），否则 Recent。
 *
 * 定时循环**不参与归档**：侧栏没有「定时任务」分区，挂着循环的会话留在它原本的位置，
 * 靠行首的时钟图标与行尾进度区分，所以这里不能按 loop 再分一支。
 */
export function sessionSectionOf(sessionId, { pins, projects } = {}) {
  if (pins?.[sessionId]) return { section: 'pinned', groupId: null }
  const groupId = projects?.assignments?.[sessionId]
  if (groupId && knownGroupIds(projects).has(groupId)) return { section: 'project', groupId }
  return { section: 'recent', groupId: null }
}

/** A visible ancestor owns the section for its whole session tree. */
export function inheritedSessionSection(sessionId, roots, options) {
  return sessionSectionOf(roots.get(sessionId) || sessionId, options)
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
 * groupId -> 分组子树摘要：`{ count, latestAt, sessions, drafts }`。
 *
 * 收起的分组不再递归渲染子行，所以它得自己说清「里面有多少条、最近什么时候动过、
 * 最近两条是什么」——这三样都来自同一趟递归，各算一遍会在大分组上多走几次子树。
 * `sessions` 按最近更新排序（与分组自己的手动顺序无关：摘要是「最近发生了什么」）。
 */
export function collectGroupDigests({ projects, sessionsByGroup: sessionsOf, draftsByGroup }) {
  const digests = new Map()
  const walk = (group) => {
    const sessions = [...(sessionsOf?.get(group.id) || [])]
    const drafts = [...(draftsByGroup?.get(group.id) || [])]
    let latestAt = 0
    for (const session of sessions) latestAt = Math.max(latestAt, Number(session.updatedAtMs) || 0)
    for (const child of childGroups(projects, group.id)) {
      const nested = walk(child)
      sessions.push(...nested.sessions)
      drafts.push(...nested.drafts)
      latestAt = Math.max(latestAt, nested.latestAt)
    }
    sessions.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))
    const digest = { count: sessions.length + drafts.length, latestAt, sessions, drafts }
    digests.set(group.id, digest)
    return digest
  }
  for (const group of childGroups(projects, null)) walk(group)
  return digests
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
