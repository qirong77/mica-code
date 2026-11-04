// 仓库变更的实时来源：盯住 `.git` 里那几个「一改就说明状态变了」的路径，
// 变化时让缓存立刻失效并把 `git:changed` 推给页面（见 server/index.js 的 broadcast）。
//
// 为什么不是把轮询调密：`git status` 是整棵工作区扫描（大仓库 1–2 秒），把它从 3 秒
// 改成 1 秒等于把 CPU 翻三倍，换来的还是「晚一点」。而提交、切分支、暂存这些动作
// **一定**会写 `.git` 里的文件，内核通知比任何轮询都早，成本只是一次回调。
// 工作区文件被 Mica 之外的进程改动时 `.git` 不会动，那种情形仍由轮询兜底。
import { readFileSync, statSync, watch } from 'node:fs'
import path from 'node:path'
import { noteWorktreeChange, repositoryRootOf } from './git-ops.js'

/** 连续写入（checkout 会同时改 HEAD、index、refs）合并成一次通知。 */
const DEBOUNCE_MS = 120
/** 同一仓库两次推送的最小间隔：终端里连跑几条 git 不该让页面扫好几遍。 */
const COOLDOWN_MS = 600
/** 页面都走了以后先留着，切回来不必重建 watcher；一直没有订阅者再关掉。 */
const IDLE_CLOSE_MS = 60_000

/**
 * 只关心「读出来的状态会因此变化」的路径：提交与切分支写 `refs/**` 和 `HEAD`，
 * 暂存写 `index`，重新打包写 `packed-refs`，冲突与 rebase 写各自的 `*_HEAD`。
 * `objects/`、`logs/`、`COMMIT_EDITMSG` 一次都不关心——那里面每次操作都在写。
 * `refs` 单独列一项：不支持递归 watch 时只会给到目录本身。
 */
const INTERESTING =
  /^(?:HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|index|packed-refs|refs)$|^refs\//
/** 锁文件是「正在写」的信号，写完一定还会再改一次真正的目标文件。 */
const IGNORED = /\.lock$/

/** 事件路径是不是值得刷新页面。导出来是为了能单测，不用真的起 watcher。 */
export function isGitStatePath(filename) {
  // 系统给不出文件名（个别平台/FSEvents 合并）时保守当作相关：多刷一次没有副作用。
  if (typeof filename !== 'string' || !filename) return true
  if (IGNORED.test(filename)) return false
  return INTERESTING.test(filename)
}

/** `.git` 的目录（worktree / 子模块那里 `.git` 是指向真实目录的文件）。 */
export function gitDirectoryOf(root) {
  const dotGit = path.join(root, '.git')
  try {
    const info = statSync(dotGit)
    if (info.isDirectory()) return dotGit
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8') || '')
    return match ? path.resolve(root, match[1].trim()) : null
  } catch {
    return null
  }
}

let broadcast = () => {}

/** 由运行时注入广播（server/index.js 的 SSE broadcast）。 */
export function setGitWatchBroadcaster(fn) {
  broadcast = typeof fn === 'function' ? fn : () => {}
}

/** root → { root, watchers, count, timer, pending, idle, lastAt } */
const watching = new Map()

function openWatchers(dir) {
  const onEvent = (_event, filename) => handleGitWatchEventFor(dir, filename)
  const opened = []
  try {
    // persistent: false —— watcher 不该把运行时进程留在前台。
    opened.push(watch(dir, { recursive: true, persistent: false }, onEvent))
    return opened
  } catch {
    // 不支持递归 watch 的运行时：退一步，把「refs 再往下两层」也各自盯上，够覆盖
    // 分支提交与远端分支更新；更深的 refs 层级交给轮询兜底。
  }
  for (const target of [dir, path.join(dir, 'refs'), path.join(dir, 'refs', 'heads')]) {
    try {
      opened.push(watch(target, { persistent: false }, onEvent))
    } catch {
      // 目录还不存在（空仓库没有 refs/heads）：跳过
    }
  }
  return opened
}

/** dir → root 的反查表，让 fs.watch 的回调能找回自己的 entry。 */
const rootByDir = new Map()

function handleGitWatchEventFor(dir, filename) {
  const root = rootByDir.get(dir)
  if (!root) return
  handleGitWatchEvent(root, filename)
}

/**
 * 一条 watcher 事件进来：过滤路径、合并连写，然后失效缓存并广播给页面。
 * `root` 是仓库根（`watchRepository` 的返回值），`filename` 是相对 `.git` 的路径。
 * 导出是为了能直接单测这条链路：真实事件由内核给，在测试运行时里拿不稳。
 */
export function handleGitWatchEvent(root, filename) {
  const entry = watching.get(root)
  if (!entry) return false
  if (!isGitStatePath(typeof filename === 'string' ? filename : '')) return false
  if (entry.timer) return false
  entry.timer = setTimeout(() => {
    entry.timer = null
    noteWorktreeChange(entry.root)
    const wait = COOLDOWN_MS - (Date.now() - entry.lastAt)
    if (wait > 0) {
      // 冷却期内：并进冷却结束后的那一次推送，别丢。
      if (!entry.pending) {
        entry.pending = setTimeout(() => {
          entry.pending = null
          entry.lastAt = Date.now()
          broadcast('git:changed', { root: entry.root })
        }, wait)
        entry.pending.unref?.()
      }
      return
    }
    entry.lastAt = Date.now()
    broadcast('git:changed', { root: entry.root })
  }, DEBOUNCE_MS)
  entry.timer.unref?.()
  return true
}

function create(root, dir) {
  const entry = {
    root,
    watchers: [],
    count: 0,
    timer: null,
    pending: null,
    idle: null,
    lastAt: 0
  }
  rootByDir.set(dir, root)
  const watchers = openWatchers(dir)
  if (!watchers.length) {
    rootByDir.delete(dir)
    return null
  }
  // 目录被删（仓库被移走）时别把错误抛到运行时里：关掉即可，轮询会发现目录不在了。
  for (const watcher of watchers) watcher.on('error', () => close(root))
  entry.watchers = watchers
  watching.set(root, entry)
  return entry
}

function close(root) {
  const entry = watching.get(root)
  if (!entry) return
  watching.delete(root)
  for (const [dir, mapped] of rootByDir) if (mapped === root) rootByDir.delete(dir)
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.pending) clearTimeout(entry.pending)
  if (entry.idle) clearTimeout(entry.idle)
  for (const watcher of entry.watchers) {
    try {
      watcher.close()
    } catch {
      // 已经自己关掉了
    }
  }
}

/**
 * 页面声明「我在看这个目录的仓库」。同一仓库被多个窗口/多次挂载订阅只开一份
 * watcher，引用计数归零后延迟关闭。不是仓库时回 `{ root: null }`。
 */
export function watchRepository(directory) {
  const root = repositoryRootOf(directory)
  if (!root) return { root: null }
  let entry = watching.get(root)
  if (!entry) {
    const dir = gitDirectoryOf(root)
    if (!dir) return { root: null }
    entry = create(root, dir)
    if (!entry) return { root: null }
  }
  if (entry.idle) {
    clearTimeout(entry.idle)
    entry.idle = null
  }
  entry.count += 1
  return { root }
}

/** 页面卸载时撤销订阅。不认识的目录什么都不做。 */
export function unwatchRepository(directory) {
  const root = repositoryRootOf(directory)
  const entry = root ? watching.get(root) : null
  if (!entry) return { root: root || null }
  entry.count = Math.max(0, entry.count - 1)
  if (entry.count === 0 && !entry.idle) {
    entry.idle = setTimeout(() => {
      entry.idle = null
      if (entry.count === 0) close(entry.root)
    }, IDLE_CLOSE_MS)
    entry.idle.unref?.()
  }
  return { root }
}

/** 运行时退出（测试、重载）时把所有 watcher 收掉。 */
export function disposeGitWatchers() {
  for (const root of [...watching.keys()]) close(root)
}
