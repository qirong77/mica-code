const STATUS_LABELS = { added: 'A', deleted: 'D', modified: 'M' }
const STATUS_COLORS = {
  added: 'var(--color-success)',
  deleted: 'var(--color-danger)',
  modified: 'var(--color-warn)'
}
// A folder borrows the most significant status of the changes below it, so a folder holding only
// new files stays green instead of always turning gold.
const STATUS_RANK = { added: 1, deleted: 2, modified: 3 }

export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.modified
}

export function statusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.modified
}

export function relativeToRoot(root, target) {
  if (!root || !target) return null
  const prefix = root.endsWith('/') ? root : `${root}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : null
}

export function buildGitDecorations(repository) {
  const files = new Map()
  const folders = new Map()
  for (const file of repository?.files || []) {
    if (!file?.path) continue
    const status = STATUS_LABELS[file.status] ? file.status : 'modified'
    files.set(file.path, status)
    const parts = file.path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const folder = parts.slice(0, index).join('/')
      const current = folders.get(folder)
      if (!current || STATUS_RANK[status] > STATUS_RANK[current]) folders.set(folder, status)
    }
  }
  return { files, folders }
}
