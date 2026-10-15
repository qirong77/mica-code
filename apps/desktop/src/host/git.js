import { readFile } from 'fs/promises'
import path from 'path'
import { ipcMain } from 'electron'
import { compareChangePaths, parseNumstat, parseStatusCode, statusFromCode } from './git-core'
import {
  countLines,
  currentBranchName,
  getBranchSummary,
  getFile,
  getRefs,
  resolveRef as resolveCompareRef
} from './git-compare'
import { discardFile, getRepository, git, gitErrorMessage, stageFile, unstageFile } from './git-ops'

async function getSummary(cwd) {
  const { root, base } = await getRepository(cwd)
  const [statusOutput, numstatOutput] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
    git(root, ['diff', base, '--numstat', '--no-renames', '--'])
  ])
  const codes = parseStatusCode(statusOutput)
  const numstats = parseNumstat(numstatOutput)
  const files = []

  for (const [filePath, code] of codes) {
    const status = statusFromCode(code)
    let stat = numstats.get(filePath)
    if (!stat && status === 'added') {
      let content
      try {
        content = await readFile(path.join(root, filePath))
      } catch {
        // A staged addition removed again from the worktree has no final diff against HEAD.
        continue
      }
      stat = {
        additions: content.includes(0) ? 0 : countLines(content),
        deletions: 0,
        binary: content.includes(0)
      }
    }
    files.push({
      path: filePath,
      status,
      // 原始两字符 `XY`：索引侧 + 工作区侧。源代码管理面板按它分
      // 「暂存的更改 / 更改」两段（未跟踪是 `??`，只算工作区侧）。
      code,
      additions: stat?.additions || 0,
      deletions: stat?.deletions || 0,
      binary: stat?.binary || false
    })
  }

  files.sort((a, b) => compareChangePaths(a.path, b.path))
  return {
    root,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  }
}

async function getStatus(cwd) {
  const { root } = await getRepository(cwd)
  const branch = await currentBranchName(root)
  if (!branch) {
    const hash = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim()
    return {
      root,
      branch: hash ? `detached@${hash}` : 'detached',
      projectName: path.basename(root)
    }
  }
  return {
    root,
    branch,
    projectName: path.basename(root)
  }
}

async function resolveRef(cwd, ref, kinds = ['branch', 'tag']) {
  const refs = await getRefs(cwd)
  const values = [...refs.branches, ...refs.tags]
  const match = values.find((item) => kinds.includes(item.kind) && item.ref === ref)
  if (!match) throw new Error('所选 Git 引用已不存在，请刷新后重试')
  return { root: refs.root, match }
}

async function createBranch(cwd, name, startRef) {
  const branch = typeof name === 'string' ? name.trim() : ''
  if (!branch) throw new Error('请输入分支名称')
  const { root } = await getRepository(cwd)
  await git(root, ['check-ref-format', '--branch', branch])
  let start
  if (startRef) start = (await resolveRef(root, startRef)).match.ref
  await git(root, ['checkout', '-b', branch, ...(start ? [start] : [])])
  return getStatus(root)
}

async function checkoutBranch(cwd, ref) {
  const { root, match } = await resolveRef(cwd, ref, ['branch'])
  if (match.name.startsWith('-')) throw new Error('不支持签出以连字符开头的分支')
  await git(root, ['check-ref-format', '--branch', match.name])
  await git(root, ['checkout', match.name])
  return getStatus(root)
}

export function registerGitIpc() {
  ipcMain.handle('git:status', async (_event, { cwd } = {}) => {
    try {
      return { status: await getStatus(cwd), error: null }
    } catch (error) {
      return { status: null, error: gitErrorMessage(error) }
    }
  })

  ipcMain.handle('git:summary', async (_event, { cwd } = {}) => {
    try {
      return { repository: await getSummary(cwd), error: null }
    } catch (error) {
      return { repository: null, error: gitErrorMessage(error) }
    }
  })

  ipcMain.handle('git:branch-summary', async (_event, { cwd, base, direct } = {}) => {
    try {
      return { repository: await getBranchSummary(cwd, { base, direct }), error: null }
    } catch (error) {
      return { repository: null, error: gitErrorMessage(error) }
    }
  })

  ipcMain.handle('git:refs', async (_event, { cwd } = {}) => {
    try {
      return { refs: await getRefs(cwd), error: null }
    } catch (error) {
      return { refs: null, error: gitErrorMessage(error) }
    }
  })

  ipcMain.handle('git:checkout', async (_event, { cwd, ref } = {}) => {
    try {
      return { status: await checkoutBranch(cwd, ref), error: null }
    } catch (error) {
      return { status: null, error: gitErrorMessage(error) }
    }
  })

  ipcMain.handle('git:create-branch', async (_event, { cwd, name, startRef } = {}) => {
    try {
      return { status: await createBranch(cwd, name, startRef), error: null }
    } catch (error) {
      return { status: null, error: gitErrorMessage(error) }
    }
  })

  ipcMain.handle('git:resolve-ref', (_event, { cwd, ref } = {}) => resolveCompareRef(cwd, ref))

  ipcMain.handle('git:file', (_event, { cwd, filePath, base, options } = {}) =>
    getFile(cwd, filePath, options || base)
  )

  // 以下三个是写操作（对应 VS Code 源代码管理里行内悬浮出来的按钮）。
  // 路径一律经 `safeFilePath` 校验，越出仓库直接报错。
  ipcMain.handle('git:stage', async (_event, { cwd, filePath } = {}) => {
    try {
      await stageFile(cwd, filePath)
      return { error: null }
    } catch (error) {
      return { error: gitErrorMessage(error) }
    }
  })

  ipcMain.handle('git:unstage', async (_event, { cwd, filePath } = {}) => {
    try {
      await unstageFile(cwd, filePath)
      return { error: null }
    } catch (error) {
      return { error: gitErrorMessage(error) }
    }
  })

  // 不可逆：调用方（渲染层）必须先确认。
  ipcMain.handle('git:discard', async (_event, { cwd, filePath } = {}) => {
    try {
      await discardFile(cwd, filePath)
      return { error: null }
    } catch (error) {
      return { error: gitErrorMessage(error) }
    }
  })
}
