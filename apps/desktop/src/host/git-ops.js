// Git 写操作：暂存 / 取消暂存 / 放弃更改。读操作留在 `git.js`（那里注册 IPC）。
// 这里不 import electron，好处是单测能对着临时仓库跑真实 git。
import { execFile } from 'child_process'
import { rm } from 'fs/promises'
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
export function safeFilePath(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath)
  const relative = path.relative(root, absolutePath)
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Invalid repository path')
  return absolutePath
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
    return
  }
  await rm(absolutePath, { force: true })
}
