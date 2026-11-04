/**
 * 「在侧栏里把这条会话露出来」需要改哪些折叠状态。
 *
 * 一条会话可能被四层折叠一起藏住：分区（Pinned / Projects / Recent）、分组（含上级
 * 分组）、父会话（派生会话的折叠）、Recent 的分页（Show more）。⌘P 打开一条会话之后
 * 左侧看不到它在哪儿，就是这四层各挡了一次。这里只算「该展开什么」，滚动与闪烁交给
 * 组件——纯函数，方便单测。
 */
import { sessionRoots } from './session-nesting'
import { sessionSectionOf } from './session-projects'

/** 分组的祖先链（含自身），由外到内。父分组不存在时截断。 */
export function groupChain(projects, groupId) {
  const byId = new Map((projects?.groups || []).map((group) => [group.id, group]))
  const chain = []
  const seen = new Set()
  let current = groupId ? byId.get(groupId) : null
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.unshift(current.id)
    current = current.parentId ? byId.get(current.parentId) : null
  }
  return chain
}

/** 一条会话的父会话祖先链，由外到内（不含它自己）。父会话缺失或成环时截断。 */
export function sessionParentChain(sessions, sessionId) {
  const byId = new Map((sessions || []).map((session) => [session.id, session]))
  const chain = []
  const seen = new Set([sessionId])
  let current = byId.get(sessionId)
  while (current?.parentSessionId) {
    const parentId = String(current.parentSessionId)
    if (seen.has(parentId)) break
    const parent = byId.get(parentId)
    if (!parent) break
    seen.add(parentId)
    chain.unshift(parentId)
    current = parent
  }
  return chain
}

/**
 * @returns `{ key, section, expandSection, expandGroups, expandParents, recentLimit }`。
 *   `key` 是这一行的定位键（`s:<会话 id>` / `d:<草稿 id>`）；`recentLimit` 为 null 表示
 *   不需要放开分页。目标不存在（既没给 sessionId 也没给 nodeId）时返回 null。
 */
export function planSessionReveal({
  sessionId = null,
  nodeId = null,
  draftGroupId = null,
  sessions = [],
  pins = {},
  projects = null,
  collapsedSections = {},
  collapsedGroups = {},
  collapsedChildren = [],
  recentCandidates = [],
  recentLimit = 0
} = {}) {
  if (!sessionId && !nodeId) return null
  const collapsedChildSet =
    collapsedChildren instanceof Set ? collapsedChildren : new Set(collapsedChildren || [])

  // 草稿不是会话文件，没有分区归属：只有「在哪个分组里」这一层，而且它总渲染在
  // Recent 顶部，不受分页影响。
  if (nodeId) {
    const section = draftGroupId ? 'project' : 'recent'
    return {
      key: `d:${nodeId}`,
      section,
      expandSection: !!collapsedSections[section],
      expandGroups: groupChain(projects, draftGroupId).filter((id) => !!collapsedGroups[id]),
      expandParents: [],
      recentLimit: null
    }
  }

  const roots = sessionRoots(sessions)
  const rootId = roots.get(sessionId) || sessionId
  const { section, groupId } = sessionSectionOf(rootId, { pins, projects })

  let nextRecentLimit = null
  if (section === 'recent') {
    // Recent 按「根会话」分页：要看目标是第几棵树，而不是第几条会话。
    const rootIds = recentCandidates
      .filter((session) => roots.get(session.id) === session.id)
      .map((session) => session.id)
    const index = rootIds.indexOf(rootId)
    if (index >= 0 && index + 1 > recentLimit) nextRecentLimit = index + 1
  }

  return {
    key: `s:${sessionId}`,
    section,
    expandSection: !!collapsedSections[section],
    expandGroups: groupChain(projects, groupId).filter((id) => !!collapsedGroups[id]),
    expandParents: sessionParentChain(sessions, sessionId).filter((id) =>
      collapsedChildSet.has(id)
    ),
    recentLimit: nextRecentLimit
  }
}
