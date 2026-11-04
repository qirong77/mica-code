import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import {
  disposeGitWatchers,
  gitDirectoryOf,
  handleGitWatchEvent,
  isGitStatePath,
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
})
