export const makeNode = (entry) => ({
  name: entry.name,
  path: entry.path,
  type: entry.type,
  ignored: !!entry.ignored,
  expanded: false,
  loaded: false,
  loading: false,
  error: '',
  children: []
})

export function findTreeNode(nodes, path) {
  for (const node of nodes) {
    if (node.path === path) return node
    const found = node.children?.length && findTreeNode(node.children, path)
    if (found) return found
  }
  return null
}

export function parentDirectory(path) {
  const source = String(path || '')
  const normalized = source.replaceAll('\\', '/').replace(/\/$/, '')
  const index = normalized.lastIndexOf('/')
  let directory = index >= 0 ? normalized.slice(0, index) || '/' : normalized || '/'
  if (/^[a-z]:$/i.test(directory)) directory += '/'
  return source.includes('\\') ? directory.replaceAll('/', '\\') : directory
}

/** Only replace the branch containing the changed node. */
export function updateTree(nodes, path, update) {
  let changed = false
  const next = nodes.map((node) => {
    let updated = node
    if (node.path === path) updated = update(node)
    else if (node.children?.length) {
      const children = updateTree(node.children, path, update)
      if (children !== node.children) updated = { ...node, children }
    }
    if (updated !== node) changed = true
    return updated
  })
  return changed ? next : nodes
}

/** A directory listing describes its immediate entries, not their cached UI state. */
export function mergeEntries(nodes, entries) {
  const previous = new Map(nodes.map((node) => [node.path, node]))
  const next = entries.map((entry) => {
    const node = previous.get(entry.path)
    if (!node || node.type !== entry.type) return makeNode(entry)
    const ignored = !!entry.ignored
    return node.name === entry.name && node.ignored === ignored
      ? node
      : { ...node, name: entry.name, ignored }
  })
  return next.length === nodes.length && next.every((node, index) => node === nodes[index])
    ? nodes
    : next
}

/** Apply to the latest tree so a user's expand/collapse during the read wins. */
export function mergeDirectoryListing(tree, root, directory, result) {
  if (tree.root !== root) return tree
  if (directory === root) {
    const children = mergeEntries(tree.children, result.entries)
    return {
      ...tree,
      root: result.path,
      parent: result.parentPath,
      children,
      refreshing: false,
      status: children.length ? '' : '这个文件夹是空的'
    }
  }
  const children = updateTree(tree.children, directory, (node) => {
    if (node.type !== 'directory') return node
    return {
      ...node,
      loaded: true,
      loading: false,
      error: '',
      children: mergeEntries(node.children, result.entries)
    }
  })
  return children === tree.children ? tree : { ...tree, children }
}

export function refreshDirectoryPaths(nodes, output = []) {
  for (const node of nodes) {
    if (node.type !== 'directory') continue
    if (node.expanded || node.loaded || node.loading) output.push(node.path)
    refreshDirectoryPaths(node.children, output)
  }
  return output
}

// Drop directory caches on Collapse All so reopening also reads external changes.
export function collapseNodes(nodes) {
  let changed = false
  const next = nodes.map((node) => {
    if (!node.expanded && !node.loaded && !node.loading && !node.error && !node.children.length)
      return node
    changed = true
    return { ...node, expanded: false, loaded: false, loading: false, error: '', children: [] }
  })
  return changed ? next : nodes
}

/** Directory requests supersede only reads of the same directory. */
export function createTreeRequests() {
  const pending = new Map()
  return {
    start(directory) {
      const token = {}
      pending.set(directory, token)
      return token
    },
    isCurrent(directory, token) {
      return pending.get(directory) === token
    },
    finish(directory, token) {
      if (pending.get(directory) === token) pending.delete(directory)
    },
    reset() {
      pending.clear()
    },
    collapse(root) {
      for (const directory of pending.keys()) {
        if (directory !== root) pending.delete(directory)
      }
    },
    prune(tree) {
      const directories = new Set([tree.root])
      const visit = (nodes) => {
        for (const node of nodes) {
          if (node.type !== 'directory') continue
          directories.add(node.path)
          visit(node.children)
        }
      }
      visit(tree.children)
      for (const directory of pending.keys()) {
        if (!directories.has(directory)) pending.delete(directory)
      }
    }
  }
}
