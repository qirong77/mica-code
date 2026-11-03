// Git 写操作：暂存 / 取消暂存 / 放弃更改。读操作留在 `git.js`（那里注册 IPC）。
// 这里不 import electron，好处是单测能对着临时仓库跑真实 git。
import { execFile } from 'child_process'
import { rm, rmdir } from 'fs/promises'
import { readFileSync, realpathSync, statSync } from 'fs'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** 没有第一个提交的仓库用它当「原始版本」（git 的空树对象）。 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * `GIT_OPTIONAL_LOCKS=0` 只关掉 git 的「可选锁」：`git status` 默认会把刷新后的
 * 索引写回磁盘（实测会占一次 `.git/index.lock`），而桌面端每 10s 轮询一次、每个
 * 窗口各轮一次，正好会撞上用户点「暂存 / 放弃更改」的那一下——后者是必需的锁，
 * 抢不到就直接报 `Unable to create '.../index.lock': File exists`。读命令不再占锁，
 * 写操作必需的锁不受影响（`git add`、`git restore --worktree` 实测照旧需要它）。
 */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }

/** 别人持有锁时 git 的统一说法，两种都用：前一种决定要不要重试，后一种确认是抢锁失败。 */
const LOCK_CREATE_PATTERN = /Unable to create '([^']*\.lock)'/
const LOCK_EXISTS_PATTERN = /File exists|文件已存在/

/**
 * 撞上锁时重试的间隔。常见的是一把短命的锁（我们自己的另一个窗口在做索引刷新、别的
 * 工具刚跑完），重试一下就好；真有一个 git 进程在跑（长提交、大仓库的 checkout）时
 * 几次重试都会失败，由 `gitErrorMessage` 给出可操作的说法。
 */
const LOCK_RETRY_DELAYS_MS = [100, 250, 500]

/**
 * 工作区里「上一次已知的变更状态」什么时候失效。
 *
 * 顶栏徽标和 Git 面板要的是同一条 `git status` + `git diff --numstat`（大仓库上
 * 各几十到上百毫秒），而轮询是每 10s / 3s 一轮、每个窗口各算一次。这里只记两件事：
 * - `probe`：结果只取决于仓库自身，`.git/HEAD` 变了（切换分支、提交、rebase）就必须重算；
 * - `hint`：agent 改了工作区文件时由调用方显式打点，不必等 mtime 探测。
 * 工作区的 mtime 这条判据没有用：任何时刻只要有一个进程在写文件就整棵重算，等于不缓存。
 */
const worktreeState = new Map()
const WORKTREE_TTL_MS = 5000
const repositoryState = new Map()

/** 让某个仓库的缓存立刻失效（写操作、agent 改完文件之后调用）。 */
export function noteWorktreeChange(root) {
  if (typeof root === 'string' && root) worktreeState.delete(root)
}

/**
 * 从一个目录往上找仓库根（只看 `.git` 是否存在，不跑 git 命令）：保存文件时用来
 * 精确失效那一份缓存。找不到就返回 null，调用方当作「没有可失效的」。
 */
export function repositoryRootOf(directory) {
  let current = typeof directory === 'string' ? directory : ''
  if (!current) return null
  for (;;) {
    try {
      statSync(path.join(current, '.git'))
      return current
    } catch {
      const parent = path.dirname(current)
      if (!parent || parent === current) return null
      current = parent
    }
  }
}

/**
 * 仓库「指向哪个提交」的签名：读几个字节比跑一条 git 命令便宜两个数量级。
 *
 * 注意 `.git/HEAD` 在分支上提交时是不变的（内容一直是 `ref: refs/heads/<branch>`），
 * 所以还要读它指向的那个 ref 文件；游离 HEAD 时 HEAD 里就是提交号，一次就够。
 */
function headSignature(root) {
  const gitDir = path.join(root, '.git')
  try {
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const parts = [`head:${head}`]
    const ref = /^ref:\s*(.+)$/.exec(head)
    if (ref) {
      const info = statSync(path.join(gitDir, ref[1]))
      parts.push(`${info.mtimeMs}:${info.size}`)
    }
    return parts.join('|')
  } catch {
    // 子模块 / worktree 的 `.git` 是文件，或者 ref 还没生成：当「不知道」——不缓存。
    return null
  }
}

/**
 * 跑一次真正的读取，但同一仓库在 TTL 内复用结果（除非 HEAD 变了或被显式打点）。
 * `refresh: true` 用于用户主动点刷新：跳过缓存。
 */
export async function cachedWorktreeRead(root, key, run, { refresh = false } = {}) {
  const signature = headSignature(root)
  const cached = worktreeState.get(root)
  if (
    !refresh &&
    signature &&
    cached &&
    cached.signature === signature &&
    Date.now() - cached.at < WORKTREE_TTL_MS
  ) {
    const hit = cached.values.get(key)
    if (hit) return hit
  }
  const value = await run()
  if (!signature) return value
  // 并发读取共用一份缓存；`probe` 取这次的 HEAD 签名，切换分支后自然失配。
  const entry =
    cached && Date.now() - cached.at < WORKTREE_TTL_MS
      ? cached
      : { signature, at: Date.now(), values: new Map() }
  entry.signature = signature
  entry.at = Date.now()
  entry.values.set(key, value)
  worktreeState.set(root, entry)
  return value
}

function errorText(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
  return `${stderr}\n${error?.message ?? ''}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function git(cwd, args, options = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        env: GIT_ENV,
        encoding: options.encoding ?? 'utf8',
        maxBuffer: 20 * 1024 * 1024
      })
      return result.stdout
    } catch (error) {
      const delay = LOCK_RETRY_DELAYS_MS[attempt]
      // 抢锁失败发生在 git 真正动手之前，命令什么都没改，重试是安全的。
      if (delay === undefined || !LOCK_CREATE_PATTERN.test(errorText(error))) throw error
      await sleep(delay)
    }
  }
}

/**
 * git 的英文 stderr 转成可操作的中文，目前只处理最常见的一种：仓库被另一个 git
 * 进程占着（另一个窗口在写、终端里在提交、或上次被中断的 git 留下了锁文件）。
 * 其余错误原样透出，便于排查。
 */
export function gitErrorMessage(error) {
  const text = errorText(error).trim()
  const lockPath = LOCK_CREATE_PATTERN.exec(text)?.[1]
  if (lockPath && LOCK_EXISTS_PATTERN.test(text)) {
    return `仓库里有另一个 git 进程正在运行，它占着 ${lockPath}。等它结束后重试即可；如果确认没有 git 进程在跑，可以删掉这个文件再试。`
  }
  return text || String(error)
}

/** 仓库根目录；`base` 是 HEAD，仓库还没有第一个提交时退回空树。 */
export async function getRepository(cwd) {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  let base = EMPTY_TREE
  try {
    base = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
  } catch {
    // 还没有第一个提交：和 git 的空树比较。
  }
  return { root, base }
}

/**
 * `getRepository` 每次要跑两个 `rev-parse`（实测约 140ms，是整条链路里最贵的一段），
 * 而它的结果只在 `HEAD` 变化时才会变：目录到仓库根的关系不会变，`base` 就是 HEAD
 * 指向的那个提交。所以按 cwd 缓存，用与工作区缓存同一份 `headSignature` 判定失效
 * ——切换分支、提交、rebase 会重跑，别的读取直接复用。
 * 目录还在但已不是仓库（`.git` 被删）时 signature 为 null，当作不可缓存。
 */
export async function cachedRepository(cwd) {
  const root = repositoryRootOf(cwd)
  const signature = root ? headSignature(root) : null
  const cached = repositoryState.get(cwd)
  if (signature && cached && cached.signature === signature) return cached.value
  const value = await getRepository(cwd)
  if (signature) repositoryState.set(cwd, { value, signature })
  return value
}

/**
 * 侧栏与页脚只要仓库根和分支名。会话视图每 10 秒轮询一次，所以合并成一次
 * `rev-parse`（原来的 show-toplevel + verify HEAD + symbolic-ref 是三个进程）。
 */
export async function getWorkspaceStatus(cwd) {
  let root
  let branch
  try {
    const [rootLine, branchLine = ''] = (
      await git(cwd, ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'])
    ).split('\n')
    root = rootLine.trim()
    branch = branchLine.trim()
  } catch (error) {
    // 还没有第一个提交时 `--abbrev-ref HEAD` 以 128 退出；仓库根照样取得到，
    // 分支名改从 HEAD 引用读（symbolic-ref 不依赖提交存在）。
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
    if (!branch) throw error
  }
  const projectName = path.basename(root)
  if (branch && branch !== 'HEAD') return { root, branch, projectName }
  const hash = (await git(root, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim()
  return { root, branch: hash ? `detached@${hash}` : 'detached', projectName }
}

/** 把仓库内的相对路径解析成绝对路径，越界（`../`）就报错。 */
/** 真实路径；路径本身还不存在时（刚删掉的文件）解析最近的存在祖先，再拼回尾巴。 */
function realish(target) {
  let current = target
  const tail = []
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...tail)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return target
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * 仓库内路径校验：越出仓库直接拒绝。
 *
 * 比较必须按真实路径做——`git rev-parse --show-toplevel` 给的是真实路径（macOS 上
 * `/tmp/...` 实际是 `/private/tmp/...`），而用户从地址栏、`?cwd=`、目录选择器拿到的
 * 常常是符号链接那条写法。只比字符串会把同一个目录判成「仓库外」，于是暂存、放弃
 * 更改、文件夹回退、打开文件一律报 `Invalid repository path`。返回真实路径，调用方
 * 再按 `path.relative(root, …)` 换算相对路径才不会错位。
 */
export function safeFilePath(root, relativePath) {
  const realRoot = realish(root)
  const realTarget = realish(path.resolve(root, relativePath))
  const relative = path.relative(realRoot, realTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Invalid repository path')
  return realTarget
}

/** 路径是否已经在索引里（未跟踪文件不在）。 */
async function isTracked(root, filePath) {
  try {
    await git(root, ['ls-files', '--error-unmatch', '--', filePath])
    return true
  } catch {
    return false
  }
}

/** 暂存：`git add`。 */
export async function stageFile(cwd, filePath) {
  const { root } = await getRepository(cwd)
  safeFilePath(root, filePath)
  await git(root, ['add', '--', filePath])
  noteWorktreeChange(root)
}

/**
 * 取消暂存：把索引里的这一项退回工作区。仓库还没有第一个提交时没有 HEAD 可退，
 * 改用 `rm --cached`（保留工作区文件）。
 */
export async function unstageFile(cwd, filePath) {
  const { root, base } = await getRepository(cwd)
  safeFilePath(root, filePath)
  if (base === EMPTY_TREE) await git(root, ['rm', '--cached', '-q', '--', filePath])
  else await git(root, ['restore', '--staged', '--', filePath])
  noteWorktreeChange(root)
}

/**
 * 放弃更改：未跟踪的文件直接删掉，已跟踪的从索引恢复（VS Code 同语义）。
 * 这是不可逆操作，调用方必须先让用户确认。
 */
export async function discardFile(cwd, filePath) {
  const { root } = await getRepository(cwd)
  const absolutePath = safeFilePath(root, filePath)
  if (await isTracked(root, filePath)) {
    await git(root, ['restore', '--worktree', '--', filePath])
    noteWorktreeChange(root)
    return
  }
  await rm(absolutePath, { force: true })
  noteWorktreeChange(root)
}

/**
 * 文件夹级回退：目录下**所有**已跟踪的文件恢复成索引里那份，未跟踪的文件删掉。
 *
 * 与单文件版的分工：单文件版靠面板给出的那一行（它只知道列出来的文件），文件夹版让
 * git 自己枚举目录下的条目，因此被筛选隐藏的、还没进面板的改动也一并回退——「回退这个
 * 文件夹」就该是这个语义，否则用户得先关掉筛选才敢点。
 *
 * 恢复的来源是索引而不是 HEAD：与单文件版一致，已经暂存的内容不会被顺手丢掉；要连
 * 暂存区一起回退，先「取消暂存」再回退。已跟踪文件一个都没有的目录只能删未跟踪文件。
 *
 * 不可逆，调用方必须先让用户确认。返回删掉的未跟踪文件数，用于给用户一句结果。
 */
export async function discardDirectory(cwd, directoryPath) {
  const { root } = await getRepository(cwd)
  const requested = String(directoryPath || '').replace(/\/+$/, '')
  if (!requested) throw new Error('缺少要回退的文件夹')
  const absolute = safeFilePath(root, requested)
  if (absolute === root) throw new Error('不能回退整个仓库，请选择仓库里的文件夹')
  // git 的 pathspec 是相对仓库根的：把绝对路径换算回去，避免用户传了绝对路径时静默无效。
  const relative = path.relative(root, absolute).split(path.sep).join('/')
  if (!relative) throw new Error('不能回退整个仓库，请选择仓库里的文件夹')
  await git(root, ['restore', '--worktree', '--', relative])
  const untracked = (
    await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', relative])
  )
    .split('\0')
    .filter(Boolean)
  for (const filePath of untracked) {
    await rm(path.join(root, filePath), { force: true })
  }
  await pruneEmptyDirectories(root, untracked)
  noteWorktreeChange(root)
  return { removed: untracked.length, restored: relative }
}

/**
 * 删完未跟踪文件后顺手收掉空目录（git 不跟踪空目录，`git clean -fd` 同样会删）。
 * 只从刚删掉的文件往上走到仓库根，遇到还有内容的目录就停——已跟踪文件因此不会被误删。
 */
async function pruneEmptyDirectories(root, removedPaths) {
  const directories = new Set()
  for (const filePath of removedPaths) {
    let current = path.dirname(path.join(root, filePath))
    while (current.startsWith(root) && current !== root) {
      directories.add(current)
      current = path.dirname(current)
    }
  }
  // 深的先删，父目录才有机会跟着空出来。
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(directory)
    } catch {
      // ENOTEMPTY / ENOENT：还有别的文件，或已经被上一次删除带走。
    }
  }
}
