export function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

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
 * A terminal node is only an in-process tab. PTYs do not survive an app quit,
 * so restoring old terminal/session bindings makes historical sessions look
 * open and may resume one before the user clicks anything.
 *
 * Start each app process with one fresh draft while preserving the last cwd.
 */
export function createColdStartTerminal(nodes, activeId, now = Date.now()) {
  const previous =
    nodes.find((node) => node.id === activeId && node.type === 'terminal') ||
    nodes.find((node) => node.type === 'terminal')
  const cwd = previous?.cwd || resolveDefaultCwd(nodes, previous?.parent)

  return {
    id: uid('term'),
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
