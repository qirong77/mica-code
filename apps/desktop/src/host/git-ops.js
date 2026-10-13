// Git 写操作：暂存 / 取消暂存 / 放弃更改。读操作留在 `git.js`（那里注册 IPC）。
// 这里不 import electron，好处是单测能对着临时仓库跑真实 git。
import { execFile } from 'child_process'
import { rm } from 'fs/promises'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** 没有第一个提交的仓库用它当「原始版本」（git 的空树对象）。 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export async function git(cwd, args, options = {}) {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  return result.stdout
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
