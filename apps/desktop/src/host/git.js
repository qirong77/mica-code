import { readFile } from 'fs/promises'
import path from 'path'
import { ipcMain } from 'electron'
import {
  baseBranchLabel,
  compareChangePaths,
  parseNumstat,
  parseStatusCode,
  statusFromCode,
  sumLineChanges
} from './git-core'
import {
  countLines,
  getBranchSummary,
  getFile,
  getRefSummary,
  getRefs,
  resolveRef as resolveCompareRef
} from './git-compare'
import {
  cachedWorktreeRead,
  discardFile,
  discardDirectory,
  cachedRepository,
  getRepository,
  repositoryRootOf,
  getWorkspaceStatus,
  git,
  gitErrorMessage,
  stageFile,
  unstageFile,
  worktreeEpochOf,
  worktreeSignature
} from './git-ops'
import { blameLine } from './git-blame'
import { getCommit, getLog } from './git-log'
import { releaseWatchers, unwatchRepository, watchRepository } from './git-watch'

/** 徽标自己那一层缓存：比全树扫描的 5s 长，配合「先回旧值、后台重算」。 */
const CHANGE_COUNTS_TTL_MS = 20_000
const changeCountsState = new Map()

async function getSummary(cwd, { refresh = false } = {}) {
  const { root, base } = await cachedRepository(cwd)
  // 顶栏徽标（change-counts）与 Git 面板（summary）要的是同一份全树扫描，10s 的 Git
  // 轮询 + 3s 的文件视图轮询又会各自来一次：同一仓库在几秒内复用结果，切换分支或
  // 我们自己写过工作区（stage/unstage/discard）时缓存自动失效。
  return cachedWorktreeRead(root, `summary:${base}`, () => readSummary(root, base), { refresh })
}

async function readSummary(root, base) {
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
  return { root, files, ...sumLineChanges(files) }
}

/**
 * 顶栏徽标只要「多少变更」：文件数与加/删行合计。故意复用 `getSummary` 而不是另算
 * 一遍——徽标和 GIT 面板显示的是同一个工作区，数字不一致比数字不准更糟。
 *
 * 这一步是**整棵工作区的扫描**（`status --untracked-files=all` + `diff --numstat`），
 * 大仓库上单次要 1–2 秒，超时的那几次能到 20 秒以上。页面每 20 秒问一次，就得让主进程
 * 每 20 秒完整扫一遍；窗口开得多时还会互相叠。所以这里再套一层：
 * - 20 秒内的同一仓库直接返回（多个窗口共用一次扫描）；
 * - 过期后**先回旧值**，后台重算，下一次轮询就拿到新的——徽标是个数字，晚 20 秒
 *   更新看不出来，把一次全树扫描挡在 IPC 之外却是实打实的；
 * - 切分支 / 提交（HEAD 变了）、我们改过工作区（stage / discard / 保存文件）时不许
 *   返回旧值：那时数字必须立刻对得上。
 */
async function getChangeCounts(cwd, { refresh = false } = {}) {
  const { root, base } = await cachedRepository(cwd)
  const key = `${root}\u0000${base}`
  const signature = `${worktreeSignature(root) || ''}|${worktreeEpochOf(root)}`
  const cached = changeCountsState.get(key)
  const fresh =
    !refresh &&
    cached &&
    cached.signature === signature &&
    Date.now() - cached.at < CHANGE_COUNTS_TTL_MS
  if (fresh) return cached.value

  const read = async () => {
    // 与 `getSummary` 共用同一份缓存（同一次全树扫描），但只把三个数字交出去：文件列表
    // 在几千个改动时会占掉 IPC 的绝大部分体积，徽标并不需要它。
    const summary = await cachedWorktreeRead(
      root,
      `summary:${base}`,
      () => readSummary(root, base),
      { refresh }
    )
    return {
      root: summary.root,
      files: summary.files.length,
      additions: summary.additions,
      deletions: summary.deletions
    }
  }

  // 没有旧值可用（第一次问、刚切分支、我们刚改过工作区）或用户主动刷新：这次必须等。
  if (!cached || refresh || cached.signature !== signature) {
    const value = await read()
    changeCountsState.set(key, { signature, at: Date.now(), value, refreshing: false })
    return value
  }

  // 旧值还在手：立刻返回，后台补一次。
  if (!cached.refreshing) {
    cached.refreshing = true
    void read()
      .then((value) => {
        // 读的过程中可能有一轮 `refresh` 已经写入更新的数字（一轮对话刚结束、用户主动
        // 刷新）：那份比这次后台重算新，用它顶掉会重新计时 20 秒，徽标反而停在过去。
        if (changeCountsState.get(key) !== cached) return
        // 存读之前那份签名（与前台路径一致）：读的过程中切了分支的话，这份数字属于旧
        // HEAD，配上新签名会被当成 fresh，之后再 20s 都不重算。
        changeCountsState.set(key, {
          signature,
          at: Date.now(),
          value,
          refreshing: false
        })
      })
      .catch(() => {
        const current = changeCountsState.get(key)
        if (current) current.refreshing = false
      })
  }
  return cached.value
}

/**
 * 仓库身份（根目录 / 分支 / 项目名）的读取。
 *
 * 每次都要 spawn 一次 `git rev-parse`，而每个窗口都在轮询它：编辑器页 3s、主窗口 10s，
 * 开着 8 个窗口时实测每 4s 一次、一天两千多次。机器被别的东西拖慢到一次 spawn 要几秒
 * 时，这些调用会互相叠上来（实测同时 4 个），越叠越慢。
 *
 * 与全树扫描共用 `cachedWorktreeRead`：`headSignature` 已经把「切分支 / 提交」算作失效，
 * 所以检出之后立刻读到的就是新分支名，不需要额外打点。
 */
async function getStatus(cwd) {
  const root = repositoryRootOf(cwd)
  if (!root) return getWorkspaceStatus(cwd)
  return cachedWorktreeRead(root, 'workspace-status', () => getWorkspaceStatus(root))
}
async function resolveRef(cwd, ref, kinds = ['branch', 'tag']) {
  const refs = await getRefs(cwd)
  const values = [...refs.branches, ...refs.tags]
  const match = values.find((item) => kinds.includes(item.kind) && item.ref === ref)
  if (!match) throw new Error('所选 Git 引用已不存在，请刷新后重试')
  return { root: refs.root, match }
}

async function createBranch(cwd, name) {
  const branch = typeof name === 'string' ? name.trim() : ''
  if (!branch) throw new Error('请输入分支名称')
  const { root } = await getRepository(cwd)
  await git(root, ['check-ref-format', '--branch', branch])
  await git(root, ['checkout', '-b', branch])
  return getStatus(root)
}

async function checkoutBranch(cwd, ref) {
  const { root, match } = await resolveRef(cwd, ref, ['branch', 'remote'])
  // 远端分支不能直接签出（那会停在游离 HEAD 上）：本地没有同名分支时建一个跟踪它的
  // 新分支，已经有就直接签出本地那条——与 VS Code 的分支选择器一致。
  const fromRemote = match.kind === 'remote'
  const name = fromRemote ? baseBranchLabel(match.name) : match.name
  if (!name) throw new Error('所选 Git 引用已不存在，请刷新后重试')
  if (name.startsWith('-')) throw new Error('不支持签出以连字符开头的分支')
  await git(root, ['check-ref-format', '--branch', name])
  if (fromRemote && !(await hasLocalBranch(root, name))) {
    await git(root, ['checkout', '--track', match.name])
  } else {
    await git(root, ['checkout', name])
  }
  return getStatus(root)
}

async function hasLocalBranch(root, name) {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    return true
  } catch {
    return false
  }
}

// 目录不是仓库是常态（主目录、临时目录、还没 init 的项目），不是失败：回 `error: null`
// 让调用方当成「这里没有仓库」。否则每 10s 的 `git:status` 都会在日志与 Performance
// 面板里记成一次失败，真正要看的错误被埋掉。
const NOT_A_REPOSITORY = /not a git repository/i
function workspaceError(error) {
  const message = gitErrorMessage(error)
  return NOT_A_REPOSITORY.test(message) ? null : message
}

/**
 * 已经挂过生命周期监听的 webContents。页面刷新 / 崩溃时旧页面来不及发 `git:unwatch`，
 * 它留下的订阅只能由宿主代撤（见 host/git-watch.js 的 `releaseWatchers`）。
 * 同一 webContents 只挂一次：每次 watch 都挂 `once` 会让 listener 一直堆着。
 */
const sendersWithLifecycle = new WeakSet()

function trackSenderLifecycle(sender) {
  if (!sender || typeof sender !== 'object' || sendersWithLifecycle.has(sender)) return
  sendersWithLifecycle.add(sender)
  // 服务端模式（server/electron-shim.js）的 sender 是进程内单例，没有 webContents 生命周期。
  if (typeof sender.on !== 'function' || typeof sender.once !== 'function') return
  const id = sender.id
  // 重新加载一开头就触发（⌘R / 崩溃后的 reload）：此时旧页面的订阅还在，新页面还没开始
  // watch，按 id 清掉正合适；晚到的 unwatch 删的是集合里不存在的成员，不会误伤别的页面。
  sender.on('did-start-loading', () => releaseWatchers(id))
  // 渲染进程崩掉、又没有自动重载时，不会再触发 did-start-loading：这里也撤一次。
  sender.on('render-process-gone', () => releaseWatchers(id))
  // 窗口关掉之后这个 id 不会再用，监听留 `once` 就够。
  sender.once('destroyed', () => releaseWatchers(id))
}

export function registerGitIpc() {
  // 页面声明「我在看这个仓库」：宿主对 `.git` 起 fs.watch，提交 / 切分支 / 暂存
  // 一发生就 `git:changed` 推过来，不必等下一轮轮询（见 host/git-watch.js）。
  // 订阅者记成发送方 webContents 的 id，页面被换掉时宿主能代它撤销。
  ipcMain.handle('git:watch', (event, { cwd } = {}) => {
    trackSenderLifecycle(event.sender)
    return watchRepository(cwd, event.sender?.id)
  })

  ipcMain.handle('git:unwatch', (event, { cwd } = {}) =>
    unwatchRepository(cwd, event.sender?.id)
  )

  ipcMain.handle('git:status', async (_event, { cwd } = {}) => {
    try {
      return { status: await getStatus(cwd), error: null }
    } catch (error) {
      return { status: null, error: workspaceError(error) }
    }
  })

  ipcMain.handle('git:summary', async (_event, { cwd, refresh } = {}) => {
    try {
      return { repository: await getSummary(cwd, { refresh: refresh === true }), error: null }
    } catch (error) {
      return { repository: null, error: workspaceError(error) }
    }
  })

  ipcMain.handle('git:change-counts', async (_event, { cwd, refresh } = {}) => {
    try {
      return {
        counts: await getChangeCounts(cwd, { refresh: refresh === true }),
        error: null
      }
    } catch (error) {
      return { counts: null, error: workspaceError(error) }
    }
  })

  ipcMain.handle('git:branch-summary', async (_event, { cwd, base, direct } = {}) => {
    try {
      return { repository: await getBranchSummary(cwd, { base, direct }), error: null }
    } catch (error) {
      return { repository: null, error: gitErrorMessage(error) }
    }
  })

  // 分支对分支（PR 视图）：`head` 相对主分支的改动，不读工作区，也不改任何目录。
  ipcMain.handle('git:ref-summary', async (_event, { cwd, head, base, direct } = {}) => {
    try {
      return { repository: await getRefSummary(cwd, { head, base, direct }), error: null }
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

  ipcMain.handle('git:create-branch', async (_event, { cwd, name } = {}) => {
    try {
      return { status: await createBranch(cwd, name), error: null }
    } catch (error) {
      return { status: null, error: gitErrorMessage(error) }
    }
  })

  ipcMain.handle('git:resolve-ref', (_event, { cwd, ref } = {}) => resolveCompareRef(cwd, ref))

  ipcMain.handle('git:file', (_event, { cwd, filePath, base, options } = {}) =>
    getFile(cwd, filePath, options || base)
  )

  // 行悬停用：`{ ref, index, line }` 三种取值口径见 `git-blame.js`；读失败（文件不在
  // 那个提交里、还没提交过）回 `{ error }` 而不是抛错——悬停不该把界面变成红字。
  ipcMain.handle('git:blame', (_event, { cwd, filePath, ref = null, index = false, line } = {}) =>
    blameLine(cwd, filePath, { ref, index: index === true, line })
  )

  // 图谱页面：提交历史（只读）与单条提交的详情。
  ipcMain.handle('git:log', async (_event, { cwd, ref = null, max, skip } = {}) => {
    try {
      return { history: await getLog(cwd, { ref, max, skip }), error: null }
    } catch (error) {
      return { history: null, error: gitErrorMessage(error) }
    }
  })

  ipcMain.handle('git:commit', async (_event, { cwd, hash } = {}) => {
    try {
      return { detail: await getCommit(cwd, hash), error: null }
    } catch (error) {
      return { detail: null, error: gitErrorMessage(error) }
    }
  })

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

  // 文件夹级回退：目录下所有已跟踪的文件回到索引里那份，未跟踪文件删掉。同样不可逆。
  ipcMain.handle('git:discard-dir', async (_event, { cwd, dirPath } = {}) => {
    try {
      return { result: await discardDirectory(cwd, dirPath), error: null }
    } catch (error) {
      return { result: null, error: gitErrorMessage(error) }
    }
  })
}
