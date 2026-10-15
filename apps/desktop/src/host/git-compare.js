// Git comparison IO without Electron: usable by the host and real-repository tests.
import { createHash } from 'crypto'
import { lstat, readFile, readlink } from 'fs/promises'
import {
  compareChangePaths,
  isBaseBranch,
  parseNameStatus,
  parseStatusCode,
  shortRefName
} from './git-core'
import { EMPTY_TREE, getRepository, git, gitErrorMessage, safeFilePath } from './git-ops'

const BASE_CANDIDATES = ['origin/master', 'origin/main', 'master', 'main']

export function countLines(buffer) {
  if (!buffer.length) return 0
  let count = 0
  for (const byte of buffer) if (byte === 10) count += 1
  return count + (buffer.at(-1) === 10 ? 0 : 1)
}

export async function currentBranchName(root) {
  try {
    return shortRefName((await git(root, ['symbolic-ref', '--quiet', 'HEAD'])).trim()) || null
  } catch {
    return null
  }
}

async function commitHash(root, ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('请输入 Git 分支、标签或提交号')
  return (
    await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref.trim()}^{commit}`])
  ).trim()
}

/** User-entered refs are always resolved as commits before use in other Git commands. */
export async function resolveRef(cwd, requested) {
  try {
    const { root } = await getRepository(cwd)
    const hash = await commitHash(root, requested)
    return { ref: { hash, name: requested.trim() }, error: null }
  } catch (error) {
    return { ref: null, error: gitErrorMessage(error) }
  }
}

async function autoBase(root) {
  const current = await currentBranchName(root)
  let remoteHead
  try {
    remoteHead = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
  } catch {
    // A repository need not have a remote default branch.
  }
  for (const name of [remoteHead, ...BASE_CANDIDATES].filter(Boolean)) {
    let hash
    try {
      hash = await commitHash(root, name)
    } catch {
      continue
    }
    if (isBaseBranch(name, current)) return null
    return { name, hash }
  }
  return null
}

async function comparison(root, head, requested, direct) {
  let base
  let warning
  if (typeof requested === 'string' && requested.trim()) {
    try {
      base = { name: requested.trim(), hash: await commitHash(root, requested) }
    } catch {
      warning = `无法解析比较基线“${requested.trim()}”，已退回自动基线或 HEAD。`
    }
  }
  base ||= await autoBase(root)
  if (!base) base = { name: 'HEAD', hash: head }
  let mergeBase = null
  if (head !== EMPTY_TREE) {
    try {
      mergeBase = (await git(root, ['merge-base', base.hash, head])).trim() || null
    } catch {
      // Unrelated histories compare directly with the selected commit.
    }
  }
  const useDirect = Boolean(direct || base.name === 'HEAD' || !mergeBase)
  return {
    base: base.name,
    baseLabel: shortRefName(base.name),
    mergeBase,
    direct: useDirect,
    compareRef: useDirect ? base.hash : mergeBase,
    ...(warning ? { warning } : {})
  }
}

/** --no-renames -z keeps tabs/newlines in filenames intact. */
function parseNumstatZ(output) {
  const stats = new Map()
  for (const record of output.split('\0')) {
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    stats.set(record.slice(second + 1), {
      additions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted),
      binary: added === '-' || deleted === '-'
    })
  }
  return stats
}

function parseTree(output) {
  const entries = new Map()
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, hash] = record.slice(0, tab).split(' ')
    entries.set(record.slice(tab + 1), { mode, type, hash })
  }
  return entries
}

async function worktreeFile(root, filePath) {
  const absolute = safeFilePath(root, filePath)
  try {
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink()) {
      return { content: Buffer.from(await readlink(absolute)), mode: '120000', exists: true }
    }
    // Gitlinks have no ordinary file bytes; their mode still participates in the fingerprint.
    if (stat.isDirectory()) return { content: Buffer.alloc(0), mode: '160000', exists: true }
    return {
      content: await readFile(absolute),
      mode: stat.mode & 0o111 ? '100755' : '100644',
      exists: true
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    return { content: Buffer.alloc(0), mode: null, exists: false }
  }
}

async function mapBounded(items, callback) {
  let cursor = 0
  const results = new Array(items.length)
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await callback(items[index])
      }
    })
  )
  return results.filter(Boolean)
}

/** Committed branch changes plus index/worktree changes and untracked files. */
export async function getBranchSummary(cwd, { base = null, direct = false } = {}) {
  const { root, base: head } = await getRepository(cwd)
  const selected = await comparison(root, head, base, direct)
  const compare = selected.compareRef
  const [names, untracked, numbers, status, treeOutput] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', '--no-renames', compare, '--']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(root, ['diff', '--numstat', '-z', '--no-renames', compare, '--']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
    git(root, ['ls-tree', '-r', '-z', compare, '--'])
  ])
  const tree = parseTree(treeOutput)
  const changes = parseNameStatus(names)
  for (const filePath of untracked.split('\0')) {
    if (filePath && !changes.has(filePath)) {
      changes.set(filePath, tree.has(filePath) ? 'modified' : 'added')
    }
  }
  const numstats = parseNumstatZ(numbers)
  const dirty = parseStatusCode(status)
  const files = await mapBounded([...changes], async ([filePath, fileStatus]) => {
    const current = await worktreeFile(root, filePath)
    const original = tree.get(filePath)
    if (!original && !current.exists) return null
    // Blob IDs represent all original bytes without spawning git-show once per file.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([compare, original?.hash, original?.mode, current.mode, fileStatus]))
      .update('\0')
      .update(current.content)
      .digest('hex')
    const binary = current.content.includes(0)
    const stat = numstats.get(filePath) || {
      additions: binary ? 0 : countLines(current.content),
      deletions: 0,
      binary
    }
    return {
      path: filePath,
      status: fileStatus,
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary || binary,
      uncommitted: dirty.has(filePath),
      untracked: dirty.get(filePath) === '??',
      fingerprint
    }
  })
  files.sort((left, right) => compareChangePaths(left.path, right.path))
  return {
    root,
    ...selected,
    head,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  }
}

function parseRefs(output, kind) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, hash, date, author, subject, current, upstream, tracking, symref] =
        line.split('\0')
      return {
        name: shortRefName(ref),
        ref,
        kind,
        hash,
        date,
        author,
        subject,
        current: current === '*',
        upstream: upstream || null,
        tracking: tracking || null,
        symref
      }
    })
    .filter((item) => !item.symref)
    .map((item) => {
      delete item.symref
      return item
    })
}

export async function getRefs(cwd) {
  const { root } = await getRepository(cwd)
  const format = [
    '%(refname)',
    '%(objectname:short)',
    '%(committerdate:relative)',
    '%(authorname)',
    '%(subject)',
    '%(HEAD)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(symref)'
  ].join('%00')
  const [branches, remotes, tags] = await Promise.all([
    git(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads']),
    git(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/remotes']),
    git(root, [
      'for-each-ref',
      '--sort=-creatordate',
      `--format=${format.replace('%(committerdate:relative)', '%(creatordate:relative)')}`,
      'refs/tags'
    ])
  ])
  return {
    root,
    branches: [...parseRefs(branches, 'branch'), ...parseRefs(remotes, 'remote')].sort(
      (left, right) => Number(right.current) - Number(left.current)
    ),
    tags: parseRefs(tags, 'tag')
  }
}

async function blob(root, ref, filePath) {
  // Looking up a literal path avoids revision/pathspec syntax in user-supplied filenames.
  const entries = parseTree(
    await git(root, ['--literal-pathspecs', 'ls-tree', '-z', ref, '--', filePath])
  )
  const entry = entries.get(filePath)
  if (!entry || entry.type !== 'blob') return Buffer.alloc(0)
  return git(root, ['cat-file', 'blob', entry.hash], { encoding: 'buffer' })
}

async function indexBlob(root, filePath) {
  const output = await git(root, [
    '--literal-pathspecs',
    'ls-files',
    '--stage',
    '-z',
    '--',
    filePath
  ])
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0 || record.slice(tab + 1) !== filePath) continue
    const [, hash, stage] = record.slice(0, tab).split(' ')
    if (stage === '0') return git(root, ['cat-file', 'blob', hash], { encoding: 'buffer' })
  }
  return Buffer.alloc(0)
}

/** Legacy head/branch/ref modes remain supported; snapshot uses the exact summary compareRef. */
export async function getFile(cwd, filePath, requested = null) {
  const { root, base: head } = await getRepository(cwd)
  safeFilePath(root, filePath)
  const options =
    typeof requested === 'string' || !requested ? { mode: requested || 'head' } : requested
  const mode = options.mode || 'head'
  let compareRef = head
  let originalLabel = 'HEAD'
  const modifiedLabel = mode === 'staged' ? 'Index' : 'Working Tree'
  if (mode === 'snapshot') {
    compareRef = options.ref === EMPTY_TREE ? EMPTY_TREE : await commitHash(root, options.ref)
    originalLabel = options.label ? `${options.label} · ${compareRef.slice(0, 8)}` : compareRef
  } else if (mode === 'branch' || mode === 'ref') {
    const selected = await comparison(
      root,
      head,
      options.ref || (mode === 'ref' ? 'HEAD' : null),
      options.direct
    )
    compareRef = selected.compareRef
    originalLabel = selected.baseLabel
  } else if (mode === 'worktree') {
    originalLabel = 'Index'
  }
  const [original, modified] = await Promise.all([
    mode === 'worktree' ? indexBlob(root, filePath) : blob(root, compareRef, filePath),
    mode === 'staged'
      ? indexBlob(root, filePath)
      : worktreeFile(root, filePath).then((file) => file.content)
  ])
  const binary = original.includes(0) || modified.includes(0)
  return {
    original: binary ? '' : original.toString('utf8'),
    modified: binary ? '' : modified.toString('utf8'),
    binary,
    originalLabel,
    modifiedLabel
  }
}
