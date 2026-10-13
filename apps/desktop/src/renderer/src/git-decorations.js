const STATUS_LABELS = { added: 'A', deleted: 'D', modified: 'M' }
// 与 VS Code 的 gitDecoration.* 一致（Darcula 没定义，走默认深色的取值）。
const STATUS_COLORS = {
  added: 'var(--color-git-added)',
  deleted: 'var(--color-git-deleted)',
  modified: 'var(--color-git-modified)'
}
// 未跟踪（`?`）在 VS Code 里显示成「U」，其余沿用 A/M/D/R。
const CODE_LABELS = { A: 'A', D: 'D', M: 'M', R: 'R', T: 'M', '?': 'U' }
// A folder borrows the most significant status of the changes below it, so a folder holding only
// new files stays green instead of always turning gold.
const STATUS_RANK = { added: 1, deleted: 2, modified: 3 }

export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.modified
}

export function statusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.modified
}

/** 状态字符（porcelain 的 `X` 或 `Y`）→ 面板三态。 */
export function codeStatus(code) {
  if (code === '?' || code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  return 'modified'
}

/** 状态字符 → 显示的字母（未跟踪是 `U`）。 */
export function codeLabel(code) {
  return CODE_LABELS[code] || 'M'
}

export function codeColor(code) {
  return statusColor(codeStatus(code))
}

/**
 * porcelain 的两字符 `XY`：X 是索引侧（已经暂存），Y 是工作区侧。
 * 空格的 X 表示这一项没有已暂存的改动；未跟踪（`??`）只算工作区侧。
 * 同一个文件可能两边都有（`MM`：改了、暂存了、又改了），于是两段里各出现一次。
 */
export function stagedCode(code) {
  const index = code?.[0] || ' '
  return index !== ' ' && index !== '?' ? index : null
}

export function worktreeCode(code) {
  const worktree = code?.[1] || ' '
  return worktree === ' ' ? null : worktree
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
