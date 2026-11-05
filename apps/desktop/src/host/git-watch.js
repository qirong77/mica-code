// 仓库变更的实时来源，两个 watcher 各管一类变化，都只做「失效缓存 + 推一次」：
// - `.git` 里那几个「一改就说明状态变了」的路径（提交 / 切分支 / 暂存 / rebase）；
// - 工作区本身（agent 改文件、在终端里跑命令改文件、别的编辑器保存）。后一种不写 `.git`，
//   只靠 `.git` 监听永远等不到，而 `git status` 是整棵扫描（大仓库 1–2 秒），把轮询调密
//   等于按秒烧 CPU 换「还是晚一点」。内核通知只在真有人写文件时才有回调。
//
// 工作区这一路的成本全在事件量和重扫频率上，所以：构建产物 / 依赖目录（构建、装依赖时
// 会刷出几万个事件）一律不看；连写合并成一次；两次推送的最小间隔按上一次扫描的实测耗时
// 放大（见 worktreeCooldown），保证扫描占用的 CPU 有上限。空闲时两条 watcher 都不产生
// 任何扫描，轮询只是兜底。
import { readFileSync, statSync, watch } from 'node:fs'
import path from 'node:path'
import { noteWorktreeChange, repositoryRootOf, summaryScanCostOf } from './git-ops.js'

/** 连续写入（checkout 会同时改 HEAD、index、refs）合并成一次通知。 */
const DEBOUNCE_MS = 120
/** 同一仓库两次推送的最小间隔：终端里连跑几条 git 不该让页面扫好几遍。 */
const COOLDOWN_MS = 600
/**
 * 工作区那一路的节奏：保存 / 格式化 / 一次工具调用常常连着写几个文件，
 * 500ms 的窗口把它们并成一次；两次推送之间至少 2 秒，扫描慢的大仓库再放大
 * （`summaryScanCostOf` × 4，上限 10 秒）。
 */
const WORKTREE_DEBOUNCE_MS = 500
const WORKTREE_MIN_COOLDOWN_MS = 2_000
const WORKTREE_MAX_COOLDOWN_MS = 10_000
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

/**
 * 工作区事件里不值得让页面重扫的路径：任何一段命中这些目录就不看。
 *
 * 它们几乎都被 `.gitignore`（构建产物、依赖、缓存、临时目录），一次构建或装依赖会在
 * 里面刷出几万个事件——真要因为 `dist/` 变了而重扫一遍，徽标还是那几个数字。编辑器自己
 * 产生的零碎文件（`.DS_Store`、vim 交换文件、`~` 备份）同理。
 */
const WORKTREE_IGNORED =
  /(?:^|\/)(?:\.git|node_modules|dist|out|build|coverage|\.next|\.turbo|\.cache|\.venv|__pycache__|temp|\.backups)(?:\/|$)|(?:^|\/)\.DS_Store$|~$|\.sw[px]$/

/** 事件路径是不是值得刷新页面。导出来是为了能单测，不用真的起 watcher。 */
export function isGitStatePath(filename) {
  // 系统给不出文件名（个别平台/FSEvents 合并）时保守当作相关：多刷一次没有副作用。
  if (typeof filename !== 'string' || !filename) return true
  if (IGNORED.test(filename)) return false
  return INTERESTING.test(filename)
}

/**
 * 工作区事件里的这个路径值不值得重扫一遍。`filename` 是相对仓库根的路径（递归 watch
 * 在 macOS 上给的就是这个）。给不出文件名时保守当作相关，与 `.git` 那一路一致。
 */
export function isWorktreePath(filename) {
  if (typeof filename !== 'string' || !filename) return true
  return !WORKTREE_IGNORED.test(filename)
}

/** 上一次扫描越贵，两次工作区推送之间就隔得越久：扫描占用的 CPU 不超过四分之一。 */
function worktreeCooldown(root) {
  const cost = summaryScanCostOf(root)
  return Math.min(WORKTREE_MAX_COOLDOWN_MS, Math.max(WORKTREE_MIN_COOLDOWN_MS, cost * 4))
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

/**
 * 没传订阅者时的公共身份：不传 id 的多次 watch 仍算同一个订阅。用 Symbol 而不是字符串，
 * 免得和真实 id（webContents id 是数字）撞上。服务端模式的 sender 没有 id，走的也是这里。
 */
const ANONYMOUS = Symbol('anonymous')

/** root → { root, watchers, subscribers, timer, pending, idle, lastAt } */
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
  // 非递归 watch 给的 filename 是**相对被监听目录**的（盯 `refs/heads` 时提交给出的是
  // `main`），要补回相对 `.git` 的前缀再判断，否则这些 watcher 一个事件都命中不了。
  for (const relative of ['', 'refs', path.join('refs', 'heads')]) {
    const target = relative ? path.join(dir, relative) : dir;
    const onNestedEvent = (_event, filename) =>
      handleGitWatchEventFor(dir, nestedWatchPath(relative, filename));
    try {
      opened.push(watch(target, { persistent: false }, onNestedEvent))
    } catch {
      // 目录还不存在（空仓库没有 refs/heads）：跳过
    }
  }
  return opened
}

/**
 * 非递归 watcher 给的相对文件名 → 相对 `.git` 的路径。
 *
 * `fs.watch` 的 filename 永远相对**被监听的那个目录**：盯 `refs/heads` 时一次提交给的是
 * `main`，而 `isGitStatePath` 只认 `refs/...`。导出来是为了能直接单测这段换算。
 */
export function nestedWatchPath(relative, filename) {
  if (typeof filename !== 'string' || !filename) return filename
  return relative ? path.join(relative, filename) : filename
}

/**
 * 工作区那一路。只有支持递归 watch 的运行时才开：拿不到递归能力时**不做**退化
 * （逐个子目录各开一个 watcher 在大仓库上就是几万个 fd），这部分仍由轮询兜底。
 */
function openWorktreeWatcher(root) {
  try {
    const onEvent = (_event, filename) => handleWorktreeEvent(root, filename)
    const watcher = watch(root, { recursive: true, persistent: false }, onEvent)
    return watcher
  } catch {
    return null
  }
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

/**
 * 一条工作区事件进来：过滤路径、合并连写，然后失效缓存并广播。
 * 与 `.git` 那一路共用 `git:changed`，页面不必区分是谁让它刷新的。
 */
export function handleWorktreeEvent(root, filename) {
  const entry = watching.get(root)
  if (!entry) return false
  if (!isWorktreePath(typeof filename === 'string' ? filename : '')) return false
  if (entry.worktreeTimer) return false
  entry.worktreeTimer = setTimeout(() => {
    entry.worktreeTimer = null
    // 缓存立刻失效：等这次推送送到页面时，读到的已经是改完之后的工作区。
    noteWorktreeChange(entry.root)
    const wait = worktreeCooldown(entry.root) - (Date.now() - entry.worktreeAt)
    if (wait > 0) {
      // 冷却期内：并进冷却结束后的那一次推送，别丢。
      if (!entry.worktreePending) {
        entry.worktreePending = setTimeout(() => {
          entry.worktreePending = null
          entry.worktreeAt = Date.now()
          broadcast('git:changed', { root: entry.root })
        }, wait)
        entry.worktreePending.unref?.()
      }
      return
    }
    entry.worktreeAt = Date.now()
    broadcast('git:changed', { root: entry.root })
  }, WORKTREE_DEBOUNCE_MS)
  entry.worktreeTimer.unref?.()
  return true
}

function create(root, dir) {
  const entry = {
    root,
    watchers: [],
    subscribers: new Set(),
    timer: null,
    pending: null,
    worktree: null,
    worktreeTimer: null,
    worktreePending: null,
    worktreeAt: 0,
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
  entry.worktree = openWorktreeWatcher(root)
  entry.worktree?.on('error', () => {
    // 工作区那一路挂掉不该连带关掉 `.git` 监听：那一路仍能给出提交 / 切分支。
    try {
      entry.worktree?.close()
    } catch {
      // 已经自己关掉了
    }
    entry.worktree = null
  })
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
  if (entry.worktreeTimer) clearTimeout(entry.worktreeTimer)
  if (entry.worktreePending) clearTimeout(entry.worktreePending)
  if (entry.idle) clearTimeout(entry.idle)
  try {
    entry.worktree?.close()
  } catch {
    // 已经自己关掉了
  }
  for (const watcher of entry.watchers) {
    try {
      watcher.close()
    } catch {
      // 已经自己关掉了
    }
  }
}

/** 订阅者集合空了：先留着 watcher（页面切回来不必重建），一直没人再来才关掉。 */
function closeWhenIdle(entry) {
  if (entry.subscribers.size || entry.idle) return
  entry.idle = setTimeout(() => {
    entry.idle = null
    if (!entry.subscribers.size) close(entry.root)
  }, IDLE_CLOSE_MS)
  entry.idle.unref?.()
}

/**
 * 页面声明「我在看这个目录的仓库」。同一仓库被多个窗口/多次挂载订阅只开一份
 * watcher，订阅者集合空了以后延迟关闭。不是仓库时回 `{ root: null }`。
 *
 * 要记住订阅者是谁（宿主传 webContents id）：页面刷新 / 崩溃时它来不及发 `unwatch`，
 * 由 `releaseWatchers` 按 id 一次清掉，否则那份引用会留到进程退出。
 */
export function watchRepository(directory, subscriber = ANONYMOUS) {
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
  entry.subscribers.add(subscriber)
  return { root }
}

/** 页面卸载时撤销订阅。不认识的目录、没订阅过的订阅者什么都不做。 */
export function unwatchRepository(directory, subscriber = ANONYMOUS) {
  const root = repositoryRootOf(directory)
  const entry = root ? watching.get(root) : null
  if (!entry) return { root: root || null }
  entry.subscribers.delete(subscriber)
  closeWhenIdle(entry)
  return { root }
}

/**
 * 丢掉某个订阅者在所有仓库上的引用：页面刷新（⌘R）、重新加载、崩溃时旧页面的
 * `git:unwatch` 永远不会发出来，只能由宿主按 webContents 身份代它撤销。
 * 重复调用安全：集合里没有这个订阅者时什么都不做，也不会把别人的引用减掉。
 */
export function releaseWatchers(subscriber = ANONYMOUS) {
  for (const entry of [...watching.values()]) {
    if (!entry.subscribers.delete(subscriber)) continue
    closeWhenIdle(entry)
  }
}

/** 运行时退出（测试、重载）时把所有 watcher 收掉。 */
export function disposeGitWatchers() {
  for (const root of [...watching.keys()]) close(root)
}
