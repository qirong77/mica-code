// Git comparison IO without Electron: usable by the host and real-repository tests.
import { createHash } from 'crypto'
import { lstat, readFile, readlink } from 'fs/promises'
import {
  baseBranchLabel,
  compareChangePaths,
  isBaseBranch,
  parseNameStatus,
  parseStatusCode,
  shortRefName
} from './git-core'
import { EMPTY_TREE, cachedRepository, git, gitErrorMessage, safeFilePath } from './git-ops'

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

/**
 * 把用户（或插件）给的名字解析成提交号。
 *
 * 分支常常只有远端那一份：评审别人的需求时本地没 checkout、刚 fetch 下来还没建跟踪分支，
 * `rev-parse --verify <名字>` 会直接失败，界面只剩一句 `fatal: Needed a single revision`。
 * 所以原名解析不到时再试一次 `origin/<名字>`——它同样是一个**提交**引用，不读工作区。
 */
async function commitHash(root, ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('请输入 Git 分支、标签或提交号')
  const name = ref.trim()
  const candidates = name.startsWith('origin/') ? [name] : [name, `origin/${name}`]
  let lastError
  for (const candidate of candidates) {
    try {
      return (
        await git(root, ['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`])
      ).trim()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** User-entered refs are always resolved as commits before use in other Git commands. */
export async function resolveRef(cwd, requested) {
  try {
    const { root } = await cachedRepository(cwd)
    const hash = await commitHash(root, requested)
    return { ref: { hash, name: requested.trim() }, error: null }
  } catch (error) {
    return { ref: null, error: gitErrorMessage(error) }
  }
}

/**
 * 自动基线：远端 HEAD → main → master → 当前分支。
 *
 * `headName` 是这次要比的那条分支：评审别人的分支时当前检出的可能正是主分支本身，
 * 不能因为「基线 == 当前分支」就退回 HEAD——那样比出来永远是空 diff。
 */
async function autoBase(root, { headName = '', allowCurrent = false } = {}) {
  const current = await currentBranchName(root)
  let remoteHead
  try {
    remoteHead = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
  } catch {
    // A repository need not have a remote default branch.
  }
  // 基线候选都是分支名，所以一次 `for-each-ref` 就把所有分支的提交号拿回来：
  // 原来每个候选各跑一次 `rev-parse --verify`，四个候选都落空时要四趟进程，
  // 而这台机器上一次 git 进程约 55ms（安全软件会拦每次 exec）。
  let branches
  try {
    branches = new Map(
      (
        await git(root, [
          'for-each-ref',
          '--format=%(refname:short)%00%(objectname)',
          'refs/heads',
          'refs/remotes'
        ])
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, hash] = line.split('\0')
          return [name, hash]
        })
    )
  } catch {
    branches = new Map()
  }
  for (const name of [remoteHead, ...BASE_CANDIDATES].filter(Boolean)) {
    const hash = branches.get(name)
    if (!hash) continue
    if (headName && shortRefName(name) === shortRefName(headName)) continue
    if (!allowCurrent && isBaseBranch(name, current)) return null
    return { name, hash }
  }
  return null
}

async function comparison(root, head, requested, direct, { headName = '', review = false } = {}) {
  let base
  let warning
  if (typeof requested === 'string' && requested.trim()) {
    try {
      base = { name: requested.trim(), hash: await commitHash(root, requested) }
    } catch {
      warning = `无法解析比较基线“${requested.trim()}”，已退回自动基线或 HEAD。`
    }
  }
  // 评审模式（提交对提交）没点名基线就是「按仓库默认主分支比」：工作区正好停在主分支上
  // 很常见，不能因此退回 HEAD，否则比出来永远是空 diff。
  base ||= await autoBase(root, { headName, allowCurrent: review })
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
    // 显示名去掉 `origin/`：评审别人的分支时基线常常只写成远端 ref，界面上
    // 「origin/master · 相对 origin/master」既长又难读，而这两处只是标题。
    baseLabel: baseBranchLabel(shortRefName(base.name)),
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

async function inspectWorktreeFile(root, filePath) {
  const absolute = safeFilePath(root, filePath)
  try {
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink()) {
      return { kind: 'link', absolute, mode: '120000', exists: true, stat }
    }
    // Gitlinks have no ordinary file bytes; their mode still participates in the fingerprint.
    if (stat.isDirectory()) return { kind: 'gitlink', absolute, mode: '160000', exists: true, stat }
    return { kind: 'file', absolute, mode: stat.mode & 0o111 ? '100755' : '100644', exists: true, stat }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    return { kind: 'missing', mode: null, exists: false }
  }
}

async function readWorktreeContent(current) {
  if (!current.exists) return Buffer.alloc(0)
  if (current.kind === 'link') return Buffer.from(await readlink(current.absolute))
  if (current.kind === 'gitlink') return Buffer.alloc(0)
  return readFile(current.absolute)
}

/**
 * 编辑器打开时 `git:branch-summary` 每 3s 跑一次，每次都要读一遍所有改动过的文件再算
 * SHA-256（几百个文件时 p50 140ms）。按「路径 + stat 指纹」缓存算好的指纹：文件没动过
 * 就只花一次 lstat，内容、权限、符号链接目标任一变化都会换 key，与原来逐字节重算的结果
 * 一致（`git:branch-summary` 的测试就钉着这一点）。
 */
const fingerprintCache = new Map()
const FINGERPRINT_CACHE_LIMIT = 4096

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
  const { root, base: head } = await cachedRepository(cwd)
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
    const current = await inspectWorktreeFile(root, filePath)
    const original = tree.get(filePath)
    if (!original && !current.exists) return null
    const cacheKey = current.exists
      ? [
          root,
          filePath,
          current.stat.mtimeMs,
          current.stat.ctimeMs,
          current.stat.size,
          current.mode,
          compare,
          original?.hash || '',
          original?.mode || '',
          fileStatus
        ].join('\0')
      : null
    let derived = cacheKey ? fingerprintCache.get(cacheKey) : null
    if (!derived) {
      const content = await readWorktreeContent(current)
      // Blob IDs represent all original bytes without spawning git-show once per file.
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([compare, original?.hash, original?.mode, current.mode, fileStatus]))
        .update('\0')
        .update(content)
        .digest('hex')
      const binary = content.includes(0)
      derived = { fingerprint, binary, lines: binary ? 0 : countLines(content) }
      if (cacheKey) {
        if (fingerprintCache.size >= FINGERPRINT_CACHE_LIMIT) fingerprintCache.clear()
        fingerprintCache.set(cacheKey, derived)
      }
    }
    const binary = derived.binary
    const stat = numstats.get(filePath) || {
      additions: derived.lines,
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
      fingerprint: derived.fingerprint
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

/**
 * 分支对分支：`head` 相对 `base` 引入的改动，两边都从提交里读。
 *
 * 与 `getBranchSummary` 的区别是它**不碰工作区**：未提交内容、未跟踪文件、那个目录还在不在
 * 都不影响结果。评审一条别人的分支（或一个随时可能被系统清掉的临时副本）必须走这条——
 * 用工作区比较会把评审人自己的改动混进别人的 diff，目录没了还会直接报错。
 *
 * 语义与 PR 视图一致：先求 `merge-base(base, head)`，再比较 `分叉点..head`，也就是
 * 「这条分支相对主分支新增了什么」，而不是把主分支自己的提交算成删除。
 */
export async function getRefSummary(cwd, { head = null, base = null, direct = false } = {}) {
  const { root, base: headHashDefault } = await cachedRepository(cwd)
  const headRef = typeof head === 'string' && head.trim() ? head.trim() : null
  const headHash = headRef ? await commitHash(root, headRef) : headHashDefault
  const headName = headRef || (await currentBranchName(root)) || 'HEAD'
  const selected = await comparison(root, headHash, base, direct, { headName, review: true })
  const compare = selected.compareRef
  const [names, numbers] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', '--no-renames', compare, headHash, '--']),
    git(root, ['diff', '--numstat', '-z', '--no-renames', compare, headHash, '--'])
  ])
  const numstats = parseNumstatZ(numbers)
  const files = [...parseNameStatus(names)]
    .map(([filePath, status]) => {
      const stat = numstats.get(filePath) || { additions: 0, deletions: 0, binary: false }
      return {
        path: filePath,
        status,
        additions: stat.additions,
        deletions: stat.deletions,
        binary: stat.binary,
        // 两边都是提交里的对象：比较点 + 目标提交 + 路径唯一确定了内容。
        fingerprint: createHash('sha256')
          .update(JSON.stringify([compare, headHash, filePath, status]))
          .digest('hex')
      }
    })
    .sort((left, right) => compareChangePaths(left.path, right.path))
  return {
    root,
    ...selected,
    head: headName,
    headHash,
    headLabel: baseBranchLabel(shortRefName(headName)),
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
  const { root } = await cachedRepository(cwd)
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
  const { root, base: head } = await cachedRepository(cwd)
  safeFilePath(root, filePath)
  const options =
    typeof requested === 'string' || !requested ? { mode: requested || 'head' } : requested
  const mode = options.mode || 'head'
  let compareRef = head
  let modifiedRef = null
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
  } else if (mode === 'refs') {
    // 评审一条分支：两边都在提交里，工作区不参与（也不会因为目录被清掉而失败）。
    // 图谱里翻到根提交时基线是空树——它不是提交，不能过 `commitHash`。
    compareRef = options.ref === EMPTY_TREE ? EMPTY_TREE : await commitHash(root, options.ref)
    modifiedRef = await commitHash(root, options.head)
    originalLabel = options.label || shortRefName(options.ref)
  } else if (mode === 'worktree') {
    originalLabel = 'Index'
  }
  const [original, modified] = await Promise.all([
    mode === 'worktree' ? indexBlob(root, filePath) : blob(root, compareRef, filePath),
    mode === 'refs'
      ? blob(root, modifiedRef, filePath)
      : mode === 'staged'
        ? indexBlob(root, filePath)
        : inspectWorktreeFile(root, filePath).then(readWorktreeContent)
  ])
  const binary = original.includes(0) || modified.includes(0)
  // 行悬停的 blame 必须按「这一侧到底是哪份内容」取：original 是某个提交或索引，
  // modified 是工作区、索引或另一个提交。渲染层照这份说明去 `git:blame`，
  // 不再自己按 mode 猜一遍（猜错就会显示别处的作者与提交）。
  const blame = {
    original:
      mode === 'worktree'
        ? { kind: 'index' }
        : compareRef === EMPTY_TREE
          ? { kind: 'none' }
          : { kind: 'commit', ref: compareRef },
    modified:
      mode === 'refs'
        ? { kind: 'commit', ref: modifiedRef }
        : mode === 'staged'
          ? { kind: 'index' }
          : { kind: 'worktree' }
  }
  return {
    original: binary ? '' : original.toString('utf8'),
    modified: binary ? '' : modified.toString('utf8'),
    binary,
    originalLabel,
    modifiedLabel:
      mode === 'refs' ? options.headLabel || shortRefName(options.head) : modifiedLabel,
    blame
  }
}
