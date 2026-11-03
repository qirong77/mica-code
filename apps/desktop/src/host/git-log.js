// Git 历史读取：图谱页面（`git:log`）与提交详情（`git:commit`）。
// 只读、不碰工作区；解析逻辑与跑命令分开放在导出函数里，便于单测。
import { compareChangePaths, parseNameStatus, shortRefName } from './git-core'
import { EMPTY_TREE, cachedRepository, git, gitErrorMessage } from './git-ops'

const FIELD = '%x00'
const LOG_FORMAT = [
  '%H', // 完整哈希
  '%h', // 短哈希
  '%P', // 父提交（空格分隔）
  '%an', // 作者
  '%ae', // 邮箱
  '%aI', // 作者时间（严格 ISO 8601，带时区）
  '%s', // 标题
  '%D' // 引用装饰（`HEAD -> main, origin/main, tag: v1`）
].join(FIELD)

/**
 * `%D` → 界面用的引用徽标。
 * `HEAD -> main` 拆成「HEAD 标记 + main 分支」，`origin/main` 与 `tag: v1` 各自带 kind，
 * 这样渲染层只按 kind 上色，不必再解析字符串。
 */
export function parseDecorations(value) {
  const refs = []
  for (const raw of String(value || '').split(',')) {
    const text = raw.trim()
    if (!text) continue
    if (text.startsWith('tag: ')) {
      refs.push({ kind: 'tag', name: text.slice(5).trim() })
      continue
    }
    const head = /^HEAD -> (.+)$/.exec(text)
    if (head) {
      refs.push({ kind: 'head', name: head[1].trim() })
      continue
    }
    if (text === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD' })
      continue
    }
    refs.push({ kind: text.includes('/') ? 'remote' : 'branch', name: text })
  }
  return refs
}

/** `git log` 的一行 → 提交对象（父提交拆成数组，提交信息里的 NUL 已由 git 保证不出现）。 */
export function parseLog(output) {
  const commits = []
  for (const line of String(output || '').split('\n')) {
    if (!line.trim()) continue
    const [hash, shortHash, parents, author, email, date, subject, decorations = ''] =
      line.split('\0')
    if (!hash) continue
    commits.push({
      hash,
      shortHash,
      parents: parents ? parents.trim().split(/\s+/).filter(Boolean) : [],
      author,
      email,
      date,
      subject,
      refs: parseDecorations(decorations)
    })
  }
  return commits
}

/**
 * 提交历史（图谱数据）。默认读全部引用，界面上只显示当前分支时由渲染层筛。
 * 仓库还没有第一个提交时 `git log` 以 128 退出，这里当成「空历史」而不是错误。
 */
export async function getLog(cwd, { ref = null, max = 400, skip = 0 } = {}) {
  const { root } = await cachedRepository(cwd)
  const count = Math.min(2000, Math.max(1, Math.floor(Number(max) || 400)))
  const offset = Math.max(0, Math.floor(Number(skip) || 0))
  let head = null
  try {
    head = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim() || null
  } catch {
    head = null
  }
  const args = ['log', `--max-count=${count}`, '--date-order', `--format=${LOG_FORMAT}`]
  if (offset) args.push(`--skip=${offset}`)
  if (typeof ref === 'string' && ref.trim()) args.push(ref.trim(), '--')
  // `--all` 也包含 `refs/notes/*` 与 `refs/stash`：笔记是仓库的元数据，stash 是没提交
  // 的临时快照，两者混进历史会让图谱里多出一串空的「笔记提交」。`--exclude` 必须写在
  // `--all` 之前才生效。
  else args.push('--exclude=refs/notes/*', '--exclude=refs/stash', '--all', ...(head ? ['HEAD'] : []), '--')
  let output
  try {
    output = await git(root, args)
  } catch (error) {
    const text = gitErrorMessage(error)
    if (/does not have any commits yet|ambiguous argument 'HEAD'/i.test(text))
      return { root, commits: [], head: null, branch: null, more: false }
    throw new Error(text)
  }
  const commits = parseLog(output)
  let branch = null
  try {
    branch = shortRefName((await git(root, ['symbolic-ref', '--quiet', 'HEAD'])).trim()) || null
  } catch {
    branch = null
  }
  // 取满了就还有更多：图谱页据此显示「加载更多」，不必额外跑一次计数。
  return { root, commits, head, branch, more: commits.length >= count, ref: ref || null }
}

/**
 * 提交详情：元信息 + 该提交相对第一个父提交改了哪些文件。
 *
 * 合并提交按「对第一个父提交」的差异算（与 `git show` 的默认行为一致），根提交与空树比。
 */
export async function getCommit(cwd, hash) {
  const requested = typeof hash === 'string' ? hash.trim() : ''
  if (!requested) throw new Error('缺少提交号')
  const { root } = await cachedRepository(cwd)
  const resolved = (
    await git(root, ['rev-parse', '--verify', '--end-of-options', `${requested}^{commit}`])
  ).trim()
  const format = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%cI', '%s', '%B', '%D'].join(FIELD)
  const meta = (await git(root, ['show', '-s', `--format=${format}`, resolved])).replace(/\n$/, '')
  const [
    full,
    shortHash,
    parents,
    author,
    email,
    date,
    committer,
    commitDate,
    subject,
    body,
    decorations = ''
  ] = meta.split('\0')
  let base = EMPTY_TREE
  const parentList = parents ? parents.trim().split(/\s+/).filter(Boolean) : []
  if (parentList.length) base = parentList[0]
  const [names, numbers] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', '--no-renames', base, resolved, '--']),
    git(root, ['diff', '--numstat', '-z', '--no-renames', base, resolved, '--'])
  ])
  const numstats = new Map()
  for (const record of numbers.split('\0')) {
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    numstats.set(record.slice(second + 1), {
      additions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted),
      binary: added === '-' || deleted === '-'
    })
  }
  const files = [...parseNameStatus(names)]
    .map(([filePath, status]) => {
      const stat = numstats.get(filePath) || { additions: 0, deletions: 0, binary: false }
      return { path: filePath, status, ...stat }
    })
    .sort((left, right) => compareChangePaths(left.path, right.path))
  return {
    root,
    commit: {
      hash: full,
      shortHash,
      parents: parentList,
      author,
      email,
      date,
      committer,
      commitDate,
      subject,
      body: (body || '').trim(),
      refs: parseDecorations(decorations)
    },
    base,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  }
}
