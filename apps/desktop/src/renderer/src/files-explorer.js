import { findTreeNode, parentDirectory } from './files-tree'

export const TREE_INDENT = 8
export const TREE_ROW_INSET = 20

export function orderEntries(children, directory, orderMap) {
  const order = orderMap?.[directory]
  if (!order?.length) return children
  const byName = new Map(children.map((node) => [node.name, node]))
  const known = order.map((name) => byName.get(name)).filter(Boolean)
  const seen = new Set(known.map((node) => node.name))
  return [...known, ...children.filter((node) => !seen.has(node.name))]
}

export function visibleTreeEntries(nodes, root, orderMap, depth = 0, output = []) {
  for (const node of orderEntries(nodes, root, orderMap)) {
    output.push({ node, depth })
    if (node.type === 'directory' && node.expanded)
      visibleTreeEntries(node.children, node.path, orderMap, depth + 1, output)
  }
  return output
}

export function creationDirectory(tree, selectedPath) {
  const node = findTreeNode(tree.children, selectedPath)
  return node ? (node.type === 'directory' ? node.path : parentDirectory(node.path)) : tree.root
}

export function nameSelection(name, type) {
  const extension = name.lastIndexOf('.')
  return [0, type === 'directory' || extension <= 0 ? name.length : extension]
}

export function entryNameError(value, rename = false) {
  const name = value.trim()
  if (!name) return '名称不能为空'
  if (name.includes('\0') || /[\r\n]/.test(name)) return '名称不能包含控制字符'
  if (rename && /[/\\]/.test(name)) return '重命名时不能包含路径分隔符'
  if (/^[a-z]:/i.test(name) || /^[/\\]/.test(name)) return '请输入相对路径'
  if (name.split(/[/\\]/).some((part) => !part.trim() || part === '.' || part === '..'))
    return '路径不能包含空名称、. 或 ..'
  return ''
}

export function treeNavigation(entries, path, key, root) {
  const index = entries.findIndex(({ node }) => node.path === path)
  if (!entries.length) return null
  if (key === 'Home') return { select: entries[0].node.path }
  if (key === 'End') return { select: entries.at(-1).node.path }
  if (key === 'ArrowDown')
    return { select: entries[Math.min(index + 1, entries.length - 1)].node.path }
  if (key === 'ArrowUp') return { select: entries[Math.max(0, index - 1)].node.path }
  if (index < 0) return null
  const { node } = entries[index]
  if (key === 'ArrowRight' && node.type === 'directory') {
    if (!node.expanded) return { toggle: node }
    if (entries[index + 1]?.depth > entries[index].depth)
      return { select: entries[index + 1].node.path }
  }
  if (key === 'ArrowLeft') {
    if (node.type === 'directory' && node.expanded) return { toggle: node }
    const parent = parentDirectory(node.path)
    if (parent !== root && entries.some(({ node: item }) => item.path === parent))
      return { select: parent }
  }
  return null
}
