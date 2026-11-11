// Git 写操作：暂存 / 取消暂存 / 放弃更改。读操作留在 `git.js`（那里注册 IPC）。
// 这里不 import electron，好处是单测能对着临时仓库跑真实 git。
import { execFile } from 'child_process'
import { rm, rmdir } from 'fs/promises'
import { lstatSync, readFileSync, realpathSync, statSync } from 'fs'
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
/**
 * 每个仓库「我们改过工作区」的次数。
 *
 * 全树读取与徽标那份更长的缓存（`git.js` 的 change-counts）都要知道自己是不是过期了：
 * stage / discard / 保存文件之后，
 * 数字必须立刻变化，而不是等 TTL。
 */
const worktreeEpoch = new Map()
/**
 * 缓存有效期按 key 区分，因为「多久会变」差得很远：
 *
 * - `summary:<base>` 是一次全树 `status` + `diff --numstat`，内容随工作区任何一次保存变化，
 *   所以只有 5 秒；
 * - `workspace-status` 只有仓库根和分支名，只随 HEAD 变化，而 `headSignature` 已经把
 *   「切分支 / 提交 / rebase」算进失效判据；普通文件保存不影响这一份仓库身份。
 *   给它 5 秒的唯一后果是：轮询间隔 10 秒永远比 TTL 长，于是**每次轮询都必然 miss**、
 *   每次都 spawn 一个 git 进程（实测一天 3000 次、274 秒，占 host 通道总耗时的 32%）。
 *   拉到 60 秒，切分支仍然立刻可见（签名变了），只是少掉那些必然落空的 spawn。
 */
const WORKTREE_TTL_MS = 5000
const WORKSPACE_STATUS_TTL_MS = 60_000
const ttlOf = (key) => (key === 'workspace-status' ? WORKSPACE_STATUS_TTL_MS : WORKTREE_TTL_MS)
const repositoryState = new Map()
/**
 * 正在跑的那一次读取，键是 `<真实 root>\0<key>`，记录起读时的 HEAD 与 epoch。
 *
 * 只缓存「跑完的结果」不够：轮询间隔（3s / 10s）比一次读取慢时不打紧，一旦机器被别的东西
 * 拖慢、一次全树扫描变成几秒，下一个 tick 会再发一次、再下一个再发一次，几个窗口叠起来
 * 就是七次全树扫描同时在跑，彼此抢 CPU 又让每一次都更慢（实测 09:23 十分钟内峰值并发 4、
 * 全天峰值 7，其中 8.8% 的调用超过 1s）。共用同一个 promise 之后，同一仓库同一份数据在
 * 同一代（HEAD / epoch）只复用一次读取；手动刷新仍可独立起读。
 */
const worktreeInFlight = new Map()
/**
 * 每个仓库「一次全树扫描」实测花了多久。
 *
 * 工作区文件一改就要重扫，而重扫的代价只取决于仓库大小：小仓库几十毫秒可以每 2 秒一次，
 * 大仓库要 1–2 秒，同一个节奏会把 git 进程一直挂在那里跑。`git-watch.js` 拿它放大推送
 * 间隔，保证扫描占用不超过主进程 CPU 的一个小份额。
 */
const summaryScanCost = new Map()

/** 上一次全树扫描的耗时（毫秒），没扫过时是 0。 */
export function summaryScanCostOf(root) {
  return summaryScanCost.get(worktreeRoot(root)) || 0
}

/** 让某个仓库的缓存立刻失效（写操作、agent 改完文件之后调用）。 */
export function noteWorktreeChange(root) {
  if (typeof root !== 'string' || !root) return
  root = worktreeRoot(root)
  worktreeEpoch.set(root, worktreeEpochOf(root) + 1)
}

export function worktreeEpochOf(root) {
  return worktreeEpoch.get(worktreeRoot(root)) || 0
}

/** Git 返回真实路径；watch / 保存文件也可能从符号链接进来，必须共用同一个身份。 */
function worktreeRoot(root) {
  return realish(path.resolve(typeof root === 'string' && root ? root : '.'))
}

/**
 * 仓库当前指向哪个提交的签名。徽标这类长 TTL 的缓存拿它做失效判据：
 * 切换分支 / 提交之后必须立刻重算。
 */
export function worktreeSignature(root) {
  return headSignature(root)
}

/**
 * 从一个目录往上找仓库根（只看 `.git` 是否存在，不跑 git 命令）：保存文件时用来
 * 精确失效那一份缓存。找不到就返回 null，调用方当作「没有可失效的」。
 */
export function repositoryRootOf(directory, { strict = false } = {}) {
  let current = typeof directory === 'string' ? directory : ''
  if (!current) return null
  current = path.resolve(current)
  if (strict && !statSync(current).isDirectory()) {
    throw Object.assign(new Error(`ENOTDIR: not a directory, '${current}'`), { code: 'ENOTDIR' })
  }
  for (;;) {
    try {
      statSync(path.join(current, '.git'))
      return current
    } catch (error) {
      // 保存文件的失效提示可以尽力而为；读取请求不能把权限/IO 错误伪装成「没有仓库」。
      if (strict && error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (!parent || parent === current) return null
      current = parent
    }
  }
}

/** 每次重新查祖先标记，无负缓存：刚 init、删除或移入 .git 时下一次读取立即生效。 */
function requireRepositoryDirectory(cwd) {
  const root = repositoryRootOf(cwd, { strict: true })
  if (root || GIT_ENV.GIT_DIR || GIT_ENV.GIT_WORK_TREE) return root
  // 裸仓库没有 .git；让 Git 给出「需要工作区」的原始错误。
  for (let current = cwd; ; current = path.dirname(current)) {
    try {
      if (
        statSync(path.join(current, 'HEAD')).isFile() &&
        statSync(path.join(current, 'objects')).isDirectory()
      ) return null
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (path.dirname(current) === current) break
  }
  throw new Error('fatal: not a git repository (or any of the parent directories): .git')
}

/**
 * 仓库「指向哪个提交」的签名：读几个字节比跑一条 git 命令便宜两个数量级。
 *
 * 注意 `.git/HEAD` 在分支上提交时是不变的（内容一直是 `ref: refs/heads/<branch>`），
 * 所以还要读它指向的 ref；worktree 从 commondir 读共享分支，打包后的 ref 看 packed-refs。
 * 身份带真实工作区及 Git 目录，不能把共用一个 commondir 的两个 worktree 合在一起。
 */
function headSignature(root) {
  try {
    root = worktreeRoot(root)
    const dotGit = path.join(root, '.git')
    let gitDir = dotGit
    if (!statSync(dotGit).isDirectory()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
      if (!match) return null
      gitDir = path.resolve(root, match[1].trim())
    }
    gitDir = realpathSync.native(gitDir)
    const commonPath = optionalFile(path.join(gitDir, 'commondir'))
    const commonDir = commonPath
      ? realpathSync.native(path.resolve(gitDir, commonPath))
      : gitDir
    const identity = (dir) => {
      const info = statSync(dir)
      return `${dir}:${info.dev}:${info.ino}`
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const parts = [identity(root), identity(gitDir), identity(commonDir), `head:${head}`]
    let reference = head
    for (let depth = 0; depth < 8; depth += 1) {
      const ref = /^ref:\s*(.+)$/.exec(reference)
      if (!ref) return JSON.stringify(parts)
      const name = ref[1]
      reference = optionalFile(path.join(gitDir, name))
      if (reference === null && commonDir !== gitDir) {
        reference = optionalFile(path.join(commonDir, name))
      }
      if (reference !== null) {
        parts.push(`${name}:${reference}`)
        continue
      }
      // packed-refs 可以很大，签名只需文件身份，不必每次轮询解析整个文件。
      // ref 和 packed-refs 都不存在也是有效状态：仓库可能还没有第一个提交。
      try {
        const info = statSync(path.join(commonDir, 'packed-refs'))
        parts.push(`packed:${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        parts.push(`missing:${name}`)
      }
      return JSON.stringify(parts)
    }
    return null
  } catch {
    // 仓库已移走、元数据不可读或引用成环时，不把未知身份当成可缓存的结果。
    return null
  }
}

function optionalFile(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 跑一次真正的读取，但同一仓库在 TTL 内复用结果（除非 HEAD 变了或被显式打点）。
 * `refresh: true` 用于用户主动点刷新：跳过缓存和在途读取。
 * `invalidate: true` 用于自动变化通知：跳过缓存，但仍合并同一代的在途读取。
 */
export async function cachedWorktreeRead(root, key, run, { refresh = false, invalidate = false, diagnostics } = {}) {
  root = worktreeRoot(root)
  const signature = headSignature(root)
  // 根目录/分支名由 HEAD 决定，文件保存和 index 变化不应让它每次都重新 spawn。
  const epoch = key === 'workspace-status' ? 0 : worktreeEpochOf(root)
  const cached = worktreeState.get(root)?.get(key)
  if (
    !refresh &&
    !invalidate &&
    signature &&
    cached &&
    cached.signature === signature &&
    cached.epoch === epoch &&
    Date.now() - cached.at < ttlOf(key)
  ) {
    if (diagnostics) diagnostics.cache = 'hit'
    return cached.value
  }
  // `refresh: true` 是用户主动点刷新：既不读缓存，也不搭别人那次还没跑完的顺风车。
  const inFlightKey = `${root}\u0000${key}`
  if (!refresh) {
    const pending = worktreeInFlight.get(inFlightKey)
    if (pending && pending.signature === signature && pending.epoch === epoch) {
      if (diagnostics) diagnostics.cache = 'wait'
      return pending.promise
    }
  }
  if (diagnostics) diagnostics.cache = 'miss'
  const pending = { signature, epoch, promise: null }
  pending.promise = (async () => {
    const startedAt = Date.now()
    const value = await run()
    // 只有全树扫描（`summary:<base>`）值得计量：`workspace-status` 是一条 rev-parse，
    // 拿它的耗时当冷却依据会让工作区推送过于密集。
    if (key.startsWith('summary')) summaryScanCost.set(root, Date.now() - startedAt)
    if (
      !signature ||
      worktreeInFlight.get(inFlightKey) !== pending ||
      (key !== 'workspace-status' && worktreeEpochOf(root) !== epoch) ||
      headSignature(root) !== signature
    ) {
      return value
    }
    // 每个 key 独立记身份、epoch 和时间，避免 summary 与 status 互相覆盖/续期。
    const values = worktreeState.get(root) || new Map()
    values.set(key, { signature, epoch, at: Date.now(), value })
    worktreeState.set(root, values)
    return value
  })()
  // 手动刷新也登记为最新读取，防止它完成后被更早开始的慢请求覆盖。
  worktreeInFlight.set(inFlightKey, pending)
  try {
    return await pending.promise
  } finally {
    if (worktreeInFlight.get(inFlightKey) === pending) worktreeInFlight.delete(inFlightKey)
  }
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
 * 指向的那个提交。所以按真实仓库根缓存，用与工作区缓存同一份 `headSignature` 判定失效
 * ——切换分支、提交、rebase 会重跑，别的读取直接复用。
 * 目录还在但已不是仓库（`.git` 被删）时 signature 为 null，当作不可缓存。
 */
export async function cachedRepository(cwd) {
  cwd = worktreeRoot(cwd)
  const root = requireRepositoryDirectory(cwd)
  const signature = root ? headSignature(root) : null
  if (!signature) return getRepository(cwd)
  const cached = repositoryState.get(root)
  if (cached && cached.signature === signature) return cached.promise
  const entry = { signature, promise: null }
  entry.promise = (async () => {
    try {
      const value = await getRepository(cwd)
      if (headSignature(root) !== signature) {
        if (repositoryState.get(root) === entry) repositoryState.delete(root)
        // 两次 rev-parse 之间切换了 HEAD 时，不能给 summary 搭配旧的 base 与新的签名。
        return cachedRepository(cwd)
      }
      return value
    } catch (error) {
      if (repositoryState.get(root) === entry) repositoryState.delete(root)
      throw error
    }
  })()
  repositoryState.set(root, entry)
  return entry.promise
}

/**
 * 侧栏与页脚只要仓库根和分支名。会话视图每 10 秒轮询一次，所以合并成一次
 * `rev-parse`（原来的 show-toplevel + verify HEAD + symbolic-ref 是三个进程）。
 */
export async function getWorkspaceStatus(cwd) {
  cwd = worktreeRoot(cwd)
  requireRepositoryDirectory(cwd)
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
    branch = (
      await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
    ).trim()
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
  // 校验按真实路径做（防 `../` 与仓库外），删除必须落在用户点的那一项上：符号链接的
  // realpath 是它指向的文件，按 realpath 删等于删掉仓库里另一个文件、把链接留成悬空。
  const absolutePath = path.resolve(root, filePath)
  try {
    safeFilePath(root, filePath)
  } catch (error) {
    // 链接指向仓库外时 realpath 会越界，但删掉链接本身是安全的：只校验它所在的目录。
    let link = false
    try {
      link = lstatSync(absolutePath).isSymbolicLink()
    } catch {
      link = false
    }
    if (!link) throw error
    safeFilePath(root, path.dirname(filePath))
  }
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
  const pathspec = `:(top,literal)${relative}`
  const tracked = await git(root, ['ls-files', '--cached', '-z', '--', pathspec])
  if (tracked) await git(root, ['restore', '--worktree', '--', pathspec])
  const untracked = (
    await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', pathspec])
  )
    .split('\0')
    .filter(Boolean)
  for (const filePath of untracked) {
    await rm(path.join(root, filePath), { force: true })
  }
  await pruneEmptyDirectories(root, absolute, untracked)
  noteWorktreeChange(root)
  return { removed: untracked.length, restored: relative }
}

/**
 * 删完未跟踪文件后顺手收掉空目录（git 不跟踪空目录，`git clean -fd` 同样会删）。
 * 只从刚删掉的文件往上走到所选目录，不清理所选目录以外的父目录。
 */
async function pruneEmptyDirectories(root, selectedDirectory, removedPaths) {
  const directories = new Set()
  for (const filePath of removedPaths) {
    let current = path.dirname(path.join(root, filePath))
    while (current === selectedDirectory || current.startsWith(selectedDirectory + path.sep)) {
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
