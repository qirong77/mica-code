import { normalizeCwd } from './cwd-recents'

export function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 空工作区里那个默认草稿页签的固定 id。工作区在运行时只有一份，两个窗口在运行时还没
 * 有任何工作区时同时打开会各造一个页签——固定 id 让它们收敛到同一个节点，而不是各造一个
 * 再互相把对方的页签换掉。
 */
export const COLD_START_NODE_ID = 'term-default'

export function normalizeNodes(nodes = []) {
  const normalized = nodes.map((node) => {
    const type = node.type || (node.parent === '#' ? 'folder' : 'terminal')
    return {
      id: node.id,
      parent: node.parent || '#',
      text: node.text || '',
      type,
      cwd: node.cwd?.trim() ? node.cwd.trim() : null,
      sessionId: type === 'terminal' && node.sessionId?.trim() ? node.sessionId.trim() : null,
      command: type === 'terminal' && node.command?.trim() ? node.command.trim() : null,
      lastActiveAt:
        type === 'terminal' && Number.isFinite(node.lastActiveAt) ? node.lastActiveAt : 0,
      state: {
        opened: type === 'folder' ? node.state?.opened !== false : false,
        selected: !!node.state?.selected
      }
    }
  })
  return normalized.map((node) =>
    node.parent === 'folder-recent' ? { ...node, parent: '#' } : node
  )
}

/**
 * Open a fresh draft tab for an empty workspace (first run, or after every tab
 * was closed). The workspace itself is shared state owned by the runtime
 * (see host/ui-state.js), so a normal start restores the tabs that were open
 * instead of going through here — this only seeds the very first one, carrying
 * the last working directory over.
 */
export function createColdStartTerminal(nodes, activeId, now = Date.now()) {
  const previous =
    nodes.find((node) => node.id === activeId && node.type === 'terminal') ||
    nodes.find((node) => node.type === 'terminal')
  const cwd = previous?.cwd || resolveDefaultCwd(nodes, previous?.parent)

  return {
    id: COLD_START_NODE_ID,
    parent: '#',
    text: '新对话',
    type: 'terminal',
    cwd,
    sessionId: null,
    command: null,
    lastActiveAt: now,
    state: { opened: false, selected: true }
  }
}

/**
 * 挑一个可以复用的空草稿页签（没有就返回 null）。
 *
 * 「New Session」每点一下都新起一个页签，连点几次、或者反复关掉又重开，工作区里就会攒出
 * 一摞没绑定真实会话、也没输入过任何内容的空会话。空会话之间没有任何理由共存，所以已经
 * 有一个空的就直接切过去，不要再造一个。
 *
 * 判定条件一个都不能少：
 * - 没有未发送文本（`drafts` 是运行时的输入框草稿表）：留了半句话的草稿是用户正在写的，
 *   复用会把他从这里顶走；
 * - 工作目录一致：显式换目录开新会话（工作目录弹窗）时复用等于在错的目录里开口；
 * - 归属分组一致：分组里的「在此新建会话」不该把 Recent 里的空草稿认领过来（反之亦然）。
 *
 * 正在跑的草稿不算：绑定 sessionId 之后本来就会被第一条排除，`isRunning` 只是兜住
 * 「turn 已经在跑、会话 id 还没绑上」的那一瞬间。
 *
 * `excludedIds` 是留给调用方的保留位（桌面端用它排掉挂着定时循环的草稿）：那不是空位，
 * 是被循环占着的会话。
 */
export function pickReusableDraft(
  nodes = [],
  {
    drafts = {},
    cwd = null,
    groupId = null,
    draftGroups = {},
    isRunning = null,
    excludedIds = null
  } = {}
) {
  const targetCwd = normalizeCwd(cwd)
  const targetGroup = typeof groupId === 'string' && groupId ? groupId : null
  for (const node of nodes) {
    if (node?.type !== 'terminal' || node.sessionId) continue
    if (String(drafts?.[node.id] ?? '').trim()) continue
    if (typeof isRunning === 'function' && isRunning(node.id)) continue
    if (excludedIds?.has?.(node.id)) continue
    if ((draftGroups?.[node.id] || null) !== targetGroup) continue
    if (normalizeCwd(node.cwd) !== targetCwd) continue
    return node
  }
  return null
}

export function childMap(nodes) {
  const children = new Map([['#', []]])
  for (const node of nodes) {
    if (!children.has(node.parent)) children.set(node.parent, [])
    if (!children.has(node.id)) children.set(node.id, [])
    children.get(node.parent).push(node)
  }
  return children
}

export function flattenNodes(nodes, children = childMap(nodes)) {
  const output = []
  const visited = new Set()
  const walk = (parent) => {
    for (const node of children.get(parent) || []) {
      if (visited.has(node.id)) continue
      visited.add(node.id)
      output.push(node)
      walk(node.id)
    }
  }
  walk('#')
  for (const node of nodes) if (!visited.has(node.id)) output.push({ ...node, parent: '#' })
  return output
}

export function resolveDefaultCwd(nodes, folderId) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let id = folderId
  while (id && id !== '#') {
    const node = byId.get(id)
    if (!node) break
    if (node.type === 'folder' && node.cwd) return node.cwd
    id = node.parent
  }
  return null
}

export function terminalIdsUnder(nodes, folderId) {
  const children = childMap(nodes)
  const ids = []
  const walk = (id) => {
    for (const child of children.get(id) || []) {
      if (child.type === 'terminal') ids.push(child.id)
      else walk(child.id)
    }
  }
  walk(folderId)
  return ids
}

export function removeNode(nodes, id) {
  const children = childMap(nodes)
  const removed = new Set()
  const walk = (nodeId) => {
    removed.add(nodeId)
    for (const child of children.get(nodeId) || []) walk(child.id)
  }
  walk(id)
  return nodes.filter((node) => !removed.has(node.id))
}

export function moveNode(nodes, id, targetId, position) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const moving = byId.get(id)
  const target = byId.get(targetId)
  if (!moving || !target || id === targetId) return nodes

  for (let parent = target; parent; parent = byId.get(parent.parent)) {
    if (parent.id === id) return nodes
    if (parent.parent === '#') break
  }

  const children = childMap(nodes)
  const oldSiblings = children.get(moving.parent) || []
  const oldIndex = oldSiblings.findIndex((node) => node.id === id)
  if (oldIndex >= 0) oldSiblings.splice(oldIndex, 1)

  const newParent = position === 'inside' && target.type === 'folder' ? target.id : target.parent
  const siblings = children.get(newParent) || []
  let index = siblings.length
  if (position !== 'inside') {
    const targetIndex = siblings.findIndex((node) => node.id === target.id)
    if (targetIndex >= 0) index = targetIndex + (position === 'after' ? 1 : 0)
  }
  const moved = { ...moving, parent: newParent }
  byId.set(id, moved)
  siblings.splice(index, 0, moved)
  children.set(newParent, siblings)
  children.set(moving.parent, oldSiblings)

  if (newParent !== '#') {
    const parent = byId.get(newParent)
    if (parent?.type === 'folder' && !parent.state.opened) {
      const opened = { ...parent, state: { ...parent.state, opened: true } }
      byId.set(newParent, opened)
      for (const list of children.values()) {
        const parentIndex = list.findIndex((node) => node.id === newParent)
        if (parentIndex >= 0) list[parentIndex] = opened
      }
    }
  }
  for (const [parent, list] of children) {
    children.set(
      parent,
      list.map((node) => byId.get(node.id) || node)
    )
  }
  return flattenNodes([...byId.values()], children)
}
