import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { ipcMain } from 'electron'
import {
  baseBranchLabel,
  compareChangePaths,
  isBaseBranch,
  parseNameStatus,
  parseNumstat,
  parseStatusCode,
  statusFromCode
} from './git-core'
import { discardFile, getRepository, git, stageFile, unstageFile } from './git-ops'

// 基线分支候选：远端默认分支（origin/HEAD）优先，其次是常见的 master/main。
const BASE_CANDIDATES = ['origin/master', 'origin/main', 'master', 'main']

function countLines(buffer) {
  if (!buffer.length) return 0
  let count = 0
  for (const byte of buffer) if (byte === 10) count += 1
  return count + (buffer.at(-1) === 10 ? 0 : 1)
}

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

/** 当前分支名（短名）。detached HEAD 或读取失败时返回 null。 */
async function currentBranchName(root) {
  try {
    const ref = (await git(root, ['symbolic-ref', '--quiet', 'HEAD'])).trim()
    if (!ref) return null
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
  } catch {
    return null
  }
}

async function refExists(root, ref) {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

/**
 * GIT TREE 面板要比的基线分支：远端默认分支（`origin/HEAD`，例如 origin/master）
 * 优先，退回到常见的 origin/master、origin/main、master、main。
 * 当前分支自己就在基线上（例如停在 master）、没有远端也没有主分支、detached HEAD
 * 时返回 null —— 此时「相对基线的变更」恒为空，调用方要退回工作区语义，
 * 否则面板会在主分支上永远显示「没有变更」。
 */
async function resolveBaseRef(root) {
  const current = await currentBranchName(root)
  let remoteHead = null
  try {
    remoteHead = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
  } catch {
    // 没有远端，或远端没设默认分支：只用本地候选。
  }
  for (const ref of [remoteHead, ...BASE_CANDIDATES].filter(Boolean)) {
    if (isBaseBranch(ref, current)) return null
    if (await refExists(root, ref)) return ref
  }
  return null
}

async function mergeBaseFor(root, base) {
  try {
    return (await git(root, ['merge-base', base, 'HEAD'])).trim() || null
  } catch {
    // 没有共同祖先（无关历史）：没有可比的基线。
    return null
  }
}

/**
 * 当前分支相对基线分支的变更：从 merge-base 一直比到工作区，所以既包含已经提交
 * 的分支改动，也包含还没提交的工作区改动（含未跟踪文件）。GIT TREE 面板用它，
 * 「这个分支带来了什么」在提交前后都看得见。
 */
async function getBranchSummary(cwd) {
  const { root } = await getRepository(cwd)
  const base = await resolveBaseRef(root)
  const mergeBase = base ? await mergeBaseFor(root, base) : null
  if (!base || !mergeBase) return { root, base: null, baseLabel: null, files: [] }
  const [statusOutput, untrackedOutput] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', '--no-renames', mergeBase]),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  const changes = parseNameStatus(statusOutput)
  for (const filePath of untrackedOutput.split('\0')) {
    if (filePath) changes.set(filePath, 'added')
  }
  const files = [...changes]
    .map(([filePath, status]) => ({ path: filePath, status }))
    .sort((left, right) => compareChangePaths(left.path, right.path))
  return { root, base, baseLabel: baseBranchLabel(base), files }
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

function safeFilePath(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath)
  const relative = path.relative(root, absolutePath)
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Invalid repository path')
  return absolutePath
}

function errorMessage(error) {
  return error?.stderr?.trim() || error?.message || String(error)
}

function parseRefs(output, kind) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, hash, date, author, subject, current, upstream, tracking] = line.split('\0')
      const prefix = kind === 'branch' ? 'refs/heads/' : 'refs/tags/'
      return {
        name: ref.startsWith(prefix) ? ref.slice(prefix.length) : ref,
        ref,
        kind,
        hash,
        date,
        author,
        subject,
        current: current === '*',
        upstream: upstream || null,
        tracking: tracking || null
      }
    })
}

async function getRefs(cwd) {
  const { root } = await getRepository(cwd)
  const format = [
    '%(refname)',
    '%(objectname:short)',
    '%(committerdate:relative)',
    '%(authorname)',
    '%(subject)',
    '%(HEAD)',
    '%(upstream:short)',
    '%(upstream:track)'
  ].join('%00')
  const tagFormat = [
    '%(refname)',
    '%(objectname:short)',
    '%(creatordate:relative)',
    '%(authorname)',
    '%(subject)',
    '',
    '',
    ''
  ].join('%00')
  const [branchesOutput, tagsOutput] = await Promise.all([
    git(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads']),
    git(root, ['for-each-ref', '--sort=-creatordate', `--format=${tagFormat}`, 'refs/tags'])
  ])
  const branches = parseRefs(branchesOutput, 'branch').sort(
    (left, right) => Number(right.current) - Number(left.current)
  )
  return { root, branches, tags: parseRefs(tagsOutput, 'tag') }
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
      return { status: null, error: errorMessage(error) }
    }
  })

  ipcMain.handle('git:summary', async (_event, { cwd } = {}) => {
    try {
      return { repository: await getSummary(cwd), error: null }
    } catch (error) {
      return { repository: null, error: errorMessage(error) }
    }
  })

  ipcMain.handle('git:branch-summary', async (_event, { cwd } = {}) => {
    try {
      return { repository: await getBranchSummary(cwd), error: null }
    } catch (error) {
      return { repository: null, error: errorMessage(error) }
    }
  })

  ipcMain.handle('git:refs', async (_event, { cwd } = {}) => {
    try {
      return { refs: await getRefs(cwd), error: null }
    } catch (error) {
      return { refs: null, error: errorMessage(error) }
    }
  })

  ipcMain.handle('git:checkout', async (_event, { cwd, ref } = {}) => {
    try {
      return { status: await checkoutBranch(cwd, ref), error: null }
    } catch (error) {
      return { status: null, error: errorMessage(error) }
    }
  })

  ipcMain.handle('git:create-branch', async (_event, { cwd, name, startRef } = {}) => {
    try {
      return { status: await createBranch(cwd, name, startRef), error: null }
    } catch (error) {
      return { status: null, error: errorMessage(error) }
    }
  })

  ipcMain.handle('git:file', async (_event, { cwd, filePath, base: mode } = {}) => {
    const { root, base: head } = await getRepository(cwd)
    // GIT TREE 里的文件是「相对基线分支」的变更，原始版本要取 merge-base 而不是
    // HEAD（分支上的改动已经提交过，跟 HEAD 比只会得到空 diff）；没有基线时退回
    // HEAD，不能因此报错。
    let base = head
    if (mode === 'branch') {
      const baseRef = await resolveBaseRef(root)
      base = (baseRef && (await mergeBaseFor(root, baseRef))) || head
    }
    const absolutePath = safeFilePath(root, filePath)
    let original = Buffer.alloc(0)
    let modified = Buffer.alloc(0)
    try {
      original = await git(root, ['show', `${base}:${filePath}`], { encoding: 'buffer' })
    } catch {
      // New files have no original content.
    }
    if (existsSync(absolutePath)) modified = await readFile(absolutePath)
    const binary = original.includes(0) || modified.includes(0)
    return {
      original: binary ? '' : original.toString('utf8'),
      modified: binary ? '' : modified.toString('utf8'),
      binary
    }
  })

  // 以下三个是写操作（对应 VS Code 源代码管理里行内悬浮出来的按钮）。
  // 路径一律经 `safeFilePath` 校验，越出仓库直接报错。
  ipcMain.handle('git:stage', async (_event, { cwd, filePath } = {}) => {
    try {
      await stageFile(cwd, filePath)
      return { error: null }
    } catch (error) {
      return { error: errorMessage(error) }
    }
  })

  ipcMain.handle('git:unstage', async (_event, { cwd, filePath } = {}) => {
    try {
      await unstageFile(cwd, filePath)
      return { error: null }
    } catch (error) {
      return { error: errorMessage(error) }
    }
  })

  // 不可逆：调用方（渲染层）必须先确认。
  ipcMain.handle('git:discard', async (_event, { cwd, filePath } = {}) => {
    try {
      await discardFile(cwd, filePath)
      return { error: null }
    } catch (error) {
      return { error: errorMessage(error) }
    }
  })
}
