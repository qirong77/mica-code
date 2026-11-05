import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import {
  disposeGitWatchers,
  gitDirectoryOf,
  handleGitWatchEvent,
  handleWorktreeEvent,
  isGitStatePath,
  isWorktreePath,
  nestedWatchPath,
  releaseWatchers,
  setGitWatchBroadcaster,
  unwatchRepository,
  watchRepository
} from './git-watch'

/**
 * 仓库变更靠 `.git` 的 fs.watch 推给页面：提交 / 切分支 / 暂存一定写这里，
 * 而 objects/、logs/ 每次操作都在写，必须挡住——否则页面会被自己的操作刷屏。
 *
 * 内核那一跳（真的 fs.watch 回调）不在单测里跑：它由运行时的 FSEvents 给，测试
 * 运行时下会丢事件。这里覆盖的是「事件进来之后」的过滤、合并与广播。
 */
const dirs = []

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mica-git-watch-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir })
  writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

/**
 * 只要「另一个仓库根」时用这个：`repositoryRootOf` 只看 `.git` 在不在，而 `repo()` 的
 * 提交会跑仓库里的钩子（本机上每条几秒），一个用例建两个会撞上 bun 的单测超时。
 */
function bareRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mica-git-empty-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** 等事件攒到这个数（内核那一跳的到达时间不受我们控制，只能等）。 */
async function waitForCount(list, count, timeoutMs = 2000) {
  const started = Date.now()
  while (list.length < count) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待 ${count} 条事件超时`)
    await sleep(20)
  }
}

afterEach(() => {
  disposeGitWatchers()
  setGitWatchBroadcaster(null)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('isGitStatePath', () => {
  it('accepts the paths whose content decides what the panel shows', () => {
    for (const name of ['HEAD', 'index', 'packed-refs', 'refs', 'refs/heads/main', 'ORIG_HEAD']) {
      expect(isGitStatePath(name)).toBe(true)
    }
  })

  it('ignores object writes, reflogs and lock files', () => {
    for (const name of ['objects/ab/cdef', 'logs/HEAD', 'index.lock', 'COMMIT_EDITMSG']) {
      expect(isGitStatePath(name)).toBe(false)
    }
  })

  it('treats an unknown filename as relevant', () => {
    // 系统给不出文件名时宁可多刷一次，也别漏掉一次真正的提交。
    expect(isGitStatePath('')).toBe(true)
    expect(isGitStatePath(null)).toBe(true)
  })
})

describe('nestedWatchPath', () => {
  // 不支持递归 watch 时会给 refs / refs/heads 各开一个 watcher，它们给的 filename 是
  // 相对各自目录的；不补前缀的话「提交」在过滤那一关就被丢掉，页面永远等不到推送。
  it('prefixes a nested watcher filename back to the .git-relative path', () => {
    expect(nestedWatchPath('refs/heads', 'main')).toBe(path.join('refs/heads', 'main'))
    expect(isGitStatePath(nestedWatchPath('refs/heads', 'main'))).toBe(true)
    expect(isGitStatePath(nestedWatchPath('refs', path.join('heads', 'main')))).toBe(true)
  })

  it('leaves the root watcher paths and empty filenames alone', () => {
    expect(nestedWatchPath('', 'HEAD')).toBe('HEAD')
    expect(nestedWatchPath('refs', '')).toBe('')
    expect(nestedWatchPath('refs', undefined)).toBeUndefined()
  })
})

describe('gitDirectoryOf', () => {
  it('returns the .git directory of a normal repository', () => {
    const dir = repo()
    expect(gitDirectoryOf(dir)).toBe(path.join(dir, '.git'))
  })

  it('follows the gitdir pointer of a worktree-style checkout', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mica-git-wt-'))
    dirs.push(dir)
    const real = path.join(dir, 'real-git')
    mkdirSync(real)
    writeFileSync(path.join(dir, '.git'), `gitdir: ${real}\n`)
    expect(gitDirectoryOf(dir)).toBe(real)
  })

  it('returns null outside a repository', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mica-git-plain-'))
    dirs.push(dir)
    expect(gitDirectoryOf(dir)).toBeNull()
  })
})

describe('isWorktreePath', () => {
  it('accepts ordinary source files', () => {
    for (const name of ['src/app.js', 'README.md', 'a.txt', 'packages/x/y.ts', 'bun.lock']) {
      expect(isWorktreePath(name)).toBe(true)
    }
  })

  it('ignores build output, dependencies and editor junk', () => {
    for (const name of [
      'node_modules/react/index.js',
      'apps/desktop/out/main/index.js',
      'dist/index.js',
      'temp/probe.mjs',
      '.git/index',
      '.DS_Store',
      'src/app.js~',
      'src/.app.js.swp'
    ]) {
      expect(isWorktreePath(name)).toBe(false)
    }
  })

  it('treats an unknown filename as relevant', () => {
    expect(isWorktreePath('')).toBe(true)
    expect(isWorktreePath(null)).toBe(true)
  })
})

describe('watchRepository', () => {
  it('reports the repository root and skips directories without one', () => {
    const dir = repo()
    const plain = mkdtempSync(path.join(os.tmpdir(), 'mica-git-norepo-'))
    dirs.push(plain)
    expect(watchRepository(path.join(dir, 'a.txt')).root).toBe(dir)
    expect(unwatchRepository(dir).root).toBe(dir)
    expect(watchRepository(plain).root).toBeNull()
  })

  it('broadcasts a change once the writes settle', async () => {
    const dir = repo()
    const events = []
    setGitWatchBroadcaster((channel, payload) => events.push({ channel, payload }))
    expect(watchRepository(dir).root).toBe(dir)

    // 一次提交会连着写 refs 与 index：两个事件只该让页面刷一次。
    expect(handleGitWatchEvent(dir, 'refs/heads/main')).toBe(true)
    expect(handleGitWatchEvent(dir, 'index')).toBe(false)
    expect(events).toHaveLength(0)
    await sleep(250)
    expect(events).toEqual([{ channel: 'git:changed', payload: { root: dir } }])
  })

  it('ignores paths that do not change what the panel shows', async () => {
    const dir = repo()
    const events = []
    setGitWatchBroadcaster((channel, payload) => events.push({ channel, payload }))
    watchRepository(dir)
    expect(handleGitWatchEvent(dir, 'objects/ab/cdef')).toBe(false)
    expect(handleGitWatchEvent(dir, 'index.lock')).toBe(false)
    await sleep(250)
    expect(events).toHaveLength(0)
  })

  it('keeps one watcher for repeated subscriptions', async () => {
    const dir = repo()
    const events = []
    setGitWatchBroadcaster((channel, payload) => events.push({ channel, payload }))
    watchRepository(dir)
    watchRepository(dir)
    // 两处订阅：撤掉一处之后变化照旧推
    unwatchRepository(dir)
    handleGitWatchEvent(dir, 'HEAD')
    await sleep(250)
    expect(events).toHaveLength(1)
  })

  it('coalesces bursts inside the cooldown window', async () => {
    const dir = repo()
    const events = []
    setGitWatchBroadcaster((channel, payload) => events.push({ channel, payload }))
    watchRepository(dir)
    handleGitWatchEvent(dir, 'HEAD')
    await waitForCount(events, 1)
    // 冷却期内的变化不立刻再推一遍
    handleGitWatchEvent(dir, 'index')
    await sleep(250)
    expect(events).toHaveLength(1)
    // 但它不会丢：冷却结束时并进那一次推送
    await waitForCount(events, 2)
    // 冷却过去之后的新变化照常推
    handleGitWatchEvent(dir, 'refs/heads/main')
    await waitForCount(events, 3)
  })

  it('broadcasts worktree writes but not the ignored ones', async () => {
    const dir = repo()
    const events = []
    setGitWatchBroadcaster((channel, payload) => events.push({ channel, payload }))
    watchRepository(dir)

    // 改文件不写 `.git`，`.git` 那一路永远等不到：这条推送是徽标跟得上的唯一来源。
    expect(handleWorktreeEvent(dir, 'a.txt')).toBe(true)
    // 一次保存会连着来好几条事件，只算一次。
    expect(handleWorktreeEvent(dir, 'a.txt')).toBe(false)
    await waitForCount(events, 1)
    expect(events).toEqual([{ channel: 'git:changed', payload: { root: dir } }])

    // 依赖 / 构建产物 / `.git` 自己都不该让页面重扫。
    expect(handleWorktreeEvent(dir, 'node_modules/react/index.js')).toBe(false)
    expect(handleWorktreeEvent(dir, 'out/renderer/index.js')).toBe(false)
    expect(handleWorktreeEvent(dir, '.git/index')).toBe(false)
  })

  it('keeps the worktree cadence bounded by the cooldown', async () => {
    const dir = repo()
    const events = []
    setGitWatchBroadcaster((channel, payload) => events.push({ channel, payload }))
    watchRepository(dir)
    handleWorktreeEvent(dir, 'a.txt')
    await waitForCount(events, 1)
    // 冷却期内连续写文件：不立刻再推（否则每次保存都要把整棵工作区扫一遍）。
    handleWorktreeEvent(dir, 'a.txt')
    await sleep(800)
    expect(events).toHaveLength(1)
    // 但不会丢：冷却结束补一次。
    await waitForCount(events, 2, 4000)
  })
})

describe('watcher subscribers', () => {
  // 订阅空了以后是 IDLE_CLOSE_MS 的延迟关闭：用假时钟直接推过去，不真等一分钟，
  // 也不必为了测试去改那个生产常量。被推过去的关闭是可观察的——entry 没了就不再推。
  afterEach(() => vi.useRealTimers())

  it('counts a repeated subscription from the same page once', () => {
    vi.useFakeTimers()
    const dir = repo()
    watchRepository(dir, 1)
    watchRepository(dir, 1)
    // 同一页面重复 watch 只留一个引用：撤一次就归零，随后走延迟关闭。
    unwatchRepository(dir, 1)
    expect(handleGitWatchEvent(dir, 'HEAD')).toBe(true)
    vi.advanceTimersByTime(200)
    vi.advanceTimersByTime(120_000)
    expect(handleGitWatchEvent(dir, 'HEAD')).toBe(false)
  })

  it('treats subscriptions without an id as one anonymous subscriber', () => {
    vi.useFakeTimers()
    const dir = repo()
    watchRepository(dir)
    watchRepository(dir)
    unwatchRepository(dir)
    vi.advanceTimersByTime(120_000)
    expect(handleGitWatchEvent(dir, 'HEAD')).toBe(false)
  })

  it('releases one page on every repository without touching the others', () => {
    vi.useFakeTimers()
    const dir = repo()
    const other = bareRepo()
    const events = []
    setGitWatchBroadcaster((channel, payload) => events.push({ channel, payload }))
    watchRepository(dir, 1)
    watchRepository(other, 1)
    watchRepository(dir, 2)

    // 刷新 / 崩溃的页面来不及 unwatch：宿主按 id 一次清掉它在所有仓库上的引用。
    releaseWatchers(1)
    vi.advanceTimersByTime(120_000)
    // 订阅者 2 还订着 dir：它没被连带清掉，事件照旧推。
    expect(handleGitWatchEvent(dir, 'HEAD')).toBe(true)
    vi.advanceTimersByTime(200)
    expect(events).toEqual([{ channel: 'git:changed', payload: { root: dir } }])
    // other 上只有订阅者 1，已经放掉并关掉了。
    expect(handleGitWatchEvent(other, 'HEAD')).toBe(false)
  })

  it('keeps the watcher until the last subscriber leaves', () => {
    vi.useFakeTimers()
    const dir = repo()
    const events = []
    setGitWatchBroadcaster((channel, payload) => events.push({ channel, payload }))
    watchRepository(dir, 1)
    watchRepository(dir, 2)

    unwatchRepository(dir, 1)
    vi.advanceTimersByTime(120_000)
    expect(handleGitWatchEvent(dir, 'refs/heads/main')).toBe(true)
    vi.advanceTimersByTime(200)
    expect(events).toEqual([{ channel: 'git:changed', payload: { root: dir } }])

    // 都撤掉之后不立刻关（页面切回来不必重建），过 IDLE_CLOSE_MS 才关。
    unwatchRepository(dir, 2)
    expect(handleGitWatchEvent(dir, 'HEAD')).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(handleGitWatchEvent(dir, 'HEAD')).toBe(false)
  })
})
