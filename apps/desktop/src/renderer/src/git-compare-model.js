import { isFileReviewed } from './git-review'
export { isFileReviewed } from './git-review'

export const DEFAULT_COMPARE_PREFERENCES = Object.freeze({
  viewMode: 'tree',
  iconStyle: 'status',
  compactFolders: true,
  showStats: false,
  showCheckboxes: true,
  unreviewedOnly: false
})

export function comparePreferences(value) {
  return {
    viewMode: value?.viewMode === 'list' ? 'list' : 'tree',
    iconStyle: value?.iconStyle === 'file' ? 'file' : 'status',
    ...Object.fromEntries(
      ['compactFolders', 'showStats', 'showCheckboxes', 'unreviewedOnly'].map((key) => [
        key,
        typeof value?.[key] === 'boolean' ? value[key] : DEFAULT_COMPARE_PREFERENCES[key]
      ])
    )
  }
}

export function reviewSummary(files, reviewed = {}) {
  const count = files.reduce((total, file) => total + Number(isFileReviewed(file, reviewed)), 0)
  return {
    count,
    total: files.length,
    checked: files.length > 0 && count === files.length,
    mixed: count > 0 && count < files.length
  }
}

export function filterCompareFiles(files, query, unreviewedOnly, reviewed = {}) {
  const words = String(query || '')
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return files.filter((file) => {
    if (unreviewedOnly && isFileReviewed(file, reviewed)) return false
    const path = file.path.toLocaleLowerCase()
    return words.every((word) => path.includes(word))
  })
}

const order = (left, right) => left.localeCompare(right, 'en', { numeric: true })
const statusRank = { added: 1, deleted: 2, modified: 3 }

function aggregate(files, reviewed) {
  return {
    ...reviewSummary(files, reviewed),
    additions: files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0),
    deletions: files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0),
    uncommitted: files.some((file) => file.uncommitted),
    status: files.reduce(
      (status, file) =>
        (statusRank[file.status] || 3) > (statusRank[status] || 0) ? file.status : status,
      null
    )
  }
}

/** All rows, including collapsed descendants. IDs and parent IDs refer to rendered compact rows. */
export function buildCompareRows(
  files,
  { viewMode = 'tree', compactFolders = true, reviewed = {} } = {}
) {
  const makeFile = (file, depth, ancestors) => ({
    ...file,
    id: `file:${file.path}`,
    type: 'file',
    name: file.path.split('/').at(-1),
    directory: file.path.split('/').slice(0, -1).join('/'),
    depth,
    ancestors,
    parentId: ancestors.at(-1) || null,
    files: [file],
    ...aggregate([file], reviewed)
  })
  if (viewMode === 'list') {
    return [...files].sort((a, b) => order(a.path, b.path)).map((file) => makeFile(file, 0, []))
  }

  const root = { path: '', name: '', folders: new Map(), files: [], descendants: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    node.descendants.push(file)
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) {
        node.folders.set(part, {
          path: node.path ? `${node.path}/${part}` : part,
          name: part,
          folders: new Map(),
          files: [],
          descendants: []
        })
      }
      node = node.folders.get(part)
      node.descendants.push(file)
    }
    node.files.push(file)
  }
  const rows = []
  function visit(node, depth, ancestors) {
    for (const start of [...node.folders.values()].sort((a, b) => order(a.name, b.name))) {
      let folder = start
      const names = [folder.name]
      if (compactFolders) {
        while (!folder.files.length && folder.folders.size === 1) {
          folder = folder.folders.values().next().value
          names.push(folder.name)
        }
      }
      const id = `directory:${folder.path}`
      rows.push({
        id,
        type: 'directory',
        name: names.join('/'),
        path: folder.path,
        depth,
        ancestors,
        parentId: ancestors.at(-1) || null,
        files: folder.descendants,
        ...aggregate(folder.descendants, reviewed)
      })
      visit(folder, depth + 1, [...ancestors, id])
    }
    for (const file of [...node.files].sort((a, b) => order(a.path, b.path))) {
      rows.push(makeFile(file, depth, ancestors))
    }
  }
  visit(root, 0, [])
  return rows
}

export function visibleCompareRows(rows, collapsed = new Set()) {
  return rows.filter((row) => !row.ancestors.some((id) => collapsed.has(id)))
}

/** Keep focus near the reviewed/filtered row, or on its parent after a collapse. */
export function reconcileCompareFocus(rows, focusedId, previousRows = []) {
  const available = new Set(rows.map((row) => row.id))
  if (available.has(focusedId)) return focusedId
  const index = previousRows.findIndex((row) => row.id === focusedId)
  if (index >= 0) {
    const previous = previousRows[index]
    const parent = [...previous.ancestors].reverse().find((id) => available.has(id))
    // A still-present parent means a collapsed subtree; a filtered file may have siblings.
    const neighbor = previousRows.slice(index + 1).find((row) => available.has(row.id))
    if (parent && (!neighbor || !neighbor.ancestors.includes(parent))) return parent
    if (neighbor) return neighbor.id
    if (parent) return parent
    const preceding = previousRows
      .slice(0, index)
      .reverse()
      .find((row) => available.has(row.id))
    if (preceding) return preceding.id
  }
  return rows[0]?.id
}

export function revealComparePath(rows, path, collapsed) {
  const row = rows.find((entry) => entry.type === 'file' && entry.path === path)
  const next = new Set(collapsed)
  for (const id of row?.ancestors || []) next.delete(id)
  return next
}

/** Pure tree keyboard decisions, shared by the panel and tests. */
export function compareTreeKey(rows, focusedId, key, collapsed = new Set()) {
  const index = rows.findIndex((row) => row.id === focusedId)
  const row = rows[index]
  if (!row) return { focusId: rows[0]?.id }
  if (key === 'ArrowDown') return { focusId: rows[Math.min(rows.length - 1, index + 1)].id }
  if (key === 'ArrowUp') return { focusId: rows[Math.max(0, index - 1)].id }
  if (key === 'Home') return { focusId: rows[0].id }
  if (key === 'End') return { focusId: rows.at(-1).id }
  if (key === 'ArrowLeft') {
    if (row.type === 'directory' && !collapsed.has(row.id)) return { toggleId: row.id }
    return { focusId: row.parentId || row.id }
  }
  if (key === 'ArrowRight' && row.type === 'directory') {
    if (collapsed.has(row.id)) return { toggleId: row.id }
    return { focusId: rows[index + 1]?.parentId === row.id ? rows[index + 1].id : row.id }
  }
  if (key === 'Enter')
    return row.type === 'directory' ? { toggleId: row.id } : { activateId: row.id }
  if (key === ' ' || key === 'Spacebar') return { reviewId: row.id }
  return {}
}

/** Remote refs are ordinary comparison bases; their labels retain the remote prefix. */
export function comparePickerItems(refs, current, query = '') {
  const items = [
    {
      id: '__auto__',
      kind: 'auto',
      ref: null,
      name: '自动基线',
      hint: '自动选择默认分支',
      group: '比较方式'
    },
    {
      id: '__head__',
      kind: 'head',
      ref: 'HEAD',
      name: 'HEAD',
      hint: '仅查看未提交的更改',
      group: '比较方式'
    }
  ]
  const seen = new Set()
  for (const [collection, fallback] of [
    [refs?.branches, 'branch'],
    [refs?.tags, 'tag']
  ]) {
    for (const entry of collection || []) {
      if (entry.current || !entry.ref || seen.has(entry.ref)) continue
      seen.add(entry.ref)
      const remote = entry.kind === 'remote' || entry.ref.startsWith('refs/remotes/')
      items.push({
        id: entry.ref,
        kind: fallback,
        ref: entry.ref,
        name: entry.name || entry.ref,
        hint: entry.subject || '',
        group: fallback === 'tag' ? '标签' : remote ? '远程分支' : '本地分支'
      })
    }
  }
  const needle = query.trim().toLocaleLowerCase()
  return items
    .filter(
      (item) =>
        !needle ||
        `${item.name} ${item.ref || ''} ${item.hint}`.toLocaleLowerCase().includes(needle)
    )
    .map((item) => ({
      ...item,
      current: (current?.kind || 'auto') === item.kind && (current?.ref || null) === item.ref
    }))
}
