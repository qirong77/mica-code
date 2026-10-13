// Git 变更数据的纯逻辑：状态码映射、porcelain / name-status / numstat 输出解析与
// 「当前分支相对谁」的基线判定。跑 git 的部分都在 `git.js`，这里只做字节到数据的
// 转换，便于单测。

const REMOTE_PREFIX_RE = /^[^/]+\//

/** `XY` 状态码（porcelain）或 `X` 状态码（name-status）→ 面板用的三态。 */
export function statusFromCode(code) {
  if (code === '??' || code[0] === 'A') return 'added'
  if (code.includes('D')) return 'deleted'
  return 'modified'
}

/** `git status --porcelain=v1 -z` 输出 → Map<path, status>。 */
export function parseStatus(value) {
  const records = value.split('\0')
  const changes = new Map()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const code = record.slice(0, 2)
    const filePath = record.slice(3)
    // 重命名/复制记录带着「旧路径」，多出来的那个字段要跳过（调用方目前用
    // `--no-renames`，这里留着以防哪天去掉）。
    if (code.includes('R') || code.includes('C')) index += 1
    changes.set(filePath, statusFromCode(code))
  }
  return changes
}

/**
 * `git diff --name-status -z` 输出 → Map<path, status>。
 * 记录形态是 `<code>\0<path>\0`（重命名是 `<code>\0<old>\0<new>\0`，取新路径）。
 */
export function parseNameStatus(value) {
  const fields = value.split('\0')
  const changes = new Map()
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index]
    if (!code) continue
    const renamed = code[0] === 'R' || code[0] === 'C'
    const filePath = fields[index + (renamed ? 2 : 1)]
    if (!filePath) break
    index += renamed ? 2 : 1
    changes.set(filePath, statusFromCode(code))
  }
  return changes
}

/** `git diff --numstat` 输出 → Map<path, {additions, deletions, binary}>。 */
export function parseNumstat(value) {
  const stats = new Map()
  for (const line of value.split('\n')) {
    if (!line) continue
    const firstTab = line.indexOf('\t')
    const secondTab = line.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const added = line.slice(0, firstTab)
    const deleted = line.slice(firstTab + 1, secondTab)
    stats.set(line.slice(secondTab + 1), {
      additions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted),
      binary: added === '-' || deleted === '-'
    })
  }
  return stats
}

/** `origin/master` → `master`，用于显示与「当前分支就是基线」的比较。 */
export function baseBranchLabel(ref) {
  return String(ref || '').replace(REMOTE_PREFIX_RE, '')
}

/**
 * 当前分支自己就是基线分支（例如就停在 master 上）时返回 true：此时「相对基线的
 * 变更」恒为空，调用方要退回工作区语义，否则面板会永远是空的。
 */
export function isBaseBranch(ref, current) {
  if (!ref || !current) return false
  return baseBranchLabel(ref) === current
}

/** 变更文件排序：与资源管理器一致的「数字感知、忽略大小写」字典序。 */
export function compareChangePaths(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}
